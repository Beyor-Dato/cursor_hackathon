"use client";

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import type { AudioChunk } from "./types";

let instance: FFmpeg | null = null;
let loading: Promise<FFmpeg> | null = null;

export type FfmpegProgress = {
  phase: "core" | "exec";
  ratio: number;
  message?: string;
};

/**
 * Lazy-load single-thread ffmpeg.wasm from /public/ffmpeg/.
 * Uses self-hosted classWorkerURL to avoid Turbopack 404 on worker.js.
 */
export async function loadFFmpeg(
  onProgress?: (p: FfmpegProgress) => void
): Promise<FFmpeg> {
  if (instance) return instance;
  if (!loading) {
    loading = (async () => {
      const ffmpeg = new FFmpeg();

      ffmpeg.on("log", ({ message }) => {
        onProgress?.({ phase: "core", ratio: 0, message });
      });
      ffmpeg.on("progress", ({ progress }) => {
        onProgress?.({ phase: "exec", ratio: progress });
      });

      onProgress?.({ phase: "core", ratio: 0.05, message: "Loading ffmpeg core…" });

      const coreURL = await toBlobURL("/ffmpeg/ffmpeg-core.js", "text/javascript");
      onProgress?.({ phase: "core", ratio: 0.35, message: "Loading wasm…" });
      const wasmURL = await toBlobURL("/ffmpeg/ffmpeg-core.wasm", "application/wasm");
      onProgress?.({ phase: "core", ratio: 0.65, message: "Loading worker…" });
      const classWorkerURL = await toBlobURL("/ffmpeg/worker.js", "text/javascript");

      await ffmpeg.load({ coreURL, wasmURL, classWorkerURL });
      onProgress?.({ phase: "core", ratio: 1, message: "ffmpeg ready" });

      instance = ffmpeg;
      return ffmpeg;
    })();
  }
  return loading;
}

/** @deprecated Use loadFFmpeg */
export async function getFFmpeg(onLog?: (msg: string) => void): Promise<FFmpeg> {
  return loadFFmpeg(onLog ? ({ message }) => onLog(message ?? "") : undefined);
}

const MP3_SEGMENT_S = 360; // 6 min @ 32kbps mono ≈ 1.4MB
const WAV_SEGMENT_S = 120; // fallback: 2 min 16k mono 16-bit ≈ 3.8MB
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Extract mono 32kbps mp3 chunks (~6 min each, each <4MB) from a dropped video.
 * Video never leaves the browser.
 */
export async function extractAudioChunks(
  file: File,
  onProgress?: (msg: string, ratio?: number) => void
): Promise<AudioChunk[]> {
  const ffmpeg = await loadFFmpeg(({ message, ratio, phase }) => {
    if (phase === "core") onProgress?.(message ?? "Loading ffmpeg…", ratio);
  });

  onProgress?.("Loading video into memory…", 0);
  await ffmpeg.writeFile("in.mp4", await fetchFile(file));

  onProgress?.("Extracting audio…", 0.1);
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
    segmentSeconds = WAV_SEGMENT_S;
    ext = "wav";
    const wavCode = await ffmpeg.exec([
      "-i", "in.mp4",
      "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
      "-f", "segment", "-segment_time", String(WAV_SEGMENT_S),
      "-reset_timestamps", "1",
      "chunk_%03d.wav",
    ]);
    if (wavCode !== 0) {
      throw new Error("Audio extraction failed — is this a valid video file?");
    }
  }

  const chunks: AudioChunk[] = [];
  const entries = await ffmpeg.listDir("/");
  const names = entries
    .filter((e) => e.name.startsWith("chunk_") && e.name.endsWith(`.${ext}`))
    .map((e) => e.name)
    .sort();

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const data = (await ffmpeg.readFile(name)) as Uint8Array;
    if (data.byteLength >= MAX_CHUNK_BYTES) {
      throw new Error(
        `Audio chunk ${name} is ${(data.byteLength / 1024 / 1024).toFixed(1)}MB — exceeds 4MB API limit`
      );
    }
    const idx = parseInt(name.slice(6, 9), 10);
    chunks.push({
      blob: new Blob([data.slice().buffer as ArrayBuffer], {
        type: ext === "mp3" ? "audio/mpeg" : "audio/wav",
      }),
      offset: idx * segmentSeconds,
      index: idx,
    });
    await ffmpeg.deleteFile(name);
    onProgress?.(`Extracted chunk ${i + 1}/${names.length}`, (i + 1) / names.length);
  }

  if (chunks.length === 0) throw new Error("No audio found in this video.");
  return chunks;
}

/** Fast keyframe-aligned cut (-c copy). Returns an mp4 blob. */
export async function cutClip(
  file: File,
  startS: number,
  endS: number
): Promise<Blob> {
  const ffmpeg = await loadFFmpeg();
  const duration = Math.max(endS - startS, 0.1);

  try {
    await ffmpeg.readFile("in.mp4");
  } catch {
    await ffmpeg.writeFile("in.mp4", await fetchFile(file));
  }

  const code = await ffmpeg.exec([
    "-ss", startS.toFixed(2),
    "-i", "in.mp4",
    "-t", duration.toFixed(2),
    "-c", "copy", "-avoid_negative_ts", "make_zero",
    "-y", "cut.mp4",
  ]);

  if (code !== 0) {
    await ffmpeg.writeFile("in.mp4", await fetchFile(file));
    const retry = await ffmpeg.exec([
      "-ss", startS.toFixed(2),
      "-i", "in.mp4",
      "-t", duration.toFixed(2),
      "-c", "copy", "-avoid_negative_ts", "make_zero",
      "-y", "cut.mp4",
    ]);
    if (retry !== 0) throw new Error("Clip cut failed");
  }

  const data = (await ffmpeg.readFile("cut.mp4")) as Uint8Array;
  await ffmpeg.deleteFile("cut.mp4");
  return new Blob([data.slice().buffer as ArrayBuffer], { type: "video/mp4" });
}

export type { AudioChunk };
