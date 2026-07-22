"use client";

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

let instance: FFmpeg | null = null;
let loading: Promise<FFmpeg> | null = null;

export async function getFFmpeg(onLog?: (msg: string) => void): Promise<FFmpeg> {
  if (instance) return instance;
  if (!loading) {
    loading = (async () => {
      const ffmpeg = new FFmpeg();
      if (onLog) ffmpeg.on("log", ({ message }) => onLog(message));
      await ffmpeg.load({
        coreURL: await toBlobURL("/ffmpeg/ffmpeg-core.js", "text/javascript"),
        wasmURL: await toBlobURL("/ffmpeg/ffmpeg-core.wasm", "application/wasm"),
      });
      instance = ffmpeg;
      return ffmpeg;
    })();
  }
  return loading;
}

export type AudioChunk = { blob: Blob; offset: number };

const MP3_SEGMENT_S = 360; // 6 min @ 32kbps mono ≈ 1.4MB
const WAV_SEGMENT_S = 120; // fallback: 2 min of 16k mono 16-bit ≈ 3.8MB

/**
 * Extract mono speech-grade audio from the dropped video, pre-split into
 * chunks that fit under Vercel's 4.5MB route body limit.
 */
export async function extractAudioChunks(
  file: File,
  onStage?: (msg: string) => void
): Promise<AudioChunk[]> {
  const ffmpeg = await getFFmpeg();
  onStage?.("Loading video into memory…");
  await ffmpeg.writeFile("in.mp4", await fetchFile(file));

  onStage?.("Extracting audio…");
  const mp3Args = [
    "-i", "in.mp4",
    "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k",
    "-f", "segment", "-segment_time", String(MP3_SEGMENT_S),
    "-reset_timestamps", "1",
    "chunk_%03d.mp3",
  ];
  let segmentSeconds = MP3_SEGMENT_S;
  let ext = "mp3";
  const code = await ffmpeg.exec(mp3Args);
  if (code !== 0) {
    // Core built without libmp3lame → WAV segments sized under the limit.
    segmentSeconds = WAV_SEGMENT_S;
    ext = "wav";
    const wavCode = await ffmpeg.exec([
      "-i", "in.mp4",
      "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
      "-f", "segment", "-segment_time", String(WAV_SEGMENT_S),
      "-reset_timestamps", "1",
      "chunk_%03d.wav",
    ]);
    if (wavCode !== 0) throw new Error("Audio extraction failed — is this a valid video file?");
  }

  const chunks: AudioChunk[] = [];
  const entries = await ffmpeg.listDir("/");
  const names = entries
    .filter((e) => e.name.startsWith("chunk_") && e.name.endsWith(`.${ext}`))
    .map((e) => e.name)
    .sort();
  for (const name of names) {
    const data = (await ffmpeg.readFile(name)) as Uint8Array;
    const idx = parseInt(name.slice(6, 9), 10);
    chunks.push({
      blob: new Blob([data.slice().buffer as ArrayBuffer], { type: ext === "mp3" ? "audio/mpeg" : "audio/wav" }),
      offset: idx * segmentSeconds,
    });
    await ffmpeg.deleteFile(name);
  }
  if (chunks.length === 0) throw new Error("No audio found in this video.");
  return chunks;
}

/** Fast keyframe-aligned cut, no re-encode. Returns an mp4 blob. */
export async function cutClip(file: File, start: number, end: number): Promise<Blob> {
  const ffmpeg = await getFFmpeg();
  // in.mp4 persists from extraction; rewrite only if missing (e.g. page refresh path)
  try {
    await ffmpeg.exec([
      "-ss", start.toFixed(2),
      "-i", "in.mp4",
      "-t", (end - start).toFixed(2),
      "-c", "copy", "-avoid_negative_ts", "make_zero",
      "-y", "cut.mp4",
    ]);
  } catch {
    await ffmpeg.writeFile("in.mp4", await fetchFile(file));
  }
  let data: Uint8Array;
  try {
    data = (await ffmpeg.readFile("cut.mp4")) as Uint8Array;
  } catch {
    await ffmpeg.writeFile("in.mp4", await fetchFile(file));
    await ffmpeg.exec([
      "-ss", start.toFixed(2),
      "-i", "in.mp4",
      "-t", (end - start).toFixed(2),
      "-c", "copy", "-avoid_negative_ts", "make_zero",
      "-y", "cut.mp4",
    ]);
    data = (await ffmpeg.readFile("cut.mp4")) as Uint8Array;
  }
  await ffmpeg.deleteFile("cut.mp4");
  return new Blob([data.slice().buffer as ArrayBuffer], { type: "video/mp4" });
}
