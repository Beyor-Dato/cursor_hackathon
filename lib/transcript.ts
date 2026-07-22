import type {
  ChunkTranscript,
  MergedTranscript,
  Seg,
  TranscriptSegment,
  TranscriptWord,
  Word,
} from "./types";

export type ChunkResult = {
  words: TranscriptWord[];
  segments: TranscriptSegment[];
  duration: number;
};

function toCompactWords(words: TranscriptWord[]): Word[] {
  return words.map((w) => ({ w: w.word, s: w.start, e: w.end }));
}

function toCompactSegs(segments: TranscriptSegment[]): Seg[] {
  return segments.map((s) => ({ s: s.start, e: s.end, text: s.text.trim() }));
}

/** Merge chunk transcripts with per-chunk time offsets (deterministic). */
export function mergeChunkTranscripts(
  chunks: ChunkTranscript[],
  offsets: number[]
): MergedTranscript {
  const words: TranscriptWord[] = [];
  const segments: TranscriptSegment[] = [];
  let duration = 0;

  chunks.forEach((chunk, i) => {
    const off = offsets[i] ?? 0;
    for (const w of chunk.words ?? []) {
      words.push({
        word: w.word,
        start: w.start + off,
        end: w.end + off,
      });
    }
    for (const s of chunk.segments ?? []) {
      segments.push({
        start: s.start + off,
        end: s.end + off,
        text: s.text.trim(),
      });
    }
    duration = Math.max(duration, off + (chunk.duration ?? 0));
  });

  const merged = { words: ensureMonotonic(words), segments, duration };
  merged.segments.sort((a, b) => a.start - b.start);
  return merged;
}

/** @deprecated Use mergeChunkTranscripts */
export function mergeChunks(results: ChunkResult[], offsets: number[]): {
  words: Word[];
  segs: Seg[];
  duration: number;
} {
  const merged = mergeChunkTranscripts(results, offsets);
  return {
    words: toCompactWords(merged.words),
    segs: toCompactSegs(merged.segments),
    duration: merged.duration,
  };
}

/** Fix overlapping or non-monotonic word timestamps after merge. */
export function ensureMonotonic(words: TranscriptWord[]): TranscriptWord[] {
  if (words.length === 0) return words;

  const sorted = [...words].sort((a, b) => a.start - b.start);
  const out: TranscriptWord[] = [];

  for (const w of sorted) {
    const prev = out[out.length - 1];
    let start = w.start;
    let end = w.end;

    if (prev) {
      if (start < prev.end) start = prev.end;
      if (end <= start) end = start + 0.05;
    }
    if (end <= start) end = start + 0.05;

    out.push({ word: w.word, start, end });
  }

  return out;
}

const SENTENCE_END = /[.!?]["']?$/;
const GAP_S = 0.75;

function isSentenceEnd(word: TranscriptWord, next?: TranscriptWord): boolean {
  if (SENTENCE_END.test(word.word.trim())) return true;
  if (next && next.start - word.end >= GAP_S) return true;
  return false;
}

function findSentenceStart(words: TranscriptWord[], targetS: number): number {
  let idx = words.findIndex((w) => w.end > targetS);
  if (idx < 0) idx = words.length - 1;
  if (idx < 0) return targetS;

  while (idx > 0) {
    const prev = words[idx - 1];
    if (isSentenceEnd(prev, words[idx])) break;
    idx--;
  }
  return Math.max(0, words[idx].start - 0.12);
}

function findSentenceEnd(words: TranscriptWord[], targetE: number): number {
  let idx = words.findIndex((w) => w.end >= targetE);
  if (idx < 0) return targetE;

  while (idx < words.length - 1) {
    if (isSentenceEnd(words[idx], words[idx + 1])) {
      return words[idx].end + 0.2;
    }
    idx++;
  }
  return words[words.length - 1].end + 0.2;
}

/** Snap clip bounds to sentence boundaries using word timestamps. */
export function snapToSentences(
  startS: number,
  endS: number,
  words: TranscriptWord[],
  duration?: number
): { start_s: number; end_s: number } {
  if (words.length === 0) {
    return { start_s: startS, end_s: Math.max(endS, startS + 3) };
  }

  const start = findSentenceStart(words, startS);
  let end = findSentenceEnd(words, endS);
  if (duration != null) end = Math.min(end, duration);
  end = Math.max(end, start + 3);

  return { start_s: start, end_s: end };
}

export function fmtTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Compact "[m:ss-m:ss] text" timeline the LLM reasons over. */
export function timelineText(segments: TranscriptSegment[] | Seg[]): string {
  return segments
    .map((s) => {
      const start = "start" in s ? s.start : s.s;
      const end = "end" in s ? s.end : s.e;
      const text = s.text;
      return `[${fmtTime(start)}-${fmtTime(end)}] ${text}`;
    })
    .join("\n");
}

/** @deprecated Use snapToSentences */
export function snapClip(
  start: number,
  end: number,
  segs: Seg[],
  duration: number
): { start: number; end: number } {
  const snapped = snapToSentences(
    start,
    end,
    segs.flatMap((seg) => {
      const parts = seg.text.split(/\s+/).filter(Boolean);
      const span = Math.max(seg.e - seg.s, 0.1);
      const step = span / Math.max(parts.length, 1);
      return parts.map((word, i) => ({
        word,
        start: seg.s + i * step,
        end: seg.s + (i + 1) * step,
      }));
    }),
    duration
  );
  return { start: snapped.start_s, end: snapped.end_s };
}

export function wordsInRange(
  words: TranscriptWord[] | Word[],
  s: number,
  e: number
): TranscriptWord[] {
  return words
    .map((w) =>
      "word" in w
        ? w
        : { word: w.w, start: w.s, end: w.e }
    )
    .filter((w) => w.end > s && w.start < e);
}
