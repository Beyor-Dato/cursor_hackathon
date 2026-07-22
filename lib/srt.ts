import type { TranscriptWord, Word } from "./types";

function srtTime(t: number): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const rem = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(
    s
  ).padStart(2, "0")},${String(rem).padStart(3, "0")}`;
}

function normalizeWord(w: TranscriptWord | Word): TranscriptWord {
  return "word" in w ? w : { word: w.w, start: w.s, end: w.e };
}

/**
 * Generate karaoke-friendly SRT for a clip window.
 * Cues are ~3 words each, timed relative to clip start (0-based).
 */
export function generateSrt(
  words: (TranscriptWord | Word)[],
  startS: number,
  endS: number
): string {
  const inRange = words
    .map(normalizeWord)
    .filter((w) => w.end > startS && w.start < endS);

  const cues: string[] = [];
  const GROUP = 3;

  for (let i = 0; i < inRange.length; i += GROUP) {
    const group = inRange.slice(i, i + GROUP);
    const relStart = Math.max(0, group[0].start - startS);
    // A word straddling endS keeps its full end — clamp so the last cue
    // never outlives the clip. endS may be Infinity (wordsToSrt path).
    const relEnd = Math.max(
      relStart + 0.05,
      Math.min(group[group.length - 1].end - startS, endS - startS)
    );
    cues.push(
      `${cues.length + 1}\n${srtTime(relStart)} --> ${srtTime(relEnd)}\n${group
        .map((w) => w.word.trim())
        .join(" ")}\n`
    );
  }

  return cues.join("\n");
}

/**
 * SRT for a jump-cut clip stitched from segments. Cue times live on the
 * concatenated ("virtual") timeline: segment i's video starts at its keyframe
 * `actualStart` (≤ start) and occupies offset_i = Σ_{j<i} (end_j − actualStart_j)
 * onward in the output, so a word at source time t in segment i appears at
 * (t − actualStart_i) + offset_i. Cues never straddle two segments.
 */
export function generateSegmentedSrt(
  words: (TranscriptWord | Word)[],
  segs: { start: number; end: number; actualStart: number }[]
): string {
  const normalized = words.map(normalizeWord);
  const cues: string[] = [];
  const GROUP = 3;
  const claimed = new Set<number>(); // first matching segment wins each word

  let offset = 0;
  for (const seg of segs) {
    const segLen = seg.end - seg.actualStart;

    const inSeg: TranscriptWord[] = [];
    for (let wi = 0; wi < normalized.length; wi++) {
      if (claimed.has(wi)) continue;
      const w = normalized[wi];
      if (w.end > seg.start && w.start < seg.end) {
        claimed.add(wi);
        inSeg.push(w);
      }
    }

    for (let i = 0; i < inSeg.length; i += GROUP) {
      const group = inSeg.slice(i, i + GROUP);
      // Floor at the segment's slot start, cap at its slot end — a word that
      // straddles a segment edge must not bleed into the neighboring segment.
      const relStart = Math.max(
        offset,
        group[0].start - seg.actualStart + offset
      );
      const relEnd = Math.max(
        relStart + 0.05,
        Math.min(group[group.length - 1].end - seg.actualStart + offset, offset + segLen)
      );
      cues.push(
        `${cues.length + 1}\n${srtTime(relStart)} --> ${srtTime(relEnd)}\n${group
          .map((w) => w.word.trim())
          .join(" ")}\n`
      );
    }

    offset += segLen;
  }

  return cues.join("\n");
}

/** @deprecated Use generateSrt */
export function wordsToSrt(words: Word[], clipStart: number): string {
  return generateSrt(words, clipStart, Infinity);
}
