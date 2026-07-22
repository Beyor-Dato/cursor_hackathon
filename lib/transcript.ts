import type { Seg, Transcript, Word } from "./types";

export type ChunkResult = {
  words: { word: string; start: number; end: number }[];
  segments: { s: number; e: number; text: string }[];
  duration: number;
};

export function mergeChunks(results: ChunkResult[], offsets: number[]): Transcript {
  const words: Word[] = [];
  const segs: Seg[] = [];
  let duration = 0;

  results.forEach((r, i) => {
    const off = offsets[i];
    for (const w of r.words ?? []) {
      words.push({ w: w.word, s: w.start + off, e: w.end + off });
    }
    for (const s of r.segments ?? []) {
      segs.push({ s: s.s + off, e: s.e + off, text: s.text.trim() });
    }
    duration = Math.max(duration, off + (r.duration ?? 0));
  });

  words.sort((a, b) => a.s - b.s);
  segs.sort((a, b) => a.s - b.s);
  return { words, segs, duration };
}

export function fmtTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Compact "[m:ss-m:ss] text" timeline the LLM reasons over. */
export function timelineText(segs: Seg[]): string {
  return segs
    .map((s) => `[${fmtTime(s.s)}-${fmtTime(s.e)}] ${s.text}`)
    .join("\n");
}

/** Snap model-proposed bounds to real sentence boundaries so cuts never clip a word. */
export function snapClip(
  start: number,
  end: number,
  segs: Seg[],
  duration: number
): { start: number; end: number } {
  let s = start;
  let e = end;
  let bestS = Infinity;
  let bestE = Infinity;
  for (const seg of segs) {
    if (Math.abs(seg.s - start) < bestS) {
      bestS = Math.abs(seg.s - start);
      if (bestS <= 2.5) s = seg.s;
    }
    if (Math.abs(seg.e - end) < bestE) {
      bestE = Math.abs(seg.e - end);
      if (bestE <= 2.5) e = seg.e;
    }
  }
  s = Math.max(0, s - 0.15); // breathe before the first word
  e = Math.min(duration || e, e + 0.25);
  return { start: s, end: Math.max(e, s + 3) };
}

export function wordsInRange(words: Word[], s: number, e: number): Word[] {
  return words.filter((w) => w.e > s && w.s < e);
}
