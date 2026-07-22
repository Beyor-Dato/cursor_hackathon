import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { ensureUFCClipsHashtag } from "@/lib/caption";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rateLimit";
import { timelineText } from "@/lib/transcript";
import type { Clip, Compliance, MergedTranscript, Storyline, Virality } from "@/lib/types";

export const maxDuration = 300;

const STORYLINE_KEYS = [
  "mcgregor", "holloway", "saint_denis", "pimblett", "royval",
  "kavanagh", "green_mckinney", "whittaker", "steveson", "general",
] as const;

const SYSTEM_PROMPT = `You are a viral clip strategist for short-form video (TikTok/Shorts/Reels). You receive a timestamped transcript of any video — podcasts, press conferences, interviews, talks, streams — and pick the moments most likely to go viral as self-contained short clips.

AUDIENCE:
- If the user message names a TARGET AUDIENCE, optimize every hook, caption and hashtag for that audience.
- If not, INFER the audience from the content itself (who would share this?) and name your inference in each clip's "reasoning". Tune hooks/captions/hashtags to that inferred audience.

UFC 329 CAMPAIGN MODE — applies ONLY when the content is UFC / MMA fight promo around McGregor vs Holloway 2 (Countdown, Embedded, pressers, weigh-ins, fighter interviews). Then you work for the official UFC 329 clipping campaign: tag each clip with the storyline it serves best and end every caption with #UFCClips. For all other content use storyline "general" and pick hashtags for the inferred niche instead — no #UFCClips.

CAMPAIGN STORYLINES (campaign mode only):
- mcgregor: McGregor Return — "Return of the Mac", new weight 170, redemption arc
- holloway: Holloway — ex-BMF, lost the original fight with Conor, new weight class
- saint_denis: Saint-Denis — "God of War", ex-military
- pimblett: Paddy Pimblett — Scouser, eating, rivalry with Ilia
- royval: Royval — comeback after losses, proving he's still at the top of the division
- kavanagh: Kavanagh — brightest flyweight prospect, beat Moreno last fight
- green_mckinney: Green vs McKinney — battle of wild styles, first-round-KO hype
- whittaker: Whittaker — "Bobby Knuckles" first fight at light heavyweight after being middleweight champ
- steveson: Gable Steveson — first UFC fight, insane wrestling resume, trains with Jon Jones
- general: all non-campaign content, or campaign content no storyline fits

WHAT GOES VIRAL (rank by this):
- Strong opinions, confrontations, revelations, quotable one-liners, emotional peaks >> process talk or b-roll narration
- ~20 seconds is the sweet spot; 15–45s is fine when the arc earns it; NEVER exceed 60s. Self-contained arc: hook line → escalation → payoff
- Open on the single hottest line (that becomes first_3s_hook)
- Rivalry heat, genuine emotion, callbacks to history (Conor/Max 2013), weight-cut drama
- Loopable or quotable endings

HARD RULES:
- caption: ready to paste, 1-2 punchy sentences + hashtags for the audience. Campaign-mode captions MUST end with #UFCClips; general captions must NOT carry #UFCClips.
- hook_title: must add storyline value. BANNED style: "I CAN'T BELIEVE THAT HAPPENED", "WAIT FOR IT", or any random-moment clickbait with no context. GOOD style: "Conor's first words to Max in 11 years", "Paddy hits back at Ilia".
- NO logos or watermarks are ever mentioned or suggested.
- compliance flags must be honest: if a segment sounds like commentary over live fight/broadcast action set in_fight_broadcast_risk=true; if it narrates a fighter's walkout set walkout_risk=true (both are false for non-broadcast content); low_value_risk always reflects how much the clip depends on context the viewer lacks.

TIMING RULES:
- start_s/end_s must correspond to real timeline entries you were given (seconds). Never invent times beyond the video duration.
- Propose rough bounds only — the client snaps to sentence boundaries in code. Do NOT fine-tune sub-second timings.
- JUMP CUTS: when trimming dead air or stitching a setup line to its payoff makes the clip hit harder, assemble it from 1-3 non-adjacent spans of the same arc via "segments" (in chronological order, each span ≥ 5s, combined length still ~20s ideal / 60s max). The client stitches them with fast cut transitions. Only stitch spans that read as ONE thought — never splice unrelated moments.

Return 5-8 clips ranked best-first by virality.total (0-100, be discriminating — a 90 is a banger, a 60 is filler).

OUTPUT FORMAT — respond with a single JSON object, nothing else, exactly this shape:
{
  "clips": [
    {
      "start_s": number,
      "end_s": number,
      "segments": [ { "start_s": number, "end_s": number } ],  // optional: 1-3 chronological spans for a jump-cut assembly; omit for one continuous clip
      "storyline": one of ${JSON.stringify([...STORYLINE_KEYS])},
      "hook_title": string,
      "first_3s_hook": string,
      "caption": string,
      "hashtags": string[],
      "virality": { "total": number, "hook": number, "emotion": number, "quotability": number, "loopability": number },
      "reasoning": string,
      "compliance": { "in_fight_broadcast_risk": boolean, "walkout_risk": boolean, "low_value_risk": "low" | "med" | "high" }
    }
  ]
}`;

