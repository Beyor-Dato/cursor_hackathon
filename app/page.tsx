"use client";

import { useEffect, useRef, useState } from "react";
import ClipCard from "@/components/ClipCard";
import { clearAll, coverage, saveSession } from "@/lib/clipStore";
import {
  mergeChunks,
  snapClip,
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

type Stage =
  | { k: "idle" }
  | { k: "loading-ffmpeg" }
  | { k: "extracting"; note: string }
  | { k: "transcribing"; done: number; total: number }
  | { k: "analyzing" }
  | { k: "ready" }
  | { k: "error"; message: string };

type BoundClip = { clip: Clip; bounds: { start: number; end: number } };

const PIPELINE = [
  { key: "loading-ffmpeg", label: "Engine" },
  { key: "extracting", label: "Audio" },
  { key: "transcribing", label: "Transcript" },
  { key: "analyzing", label: "Moments" },
] as const;

async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: size }, worker));
  return out;
}

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

function stageCopy(stage: Stage): { headline: string; sub: string } {
  switch (stage.k) {
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
        sub: "Scoring every mic moment against the UFC 329 storylines — McGregor to Steveson.",
      };
    default:
      return { headline: "", sub: "" };
  }
}

function CoverageStrip({
  cov,
  onReset,
}: {
  cov: Record<Storyline, number>;
  onReset: () => void;
}) {
  return (
    <section className="mt-8">
      <div className="flex items-center justify-between gap-4">
        <h3 className="font-mono text-[11px] uppercase tracking-[0.25em] text-ash">
          Campaign coverage · all sessions
        </h3>
        <button
          onClick={onReset}
          className="font-mono text-[11px] uppercase tracking-wider text-ash transition-colors hover:text-blood-hot"
        >
          Reset library
        </button>
      </div>
      <div className="mt-3 flex gap-2 overflow-x-auto pb-2">
        {(Object.keys(STORYLINES) as Storyline[]).map((k) => {
          const n = cov[k];
          const banked = n > 0;
          return (
            <div
              key={k}
              className={`w-32 shrink-0 rounded-md border px-3 py-2.5 ${
                banked ? "border-line bg-coal" : "border-line/50 opacity-60"
              }`}
            >
              <div
                className={`font-display text-2xl leading-none ${
                  banked ? "text-gold" : "text-ash"
                }`}
              >
                {n}
              </div>
              <div className="mt-1.5 text-[10px] font-semibold uppercase leading-tight tracking-wider text-bone/80">
                {STORYLINES[k]}
              </div>
              <div className="mt-0.5 text-[10px] text-ash">
                {banked ? (n === 1 ? "clip banked" : "clips banked") : "0 clips yet"}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default function Home() {
  const [stage, setStage] = useState<Stage>({ k: "idle" });
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [clips, setClips] = useState<BoundClip[]>([]);
  const [filter, setFilter] = useState<Storyline | "all">("all");
  const [cov, setCov] = useState<Record<Storyline, number> | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    setCov(coverage());
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
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

  async function run(f: File) {
    setFile(f);
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    const url = URL.createObjectURL(f);
    urlRef.current = url;
    setVideoUrl(url);
    setClips([]);
    setFilter("all");
    setTranscript(null);

    try {
      setStage({ k: "loading-ffmpeg" });
      const { extractAudioChunks } = await import("@/lib/ffmpeg");
      const chunks = await extractAudioChunks(f, (msg) =>
        setStage({ k: "extracting", note: msg })
      );

      setStage({ k: "transcribing", done: 0, total: chunks.length });
      const results = await mapPool(chunks, 3, async (chunk, i) => {
        const fd = new FormData();
        const ext = chunk.blob.type === "audio/wav" ? "wav" : "mp3";
        fd.append(
          "audio",
          new File([chunk.blob], `chunk-${i}.${ext}`, { type: chunk.blob.type })
        );
        const res = await fetch("/api/transcribe", { method: "POST", body: fd });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(
            body?.error ?? `Transcription failed on chunk ${i + 1} (${res.status})`
          );
        }
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

      setStage({ k: "analyzing" });
      const res = await fetch("/api/moments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timeline: timelineText(t.segs),
          duration: t.duration,
          videoName: f.name,
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        clips?: Clip[];
        error?: string;
      } | null;
      if (!res.ok || !body?.clips) {
        throw new Error(body?.error ?? `Moment analysis failed (${res.status})`);
      }

      setClips(
        body.clips.map((clip) => ({
          clip,
          bounds: snapClip(clip.start_s, clip.end_s, t.segs, t.duration),
        }))
      );
      saveSession(f.name, body.clips);
      setCov(coverage());
      setStage({ k: "ready" });
    } catch (err) {
      setStage({
        k: "error",
        message:
          err instanceof Error ? err.message : "Something broke mid-pipeline.",
      });
    }
  }

  const present = (Object.keys(STORYLINES) as Storyline[]).filter((k) =>
    clips.some((c) => c.clip.storyline === k)
  );
  const visible =
    filter === "all" ? clips : clips.filter((c) => c.clip.storyline === filter);
  const stepIndex = PIPELINE.findIndex((p) => p.key === stage.k);
  const copy = stageCopy(stage);
  const hasHistory = cov !== null && Object.values(cov).some((n) => n > 0);

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b border-line bg-ink/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden
              className="h-6 w-2 -skew-x-12 bg-blood shadow-[0_0_16px_rgba(224,27,44,0.6)]"
            />
            <span className="font-display text-2xl leading-none tracking-wide">
              HOOK<span className="text-blood">SHOT</span>
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden rounded border border-line px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-ash sm:inline">
              UFC 329 · McGregor vs Holloway 2
            </span>
            {(stage.k === "ready" || stage.k === "error") && (
              <button
                onClick={reset}
                className="rounded bg-blood px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-white transition-colors hover:bg-blood-hot"
              >
                New video
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        {stage.k === "idle" && (
          <section className="pt-14 sm:pt-20">
            <p className="font-mono text-xs uppercase tracking-[0.35em] text-blood-hot">
              Official clipping campaign tool
            </p>
            <h1 className="mt-3 font-display text-5xl uppercase leading-[0.95] sm:text-7xl">
              Find the moment.
              <br />
              <span className="text-blood">Ship the clip.</span>
            </h1>
            <p className="mt-5 max-w-2xl text-lg leading-relaxed text-ash">
              Drop UFC 329 promo footage — Countdown, Embedded, pressers,
              weigh-ins. HookShot transcribes it, finds the mic moments, tags
              the storyline and cuts campaign-ready shorts with karaoke
              captions.
            </p>

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
              className={`stripes group relative mt-10 cursor-pointer rounded-xl border-2 bg-coal/60 px-6 py-16 text-center transition-colors sm:py-24 ${
                dragging
                  ? "border-blood bg-blood/10"
                  : "border-line hover:border-blood/70"
              }`}
            >
              <span aria-hidden className="absolute left-3 top-3 h-5 w-5 border-l-2 border-t-2 border-blood" />
              <span aria-hidden className="absolute right-3 top-3 h-5 w-5 border-r-2 border-t-2 border-blood" />
              <span aria-hidden className="absolute bottom-3 left-3 h-5 w-5 border-b-2 border-l-2 border-blood" />
              <span aria-hidden className="absolute bottom-3 right-3 h-5 w-5 border-b-2 border-r-2 border-blood" />
              <div className="font-display text-3xl uppercase tracking-wide sm:text-4xl">
                Drop the tape
              </div>
              <p className="mt-2 text-ash">
                or click to browse — MP4 · MOV · WEBM
              </p>
            </div>

            <div className="mt-6 flex flex-wrap gap-2 font-mono text-[11px] uppercase tracking-wider text-ash">
              <span className="rounded border border-line px-2.5 py-1">
                Video stays in your browser
              </span>
              <span className="rounded border border-line px-2.5 py-1">
                #UFCClips on every caption
              </span>
              <span className="rounded border border-line px-2.5 py-1">
                Compliance flags on risky moments
              </span>
            </div>

            {hasHistory && cov && (
              <CoverageStrip
                cov={cov}
                onReset={() => {
                  clearAll();
                  setCov(coverage());
                }}
              />
            )}
          </section>
        )}

        {processing && (
          <section className="mx-auto mt-16 max-w-2xl sm:mt-24">
            <div className="rounded-xl border border-line bg-coal p-6 sm:p-8">
              <ol className="flex items-center gap-4">
                {PIPELINE.map((p, i) => {
                  const state =
                    i < stepIndex ? "done" : i === stepIndex ? "active" : "todo";
                  return (
                    <li key={p.key} className="flex items-center gap-2">
                      <span
                        className={`h-2.5 w-2.5 rounded-full ${
                          state === "done"
                            ? "bg-blood"
                            : state === "active"
                              ? "animate-[pulse-dot_1.2s_ease-in-out_infinite] bg-blood-hot"
                              : "bg-line"
                        }`}
                      />
                      <span
                        className={`font-mono text-[10px] uppercase tracking-[0.2em] ${
                          state === "todo" ? "text-ash/50" : "text-bone"
                        }`}
                      >
                        {p.label}
                      </span>
                    </li>
                  );
                })}
              </ol>

              <h2 className="mt-7 font-display text-3xl uppercase leading-tight sm:text-4xl">
                {copy.headline}
              </h2>
              <p className="mt-2 leading-relaxed text-ash">{copy.sub}</p>
              {stage.k === "extracting" && (
                <p className="mt-1 font-mono text-xs text-ash/70">{stage.note}</p>
              )}

              <div className="mt-6 h-1.5 overflow-hidden rounded-full bg-line">
                {stage.k === "transcribing" ? (
                  <div
                    className="h-full rounded-full bg-blood transition-[width] duration-500"
                    style={{
                      width: `${(stage.done / Math.max(1, stage.total)) * 100}%`,
                    }}
                  />
                ) : (
                  <div className="h-full w-2/5 animate-[slide_1.2s_ease-in-out_infinite] rounded-full bg-blood" />
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
            <div className="rounded-xl border border-blood/50 bg-blood/10 p-6 sm:p-8">
              <h2 className="font-display text-3xl uppercase text-blood-hot">
                Pipeline down
              </h2>
              <p className="mt-3 break-words leading-relaxed text-bone/90">
                {stage.message}
              </p>
              <button
                onClick={reset}
                className="mt-6 rounded bg-blood px-4 py-2 text-xs font-semibold uppercase tracking-wider text-white transition-colors hover:bg-blood-hot"
              >
                Start over
              </button>
            </div>
          </section>
        )}

        {stage.k === "ready" && transcript && file && videoUrl && (
          <section className="pt-10">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="font-mono text-xs uppercase tracking-[0.35em] text-blood-hot">
                  Analysis complete
                </p>
                <h1 className="mt-1 font-display text-4xl uppercase sm:text-5xl">
                  {clips.length} clips on the card
                </h1>
              </div>
              <div className="text-right text-sm">
                <div className="max-w-[320px] truncate font-semibold text-bone">
                  {file.name}
                </div>
                <div className="font-mono text-xs text-ash">
                  {fmtBytes(file.size)} · {fmtTime(transcript.duration)} runtime
                </div>
              </div>
            </div>

            <div className="mt-6 flex flex-wrap gap-2">
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
                  className={`px-4 py-1.5 text-xs font-bold uppercase tracking-wider transition-colors [clip-path:polygon(9px_0,100%_0,calc(100%_-_9px)_100%,0_100%)] ${
                    filter === key
                      ? "bg-blood text-white"
                      : "bg-steel text-ash hover:text-bone"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {cov && (
              <CoverageStrip
                cov={cov}
                onReset={() => {
                  clearAll();
                  setCov(coverage());
                }}
              />
            )}

            <div className="mt-8 grid grid-cols-1 gap-6 xl:grid-cols-2">
              {visible.map((c, i) => (
                <div
                  key={`${c.clip.start_s}-${c.clip.hook_title}`}
                  className="animate-[rise_0.5s_cubic-bezier(0.2,0.7,0.3,1)_both]"
                  style={{ animationDelay: `${i * 70}ms` }}
                >
                  <ClipCard
                    clip={c.clip}
                    bounds={c.bounds}
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
