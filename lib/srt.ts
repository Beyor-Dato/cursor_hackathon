import type { Word } from "./types";

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

/** Karaoke-style cues: ~3 words each, timed relative to the clip start. */
export function wordsToSrt(words: Word[], clipStart: number): string {
  const cues: string[] = [];
  const GROUP = 3;
  for (let i = 0; i < words.length; i += GROUP) {
    const group = words.slice(i, i + GROUP);
    const start = group[0].s - clipStart;
    const end = group[group.length - 1].e - clipStart;
    cues.push(
      `${cues.length + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${group
        .map((w) => w.w.trim())
        .join(" ")}\n`
    );
  }
  return cues.join("\n");
}
