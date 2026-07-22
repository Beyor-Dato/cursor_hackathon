export default function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-2 px-4 py-5 font-mono text-[10px] uppercase tracking-[0.2em] text-ash sm:flex-row sm:items-center sm:px-6">
        <p>
          HookShot · turn any footage into shorts ·{" "}
          <span className="text-gold">footage stays in your browser</span>
        </p>
        <p className="text-ash/60">
          No logos · no watermarks · compliance flags on
        </p>
      </div>
    </footer>
  );
}
