"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ensureUFCClipsHashtag } from "@/lib/caption";
import { wordsInRange } from "@/lib/transcript";
import { wordsToSrt } from "@/lib/srt";
import { STORYLINES, type Clip, type Transcript } from "@/lib/types";

type Props = {
  clip: Clip;
  index: number;
  videoFile: File;
  transcript: Transcript;
};

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function ScoreRing({ score, label }: { score: number; label: string }) {
  const r = 18;
  const c = 2 * Math.PI * r;
  const pct = Math.min(100, Math.max(0, score)) / 100;
  return (
    <div className="flex flex-col items-center gap-0.5">
      <svg width="44" height="44" className="-rotate-90">
        <circle cx="22" cy="22" r={r} fill="none" stroke="#27272a" strokeWidth="4" />
        <circle
          cx="22"
          cy="22"
          r={r}
          fill="none"
          stroke="#ef4444"
          strokeWidth="4"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct)}
          strokeLinecap="round"
        />
      </svg>
      <span className="text-[10px] font-bold text-zinc-400">{label}</span>
      <span className="text-xs font-bold text-white">{Math.round(score)}</span>
    </div>
  );
}

function hasComplianceWarning(clip: Clip): boolean {
  const { compliance } = clip;
  return (
    compliance.in_fight_broadcast_risk ||
    compliance.walkout_risk ||
    compliance.low_value_risk !== "low"
  );
}

function complianceMessages(clip: Clip): string[] {
  const msgs: string[] = [];
  if (clip.compliance.in_fight_broadcast_risk) {
    msgs.push("Possible in-fight broadcast footage — review before posting");
  }
  if (clip.compliance.walkout_risk) {
    msgs.push("Possible walkout footage — campaign may restrict use");
  }
  if (clip.compliance.low_value_risk === "med") {
    msgs.push("Medium context risk — clip may need setup for viewers");
  }
  if (clip.compliance.low_value_risk === "high") {
    msgs.push("High context risk — low standalone value");
  }
  return msgs;
}

