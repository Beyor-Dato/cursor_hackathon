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
    const relEnd = Math.max(relStart + 0.05, group[group.length - 1].end - startS);
    cues.push(
      `${cues.length + 1}\n${srtTime(relStart)} --> ${srtTime(relEnd)}\n${group
        .map((w) => w.word.trim())
        .join(" ")}\n`
    );
  }

  return cues.join("\n");
}

/** @deprecated Use generateSrt */
export function wordsToSrt(words: Word[], clipStart: number): string {
  return generateSrt(words, clipStart, Infinity);
}
