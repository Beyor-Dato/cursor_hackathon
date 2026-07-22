import { mergeChunks, snapClip, timelineText, type ChunkResult } from "./transcript";
import type { Clip, Transcript } from "./types";
import { ensureUFCClipsHashtag } from "./caption";

export type PipelineProgress =
  | { stage: "loading-ffmpeg"; message: string }
  | { stage: "extracting-audio"; message: string }
  | { stage: "transcribing"; message: string; current: number; total: number }
  | { stage: "finding-moments"; message: string }
  | { stage: "ready"; message: string };

export type PipelineResult = {
  transcript: Transcript;
  clips: Clip[];
  model?: string;
};

async function transcribeChunk(blob: Blob): Promise<ChunkResult> {
  const fd = new FormData();
  fd.append("audio", blob, "chunk.mp3");
  const res = await fetch("/api/transcribe", { method: "POST", body: fd });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Transcription failed (${res.status})`);
  }
  return res.json() as Promise<ChunkResult>;
}

async function findMoments(
  timeline: string,
  duration: number,
  videoName: string
): Promise<{ clips: Clip[]; model?: string }> {
  const res = await fetch("/api/moments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timeline, duration, videoName }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Moment analysis failed (${res.status})`);
  }
  return res.json() as Promise<{ clips: Clip[]; model?: string }>;
}

/** Full client-side pipeline: extract → transcribe → moments. Video never leaves browser. */
export async function runPipeline(
  file: File,
  onProgress: (p: PipelineProgress) => void
): Promise<PipelineResult> {
  onProgress({ stage: "loading-ffmpeg", message: "Loading ffmpeg.wasm…" });
  const { extractAudioChunks } = await import("./ffmpeg");

  onProgress({ stage: "extracting-audio", message: "Extracting audio…" });
  const chunks = await extractAudioChunks(file, (msg) =>
    onProgress({ stage: "extracting-audio", message: msg })
  );

  const results: ChunkResult[] = [];
  const offsets: number[] = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress({
      stage: "transcribing",
      message: `Transcribing chunk ${i + 1}/${chunks.length}…`,
      current: i + 1,
      total: chunks.length,
    });
    results.push(await transcribeChunk(chunks[i].blob));
    offsets.push(chunks[i].offset);
  }

  const transcript = mergeChunks(results, offsets);

  onProgress({ stage: "finding-moments", message: "Finding campaign moments…" });
  const { clips: rawClips, model } = await findMoments(
    timelineText(transcript.segs),
    transcript.duration,
    file.name
  );

  const clips = rawClips.map((c) => {
    const snapped = snapClip(c.start_s, c.end_s, transcript.segs, transcript.duration);
    return {
      ...c,
      start_s: snapped.start,
      end_s: snapped.end,
      caption: ensureUFCClipsHashtag(c.caption),
    };
  });

  onProgress({ stage: "ready", message: "Ready" });
  return { transcript, clips, model };
}
