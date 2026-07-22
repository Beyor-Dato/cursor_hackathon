# HookShot — agent notes

OpusClip-style clipping machine for the UFC 329 campaign, built in an 8-hour hackathon.
User drops a campaign mp4 → browser extracts audio → Whisper transcribes → GPT finds
campaign moments → clip cards with karaoke captions → mp4/.srt and 9:16 WebM exports.
Full build plan and phase breakdown: `PLAN.md`.

## Commands

```bash
npm run dev            # local dev (see Turbopack gotcha below)
npm run build          # production build
npx tsc --noEmit       # type check — run after every change set
npm run lint           # eslint
```

Requires `OPENAI_API_KEY` in `.env.local` (copy `.env.example`). Never commit it.
Source videos are fetched locally via `scripts/fetch.sh <youtube-url>` (yt-dlp) — Vercel cannot download from YouTube.

## Pipeline

```
[browser] drop mp4 → ffmpeg.wasm → mono 32kbps audio, ~6-min chunks (<4MB each)
[server]  POST /api/transcribe → whisper-1 (verbose_json, word timestamps)
[browser] merge chunk transcripts with offsets (lib/transcript.ts)
[server]  POST /api/moments → gpt-5 structured outputs, UFC 329 storylines in prompt
[browser] clip cards: clamped preview + karaoke caption overlay
[browser] export: ffmpeg.wasm -c copy mp4 + .srt | canvas compositor → 9:16 burned-caption WebM
```

Key files: `app/page.tsx` (dropzone + clip grid), `components/ClipCard.tsx`,
`lib/ffmpeg.ts`, `lib/compositor.ts`, `lib/transcript.ts`, `lib/srt.ts`,
`app/api/transcribe/route.ts`, `app/api/moments/route.ts`, `lib/clipStore.ts`.

## Iron rules — never break these

1. **The video file NEVER leaves the browser.** Only compressed audio chunks (<4MB)
   go to API routes — Vercel's body limit is 4.5MB. Never add an upload path for video.
2. **Every generated social caption ends with `#UFCClips`**, enforced in code
   (appended client-side), not just in the prompt. Do not remove the code-level append.
3. **No logos or watermarks on exports.** Ever. Campaign rule.
4. **Compliance flags stay in the moments schema** (`in_fight_broadcast_risk`,
   `walkout_risk`, `low_value_risk`). Never remove them or hide the warning banners.
5. **Deterministic math lives in code** — timestamps, chunk offsets, .srt timing,
   sentence snapping. The LLM only classifies moments and writes copy. Never ask
   the model to compute or adjust timings.

## Conventions

- Next.js 16 App Router, strict TypeScript, Tailwind 4. No new dependencies without a reason.
- ffmpeg.wasm code (`lib/ffmpeg.ts`, `lib/compositor.ts`) is client-only: `'use client'`
  consumers, loaded via dynamic `import()` after file drop. Never import these from
  a route handler or server component — they touch `window`/workers and will crash SSR.
- API routes are thin: parse input, call OpenAI, return JSON. All merging/snapping
  happens client-side in `lib/`.
- Models: `whisper-1` for transcription, `gpt-5` for moments (fallback `gpt-5-mini`).
- One source of truth for clip state: `lib/clipStore.ts` (localStorage).

## Gotchas

- **Turbopack (Next 16 default) can 404 `@ffmpeg/ffmpeg`'s `worker.js`.** If ffmpeg
  fails to load in dev/build, run with the webpack flag instead, or self-host the esm
  worker and pass `classWorkerURL` to `FFmpeg.load()`.
- `ffmpeg-core.wasm` is 32MB, self-hosted in `public/ffmpeg/`. Lazy-load only after
  file drop, with a progress bar. Never import it at module top level.
- Single-thread ffmpeg core on purpose — no COOP/COEP headers needed. Don't switch
  to the multithreaded core.
- `/api/transcribe` sets `maxDuration = 300`; prod route limits differ from dev, so
  re-test the full pipeline on Vercel after API changes.
- MediaRecorder WebM export is Chrome-first; Safari is flaky. The `-c copy` mp4 + .srt
  path is the fallback that always works.

## Verify before calling anything done

1. `npx tsc --noEmit` and `npm run build` — both clean.
2. Run a real mp4 through the pipeline: chunks extract, merged timestamps are
   monotonic, clip ranges are in-bounds.
3. Every generated caption ends with `#UFCClips`; compliance banners render.
4. Exports: mp4 + .srt play in Chrome/QuickTime, .srt loads in VLC; WebM plays in Chrome.

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
