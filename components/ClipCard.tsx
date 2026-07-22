"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { ensureUFCClipsHashtag } from "@/lib/caption";
import { downloadBlob } from "@/lib/download";
import { generateSegmentedSrt } from "@/lib/srt";
import { fmtTime } from "@/lib/transcript";
import { STORYLINES, type Clip, type Word } from "@/lib/types";

type Props = {
  clip: Clip;
  bounds: { start: number; end: number };
  /** Sentence-snapped spans (≥1, sorted). >1 = jump-cut assembly. */
  segments: { start: number; end: number }[];
  videoUrl: string;
  file: File;
  words: Word[];
};

type KGroup = { words: Word[]; s: number; e: number };

function pct(n: number): number {
  return Math.max(0, Math.min(100, n));
}

/** Double-rAF so the initial frame paints before mount transitions kick in. */
function useMountedFrame(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setOn(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, []);
  return on;
}

function ScoreRing({ total }: { total: number }) {
  const v = pct(total);
  const on = useMountedFrame();
  const R = 30;
  const C = 2 * Math.PI * R;
  const color =
    v >= 80
      ? "var(--color-gold)"
      : v >= 60
        ? "var(--color-blood-hot)"
        : "var(--color-ash)";
  return (
    <div className="relative h-[84px] w-[84px] shrink-0">
      <svg viewBox="0 0 76 76" className="h-full w-full -rotate-90">
        <circle
          cx="38"
          cy="38"
          r={R}
          fill="none"
          stroke="var(--color-line)"
          strokeWidth="6"
        />
        <circle
          cx="38"
          cy="38"
          r={R}
          fill="none"
          stroke={color}
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={on ? C * (1 - v / 100) : C}
          className="transition-[stroke-dashoffset] duration-1000 ease-out motion-reduce:transition-none"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-display text-2xl leading-none text-gold">
          {Math.round(v)}
        </span>
        <span className="mt-0.5 text-[8px] font-bold uppercase tracking-[0.2em] text-ash">
          Viral
        </span>
      </div>
    </div>
  );
}

function SubScore({
  label,
  value,
  delay,
}: {
  label: string;
  value: number;
  delay: number;
}) {
  const v = pct(value);
  const on = useMountedFrame();
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-ash">
          {label}
        </span>
        <span className="font-mono text-[10px] tabular-nums text-bone/70">
          {Math.round(v)}
        </span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-line">
        <div
          className="h-full rounded-full bg-gradient-to-r from-blood to-blood-hot transition-[width] duration-700 ease-out motion-reduce:transition-none"
          style={{ width: on ? `${v}%` : "0%", transitionDelay: `${delay}ms` }}
        />
      </div>
    </div>
  );
}

const BTN =
  "rounded px-3.5 py-2 text-xs font-bold uppercase tracking-wider transition-colors disabled:cursor-not-allowed disabled:opacity-40";

const OVERLAY_BTN =
  "grid h-7 w-7 place-items-center rounded bg-black/60 text-bone transition-colors hover:bg-black/85 hover:text-white";

