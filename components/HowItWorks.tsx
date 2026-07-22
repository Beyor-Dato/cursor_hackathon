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
    </section>
  );
}