const MODEL_CHAIN = ["gpt-5", "gpt-5-mini"] as const;
const MAX_TIMELINE_CHARS = 150_000;

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

function coerceVirality(v: unknown): Virality {
  const o = (v ?? {}) as Record<string, unknown>;
  return {
    total: num(o.total, 50, 0, 100),
    hook: num(o.hook, 50, 0, 100),
    emotion: num(o.emotion, 50, 0, 100),
    quotability: num(o.quotability, 50, 0, 100),
    loopability: num(o.loopability, 50, 0, 100),
  };
}

/** Missing compliance data defaults to cautious, never to "all clear". */
function coerceCompliance(v: unknown): Compliance {
  const o = (v ?? {}) as Record<string, unknown>;
  const risk = o.low_value_risk;
  return {
    in_fight_broadcast_risk: o.in_fight_broadcast_risk === true,
    walkout_risk: o.walkout_risk === true,
    low_value_risk: risk === "low" || risk === "med" || risk === "high" ? risk : "med",
  };
}

const MIN_SPAN_S = 4;
const MAX_TOTAL_S = 120;

type Span = { start_s: number; end_s: number };

/** Sort, drop invalid spans, merge overlaps, cap at 3 spans / MAX_TOTAL_S combined. */
function coerceSegments(raw: unknown, duration: number): Span[] {
  const spans: Span[] = (Array.isArray(raw) ? raw : [])
    .map((s) => {
      const o = (s ?? {}) as Record<string, unknown>;
      return {
        start_s: num(o.start_s, NaN, 0, duration),
        end_s: num(o.end_s, NaN, 0, duration),
      };
    })
    .filter(
      (s) =>
        Number.isFinite(s.start_s) &&
        Number.isFinite(s.end_s) &&
        s.end_s - s.start_s >= MIN_SPAN_S
    )
    .sort((a, b) => a.start_s - b.start_s)
    .slice(0, 3);

  const merged: Span[] = [];
  for (const s of spans) {
    const prev = merged[merged.length - 1];
    if (prev && s.start_s < prev.end_s + 0.5) {
      prev.end_s = Math.max(prev.end_s, s.end_s);
    } else {
      merged.push({ ...s });
    }
  }

  let total = 0;
  const capped: Span[] = [];
  for (const s of merged) {
    const len = s.end_s - s.start_s;
    if (total + len <= MAX_TOTAL_S) {
      capped.push(s);
      total += len;
    } else {
      const room = MAX_TOTAL_S - total;
      if (room >= MIN_SPAN_S) {
        capped.push({ start_s: s.start_s, end_s: s.start_s + room });
      }
      break;
    }
  }
  return capped;
}

