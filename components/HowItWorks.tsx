const BEATS = [
  {
    n: "01",
    title: "Drop the tape",
    body: "Paste a YouTube link or drop an mp4 — ffmpeg.wasm rips mono audio right in the tab. The video never leaves your browser.",
  },
  {
    n: "02",
    title: "Whisper finds the mic moments",
    body: "Word-level transcript, then GPT scores every line for hook, emotion and quotability — tuned to your audience.",
  },
  {
    n: "03",
    title: "Export 9:16 with captions",
    body: "Karaoke captions burned in, jump cuts stitched, mp4 + .srt fallback — ready to post.",
  },
] as const;

/** The two jobs, split on purpose: the model judges, the code does the math. */
const SPLIT = {
  model: [
    "Which 20 seconds are worth posting",
    "The hook line that opens the clip",
    "Caption, hashtags and audience read",
    "Honest compliance flags",
  ],
  code: [
    "Chunk offsets and timestamp merging",
    "Snapping cuts to sentence boundaries",
    "Keyframe-aligned cutting and concat",
    "Subtitle timing across jump cuts",
  ],
} as const;

const MECHANICS = [
  {
    k: "Scored, not skimmed",
    d: "Every moment gets four sub-scores — hook, emotion, quotability, loopability. The total is what ranks your grid, so the best clip is on top instead of the first one found.",
  },
  {
    k: "Cuts land on sentences",
    d: "The model proposes rough bounds; code snaps them to real sentence edges using word timestamps, so clips never open mid-word or die on a half-finished thought.",
  },
  {
    k: "Jump cuts remove the dead air",
    d: "When a setup and its payoff are 40 seconds apart, the clip is assembled from up to three spans stitched with a fast flash — tight arc, no filler in between.",
  },
  {
    k: "Captions match the cut",
    d: "Stream copy can only start on a keyframe, so the real start is probed and subtitles are timed against it — across every jump cut. Captions never drift.",
  },
] as const;

export default function HowItWorks() {
  return (
    <section aria-label="How it works" className="mt-14">
      <div className="grid grid-cols-1 border-y border-line sm:grid-cols-3">
        {BEATS.map((b, i) => (
          <div
            key={b.n}
            className={`relative overflow-hidden px-5 py-6 ${
              i > 0 ? "border-t border-line sm:border-l sm:border-t-0" : ""
            }`}
          >
            <span
              aria-hidden
              className="ghost pointer-events-none absolute -right-2 -top-7 font-display text-[7rem] leading-none"
            >
              {b.n}
            </span>
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-blood-hot">
              Round {b.n}
            </p>
            <h3 className="mt-2 font-display text-xl uppercase leading-tight">
              {b.title}
            </h3>
            <p className="mt-2 max-w-xs text-sm leading-relaxed text-ash">
              {b.body}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-12 border-b-2 border-line pb-2">
        <h2 className="font-display text-xl uppercase tracking-wide">
          How the clipping actually works
        </h2>
        <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.25em] text-ash">
          Judgement from the model · timing from the code
        </p>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        {MECHANICS.map((m) => (
          <div
            key={m.k}
            className="border-l-2 border-blood/70 bg-coal/50 py-3 pl-4 pr-3 transition-colors hover:border-blood hover:bg-coal"
          >
            <h3 className="font-display text-base uppercase leading-tight tracking-wide">
              {m.k}
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-ash">{m.d}</p>
          </div>
        ))}
      </div>

      <div className="mt-6 grid grid-cols-1 overflow-hidden border border-line sm:grid-cols-2">
        <div className="border-b border-line p-5 sm:border-b-0 sm:border-r">
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-blood-hot">
            The model decides
          </p>
          <ul className="mt-3 space-y-2">
            {SPLIT.model.map((s) => (
              <li key={s} className="flex gap-2.5 text-sm text-bone/85">
                <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 bg-blood" />
                {s}
              </li>
            ))}
          </ul>
        </div>
        <div className="bg-ink/40 p-5">
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-gold">
            The code decides
          </p>
          <ul className="mt-3 space-y-2">
            {SPLIT.code.map((s) => (
              <li key={s} className="flex gap-2.5 text-sm text-bone/85">
                <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 bg-gold" />
                {s}
              </li>
            ))}
          </ul>
          <p className="mt-4 border-t border-line pt-3 text-xs leading-relaxed text-ash">
            Every number you see — timestamps, offsets, subtitle cues — is
            computed, never guessed by a language model.
          </p>
        </div>
      </div>
    </section>
  );
}
