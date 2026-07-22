import { NextRequest, NextResponse } from "next/server";

// Per-instance sliding-window limiter. On serverless each warm instance gets
// its own window — good enough to stop a single client from hammering the
// OpenAI budget, which is the actual threat model here.
type Bucket = { times: number[] };
const buckets = new Map<string, Bucket>();
const MAX_KEYS = 2000;

export function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "local";
}

/** True if this call is allowed; false when the key exceeded limit/window. */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number
): { ok: boolean; retryAfterS: number } {
  const now = Date.now();

  if (buckets.size > MAX_KEYS) {
    for (const [k, b] of buckets) {
      if (b.times.length === 0 || now - b.times[b.times.length - 1] > windowMs) {
        buckets.delete(k);
      }
    }
  }

  const b = buckets.get(key) ?? { times: [] };
  b.times = b.times.filter((t) => now - t < windowMs);

  if (b.times.length >= limit) {
    buckets.set(key, b);
    return {
      ok: false,
      retryAfterS: Math.max(1, Math.ceil((windowMs - (now - b.times[0])) / 1000)),
    };
  }

  b.times.push(now);
  buckets.set(key, b);
  return { ok: true, retryAfterS: 0 };
}

export function tooManyRequests(retryAfterS: number): NextResponse {
  return NextResponse.json(
    { error: `Too many requests — try again in ~${retryAfterS}s.` },
    { status: 429, headers: { "Retry-After": String(retryAfterS) } }
  );
}
