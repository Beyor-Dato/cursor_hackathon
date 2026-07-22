import { NextRequest, NextResponse } from "next/server";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rateLimit";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { unlink as unlinkCb } from "node:fs";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const runtime = "nodejs";
export const maxDuration = 300;

const ALLOWED_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

// The browser buffers the whole download in memory and ffmpeg.wasm tops out
// around 2GB, so cap well below that.
const MAX_BYTES = 500 * 1024 * 1024; // 500MB
const YTDLP_TIMEOUT_MS = 240_000;

function isAllowedYoutubeUrl(raw: string): boolean {
  try {
    return ALLOWED_HOSTS.has(new URL(raw).hostname);
  } catch {
    return false;
  }
}

/** Accept yt-dlp search refs ("ytsearch1:query") — forced to one result, sanitized. */
function normalizeSearchRef(raw: string): string | null {
  const m = raw
    .replace(/[\u0000-\u001f]/g, " ")
    .trim()
    .match(/^ytsearch\d*:(.+)$/i);
  if (!m) return null;
  const query = m[1].trim().slice(0, 160);
  return query ? `ytsearch1:${query}` : null;
}

function ytDlpAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("yt-dlp", ["--version"]);
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

let availabilityCache: Promise<boolean> | null = null;

function ytDlpAvailableCached(): Promise<boolean> {
  if (!availabilityCache) availabilityCache = ytDlpAvailable();
  return availabilityCache;
}

/** Map raw yt-dlp stderr to a clean human message — never expose server paths. */
function ytDlpErrorMessage(stderr: string): string {
  if (/Video unavailable/i.test(stderr)) return "This video is unavailable.";
  if (/Private video/i.test(stderr)) return "This video is private.";
  if (/age[- ]restricted|confirm your age/i.test(stderr))
    return "This video is age-restricted and can't be downloaded.";
  if (/Sign in to confirm/i.test(stderr))
    return "YouTube is asking for sign-in verification. Try again later or use scripts/fetch.sh.";
  return "YouTube download failed. Try another video or scripts/fetch.sh.";
}

function runYtDlp(
  args: string[]
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", args);
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, YTDLP_TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

async function findOutputFile(dir: string, jobId: string): Promise<string | null> {
  const expected = path.join(dir, `${jobId}.mp4`);
  try {
    await stat(expected);
    return expected;
  } catch {
    // fall through to readdir
  }
  try {
    const entries = await readdir(dir);
    const match = entries.find((f) => f.startsWith(`${jobId}.`));
    return match ? path.join(dir, match) : null;
  } catch {
    return null;
  }
}

export async function GET() {
  return NextResponse.json({ available: await ytDlpAvailableCached() });
}

export async function POST(req: NextRequest) {
  // Downloads are heavy — 6 pulls per 5 minutes per client is plenty.
  const rl = rateLimit(`youtube:${clientIp(req)}`, 6, 300_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfterS);

  let url: unknown;
  try {
    ({ url } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const ref =
    typeof url === "string"
      ? (normalizeSearchRef(url) ?? (isAllowedYoutubeUrl(url) ? url : null))
      : null;
  if (!ref) {
    return NextResponse.json(
      { error: "Not a valid YouTube URL (youtube.com / youtu.be only)." },
      { status: 400 }
    );
  }

  if (!(await ytDlpAvailable())) {
    return NextResponse.json(
      {
        error:
          "yt-dlp is not installed on this machine. Run: brew install yt-dlp — or use scripts/fetch.sh and drop the mp4.",
      },
      { status: 501 }
    );
  }

  const dir = os.tmpdir();
  const jobId = crypto.randomUUID();

  let result: Awaited<ReturnType<typeof runYtDlp>>;
  try {
    result = await runYtDlp([
      "--no-playlist",
      "-f",
      "b[ext=mp4][height<=480]/bv*[height<=480][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
      "--merge-output-format",
      "mp4",
      "-o",
      `${dir}/${jobId}.%(ext)s`,
      "--no-simulate",
      "--print",
      "title",
      ref,
    ]);
  } catch {
    return NextResponse.json(
      {
        error:
          "yt-dlp is not installed on this machine. Run: brew install yt-dlp — or use scripts/fetch.sh and drop the mp4.",
      },
      { status: 501 }
    );
  }

  if (result.timedOut) {
    const stale = await findOutputFile(dir, jobId);
    if (stale) await unlink(stale).catch(() => {});
    return NextResponse.json(
      { error: "YouTube download timed out after 240s. Try a shorter video or scripts/fetch.sh." },
      { status: 504 }
    );
  }

  if (result.code !== 0) {
    const stale = await findOutputFile(dir, jobId);
    if (stale) await unlink(stale).catch(() => {});
    console.error(`[youtube] yt-dlp exit ${result.code}:`, result.stderr.trim().slice(-500));
    return NextResponse.json({ error: ytDlpErrorMessage(result.stderr) }, { status: 502 });
  }

  const filePath = await findOutputFile(dir, jobId);
  if (!filePath) {
    return NextResponse.json(
      { error: "yt-dlp finished but no output file was found." },
      { status: 502 }
    );
  }

  const { size } = await stat(filePath);
  if (size > MAX_BYTES) {
    await unlink(filePath).catch(() => {});
    return NextResponse.json(
      { error: "Video too large (over 500MB) — use scripts/fetch.sh with --download-sections." },
      { status: 413 }
    );
  }

  const title = result.stdout.trim().slice(0, 120) || "youtube-video";

  const nodeStream = createReadStream(filePath);
  nodeStream.on("close", () => unlinkCb(filePath, () => {}));

  return new Response(Readable.toWeb(nodeStream) as ReadableStream, {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(size),
      "X-Video-Title": encodeURIComponent(title),
    },
  });
}
