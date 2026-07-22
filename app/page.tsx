"use client";

import { useEffect, useRef, useState } from "react";
import ClipCard from "@/components/ClipCard";
import Footer from "@/components/Footer";
import HowItWorks from "@/components/HowItWorks";
import { saveSession } from "@/lib/clipStore";
import {
  mergeChunks,
  snapToSentences,
  timelineText,
  fmtTime,
  type ChunkResult,
} from "@/lib/transcript";
import {
  STORYLINES,
  type Clip,
  type Storyline,
  type Transcript,
} from "@/lib/types";
import { isPullableRef, fetchYoutubeVideo } from "@/lib/youtube";

type Stage =
  | { k: "idle" }
  | { k: "fetching"; note: string }
  | { k: "loading-ffmpeg" }
  | { k: "extracting"; note: string }
  | { k: "transcribing"; done: number; total: number }
  | { k: "analyzing" }
  | { k: "ready" }
  | { k: "error"; message: string };

type Span = { start: number; end: number };
type BoundClip = { clip: Clip; bounds: Span; segments: Span[] };

/** Merge spans that overlap or nearly touch after sentence snapping. */
function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of sorted) {
    const prev = out[out.length - 1];
    if (prev && s.start <= prev.end + 0.25) {
      prev.end = Math.max(prev.end, s.end);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

const PIPELINE = [
  { key: "fetching", label: "Source" },
  { key: "loading-ffmpeg", label: "Engine" },
  { key: "extracting", label: "Audio" },
  { key: "transcribing", label: "Transcript" },
  { key: "analyzing", label: "Moments" },
] as const;

const TRUST_CHIPS = [
  "Video stays in your browser",
  "Audience-aware captions",
  "#UFCClips + compliance on campaign clips",
] as const;

async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  async function worker(): Promise<void> {
    for (;;) {
      if (failed) return;
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i], i);
      } catch (err) {
        failed = true; // stop other workers from claiming new items
        throw err;
      }
    }
  }
  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: size }, worker));
  return out;
}