/** Coerce one raw model clip into a valid Clip, or null if unusable. */
function coerceClip(raw: unknown, duration: number): Clip | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;

  const segments = coerceSegments(o.segments, duration);
  let start = num(o.start_s, NaN, 0, Math.max(duration - 5, 0));
  let end = num(o.end_s, NaN, 0, duration);
  if (segments.length > 0) {
    start = segments[0].start_s;
    end = segments[segments.length - 1].end_s;
  } else if (Number.isFinite(start) && Number.isFinite(end)) {
    end = Math.min(end, start + MAX_TOTAL_S);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 5) return null;

  const storyline = (STORYLINE_KEYS as readonly string[]).includes(String(o.storyline))
    ? (o.storyline as Storyline)
    : "general";

  return {
    start_s: start,
    end_s: end,
    ...(segments.length > 1 ? { segments } : {}),
    storyline,
    hook_title: str(o.hook_title, "Campaign moment"),
    first_3s_hook: str(o.first_3s_hook, ""),
    // Iron rule 2 applies to campaign clips; general content keeps its own tags.
    caption:
      storyline === "general"
        ? str(o.caption, "")
        : ensureUFCClipsHashtag(str(o.caption, "")),
    hashtags: Array.isArray(o.hashtags)
      ? o.hashtags.filter((h): h is string => typeof h === "string").slice(0, 8)
      : [],
    virality: coerceVirality(o.virality),
    reasoning: str(o.reasoning, ""),
    compliance: coerceCompliance(o.compliance),
  };
}

/** Model output may arrive fenced or with stray prose — dig out the JSON object. */
function parseClipsJson(raw: string): unknown[] {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace > 0 || lastBrace < text.length - 1) {
    if (firstBrace === -1 || lastBrace === -1) throw new Error("No JSON object in completion");
    text = text.slice(firstBrace, lastBrace + 1);
  }
  const parsed = JSON.parse(text) as { clips?: unknown };
  if (!Array.isArray(parsed.clips)) throw new Error("Completion JSON has no clips array");
  return parsed.clips;
}

export async function POST(req: NextRequest) {
  const rl = rateLimit(`moments:${clientIp(req)}`, 10, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfterS);

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not set. Add it to .env.local (and Vercel env)." },
      { status: 500 }
    );
  }

  // 120s per attempt keeps gpt-5 + the gpt-5-mini fallback inside maxDuration=300.
  const openai = new OpenAI({ timeout: 120_000, maxRetries: 1 });

  let body: {
    transcript?: MergedTranscript;
    timeline?: string;
    duration?: number;
    videoName?: string;
    audience?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const duration = body.duration ?? body.transcript?.duration ?? 0;
  if (!Number.isFinite(duration) || duration <= 0) {
    return NextResponse.json(
      { error: "Missing or invalid video duration" },
      { status: 400 }
    );
  }

  const timeline =
    body.timeline?.trim() ||
    (body.transcript?.segments ? timelineText(body.transcript.segments) : "");

  if (!timeline) {
    return NextResponse.json({ error: "Empty transcript" }, { status: 400 });
  }
  if (timeline.length > MAX_TIMELINE_CHARS) {
    return NextResponse.json(
      { error: "Transcript too long for moment analysis — split the video into shorter parts." },
      { status: 413 }
    );
  }

  const audienceLine =
    typeof body.audience === "string" && body.audience.trim()
      ? `TARGET AUDIENCE: ${body.audience.trim().slice(0, 200)}`
      : "TARGET AUDIENCE: (not provided — infer it from the content)";

  const userMsg = `SOURCE: ${body.videoName ?? "video"} (duration ${Math.round(
    duration
  )}s)\n${audienceLine}\n\nTIMESTAMPED TRANSCRIPT (format [m:ss-m:ss] text — use seconds for start_s/end_s):\n${timeline}`;

  let lastErr: unknown = null;
  for (const model of MODEL_CHAIN) {
    try {
      // Default reasoning effort costs ~75s on a short transcript — far too
      // slow for a live run, and close to the platform's function ceiling.
      const res = await openai.chat.completions.create({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMsg },
        ],
        response_format: { type: "json_object" },
        reasoning_effort: "minimal",
      });

      const raw = res.choices[0]?.message?.content;
      if (!raw) throw new Error("Empty completion");

      const clips = parseClipsJson(raw)
        .map((c) => coerceClip(c, duration))
        .filter((c): c is Clip => c !== null)
        .sort((a, b) => b.virality.total - a.virality.total);

      if (clips.length === 0) throw new Error("Model returned no usable clips");

      return NextResponse.json({ clips, model });
    } catch (err) {
      lastErr = err;
      console.error(`[moments] ${model} failed:`, err instanceof Error ? err.message : err);
    }
  }

  const msg = lastErr instanceof Error ? lastErr.message : "Unknown error";
  return NextResponse.json({ error: `Moment analysis failed: ${msg}` }, { status: 502 });
}