export default function ClipCard({ clip, index, videoFile, transcript }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(clip.start_s);
  const [copied, setCopied] = useState(false);
  const [exportingMp4, setExportingMp4] = useState(false);
  const [exportingWebm, setExportingWebm] = useState(false);
  const [webmProgress, setWebmProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const videoUrl = useRef<string | null>(null);
  if (!videoUrl.current) videoUrl.current = URL.createObjectURL(videoFile);

  const caption = ensureUFCClipsHashtag(clip.caption);
  const words = wordsInRange(transcript.words, clip.start_s, clip.end_s);
  const activeIdx = words.findIndex((w) => currentTime >= w.s && currentTime <= w.e);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const clamp = () => {
      if (video.currentTime >= clip.end_s - 0.05) {
        video.currentTime = clip.start_s;
      }
      if (video.currentTime < clip.start_s) {
        video.currentTime = clip.start_s;
      }
      setCurrentTime(video.currentTime);
    };

    const onLoaded = () => {
      video.currentTime = clip.start_s;
      void video.play().catch(() => {});
    };

    video.addEventListener("timeupdate", clamp);
    video.addEventListener("loadeddata", onLoaded);
    return () => {
      video.removeEventListener("timeupdate", clamp);
      video.removeEventListener("loadeddata", onLoaded);
    };
  }, [clip.start_s, clip.end_s]);

  const copyCaption = useCallback(async () => {
    await navigator.clipboard.writeText(caption);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [caption]);

  const exportMp4Srt = useCallback(async () => {
    setExportingMp4(true);
    setError(null);
    try {
      const { cutClip } = await import("@/lib/ffmpeg");
      const mp4 = await cutClip(videoFile, clip.start_s, clip.end_s);
      const srt = wordsToSrt(words, clip.start_s);
      const base = `hookshot-${index + 1}-${clip.storyline}`;
      downloadBlob(mp4, `${base}.mp4`);
      downloadBlob(new Blob([srt], { type: "text/plain" }), `${base}.srt`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExportingMp4(false);
    }
  }, [videoFile, clip.start_s, clip.end_s, words, index, clip.storyline]);

  const exportWebm = useCallback(async () => {
    setExportingWebm(true);
    setWebmProgress(0);
    setError(null);
    try {
      const { renderVerticalWebM } = await import("@/lib/compositor");
      const webm = await renderVerticalWebM(
        videoFile,
        clip.start_s,
        clip.end_s,
        words,
        (p) => setWebmProgress(p.pct)
      );
      downloadBlob(webm, `hookshot-${index + 1}-${clip.storyline}-9x16.webm`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "WebM export failed");
    } finally {
      setExportingWebm(false);
    }
  }, [videoFile, clip.start_s, clip.end_s, words, index, clip.storyline]);

  const showWarning = hasComplianceWarning(clip);

  return (
    <article className="flex flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/80 shadow-xl">
      {showWarning && (
        <div className="border-b border-red-900/60 bg-red-950/90 px-4 py-2.5">
          <p className="text-xs font-bold uppercase tracking-wide text-red-400">
            Compliance warning
          </p>
          <ul className="mt-1 space-y-0.5">
            {complianceMessages(clip).map((m) => (
              <li key={m} className="text-sm text-red-200">
                {m}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="relative aspect-video bg-black">
        <video
          ref={videoRef}
          src={videoUrl.current}
          className="h-full w-full object-contain"
          muted
          playsInline
          loop
        />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent px-4 pb-4 pt-16">
          <p className="mb-2 text-center text-lg font-black uppercase leading-tight text-white drop-shadow-lg">
            {words.slice(Math.max(0, activeIdx - 1), activeIdx + 4).map((w, i) => {
              const globalI = Math.max(0, activeIdx - 1) + i;
              const isActive = globalI === activeIdx;
              const isPast = globalI < activeIdx;
              return (
                <span
                  key={`${w.s}-${w.w}`}
                  className={
                    isActive
                      ? "text-red-500"
                      : isPast
                        ? "text-white"
                        : "text-white/50"
                  }
                >
                  {w.w}{" "}
                </span>
              );
            })}
          </p>
        </div>
        <span className="absolute left-3 top-3 rounded bg-red-600 px-2 py-0.5 text-xs font-bold uppercase text-white">
          {STORYLINES[clip.storyline]}
        </span>
        <span className="absolute right-3 top-3 rounded bg-black/70 px-2 py-0.5 font-mono text-xs text-zinc-300">
          {formatTs(clip.start_s)}–{formatTs(clip.end_s)}
        </span>
      </div>

      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-bold leading-snug text-white">{clip.hook_title}</h3>
            <p className="mt-1 text-xs text-zinc-500">{clip.first_3s_hook}</p>
          </div>
          <div className="flex shrink-0 flex-col items-center">
            <div className="relative flex h-16 w-16 items-center justify-center">
              <svg width="64" height="64" className="-rotate-90">
                <circle cx="32" cy="32" r="28" fill="none" stroke="#27272a" strokeWidth="5" />
                <circle
                  cx="32"
                  cy="32"
                  r="28"
                  fill="none"
                  stroke="#ef4444"
                  strokeWidth="5"
                  strokeDasharray={2 * Math.PI * 28}
                  strokeDashoffset={
                    2 * Math.PI * 28 * (1 - clip.virality.total / 100)
                  }
                  strokeLinecap="round"
                />
              </svg>
              <span className="absolute text-lg font-black text-white">
                {Math.round(clip.virality.total)}
              </span>
            </div>
            <span className="text-[10px] font-bold uppercase text-zinc-500">Virality</span>
          </div>
        </div>

        <div className="flex justify-between gap-1 rounded-lg bg-zinc-950/60 px-2 py-3">
          <ScoreRing score={clip.virality.hook} label="Hook" />
          <ScoreRing score={clip.virality.emotion} label="Emotion" />
          <ScoreRing score={clip.virality.quotability} label="Quote" />
          <ScoreRing score={clip.virality.loopability} label="Loop" />
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
          <p className="text-sm leading-relaxed text-zinc-300">{caption}</p>
          {clip.hashtags.length > 0 && (
            <p className="mt-2 text-xs text-zinc-500">{clip.hashtags.join(" ")}</p>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void copyCaption()}
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm font-semibold text-white transition hover:bg-zinc-700"
          >
            {copied ? "Copied!" : "Copy caption"}
          </button>
          <button
            type="button"
            onClick={() => void exportMp4Srt()}
            disabled={exportingMp4 || exportingWebm}
            className="flex-1 rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-red-500 disabled:opacity-50"
          >
            {exportingMp4 ? "Cutting…" : "MP4 + SRT"}
          </button>
          <button
            type="button"
            onClick={() => void exportWebm()}
            disabled={exportingMp4 || exportingWebm}
            className="flex-1 rounded-lg border border-red-600/50 bg-red-950/40 px-3 py-2 text-sm font-semibold text-red-300 transition hover:bg-red-950/70 disabled:opacity-50"
          >
            {exportingWebm ? `${Math.round(webmProgress)}%` : "9:16 WebM"}
          </button>
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
    </article>
  );
}

function formatTs(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}
