import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { timelineText } from "@/lib/transcript";
import type { Clip, MergedTranscript } from "@/lib/types";

export const maxDuration = 300;

const STORYLINE_KEYS = [
  "mcgregor", "holloway", "saint_denis", "pimblett", "royval",
  "kavanagh", "green_mckinney", "whittaker", "steveson", "general",
] as const;

const SYSTEM_PROMPT = `You are the clip strategist for the official UFC 329 (McGregor vs Holloway 2) clipping campaign. You receive a timestamped transcript of official promo content (Countdown, Embedded, media day, press conferences, weigh-ins, octagon interviews) and pick the moments most likely to go viral as short-form clips for TikTok/Shorts/Reels.

AUDIENCE: English-speaking countries — US, UK, Canada, Australia, New Zealand.

CAMPAIGN STORYLINES (tag every clip with the one it serves best):
- mcgregor: McGregor Return — "Return of the Mac", new weight 170, redemption arc
- holloway: Holloway — ex-BMF, lost the original fight with Conor, new weight class
- saint_denis: Saint-Denis — "God of War", ex-military
- pimblett: Paddy Pimblett — Scouser, eating, rivalry with Ilia
- royval: Royval — comeback after losses, proving he's still at the top of the division
- kavanagh: Kavanagh — brightest flyweight prospect, beat Moreno last fight
- green_mckinney: Green vs McKinney — battle of wild styles, first-round-KO hype
- whittaker: Whittaker — "Bobby Knuckles" first fight at light heavyweight after being middleweight champ
- steveson: Gable Steveson — first UFC fight, insane wrestling resume, trains with Jon Jones
- general: only if no storyline fits (use sparingly)

WHAT GOES VIRAL IN FIGHT PROMO (rank by this):
- Trash talk peaks, quotable one-liners, mic moments >> b-roll or process talk
- 20–45 seconds, self-contained arc: hook line → escalation → payoff
- Open on the single hottest line (that becomes first_3s_hook)
- Rivalry heat, genuine emotion, callbacks to history (Conor/Max 2013), weight-cut drama
- Loopable or quotable endings

HARD CAMPAIGN RULES:
- caption: ready to paste, 1-2 punchy sentences + relevant fighter/event hashtags, and it MUST end with #UFCClips
- hook_title: must add storyline value. BANNED style: "I CAN'T BELIEVE THAT HAPPENED", "WAIT FOR IT", or any random-moment clickbait with no context. GOOD style: "Conor's first words to Max in 11 years", "Paddy hits back at Ilia".
- NO logos or watermarks are ever mentioned or suggested.
- compliance flags must be honest: if a segment sounds like commentary over live fight action set in_fight_broadcast_risk=true; if it narrates a fighter's walkout set walkout_risk=true; low_value_risk reflects how much the clip depends on context the viewer lacks.

TIMING RULES:
- start_s/end_s must correspond to real timeline entries you were given (seconds). Never invent times beyond the video duration.
- Propose rough bounds only — the client snaps to sentence boundaries in code. Do NOT fine-tune sub-second timings.

Return 5-8 clips ranked best-first by virality.total (0-100, be discriminating — a 90 is a banger, a 60 is filler).`;

const CLIPS_SCHEMA = {
  name: "campaign_clips",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["clips"],
    properties: {
      clips: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "start_s", "end_s", "storyline", "hook_title", "first_3s_hook",
            "caption", "hashtags", "virality", "reasoning", "compliance",
          ],
          properties: {
            start_s: { type: "number" },
            end_s: { type: "number" },
            storyline: { type: "string", enum: [...STORYLINE_KEYS] },
            hook_title: { type: "string" },
            first_3s_hook: { type: "string" },
            caption: { type: "string" },
            hashtags: { type: "array", items: { type: "string" } },
            virality: {
              type: "object",
              additionalProperties: false,
              required: ["total", "hook", "emotion", "quotability", "loopability"],
              properties: {
                total: { type: "number" },
                hook: { type: "number" },
                emotion: { type: "number" },
                quotability: { type: "number" },
                loopability: { type: "number" },
              },
            },
            reasoning: { type: "string" },
            compliance: {
              type: "object",
              additionalProperties: false,
              required: ["in_fight_broadcast_risk", "walkout_risk", "low_value_risk"],
              properties: {
                in_fight_broadcast_risk: { type: "boolean" },
                walkout_risk: { type: "boolean" },
                low_value_risk: { type: "string", enum: ["low", "med", "high"] },
              },
            },
          },
        },
      },
    },
  },
} as const;

const MODEL_CHAIN = ["gpt-5", "gpt-5-mini"] as const;

function enforceUfcClips(caption: string): string {
  const trimmed = caption.trim();
  return /#UFCClips\s*$/i.test(trimmed) ? trimmed : `${trimmed} #UFCClips`;
}

export async function POST(req: NextRequest) {
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not set. Add it to .env.local (and Vercel env)." },
      { status: 500 }
    );
  }

  const openai = new OpenAI();
  const body = (await req.json()) as {
    transcript?: MergedTranscript;
    timeline?: string;
    duration?: number;
    videoName?: string;
  };

  const duration = body.duration ?? body.transcript?.duration ?? 0;
  const timeline =
    body.timeline?.trim() ||
    (body.transcript?.segments ? timelineText(body.transcript.segments) : "");

  if (!timeline) {
    return NextResponse.json({ error: "Empty transcript" }, { status: 400 });
  }

  const userMsg = `SOURCE: ${body.videoName ?? "campaign video"} (duration ${Math.round(
    duration
  )}s)\n\nTIMESTAMPED TRANSCRIPT (format [m:ss-m:ss] text — use seconds for start_s/end_s):\n${timeline}`;

  let lastErr: unknown = null;
  for (const model of MODEL_CHAIN) {
    try {
      const res = await openai.chat.completions.create({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMsg },
        ],
        response_format: { type: "json_schema", json_schema: CLIPS_SCHEMA },
      });

      const raw = res.choices[0]?.message?.content;
      if (!raw) throw new Error("Empty completion");

      const parsed = JSON.parse(raw) as { clips: Clip[] };

      const clips = parsed.clips
        .filter((c) => c.end_s - c.start_s >= 5 && c.start_s >= 0 && c.start_s < duration)
        .map((c) => ({
          ...c,
          end_s: Math.min(c.end_s, duration),
          caption: enforceUfcClips(c.caption),
        }))
        .sort((a, b) => b.virality.total - a.virality.total);

      return NextResponse.json({ clips, model });
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!/model|not.?found|does not exist|unsupported/i.test(msg)) break;
    }
  }

  const msg = lastErr instanceof Error ? lastErr.message : "Unknown error";
  return NextResponse.json({ error: `Moment analysis failed: ${msg}` }, { status: 502 });
}
