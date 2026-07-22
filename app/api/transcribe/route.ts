import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not set. Add it to .env.local (and Vercel env)." },
      { status: 500 }
    );
  }
  const openai = new OpenAI();

  const fd = await req.formData();
  const audio = fd.get("audio");
  if (!(audio instanceof File)) {
    return NextResponse.json({ error: "Missing audio chunk" }, { status: 400 });
  }

  const r = await openai.audio.transcriptions.create({
    file: audio,
    model: "whisper-1",
    response_format: "verbose_json",
    timestamp_granularities: ["word", "segment"],
  });

  return NextResponse.json({
    words: (r.words ?? []).map((w) => ({ word: w.word, start: w.start, end: w.end })),
    segments: (r.segments ?? []).map((s) => ({ s: s.start, e: s.end, text: s.text })),
    duration: r.duration ?? 0,
  });
}
