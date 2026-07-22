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

/**
 * Prefix-sum chunk offsets from Whisper-reported durations. Real ffmpeg
 * segments run slightly longer than the nominal segment length (keyframe
 * alignment), so `idx * segmentSeconds` drifts on long videos. Falls back
 * to the caller's nominal offsets for any chunk whose duration is missing.
 */
function chunkOffsets(chunks: ChunkTranscript[], fallback: number[]): number[] {
  const out = new Array<number>(chunks.length);
  let acc = 0;
  chunks.forEach((chunk, i) => {
    out[i] = acc;
    const d = chunk.duration ?? 0;
    const nominal = Math.max((fallback[i + 1] ?? 0) - (fallback[i] ?? 0), 0);
    acc += d > 0 ? d : nominal;
  });
  return out;
}

/** Merge chunk transcripts with per-chunk time offsets (deterministic). */
export function mergeChunkTranscripts(
  chunks: ChunkTranscript[],
  nominalOffsets: number[]
): MergedTranscript {
  const offsets = chunkOffsets(chunks, nominalOffsets);
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

  let start = findSentenceStart(words, startS);
  let end = findSentenceEnd(words, endS);
  if (duration != null) {
    // Clamp start first so the 3s minimum length can't push end past duration.
    start = Math.min(start, Math.max(0, duration - 3));
    end = Math.min(Math.max(end, start + 3), duration);
  } else {
    end = Math.max(end, start + 3);
  }

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
