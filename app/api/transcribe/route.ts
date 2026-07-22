import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rateLimit";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  // Chunks arrive 3-at-a-time per video; 60/min still stops runaway clients.
  const rl = rateLimit(`transcribe:${clientIp(req)}`, 60, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfterS);

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not set. Add it to .env.local (and Vercel env)." },
      { status: 500 }
    );
  }
  const openai = new OpenAI();

  let fd: FormData;
  try {
    fd = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data with an audio chunk" }, { status: 400 });
  }
  const audio = fd.get("audio");
  if (!(audio instanceof File)) {
    return NextResponse.json({ error: "Missing audio chunk" }, { status: 400 });
  }
  if (audio.size === 0) {
    return NextResponse.json({ error: "Empty audio chunk" }, { status: 400 });
  }
  if (audio.size > 4.4 * 1024 * 1024) {
    return NextResponse.json({ error: "Audio chunk too large" }, { status: 413 });
  }

  try {
    const r = await openai.audio.transcriptions.create({
      file: audio,
      model: "whisper-1",
      response_format: "verbose_json",
      timestamp_granularities: ["word", "segment"],
    });

    return NextResponse.json({
      words: (r.words ?? []).map((w) => ({ word: w.word, start: w.start, end: w.end })),
      segments: (r.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text })),
      duration: r.duration ?? 0,
    });
  } catch (err) {
    if (err instanceof OpenAI.APIError) {
      const status = err.status ?? 502;
      const message =
        status === 429
          ? "Transcription rate limited — retry shortly."
          : status === 413
            ? "Audio chunk rejected as too large."
            : "Transcription service error.";
      console.error(`[transcribe] OpenAI ${status}:`, err.message);
      return NextResponse.json({ error: message }, { status });
    }
    console.error("[transcribe] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Transcription failed. Please retry." }, { status: 502 });
  }
}