const RETRY_DELAYS_MS = [1_000, 3_000] as const;
const FETCH_TIMEOUT_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** fetch with a 120s timeout per attempt, retrying 429/5xx/network errors twice. */
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (
        (res.status === 429 || res.status >= 500) &&
        attempt < RETRY_DELAYS_MS.length
      ) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      return res;
    } catch (err) {
      // A deliberate abort is final; timeouts and network failures are retried.
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      if (attempt >= RETRY_DELAYS_MS.length) throw err;
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

// Same-file transcript cache: re-running a video skips extraction + Whisper.
const transcriptCache = new Map<string, Transcript>();

function transcriptCacheKey(f: File): string {
  return `${f.name}:${f.size}:${f.lastModified}`;
}

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

function stageCopy(stage: Stage): { headline: string; sub: string } {
  switch (stage.k) {
    case "fetching":
      return {
        headline: "Pulling the tape",
        sub: "Downloading the source straight into your browser — transcription and cutting still happen locally.",
      };
    case "loading-ffmpeg":
      return {
        headline: "Loading the engine",
        sub: "ffmpeg.wasm is warming up inside your browser — no uploads, no servers.",
      };
    case "extracting":
      return {
        headline: "Ripping the audio",
        sub: "Extracting audio — the video never leaves your browser. Only compressed sound goes out.",
      };
    case "transcribing":
      return {
        headline: "Transcribing the mic moments",
        sub: `Whisper is chewing through chunk ${Math.min(
          stage.done + 1,
          stage.total
        )} of ${stage.total} — word-level timestamps incoming.`,
      };
    case "analyzing":
      return {
        headline: "Hunting campaign moments",
        sub: "Scoring every moment for hook, emotion and quotability — tuned to your audience.",
      };
    default:
      return { headline: "", sub: "" };
  }
}

export default function Home() {
  const [stage, setStage] = useState<Stage>({ k: "idle" });
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [clips, setClips] = useState<BoundClip[]>([]);
  const [filter, setFilter] = useState<Storyline | "all">("all");
  const [dragging, setDragging] = useState(false);
  const [ytUrl, setYtUrl] = useState("");
  const [audience, setAudience] = useState("");
  const [ytAvailable, setYtAvailable] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  // Warm the 32MB ffmpeg core while the page idles. Errors are swallowed —
  // the real run() surfaces them. Never import lib/ffmpeg at module top level.
  useEffect(() => {
    const warm = () => {
      void import("@/lib/ffmpeg")
        .then((m) => void m.loadFFmpeg().catch(() => {}))
        .catch(() => {});
    };
    if ("requestIdleCallback" in window) {
      const id = window.requestIdleCallback(warm);
      return () => window.cancelIdleCallback(id);
    }
    const t = setTimeout(warm, 1500);
    return () => clearTimeout(t);
  }, []);

  // Hide the YouTube URL row when the server can't pull videos (no yt-dlp).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/youtube", { method: "GET" })
      .then((res) =>
        res.ok ? (res.json() as Promise<{ available?: boolean }>) : null
      )
      .then((body) => {
        if (!cancelled && body?.available !== true) setYtAvailable(false);
      })
      .catch(() => {
        if (!cancelled) setYtAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const processing =
    stage.k !== "idle" && stage.k !== "ready" && stage.k !== "error";

  function reset() {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    setVideoUrl(null);
    setFile(null);
    setTranscript(null);
    setClips([]);
    setFilter("all");
    setStage({ k: "idle" });
  }

  function acceptFile(f: File | null | undefined) {
    if (!f || processing) return;
    if (
      !f.type.startsWith("video/") &&
      !/\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name)
    ) {
      setStage({
        k: "error",
        message: `"${f.name}" doesn't look like a video. Drop an MP4, MOV or WEBM.`,
      });
      return;
    }
    void run(f);
  }

  async function runFromUrl(refArg?: string) {
    if (processing) return;
    const u = (refArg ?? ytUrl).trim();
    if (!isPullableRef(u)) {
      setStage({ k: "error", message: "That doesn't look like a YouTube link." });
      return;
    }
    try {
      setStage({ k: "fetching", note: "Contacting YouTube…" });
      const f = await fetchYoutubeVideo(u, (loaded, total) =>
        setStage({
          k: "fetching",
          note: total
            ? `${fmtBytes(loaded)} of ${fmtBytes(total)}`
            : `${fmtBytes(loaded)} downloaded`,
        })
      );
      const ok = await run(f);
      // Only clear on success so a failed run doesn't force a re-paste.
      if (ok) setYtUrl("");
    } catch (err) {
      setStage({
        k: "error",
        message:
          err instanceof Error ? err.message : "YouTube download failed.",
      });
    }
  }

  /** Moments fetch + clip snapping. Throws on failure so callers decide the recovery UI. */
  async function analyze(t: Transcript, videoName: string): Promise<void> {
    setStage({ k: "analyzing" });
    const res = await fetchWithRetry("/api/moments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timeline: timelineText(t.segs),
        duration: t.duration,
        videoName,
        audience: audience.trim() || undefined,
      }),
    });
    const body = (await res.json().catch(() => null)) as {
      clips?: Clip[];
      error?: string;
    } | null;
    if (!res.ok || !body?.clips) {
      throw new Error(body?.error ?? `Moment analysis failed (${res.status})`);
    }

    // Snap on real Whisper word timings, mapped once and reused for all clips.
    const words = t.words.map((w) => ({ word: w.w, start: w.s, end: w.e }));
    setClips(
      body.clips.map((clip) => {
        const spans = clip.segments?.length
          ? clip.segments
          : [{ start_s: clip.start_s, end_s: clip.end_s }];
        const segments = mergeSpans(
          spans.map((s) => {
            const b = snapToSentences(s.start_s, s.end_s, words, t.duration);
            return { start: b.start_s, end: b.end_s };
          })
        );
        const bounds = {
          start: segments[0].start,
          end: segments[segments.length - 1].end,
        };
        return { clip, bounds, segments };
      })
    );
    saveSession(videoName, body.clips);
    setStage({ k: "ready" });
  }

  /** Re-run only the moments stage — the transcript is already in state. */
  async function retryAnalysis() {
    if (processing || !transcript || !file) return;
    try {
      await analyze(transcript, file.name);
    } catch (err) {
      setStage({
        k: "error",
        message:
          err instanceof Error ? err.message : "Moment analysis failed.",
      });
    }
  }

  async function run(f: File): Promise<boolean> {
    setFile(f);
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    const url = URL.createObjectURL(f);
    urlRef.current = url;
    setVideoUrl(url);
    setClips([]);
    setFilter("all");
    setTranscript(null);

    try {
      const cached = transcriptCache.get(transcriptCacheKey(f));
      if (cached) {
        setTranscript(cached);
        await analyze(cached, f.name);
        return true;
      }

      setStage({ k: "loading-ffmpeg" });
      const { extractAudioChunks } = await import("@/lib/ffmpeg");
      const chunks = await extractAudioChunks(f, (msg) => {
        // The callback also relays ffmpeg core-load lines and raw exec logs;
        // keep the stage copy curated.
        if (/^(Loading ffmpeg|Loading wasm|Loading worker|ffmpeg ready)/.test(msg)) {
          setStage({ k: "loading-ffmpeg" });
        } else if (/^(Loading video|Extracting audio|Extracted chunk)/.test(msg)) {
          setStage({ k: "extracting", note: msg });
        }
      });

      setStage({ k: "transcribing", done: 0, total: chunks.length });
      const results = await mapPool(chunks, 3, async (chunk, i) => {
        const fd = new FormData();
        const ext = chunk.blob.type === "audio/wav" ? "wav" : "mp3";
        fd.append(
          "audio",
          new File([chunk.blob], `chunk-${i}.${ext}`, { type: chunk.blob.type })
        );
        const res = await fetchWithRetry("/api/transcribe", {
          method: "POST",
          body: fd,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(
            body?.error ?? `Transcription failed on chunk ${i + 1} (${res.status})`
          );
        }
        // The route returns {word,start,end} words and {start,end,text} segments,
        // matching ChunkResult directly.
        const json = (await res.json()) as ChunkResult;
        setStage((s) =>
          s.k === "transcribing" ? { ...s, done: s.done + 1 } : s
        );
        return json;
      });

      const t = mergeChunks(
        results,
        chunks.map((c) => c.offset)
      );
      setTranscript(t);
      transcriptCache.set(transcriptCacheKey(f), t);

      await analyze(t, f.name);
      return true;
    } catch (err) {
      setStage({
        k: "error",
        message:
          err instanceof Error ? err.message : "Something broke mid-pipeline.",
      });
      return false;
    }
  }

  const present = (Object.keys(STORYLINES) as Storyline[]).filter((k) =>
    clips.some((c) => c.clip.storyline === k)
  );
  const visible =
    filter === "all" ? clips : clips.filter((c) => c.clip.storyline === filter);
  const stepIndex = PIPELINE.findIndex((p) => p.key === stage.k);
  const copy = stageCopy(stage);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 border-b border-line bg-ink/85 backdrop-blur-md">
        <div
          aria-hidden
          className="h-0.5 bg-gradient-to-r from-blood via-blood-hot to-gold"
        />
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <span aria-hidden className="flex gap-1">
              <span className="h-6 w-2 -skew-x-12 bg-blood shadow-[0_0_16px_rgba(224,27,44,0.6)]" />
              <span className="h-6 w-1 -skew-x-12 bg-gold" />
            </span>
            <span className="font-display text-2xl leading-none tracking-wide">
              HOOK<span className="text-blood">SHOT</span>
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden items-center gap-2 border border-line px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-ash sm:flex">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-gold" />
              Clip anything · UFC 329 kit inside
            </span>
            {(stage.k === "ready" || stage.k === "error") && (
              <button
                onClick={reset}
                className="bg-blood px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-white transition-colors [clip-path:polygon(8px_0,100%_0,calc(100%_-_8px)_100%,0_100%)] hover:bg-blood-hot"
              >
                New video
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-24 sm:px-6">
        {stage.k === "idle" && (
          <section className="relative pt-14 sm:pt-20">
            <div
              aria-hidden
              className="ghost pointer-events-none absolute -top-10 right-0 hidden select-none font-display text-[15rem] leading-none tracking-tight lg:block xl:text-[20rem]"
            >
              329
            </div>

            <p className="reveal reveal-1 flex items-center gap-3 font-mono text-xs uppercase tracking-[0.35em] text-blood-hot">
              <span aria-hidden className="h-px w-10 bg-blood" />
              Official clipping campaign tool
            </p>
            <h1 className="reveal reveal-2 relative mt-4 font-display text-6xl uppercase leading-[0.9] sm:text-8xl">
              Find the moment.
              <br />
              <span className="text-blood drop-shadow-[0_0_28px_rgba(224,27,44,0.45)]">
                Ship the clip.
              </span>
            </h1>
            <p className="reveal reveal-3 relative mt-6 max-w-2xl text-lg leading-relaxed text-ash">
              Paste a YouTube link or drop any footage — podcasts, pressers,
              interviews, VODs. HookShot transcribes it, finds the viral
              moments for your audience and cuts caption-burned vertical
              shorts. UFC 329 campaign content gets storyline tags and
              compliance checks automatically.
            </p>

            {ytAvailable && (
              <>
                <div className="reveal reveal-4 mt-10 flex gap-2">
                  <input
                    value={ytUrl}
                    onChange={(e) => setYtUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void runFromUrl();
                    }}
                    disabled={processing}
                    placeholder="Paste a YouTube link — podcast, presser, interview, VOD…"
                    className="min-w-0 flex-1 border border-line bg-coal px-4 py-3 font-mono text-sm text-bone outline-none transition-colors placeholder:text-ash/60 focus:border-blood/70 disabled:opacity-50"
                  />
                  <button
                    onClick={() => void runFromUrl()}
                    disabled={processing}
                    className="shrink-0 bg-blood px-5 py-3 text-sm font-bold uppercase tracking-wider text-white transition-colors [clip-path:polygon(10px_0,100%_0,calc(100%_-_10px)_100%,0_100%)] hover:bg-blood-hot disabled:opacity-50"
                  >
                    Pull &amp; Clip
                  </button>
                </div>

                <div
                  aria-hidden
                  className="reveal reveal-4 mt-8 flex items-center gap-4 font-mono text-[11px] uppercase tracking-[0.2em] text-ash"
                >
                  <span className="h-px flex-1 bg-line" />
                  or drop a file
                  <span className="h-px flex-1 bg-line" />
                </div>
              </>
            )}

            <div className="reveal reveal-4 mt-3">
              <input
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
                disabled={processing}
                placeholder="Target audience (optional) — e.g. “MMA fans”, “indie founders”. Blank = read it from the video"
                aria-label="Target audience, optional"
                className="w-full border border-line bg-coal/60 px-4 py-2.5 font-mono text-xs text-bone outline-none transition-colors placeholder:text-ash/50 focus:border-gold/60 disabled:opacity-50"
              />
            </div>

            <div
              role="button"
              tabIndex={0}
              aria-label="Drop a video file or click to browse"
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  inputRef.current?.click();
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                acceptFile(e.dataTransfer.files?.[0]);
              }}
              className={`reveal reveal-5 group relative mt-8 cursor-pointer overflow-hidden border-2 bg-coal/60 px-6 py-14 text-center transition-[border-color,background-color,box-shadow,scale] duration-200 sm:py-20 ${
                dragging
                  ? "stripes-hot scale-[1.01] border-blood bg-blood/10 shadow-[0_0_60px_rgba(224,27,44,0.3)]"
                  : "stripes border-line hover:border-blood/70"
              }`}
            >
              <span
                aria-hidden
                className="pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-bone/5 to-transparent opacity-0 group-hover:animate-[sheen_1s_ease_both] group-hover:opacity-100"
              />
              <span aria-hidden className="absolute left-3 top-3 h-6 w-6 border-l-[3px] border-t-[3px] border-blood" />
              <span aria-hidden className="absolute right-3 top-3 h-6 w-6 border-r-[3px] border-t-[3px] border-blood" />
              <span aria-hidden className="absolute bottom-3 left-3 h-6 w-6 border-b-[3px] border-l-[3px] border-blood" />
              <span aria-hidden className="absolute bottom-3 right-3 h-6 w-6 border-b-[3px] border-r-[3px] border-blood" />
              <p className="font-mono text-[10px] uppercase tracking-[0.35em] text-ash">
                {dragging ? "Release" : "Step into the cage"}
              </p>
              <div
                className={`mt-3 font-display text-4xl uppercase tracking-wide transition-colors sm:text-5xl ${
                  dragging ? "text-blood-hot" : ""
                }`}
              >
                Drop the tape
              </div>
              <p className="mt-3 text-ash">
                or click to browse — MP4 · MOV · WEBM
              </p>
            </div>

            <div className="reveal reveal-6 mt-6 flex flex-wrap gap-2 font-mono text-[11px] uppercase tracking-wider text-ash">
              {TRUST_CHIPS.map((chip) => (
                <span
                  key={chip}
                  className="flex items-center gap-2 border border-line px-2.5 py-1"
                >
                  <span aria-hidden className="h-1 w-1 bg-gold" />
                  {chip}
                </span>
              ))}
            </div>

            <div className="reveal reveal-6">
              <HowItWorks />
            </div>
          </section>
        )}

        {processing && (
          <section className="mx-auto mt-16 max-w-2xl sm:mt-24">
            <div className="relative overflow-hidden border border-line bg-coal p-6 sm:p-8">
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-0 top-0 h-1/5 animate-[scan_3.4s_linear_infinite] bg-gradient-to-b from-transparent via-bone/[0.03] to-transparent"
              />

              <div className="flex items-center justify-between gap-4">
                <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.3em] text-blood-hot">
                  <span
                    aria-hidden
                    className="h-2 w-2 animate-[pulse-dot_1.2s_ease-in-out_infinite] rounded-full bg-blood-hot"
                  />
                  Rec · Production room
                </p>
                <div aria-hidden className="flex h-4 items-end gap-0.5">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <span
                      key={i}
                      className="h-full w-1 origin-bottom rounded-full animate-[eq_0.9s_ease-in-out_infinite] bg-blood-hot shadow-[0_0_6px_rgba(255,51,71,0.95),0_0_14px_rgba(224,27,44,0.7),0_0_28px_rgba(224,27,44,0.45)]"
                      style={{ animationDelay: `${i * 0.12}s` }}
                    />
                  ))}
                </div>
              </div>

              <ol className="mt-6 flex items-center">
                {PIPELINE.map((p, i) => {
                  const state =
                    i < stepIndex ? "done" : i === stepIndex ? "active" : "todo";
                  return (
                    <li
                      key={p.key}
                      className="flex flex-1 items-center last:flex-none"
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className={`grid h-6 w-6 shrink-0 place-items-center border font-mono text-[10px] ${
                            state === "done"
                              ? "border-blood bg-blood text-white"
                              : state === "active"
                                ? "animate-[pulse-dot_1.2s_ease-in-out_infinite] border-blood-hot text-blood-hot"
                                : "border-line text-ash/50"
                          }`}
                        >
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        <span
                          className={`font-mono text-[10px] uppercase tracking-[0.2em] ${
                            state === "active"
                              ? "inline text-bone"
                              : state === "done"
                                ? "hidden text-bone sm:inline"
                                : "hidden text-ash/50 sm:inline"
                          }`}
                        >
                          {p.label}
                        </span>
                      </span>
                      {i < PIPELINE.length - 1 && (
                        <span
                          aria-hidden
                          className={`mx-2 h-px flex-1 sm:mx-3 ${
                            i < stepIndex ? "bg-blood" : "bg-line"
                          }`}
                        />
                      )}
                    </li>
                  );
                })}
              </ol>

              <h2 className="mt-7 font-display text-4xl uppercase leading-tight sm:text-5xl">
                {copy.headline}
              </h2>
              <p className="mt-2 leading-relaxed text-ash">{copy.sub}</p>
              {(stage.k === "extracting" || stage.k === "fetching") && (
                <p className="mt-1 font-mono text-xs text-ash/70">{stage.note}</p>
              )}

              <div className="mt-6 h-1.5 overflow-hidden bg-steel">
                {stage.k === "transcribing" ? (
                  <div
                    className="h-full bg-blood shadow-[0_0_12px_rgba(224,27,44,0.7)] transition-[width] duration-500"
                    style={{
                      width: `${(stage.done / Math.max(1, stage.total)) * 100}%`,
                    }}
                  />
                ) : (
                  <div className="h-full w-2/5 animate-[slide_1.2s_ease-in-out_infinite] bg-blood shadow-[0_0_12px_rgba(224,27,44,0.7)]" />
                )}
              </div>
              {stage.k === "transcribing" && (
                <p className="mt-2 text-right font-mono text-xs text-ash">
                  {stage.done}/{stage.total} chunks
                </p>
              )}

              {file && (
                <p className="mt-6 truncate border-t border-line pt-4 font-mono text-xs text-ash">
                  {file.name} · {fmtBytes(file.size)} — keep this tab open,
                  everything runs locally
                </p>
              )}
            </div>
          </section>
        )}

        {stage.k === "error" && (
          <section className="mx-auto mt-16 max-w-2xl sm:mt-24">
            <div className="relative border-2 border-blood/60 bg-blood/10 p-6 sm:p-8">
              <span aria-hidden className="absolute left-2 top-2 h-4 w-4 border-l-2 border-t-2 border-blood-hot" />
              <span aria-hidden className="absolute right-2 top-2 h-4 w-4 border-r-2 border-t-2 border-blood-hot" />
              <span aria-hidden className="absolute bottom-2 left-2 h-4 w-4 border-b-2 border-l-2 border-blood-hot" />
              <span aria-hidden className="absolute bottom-2 right-2 h-4 w-4 border-b-2 border-r-2 border-blood-hot" />
              <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-blood-hot">
                Stoppage · technical
              </p>
              <h2 className="mt-2 font-display text-4xl uppercase text-blood-hot">
                Pipeline down
              </h2>
              <p className="mt-3 break-words leading-relaxed text-bone/90">
                {stage.message}
              </p>
              {transcript && (
                <p className="mt-2 font-mono text-xs text-ash">
                  Transcript survived — retry the analysis without
                  re-transcribing.
                </p>
              )}
              <div className="mt-6 flex flex-wrap gap-3">
                {transcript && (
                  <button
                    onClick={() => void retryAnalysis()}
                    className="bg-blood px-5 py-2 text-xs font-bold uppercase tracking-wider text-white transition-colors [clip-path:polygon(8px_0,100%_0,calc(100%_-_8px)_100%,0_100%)] hover:bg-blood-hot"
                  >
                    Retry analysis
                  </button>
                )}
                <button
                  onClick={reset}
                  className={`px-5 py-2 text-xs font-bold uppercase tracking-wider transition-colors [clip-path:polygon(8px_0,100%_0,calc(100%_-_8px)_100%,0_100%)] ${
                    transcript
                      ? "bg-steel text-ash hover:bg-line hover:text-bone"
                      : "bg-blood text-white hover:bg-blood-hot"
                  }`}
                >
                  Start over
                </button>
              </div>
            </div>
          </section>
        )}

        {stage.k === "ready" && transcript && file && videoUrl && (
          <section className="pt-10">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="flex items-center gap-3 font-mono text-xs uppercase tracking-[0.35em] text-gold">
                  <span aria-hidden className="h-px w-10 bg-gold" />
                  Analysis complete
                </p>
                <h1 className="mt-2 font-display text-5xl uppercase leading-[0.95] sm:text-6xl">
                  {clips.length} clips
                  <span className="text-blood"> on the card</span>
                </h1>
              </div>
              <div className="border border-line px-3 py-2 text-right text-sm">
                <div className="max-w-[320px] truncate font-semibold text-bone">
                  {file.name}
                </div>
                <div className="font-mono text-[11px] text-ash">
                  {fmtBytes(file.size)} · {fmtTime(transcript.duration)} runtime
                </div>
              </div>
            </div>

            <div className="mt-7 flex flex-wrap gap-2">
              {(
                [
                  ["all", `All (${clips.length})`] as const,
                  ...present.map(
                    (k) =>
                      [
                        k,
                        `${STORYLINES[k]} (${clips.filter((c) => c.clip.storyline === k).length})`,
                      ] as const
                  ),
                ] as ReadonlyArray<readonly [Storyline | "all", string]>
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setFilter(key)}
                  className={`px-4 py-1.5 text-xs font-bold uppercase tracking-wider transition-[background-color,color,translate,box-shadow] [clip-path:polygon(9px_0,100%_0,calc(100%_-_9px)_100%,0_100%)] ${
                    filter === key
                      ? "bg-blood text-white shadow-[0_0_20px_rgba(224,27,44,0.35)]"
                      : "bg-steel text-ash hover:-translate-y-0.5 hover:bg-line hover:text-bone"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="mt-8 grid grid-cols-1 gap-6 xl:grid-cols-2">
              {visible.map((c, i) => (
                <div
                  key={`${c.clip.storyline}-${c.clip.start_s}-${i}`}
                  className="animate-[rise_0.5s_cubic-bezier(0.2,0.7,0.3,1)_both]"
                  style={{ animationDelay: `${i * 70}ms` }}
                >
                  <ClipCard
                    clip={c.clip}
                    bounds={c.bounds}
                    segments={c.segments}
                    videoUrl={videoUrl}
                    file={file}
                    words={transcript.words}
                  />
                </div>
              ))}
            </div>
          </section>
        )}
      </main>

      <Footer />

      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => {
          acceptFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}
