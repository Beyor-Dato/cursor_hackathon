import type { Clip, StoredClip, Storyline } from "./types";
import { STORYLINES } from "./types";

const KEY = "hookshot.clips";

export function loadAll(): StoredClip[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredClip[]) : [];
  } catch {
    return [];
  }
}

/** Append this session's clips to the library, deduped by videoName + start_s. */
export function saveSession(videoName: string, clips: Clip[]): void {
  if (typeof window === "undefined") return;
  const existing = loadAll();
  const seen = new Set(existing.map((c) => `${c.videoName}::${c.start_s}`));
  const now = Date.now();
  const fresh: StoredClip[] = clips
    .filter((c) => !seen.has(`${videoName}::${c.start_s}`))
    .map((c) => ({ ...c, videoName, savedAt: now }));
  if (fresh.length === 0) return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify([...existing, ...fresh]));
  } catch {
    // storage full or blocked — the library is a nice-to-have, never fatal
  }
}

/** Clip counts per storyline across every stored session. */
export function coverage(): Record<Storyline, number> {
  const counts = Object.fromEntries(
    (Object.keys(STORYLINES) as Storyline[]).map((k) => [k, 0])
  ) as Record<Storyline, number>;
  for (const c of loadAll()) {
    if (c.storyline in counts) counts[c.storyline] += 1;
  }
  return counts;
}

export function clearAll(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY);
}