export default function ClipCard({
  clip,
  bounds,
  segments,
  videoUrl,
  file,
  words,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const bgVideoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [muted, setMuted] = useState(false);
  const [t, setT] = useState(bounds.start);
  const [copied, setCopied] = useState<"caption" | "script" | null>(null);
  const [busy, setBusy] = useState<"mp4" | "vertical" | null>(null);
  const [renderPct, setRenderPct] = useState(0);
  const [exportError, setExportError] = useState<string | null>(null);
  const [pendingSrt, setPendingSrt] = useState<string | null>(null);
  const [saveLink, setSaveLink] = useState<{
    url: string;
    name: string;
    mb: number;
  } | null>(null);

  useEffect(() => {
    return () => {
      if (saveLink) URL.revokeObjectURL(saveLink.url);
    };
  }, [saveLink]);

  const base = `hookshot-${clip.storyline}-${Math.round(bounds.start)}s`;

  // Virtual timeline: the clip plays as if its segments were spliced together.
  const totalDur = useMemo(
    () => Math.max(0.01, segments.reduce((a, s) => a + (s.end - s.start), 0)),
    [segments]
  );

  const toVirtual = (sourceT: number): number => {
    let acc = 0;
    for (const s of segments) {
      if (sourceT < s.start) return acc;
      if (sourceT <= s.end) return acc + (sourceT - s.start);
      acc += s.end - s.start;
    }
    return acc;
  };

  const toSource = (virtualT: number): number => {
    let rem = Math.max(0, Math.min(virtualT, totalDur));
    for (const s of segments) {
      const d = s.end - s.start;
      if (rem <= d) return s.start + rem;
      rem -= d;
    }
    return segments[segments.length - 1].end;
  };

  /** Keep playback inside the segments: skip gaps, loop at the end. */
  const enforceSegments = (v: HTMLVideoElement): void => {
    const ct = v.currentTime;
    const idx = segments.findIndex((s) => ct < s.end - 0.05);
    if (idx === -1) {
      v.currentTime = segments[0].start; // past the last segment — loop
    } else if (ct < segments[idx].start - 0.05) {
      v.currentTime = segments[idx].start; // in a gap — jump cut forward
    }
  };

  const clipWords = useMemo<Word[]>(
    () =>
      words.filter((w) =>
        segments.some((s) => w.e > s.start && w.s < s.end)
      ),
    [words, segments]
  );

  const script = useMemo(
    () =>
      clipWords
        .map((w) => w.w)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    [clipWords]
  );

  const groups = useMemo<KGroup[]>(() => {
    const clean = clipWords.filter((w) => w.w.trim().length > 0);
    const out: KGroup[] = [];
    for (let i = 0; i < clean.length; i += 3) {
      const g = clean.slice(i, i + 3);
      out.push({ words: g, s: g[0].s, e: g[g.length - 1].e });
    }
    return out;
  }, [clipWords]);

  // Iron rule 2: campaign clips always carry #UFCClips; general clips don't.
  const caption = useMemo(
    () =>
      clip.storyline === "general"
        ? clip.caption.trim()
        : ensureUFCClipsHashtag(clip.caption),
    [clip.caption, clip.storyline]
  );

  // Smooth karaoke sync while playing; onTimeUpdate alone is too coarse.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) {
        enforceSegments(v);
        setT(v.currentTime);
        // Nudge the blurred backdrop back into step when it drifts; it is
        // heavily blurred, so only gross desync is visible.
        const bg = bgVideoRef.current;
        if (bg && Math.abs(bg.currentTime - v.currentTime) > 0.3) {
          bg.currentTime = v.currentTime;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  function handleTimeUpdate() {
    const v = videoRef.current;
    if (!v) return;
    enforceSegments(v);
    setT(v.currentTime);
  }

  function handlePlay() {
    const v = videoRef.current;
    if (v && (v.currentTime < bounds.start || v.currentTime >= bounds.end)) {
      v.currentTime = segments[0].start;
    }
    setStarted(true);
    setPlaying(true);
  }

  function togglePlay() {
    const v = videoRef.current;
    const bg = bgVideoRef.current;
    if (!v) return;
    if (v.paused) {
      void v.play().catch(() => undefined);
      if (bg) {
        bg.currentTime = v.currentTime;
        void bg.play().catch(() => undefined);
      }
    } else {
      v.pause();
      bg?.pause();
    }
  }

  /** Seek to a virtual-timeline offset, mapped into the right segment. */
  function seekTo(offset: number) {
    const v = videoRef.current;
    if (!v) return;
    const target = Math.min(toSource(offset), bounds.end - 0.05);
    v.currentTime = target;
    setT(target);
    setStarted(true);
  }

  function restart() {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = bounds.start;
    setT(bounds.start);
    setStarted(true);
    void v.play().catch(() => undefined);
  }

  function toggleMute() {
    const v = videoRef.current;
    const next = !muted;
    if (v) v.muted = next;
    setMuted(next);
  }

  async function copyText(text: string, which: "caption" | "script") {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      setExportError("Clipboard blocked — copy manually.");
    }
  }

  async function exportMp4Srt() {
    setExportError(null);
    setPendingSrt(null);
    setBusy("mp4");
    try {
      const { cutClipSegments } = await import("@/lib/ffmpeg");
      // -c copy starts each cut at the keyframe at-or-before its segment start;
      // captions must be timed against those actual starts or they fire early.
      const { blob, actualStarts } = await cutClipSegments(file, segments);
      downloadBlob(blob, `${base}.mp4`);
      if (clipWords.length > 0) {
        // Chrome allows one download per gesture — a second one here trips the
        // multi-download prompt and a dismissal silently drops the .srt. Stash
        // it behind its own "Save .srt" click instead.
        setPendingSrt(
          generateSegmentedSrt(
            clipWords,
            segments.map((s, i) => ({
              start: s.start,
              end: s.end,
              actualStart: actualStarts[i] ?? s.start,
            }))
          )
        );
      }
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "MP4 export failed");
    } finally {
      setBusy(null);
    }
  }

  function saveSrt() {
    if (pendingSrt === null) return;
    downloadBlob(new Blob([pendingSrt], { type: "text/plain" }), `${base}.srt`);
    setPendingSrt(null);
  }

  async function exportVerticalWebm() {
    setExportError(null);
    setBusy("vertical");
    setRenderPct(0);
    try {
      const { exportVertical } = await import("@/lib/compositor");
      const blob = await exportVertical(videoUrl, clip, clipWords, {
        segments,
        onProgress: (frac) => setRenderPct(frac),
      });
      const ext = blob.type.includes("mp4") ? "mp4" : "webm";
      const name = `${base}-9x16.${ext}`;
      // Synthetic anchor clicks lose the filename in some browsers (the file
      // lands as a bare blob UUID), so also expose a real link to click.
      setSaveLink((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return { url: URL.createObjectURL(blob), name, mb: blob.size / 1e6 };
      });
      downloadBlob(blob, name);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "9:16 render failed");
    } finally {
      setBusy(null);
    }
  }

  const durS = Math.max(1, Math.round(totalDur));
  const clipDur = totalDur;
  const offset = Math.min(clipDur, Math.max(0, toVirtual(t)));
  const progress = (offset / clipDur) * 100;

  const hardRisks: string[] = [];
  if (clip.compliance.in_fight_broadcast_risk)
    hardRisks.push("in-fight broadcast footage");
  if (clip.compliance.walkout_risk) hardRisks.push("walkout footage");
  const lowValue = clip.compliance.low_value_risk;

  // Current 3-word karaoke group + active word for time t.
  let group: KGroup | null = null;
  let activeIdx = -1;
  if (started) {
    for (const g of groups) {
      if (t <= g.e + 0.12) {
        if (t >= g.s - 0.3) {
          group = g;
          activeIdx = 0;
          for (let i = 0; i < g.words.length; i++) {
            if (t >= g.words[i].s - 0.05) activeIdx = i;
          }
        }
        break;
      }
    }
  }
  const showHook = started && t >= bounds.start && offset < 3;

  return (
    <article className="relative flex h-full flex-col gap-5 rounded-xl border border-line bg-coal p-4 transition-[border-color,box-shadow] duration-300 hover:border-blood/40 hover:shadow-[0_0_44px_-14px_rgba(224,27,44,0.4)] sm:flex-row sm:p-5">
      <style>{`
        .clipcard-scrub {
          -webkit-appearance: none;
          appearance: none;
          background: transparent;
          cursor: pointer;
        }
        .clipcard-scrub::-webkit-slider-runnable-track {
          height: 3px;
          border-radius: 9999px;
          background: linear-gradient(
            90deg,
            var(--color-blood) var(--clipcard-fill, 0%),
            rgb(255 255 255 / 0.18) var(--clipcard-fill, 0%)
          );
        }
        .clipcard-scrub::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          margin-top: -4px;
          height: 11px;
          width: 11px;
          border-radius: 9999px;
          background: var(--color-gold);
          border: 2px solid #000;
          box-shadow: 0 0 0 1px rgb(245 181 46 / 0.35);
          transition: transform 0.15s ease-out;
        }
        .clipcard-scrub:hover::-webkit-slider-thumb,
        .clipcard-scrub:focus-visible::-webkit-slider-thumb {
          transform: scale(1.25);
        }
        .clipcard-scrub::-moz-range-track {
          height: 3px;
          border-radius: 9999px;
          background: linear-gradient(
            90deg,
            var(--color-blood) var(--clipcard-fill, 0%),
            rgb(255 255 255 / 0.18) var(--clipcard-fill, 0%)
          );
        }
        .clipcard-scrub::-moz-range-thumb {
          height: 11px;
          width: 11px;
          border-radius: 9999px;
          background: var(--color-gold);
          border: 2px solid #000;
        }
        .clipcard-hazard {
          background-image: repeating-linear-gradient(
            135deg,
            rgb(224 27 44 / 0.16) 0 8px,
            transparent 8px 16px
          );
        }
        .clipcard-word-active {
          text-shadow:
            0 0 18px rgb(245 181 46 / 0.55),
            0 2px 12px rgb(0 0 0 / 0.95),
            0 1px 2px rgb(0 0 0 / 0.9);
        }
        @media (prefers-reduced-motion: reduce) {
          .clipcard-scrub::-webkit-slider-thumb {
            transition: none;
          }
        }
      `}</style>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-4 top-0 h-px bg-gradient-to-r from-transparent via-blood/50 to-transparent"
      />

      <div
        className="group relative mx-auto aspect-[9/16] w-full max-w-[230px] shrink-0 cursor-pointer self-start overflow-hidden rounded-lg border border-steel bg-black sm:mx-0"
        onClick={togglePlay}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            togglePlay();
          }
        }}
        role="button"
        tabIndex={0}
        aria-label={playing ? "Pause preview" : "Play preview"}
      >
        {/* Mirrors the export exactly: blurred cover fill behind the whole
            frame contained on top. Preview and MP4 must look identical. */}
        <video
          ref={bgVideoRef}
          src={videoUrl}
          playsInline
          muted
          preload="metadata"
          aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full scale-110 object-cover blur-xl brightness-[0.62]"
        />
        <video
          ref={videoRef}
          src={videoUrl}
          playsInline
          muted={muted}
          preload="metadata"
          className="absolute inset-0 h-full w-full object-contain"
          style={{ transform: "translateY(-8%)" }}
          onTimeUpdate={handleTimeUpdate}
          onPlay={handlePlay}
          onPause={() => setPlaying(false)}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-black/80 to-transparent"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-black/90 to-transparent"
        />
        {showHook && (
          <div className="pointer-events-none absolute inset-x-2 top-3 text-center font-display text-sm uppercase leading-tight tracking-wide text-white caption-shadow">
            {clip.hook_title}
          </div>
        )}
        {group && (
          <div className="pointer-events-none absolute inset-x-1 bottom-[19%] text-center font-display text-[21px] uppercase leading-tight caption-shadow">
            {group.words.map((w, i) => (
              <span
                key={`${w.s}-${i}`}
                className={`mx-[0.1em] inline-block transition-transform duration-150 ease-out motion-reduce:transition-none ${
                  i === activeIdx
                    ? "clipcard-word-active scale-110 text-gold"
                    : "scale-100 text-white"
                }`}
              >
                {w.w.trim()}
              </span>
            ))}
          </div>
        )}
        {!playing && (
          <div className="absolute inset-0 grid place-items-center bg-black/30">
            <span className="grid h-12 w-12 place-items-center rounded-full bg-blood/90 pl-0.5 shadow-lg shadow-blood/40 transition-transform duration-200 group-hover:scale-110 motion-reduce:transition-none">
              <svg viewBox="0 0 24 24" className="h-5 w-5 fill-white">
                <path d="M8 5v14l11-7z" />
              </svg>
            </span>
          </div>
        )}

        <div
          className="absolute inset-x-0 bottom-0 flex flex-col gap-1 px-2 pb-1.5 pt-1"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="range"
            min={0}
            max={clipDur}
            step={0.05}
            value={offset}
            onChange={(e) => seekTo(Number(e.currentTarget.value))}
            aria-label="Scrub within clip"
            aria-valuetext={`${fmtTime(offset)} of ${fmtTime(clipDur)}`}
            className="clipcard-scrub h-3.5 w-full"
            style={{ "--clipcard-fill": `${progress}%` } as CSSProperties}
          />
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={restart}
              aria-label="Restart clip"
              className={OVERLAY_BTN}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current">
                <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={toggleMute}
              aria-label={muted ? "Unmute preview" : "Mute preview"}
              aria-pressed={muted}
              className={OVERLAY_BTN}
            >
              {muted ? (
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current">
                  <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current">
                  <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                </svg>
              )}
            </button>
            <span className="ml-auto rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-bone">
              {fmtTime(offset)} / {fmtTime(clipDur)}
            </span>
          </div>
        </div>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="bg-blood px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-white [clip-path:polygon(6px_0,100%_0,calc(100%_-_6px)_100%,0_100%)]">
            {STORYLINES[clip.storyline]}
          </span>
          <span className="rounded border border-line px-2 py-0.5 font-mono text-[11px] text-ash">
            {fmtTime(bounds.start)} – {fmtTime(bounds.end)} · {durS}s
          </span>
          {segments.length > 1 && (
            <span className="rounded border border-gold/50 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-gold">
              {segments.length} cuts
            </span>
          )}
        </div>

        <h3 className="mt-2.5 font-display text-2xl uppercase leading-tight">
          {clip.hook_title}
        </h3>

        <div className="mt-4 rounded-lg border border-line/70 bg-ink/40 p-3">
          <div className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-ash">
            Virality breakdown
          </div>
          <div className="mt-2.5 flex items-center gap-5">
            <ScoreRing total={clip.virality.total} />
            <div className="grid min-w-0 flex-1 grid-cols-2 gap-x-4 gap-y-3">
              <SubScore label="Hook" value={clip.virality.hook} delay={0} />
              <SubScore
                label="Emotion"
                value={clip.virality.emotion}
                delay={90}
              />
              <SubScore
                label="Quote"
                value={clip.virality.quotability}
                delay={180}
              />
              <SubScore
                label="Loop"
                value={clip.virality.loopability}
                delay={270}
              />
            </div>
          </div>
        </div>

        <div className="mt-4 border-l-2 border-blood pl-3">
          <div className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-ash">
            First 3 seconds
          </div>
          <blockquote className="mt-1 text-sm italic leading-relaxed text-bone/90">
            &ldquo;{clip.first_3s_hook}&rdquo;
          </blockquote>
        </div>

        {hardRisks.length > 0 && (
          <div
            role="alert"
            className="mt-4 overflow-hidden rounded border border-blood bg-blood/10"
          >
            <div className="clipcard-hazard flex items-center gap-2 border-b border-blood/40 px-3 py-1.5">
              <svg
                viewBox="0 0 24 24"
                aria-hidden
                className="h-3.5 w-3.5 shrink-0 fill-blood-hot"
              >
                <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
              </svg>
              <span className="font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-blood-hot">
                Compliance hold
              </span>
            </div>
            <p className="px-3 py-2 text-sm font-semibold text-blood-hot">
              Campaign rule risk — review before posting:{" "}
              {hardRisks.join(" + ")}
            </p>
          </div>
        )}
        {(lowValue === "med" || lowValue === "high") && (
          <div
            role="status"
            className="mt-3 flex items-center gap-2.5 rounded border border-gold/40 bg-gold/10 px-3 py-2"
          >
            <span className="shrink-0 rounded border border-gold/50 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-gold">
              QC {lowValue === "high" ? "High" : "Med"}
            </span>
            <p className="text-xs text-gold">
              Low-value risk — leans on context the viewer may not have.
            </p>
          </div>
        )}

        <div className="mt-4 rounded-lg border border-line bg-steel/50 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-ash">
                Post caption
              </span>
              <span className="font-mono text-[10px] text-ash/60">
                {caption.length} chars
              </span>
            </div>
            <button
              onClick={() => void copyText(caption, "caption")}
              className={`shrink-0 rounded border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider transition-colors ${
                copied === "caption"
                  ? "border-gold text-gold"
                  : "border-line text-ash hover:border-ash hover:text-bone"
              }`}
            >
              {copied === "caption" ? "Copied" : "Copy caption"}
            </button>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-bone/90">{caption}</p>
          {clip.hashtags.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5 border-t border-line/60 pt-2.5">
              {clip.hashtags.map((h) => (
                <span
                  key={h}
                  className="rounded-full border border-line px-2 py-0.5 font-mono text-[10px] text-ash transition-colors hover:border-ash hover:text-bone"
                >
                  {h.startsWith("#") ? h : `#${h}`}
                </span>
              ))}
            </div>
          )}
        </div>

        <details className="reasoning mt-3">
          <summary className="cursor-pointer select-none text-xs font-semibold uppercase tracking-wider text-ash transition-colors hover:text-bone">
            Why this clip
          </summary>
          <p className="mt-2 text-sm leading-relaxed text-ash">
            {clip.reasoning}
          </p>
        </details>

        <div className="mt-5 flex items-baseline justify-between gap-3">
          <span className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-ash">
            Export
          </span>
          <span className="truncate font-mono text-[10px] text-ash/60">
            renders locally — video never uploads
          </span>
        </div>

        {exportError && (
          <p
            role="alert"
            className="mt-2 rounded border border-blood/40 bg-blood/10 px-2.5 py-1.5 font-mono text-[11px] font-semibold text-blood-hot"
          >
            {exportError}
          </p>
        )}

        {saveLink && (
          <a
            href={saveLink.url}
            download={saveLink.name}
            className="mt-2 flex items-center justify-between gap-3 rounded border border-gold bg-gold/10 px-3 py-2.5 transition-colors hover:bg-gold hover:text-ink"
          >
            <span className="min-w-0">
              <span className="block text-xs font-bold uppercase tracking-wider text-gold">
                ⬇ Save {saveLink.name.endsWith(".mp4") ? "MP4" : "WebM"}
              </span>
              <span className="mt-0.5 block truncate font-mono text-[10px] text-ash">
                {saveLink.name} · {saveLink.mb.toFixed(1)} MB
              </span>
            </span>
          </a>
        )}

        <div className="mt-2 flex flex-col gap-2">
          <button
            onClick={() => void exportVerticalWebm()}
            disabled={busy !== null}
            className={`${BTN} relative w-full overflow-hidden bg-blood py-2.5 text-white shadow-lg shadow-blood/25 hover:bg-blood-hot`}
          >
            {busy === "vertical" && (
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 bg-white/15 transition-[width]"
                style={{ width: `${renderPct * 100}%` }}
              />
            )}
            <span className="relative">
              {busy === "vertical"
                ? `Rendering ${Math.round(renderPct * 100)}%`
                : "Export 9:16 MP4"}
            </span>
            {busy === "vertical" && (
              <span
                aria-hidden
                className="absolute bottom-0 left-0 h-0.5 bg-white/80 transition-[width]"
                style={{ width: `${renderPct * 100}%` }}
              />
            )}
          </button>
          <div className="flex gap-2">
            <button
              onClick={() =>
                pendingSrt !== null ? saveSrt() : void exportMp4Srt()
              }
              disabled={busy !== null}
              className={`${BTN} flex-1 border ${
                pendingSrt !== null
                  ? "border-gold text-gold hover:border-gold"
                  : "border-line text-bone hover:border-ash"
              }`}
            >
              <span className={busy === "mp4" ? "animate-pulse" : undefined}>
                {busy === "mp4"
                  ? "Cutting…"
                  : pendingSrt !== null
                    ? "Save .srt"
                    : "MP4 + SRT"}
              </span>
            </button>
            <button
              onClick={() => void copyText(script, "script")}
              disabled={script.length === 0}
              className={`${BTN} flex-1 border ${
                copied === "script"
                  ? "border-gold text-gold"
                  : "border-line text-bone hover:border-ash"
              }`}
            >
              {copied === "script" ? "Copied" : "Copy script"}
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}
