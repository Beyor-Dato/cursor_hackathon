"use client";

import type { Clip, Word } from "./types";

const W = 1080;
const H = 1920;
const FPS = 30;
const ACCENT = "#FACC15";
const CAPTION_MAX_WIDTH = 940;
const CAPTION_BASE_SIZE = 76;
const CAPTION_MIN_SIZE = 48;
const TITLE_BASE_SIZE = 64;
const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

const captionFont = (size: number) => `700 ${size}px ${FONT_STACK}`;
const titleFont = (size: number) => `800 ${size}px ${FONT_STACK}`;

type CaptionGroup = { words: Word[]; start: number; end: number };
/** Lines of indices into the group's words, plus the font size they fit at. */
type CaptionLayout = { size: number; lines: number[][] };
type TitleLayout = { size: number; lines: string[]; lineWidths: number[] };

function pickMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return null;
}

function once(video: HTMLVideoElement, event: string, errMsg: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(errMsg));
    };
    const cleanup = () => {
      video.removeEventListener(event, onEvent);
      video.removeEventListener("error", onError);
    };
    video.addEventListener(event, onEvent, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

/** Source rect for a centered 9:16 cover crop of the video frame. */
function coverRect(vw: number, vh: number): { x: number; y: number; w: number; h: number } {
  const target = W / H;
  if (vw / vh > target) {
    const w = vh * target;
    return { x: (vw - w) / 2, y: 0, w, h: vh };
  }
  const h = vw / target;
  return { x: 0, y: (vh - h) / 2, w: vw, h };
}

function buildGroups(words: Word[]): CaptionGroup[] {
  const clean = words.filter((w) => w.w.trim().length > 0);
  const groups: CaptionGroup[] = [];
  for (let i = 0; i < clean.length; i += 3) {
    const slice = clean.slice(i, i + 3);
    groups.push({ words: slice, start: slice[0].s, end: slice[slice.length - 1].e });
  }
  return groups;
}

function layoutCaption(ctx: CanvasRenderingContext2D, group: CaptionGroup): CaptionLayout {
  const texts = group.words.map((w) => w.w.trim());
  const idx = texts.map((_, i) => i);

  const lineWidth = (indices: number[], size: number): number => {
    ctx.font = captionFont(size);
    const space = ctx.measureText(" ").width;
    let w = 0;
    indices.forEach((i, k) => {
      w += ctx.measureText(texts[i]).width;
      if (k > 0) w += space;
    });
    return w;
  };

  const oneLine = lineWidth(idx, CAPTION_BASE_SIZE);
  if (oneLine <= CAPTION_MAX_WIDTH) return { size: CAPTION_BASE_SIZE, lines: [idx] };

  // Too wide: mild scale-down stays on one line, otherwise wrap to two lines.
  const scaled = Math.floor((CAPTION_BASE_SIZE * CAPTION_MAX_WIDTH) / oneLine);
  if (scaled >= 56 || idx.length === 1) {
    return { size: Math.max(scaled, CAPTION_MIN_SIZE), lines: [idx] };
  }

  let best: number[][] = [idx];
  let bestMax = Infinity;
  for (let split = 1; split < idx.length; split++) {
    const a = idx.slice(0, split);
    const b = idx.slice(split);
    const max = Math.max(lineWidth(a, CAPTION_BASE_SIZE), lineWidth(b, CAPTION_BASE_SIZE));
    if (max < bestMax) {
      bestMax = max;
      best = [a, b];
    }
  }
  const size =
    bestMax > CAPTION_MAX_WIDTH
      ? Math.max(CAPTION_MIN_SIZE, Math.floor((CAPTION_BASE_SIZE * CAPTION_MAX_WIDTH) / bestMax))
      : CAPTION_BASE_SIZE;
  return { size, lines: best };
}

function drawCaption(
  ctx: CanvasRenderingContext2D,
  group: CaptionGroup,
  layout: CaptionLayout,
  t: number
): void {
  ctx.font = captionFont(layout.size);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const space = ctx.measureText(" ").width;
  const lineHeight = Math.round(layout.size * 1.2);
  const blockH = lineHeight * layout.lines.length;
  let baseline = Math.round(H * 0.72 - blockH / 2 + lineHeight * 0.8);

  for (const line of layout.lines) {
    const texts = line.map((i) => group.words[i].w.trim());
    const widths = texts.map((text) => ctx.measureText(text).width);
    const total = widths.reduce((a, b) => a + b, 0) + space * (line.length - 1);
    const startX = Math.round((W - total) / 2);

    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineWidth = 8;
    ctx.strokeStyle = "#000";
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 4;
    let x = startX;
    texts.forEach((text, k) => {
      ctx.strokeText(text, x, baseline);
      x = Math.round(x + widths[k] + space);
    });
    ctx.restore();

    x = startX;
    line.forEach((i, k) => {
      const word = group.words[i];
      ctx.fillStyle = t >= word.s && t <= word.e ? ACCENT : "#fff";
      ctx.fillText(texts[k], x, baseline);
      x = Math.round(x + widths[k] + space);
    });

    baseline += lineHeight;
  }
}

function layoutTitle(ctx: CanvasRenderingContext2D, title: string): TitleLayout | null {
  const text = title.trim().toUpperCase();
  if (!text) return null;
  const words = text.split(/\s+/);
  let size = TITLE_BASE_SIZE;

  const wrap = (): string[] => {
    ctx.font = titleFont(size);
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      const candidate = cur ? `${cur} ${w}` : w;
      if (!cur || ctx.measureText(candidate).width <= CAPTION_MAX_WIDTH) cur = candidate;
      else {
        lines.push(cur);
        cur = w;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  };

  let lines = wrap();
  while (
    size > 40 &&
    (lines.length > 2 || lines.some((l) => ctx.measureText(l).width > CAPTION_MAX_WIDTH))
  ) {
    size -= 4;
    lines = wrap();
  }
  if (lines.length > 2) {
    lines = lines.slice(0, 2);
    lines[1] += "…";
  }
  ctx.font = titleFont(size);
  return { size, lines, lineWidths: lines.map((l) => ctx.measureText(l).width) };
}

function drawTitle(ctx: CanvasRenderingContext2D, tl: TitleLayout): void {
  ctx.font = titleFont(tl.size);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  const lineHeight = Math.round(tl.size * 1.25);
  const top = Math.round(H * 0.12);
  const blockW = Math.max(...tl.lineWidths);
  const padX = 32;
  const padY = 24;

  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(
    Math.round((W - blockW) / 2 - padX),
    top - padY,
    Math.round(blockW + padX * 2),
    tl.lines.length * lineHeight + padY * 2
  );

  ctx.fillStyle = "#fff";
  tl.lines.forEach((line, i) => {
    ctx.fillText(line, Math.round((W - tl.lineWidths[i]) / 2), top + i * lineHeight);
  });
}

/**
 * Renders a 1080×1920 vertical clip with burned-in karaoke captions, hook
 * title (first 3s), and progress bar. Records canvas frames plus the video's
 * audio (rerouted through WebAudio, never to speakers) via MediaRecorder and
 * resolves with the resulting WebM blob.
 *
 * Word timestamps are in source-video seconds and compared against
 * video.currentTime directly. No logos or watermarks — campaign rule.
 */
export async function exportVertical(
  videoUrl: string,
  clip: Clip,
  words: Word[],
  opts: { start: number; end: number; onProgress?: (frac: number) => void }
): Promise<Blob> {
  if (typeof window === "undefined") {
    throw new Error("exportVertical must run in the browser");
  }
  const mimeType = pickMimeType();
  if (!mimeType) {
    throw new Error("Use Chrome for captioned export — MP4 export works everywhere");
  }

  const { start, end } = opts;
  const duration = Math.max(end - start, 0.01);

  // Fresh element per call: createMediaElementSource can only ever attach once
  // to a given media element.
  const video = document.createElement("video");
  video.src = videoUrl;
  video.muted = false;
  video.playsInline = true;
  video.preload = "auto";

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  let audioCtx: AudioContext | null = null;
  let recorder: MediaRecorder | null = null;
  let raf = 0;
  const tracks: MediaStreamTrack[] = [];

  try {
    await once(video, "loadedmetadata", "Could not load video for export");
    video.currentTime = start;
    await once(video, "seeked", "Could not seek video for export");

    const src = coverRect(video.videoWidth, video.videoHeight);
    const groups = buildGroups(words);
    const layouts = new Map<number, CaptionLayout>();
    const title = layoutTitle(ctx, clip.hook_title);

    // Route element audio into the recording graph only — no speaker bleed.
    const ac = new AudioContext();
    audioCtx = ac;
    const sourceNode = ac.createMediaElementSource(video);
    const dest = ac.createMediaStreamDestination();
    sourceNode.connect(dest);
    await ac.resume();

    const canvasStream = canvas.captureStream(FPS);
    const stream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...dest.stream.getAudioTracks(),
    ]);
    tracks.push(...stream.getTracks());

    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
    recorder = rec;
    const chunks: Blob[] = [];
    rec.ondataavailable = (e: BlobEvent) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    const stopped = new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
    });

    let groupIdx = 0;
    const drawFrame = () => {
      const t = video.currentTime;
      ctx.drawImage(video, src.x, src.y, src.w, src.h, 0, 0, W, H);

      if (groups.length > 0) {
        while (groupIdx + 1 < groups.length && t >= groups[groupIdx + 1].start) groupIdx++;
        const group = groups[groupIdx];
        if (t >= group.start && t <= group.end + 0.6) {
          let layout = layouts.get(groupIdx);
          if (!layout) {
            layout = layoutCaption(ctx, group);
            layouts.set(groupIdx, layout);
          }
          drawCaption(ctx, group, layout, t);
        }
      }

      if (title && t - start < 3) drawTitle(ctx, title);

      const frac = Math.min(Math.max((t - start) / duration, 0), 1);
      ctx.fillStyle = ACCENT;
      ctx.fillRect(0, H - 8, Math.round(W * frac), 8);
    };

    drawFrame(); // prime the canvas so the capture track has a first frame
    rec.start(250);
    await video.play();

    await new Promise<void>((resolve, reject) => {
      video.onerror = () => reject(new Error("Video playback failed during export"));
      const tick = () => {
        if (video.currentTime >= end || video.ended) {
          resolve();
          return;
        }
        drawFrame();
        opts.onProgress?.(Math.min(Math.max((video.currentTime - start) / duration, 0), 1));
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    });

    video.pause();
    opts.onProgress?.(1);
    rec.requestData();
    rec.stop();
    await stopped;

    return new Blob(chunks, { type: rec.mimeType || mimeType });
  } finally {
    cancelAnimationFrame(raf);
    video.onerror = null;
    video.pause();
    video.removeAttribute("src");
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // already stopping
      }
    }
    for (const track of tracks) track.stop();
    if (audioCtx && audioCtx.state !== "closed") {
      await audioCtx.close().catch(() => undefined);
    }
  }
}
