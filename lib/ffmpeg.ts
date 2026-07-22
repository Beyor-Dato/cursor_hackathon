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
    // A failed core load must not poison every future attempt — clear the
    // cached promise so the next call retries from scratch.
    loading.catch(() => {
      loading = null;
    });
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
const MAX_INPUT_BYTES = 1.5e9; // ffmpeg.wasm holds the file in memory

/**
 * Extract mono 32kbps mp3 chunks (~6 min each, each <4MB) from a dropped video.
 * Video never leaves the browser.
 */
export async function extractAudioChunks(
  file: File,
  onProgress?: (msg: string, ratio?: number) => void
): Promise<AudioChunk[]> {
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error(
      `Video is ${(file.size / 1e9).toFixed(1)}GB — over the ~1.5GB in-browser limit. Trim it shorter first.`
    );
  }

  const ffmpeg = await loadFFmpeg(({ message, ratio, phase }) => {
    if (phase === "core") onProgress?.(message ?? "Loading ffmpeg…", ratio);
  });

  // "Output file does not contain any stream" in the log means the input has
  // no audio track — surface that instead of a generic failure.
  let noAudioStream = false;
  const onLog = ({ message }: { message: string }) => {
    if (message.includes("does not contain any stream")) noAudioStream = true;
  };
  ffmpeg.on("log", onLog);

  try {
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
      if (noAudioStream) throw new Error("This video has no audio track.");
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
        throw new Error(
          noAudioStream
            ? "This video has no audio track."
            : "Audio extraction failed — is this a valid video file?"
        );
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

    if (chunks.length === 0) {
      throw new Error(
        noAudioStream ? "This video has no audio track." : "No audio found in this video."
      );
    }
    return chunks;
  } finally {
    ffmpeg.off("log", onLog);
  }
}

// Cuts share the singleton FS and fixed output names, so concurrent exports
// from different clip cards would clobber each other. Serialize them.
let cutQueue: Promise<unknown> = Promise.resolve();

export type CutResult = {
  blob: Blob;
  /** Source-time second the mp4 actually begins at (keyframe ≤ requested start). */
  actualStart: number;
};

export type SegmentCutResult = {
  blob: Blob;
  /** Per-segment source-time second each segment actually begins at. */
  actualStarts: number[];
};

/**
 * Fast keyframe-aligned cut (-c copy). Stream copy can only begin on a
 * keyframe, so the mp4 really starts at the keyframe at-or-before startS.
 * We probe that keyframe and return it as `actualStart` — captions must be
 * timed against it, not against startS, or they fire early.
 */
export function cutClip(
  file: File,
  startS: number,
  endS: number
): Promise<CutResult> {
  return cutClipSegments(file, [{ start: startS, end: endS }]).then(
    ({ blob, actualStarts }) => ({ blob, actualStart: actualStarts[0] })
  );
}

/**
 * Multi-segment jump-cut: keyframe-aligned -c copy cut per segment, then
 * stream-copy concat. Each segment really starts at its keyframe at-or-before
 * start — returned as actualStarts, which caption timing must use.
 */
export function cutClipSegments(
  file: File,
  segments: { start: number; end: number }[]
): Promise<SegmentCutResult> {
  const run = cutQueue.then(() => doCutClipSegments(file, segments));
  cutQueue = run.catch(() => {});
  return run;
}

/**
 * ffprobe the video keyframe at-or-before t (seconds). Returns null when the
 * probe is unavailable or unusable — caller falls back to the requested start.
 */
async function probeKeyframeAtOrBefore(
  ffmpeg: FFmpeg,
  t: number
): Promise<number | null> {
  // Runtime feature check: a stale self-hosted core/worker may predate ffprobe.
  if (typeof ffmpeg.ffprobe !== "function") return null;
  try {
    const code = await ffmpeg.ffprobe([
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "packet=pts_time,flags",
      "-of", "csv=p=0",
      "-read_intervals", `${Math.max(t, 0).toFixed(3)}%+#8`,
      "in.mp4",
      "-o", "probe.txt",
    ]);
    if (code !== 0) return null;
    const raw = (await ffmpeg.readFile("probe.txt", "utf8")) as string;
    await ffmpeg.deleteFile("probe.txt");
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    // The seek lands on a keyframe, so a K-flagged packet comes first; scan
    // anyway in case the demuxer emits non-key packets ahead of it.
    const kf = lines.find((l) => l.split(",")[1]?.startsWith("K")) ?? lines[0];
    const pts = Number.parseFloat(kf?.split(",")[0] ?? "");
    return Number.isFinite(pts) ? pts : null;
  } catch {
    return null;
  }
}

/** Cut one keyframe-aligned segment of in.mp4 to outName; returns actualStart. */
async function cutSegment(
  ffmpeg: FFmpeg,
  file: File,
  startS: number,
  endS: number,
  outName: string
): Promise<number> {
  const probed = await probeKeyframeAtOrBefore(ffmpeg, startS);
  const actualStart =
    probed !== null && probed >= 0 && probed < endS - 0.05 ? probed : startS;
  // Cut [actualStart, endS] so nothing is truncated from the tail. The .srt is
  // generated relative to actualStart — video and captions agree exactly.
  const duration = Math.max(endS - actualStart, 0.1);

  const args = [
    // +5ms seek bias so timebase rounding can't land on the previous keyframe
    "-ss", (actualStart + 0.005).toFixed(3),
    "-i", "in.mp4",
    "-t", duration.toFixed(3),
    "-c", "copy", "-avoid_negative_ts", "make_zero",
    "-y", outName,
  ];

  const code = await ffmpeg.exec(args);
  if (code !== 0) {
    await ffmpeg.writeFile("in.mp4", await fetchFile(file));
    const retry = await ffmpeg.exec(args);
    if (retry !== 0) throw new Error("Clip cut failed");
  }
  return actualStart;
}

async function doCutClipSegments(
  file: File,
  segments: { start: number; end: number }[]
): Promise<SegmentCutResult> {
  if (segments.length === 0) throw new Error("No segments to cut");

  const ffmpeg = await loadFFmpeg();

  const hasInput = (await ffmpeg.listDir("/")).some((e) => e.name === "in.mp4");
  if (!hasInput) {
    await ffmpeg.writeFile("in.mp4", await fetchFile(file));
  }

  const segNames = segments.map((_, i) => `seg_${i}.mp4`);
  const toClean = [...segNames];

  try {
    const actualStarts: number[] = [];
    for (let i = 0; i < segments.length; i++) {
      actualStarts.push(
        await cutSegment(ffmpeg, file, segments[i].start, segments[i].end, segNames[i])
      );
    }

    let outName = segNames[0];
    if (segments.length > 1) {
      await ffmpeg.writeFile(
        "list.txt",
        segNames.map((n) => `file '${n}'`).join("\n") + "\n"
      );
      toClean.push("list.txt", "cut.mp4");
      const code = await ffmpeg.exec([
        "-f", "concat", "-safe", "0",
        "-i", "list.txt",
        "-c", "copy", "-avoid_negative_ts", "make_zero",
        "-y", "cut.mp4",
      ]);
      if (code !== 0) throw new Error("Segment concat failed");
      outName = "cut.mp4";
    }

    const data = (await ffmpeg.readFile(outName)) as Uint8Array;
    return {
      blob: new Blob([data.slice().buffer as ArrayBuffer], { type: "video/mp4" }),
      actualStarts,
    };
  } finally {
    for (const name of toClean) {
      try {
        await ffmpeg.deleteFile(name);
      } catch {
        // never created (earlier failure) — nothing to clean
      }
    }
  }
}

export type { AudioChunk };
