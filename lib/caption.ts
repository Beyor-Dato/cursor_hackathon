const HASHTAG = "#UFCClips";

/** Belt-and-suspenders: every caption must end with #UFCClips. */
export function ensureUFCClipsHashtag(caption: string): string {
  const trimmed = caption.trim();
  if (/#UFCClips\s*$/i.test(trimmed)) return trimmed;
  return `${trimmed} ${HASHTAG}`;
}
