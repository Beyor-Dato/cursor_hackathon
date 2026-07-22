const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

/** Prepend https:// when the scheme is missing, so client and server parse the same URL. */
export function normalizeYoutubeUrl(input: string): string {
  const trimmed = input.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** True if the input looks like a YouTube watch/shorts/live/youtu.be link. */
export function isYoutubeUrl(input: string): boolean {
  if (!input.trim()) return false;

  let parsed: URL;
  try {
    parsed = new URL(normalizeYoutubeUrl(input));
  } catch {
    return false;
  }

  if (!YOUTUBE_HOSTS.has(parsed.hostname)) return false;

  if (parsed.hostname === "youtu.be") {
    return parsed.pathname.length > 1;
  }
  return (
    parsed.pathname === "/watch" ||
    parsed.pathname.startsWith("/shorts/") ||
    parsed.pathname.startsWith("/live/") ||
    parsed.pathname.startsWith("/embed/")
  );
}

/** True for yt-dlp search refs like "ytsearch1:UFC 329 Countdown". */
export function isYtSearchRef(input: string): boolean {
  return /^ytsearch\d*:.*\S/i.test(input.trim());
}

/** Anything the in-app puller accepts: a YouTube link or a ytsearch ref. */
export function isPullableRef(input: string): boolean {
  return isYtSearchRef(input) || isYoutubeUrl(input);
}

function sanitizeFilename(name: string): string {
  const clean = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return clean || "youtube-video";
}

/** Download a YouTube video through /api/youtube and hand it back as a File. */
export async function fetchYoutubeVideo(
  url: string,
  onProgress?: (loaded: number, total: number | null) => void
): Promise<File> {
  const res = await fetch("/api/youtube", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: isYtSearchRef(url) ? url.trim() : normalizeYoutubeUrl(url),
    }),
  });

  if (!res.ok) {
    let message = `YouTube download failed (${res.status})`;
    try {
      const body = await res.json();
      if (typeof body?.error === "string" && body.error) message = body.error;
    } catch {
      // non-JSON error body, keep the default message
    }
    throw new Error(message);
  }

  if (!res.body) {
    throw new Error("YouTube download failed: empty response body");
  }

  const lengthHeader = res.headers.get("Content-Length");
  const total = lengthHeader ? Number(lengthHeader) || null : null;

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      onProgress?.(loaded, total);
    }
  }

  let title = "youtube-video";
  const titleHeader = res.headers.get("X-Video-Title");
  if (titleHeader) {
    try {
      title = decodeURIComponent(titleHeader) || title;
    } catch {
      // malformed header, keep fallback
    }
  }

  return new File(chunks as BlobPart[], `${sanitizeFilename(title)}.mp4`, {
    type: "video/mp4",
  });
}
