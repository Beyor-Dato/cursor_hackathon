# HookShot — UFC 329 Campaign Clipping Machine (8-Hour Build)

## Context

Cursor hackathon, 8 hours, Vercel + OpenAI key. The real use case: the user is participating in the **UFC 329 (McGregor vs Holloway 2) clipping campaign** — official promo content (Countdown, Embedded eps, media day, press conferences, weigh-ins, octagon interviews) gets clipped into shorts to maximize viewership in US/UK/CA/AU/NZ. First target video: `https://www.youtube.com/watch?v=n0yNW7UxnME`.

So this is an OpusClip clone **specialized for one campaign**: it must find mic-moments that hit the campaign's 9 storylines, generate compliant captions (#UFCClips, no low-value spam), and refuse clips that violate campaign rules (no broadcast in-fight action, no broadcast walkouts, no logos).

**Architecture bet (unchanged):** the video never leaves the browser. ffmpeg.wasm extracts/chunks audio client-side → only audio hits the API (Whisper). Cutting and caption-burning happen in-browser. This sidesteps Vercel's 4.5MB body limit, timeouts, and storage.

**Getting the source videos:** Vercel can't download from YouTube (datacenter IPs blocked; not worth fighting in 8h). Include `scripts/fetch.sh` — a one-line local yt-dlp wrapper the user runs on their machine for each campaign link, then drops the mp4 into the app. Campaign content is provided for clipping, so this is the sanctioned workflow.

## Pipeline

```
[local]   scripts/fetch.sh <youtube-url>  → campaign mp4 on disk
[browser] drop mp4 → ffmpeg.wasm → mono 32kbps audio in ~6-min chunks (<4MB each)
[server]  /api/transcribe → whisper-1 (verbose_json, word timestamps), client merges w/ offsets
[server]  /api/moments   → gpt-5 structured output, CAMPAIGN-AWARE (storylines + rules injected)
[browser] clip cards: instant preview (currentTime clamp) + karaoke caption overlay
[browser] export: ffmpeg.wasm -c copy mp4 + .srt  |  canvas compositor → 9:16 burned-caption WebM
```

## Campaign brain (the differentiator)

`/api/moments` system prompt hardcodes the campaign brief:

**Storylines to hunt** (each clip tagged with one): McGregor return/redemption at 170 · Holloway ex-BMF new weight class · Saint-Denis "god of war" ex-military · Pimblett scouser/eating/Ilia rivalry · Royval comeback · Kavanagh flyweight prospect (beat Moreno) · Green vs McKinney wild-styles KO hype · Whittaker up at LHW · Gable Steveson debut (wrestling pedigree, trains with Jones).

**Viral heuristics for fight promo:** trash-talk peaks and quotable one-liners beat b-roll; 20-45s self-contained arcs; open on the hottest line (first_3s_hook); rivalry heat and emotional beats; loopable endings.

**Hard rules encoded:** every caption ends with `#UFCClips`; hook titles must add storyline value (explicit anti-example in prompt: banned "Random moment + I CAN'T BELIEVE THAT HAPPENED" style); compliance flags per clip.

Structured output schema:
```ts
{ clips: Array<{
    start_s: number; end_s: number;                    // sentence-snapped
    storyline: 'mcgregor'|'holloway'|'saint_denis'|'pimblett'|'royval'|'kavanagh'|'green_mckinney'|'whittaker'|'steveson'|'general';
    hook_title: string; first_3s_hook: string;
    caption: string;                                   // ready-to-paste, ends with #UFCClips
    hashtags: string[];                                // beyond #UFCClips, EN-market tuned
    virality: { total: number; hook: number; emotion: number; quotability: number; loopability: number };
    reasoning: string;
    compliance: { in_fight_broadcast_risk: boolean; walkout_risk: boolean; low_value_risk: 'low'|'med'|'high' };
}> }
```
Client renders compliance warnings as a red banner; `#UFCClips` is ALSO appended in code (belt and suspenders — a missing hashtag = rejected post).

## Files

- `app/page.tsx` — dropzone → staged progress → clip grid with storyline filter tabs
- `components/ClipCard.tsx` — preview player + karaoke overlay, virality ring + sub-scores, storyline badge, caption copy button, compliance banner, export buttons
- `lib/ffmpeg.ts` (wasm load from /public, single-thread core — no COOP/COEP needed; extractAudioChunks, cutClip)
- `lib/compositor.ts` (hidden video → 1080×1920 canvas center-crop + captions + progress bar → captureStream + AudioContext → MediaRecorder WebM)
- `lib/transcript.ts` (chunk merge with offsets, sentence snapping), `lib/srt.ts`
- `app/api/transcribe/route.ts` (`maxDuration = 300`, FormData binary), `app/api/moments/route.ts` (campaign prompt)
- `lib/clipStore.ts` — localStorage clip library across videos: per-storyline coverage counts, so across Embedded eps + pressers the user sees which plotpoints are underserved
- `scripts/fetch.sh` — local yt-dlp wrapper for campaign links

## Phases (480 min)

| Phase | Time | Work | Done when |
|-------|------|------|-----------|
| 0. Skeleton live | 20m | create-next-app (into `.`, existing .gitignore is allowlisted), vercel deploy, env key | Prod URL serves |
| 1. Ingest | 60m | dropzone, lazy wasm load w/ progress, audio extract + chunking | 40-min mp4 → audio chunks in browser |
| 2. Brain | 70m | transcribe route + merge; moments route with full campaign prompt; test on the n0yNW7UxnME transcript | Clips JSON hits real storylines w/ sane timestamps |
| 3. Clip cards | 70m | clamped preview player, karaoke overlay, score ring, storyline badges + filter tabs, caption copy, compliance banners | Feels like OpusClip's review screen, campaign-flavored |
| 4. Export | 75m | -c copy mp4 + .srt; canvas compositor 9:16 burned-caption WebM | Both files play in Chrome/QuickTime |
| 5. Clip library | 30m | localStorage store + storyline coverage strip ("Pimblett: 0 clips yet") | Clips persist across two processed videos |
| 6. Polish + prod | 45m | landing, error states, staged progress copy, prod deploy, FULL prod run with the real campaign video | User can run the actual campaign workflow end-to-end |
| Buffer | 60m | wasm quirks, Safari MediaRecorder, prompt tuning on real transcript | — |

**Cut lines if behind (in order):** clip library → canvas 9:16 export (ship -c copy + .srt) → sub-score rings. Never cut: campaign prompt w/ storylines, #UFCClips enforcement, compliance flags, preview with captions, one-click export.

**Stretch if ahead:** face-aware crop (one vision call on 3 keyframes/clip → crop-x offset); per-platform caption variants (TikTok vs Shorts phrasing).

## Risks & mitigations

- Press conference audio (crowd, crosstalk): Whisper handles it OK; test Phase 2 against the noisiest source early; word timestamps degrade gracefully
- ffmpeg.wasm 30MB: lazy-load after drop w/ progress bar, self-hosted
- MediaRecorder/Safari: demo in Chrome; mp4 fast path always works
- Long livestreams (pressers are 1-2h): cap ingest at 90 min, suggest yt-dlp `--download-sections` in fetch.sh for longer sources
- Model naming: `gpt-5` for moments, fall back `gpt-5-mini`; `whisper-1` for transcription

## Verification

1. Run the real target video (n0yNW7UxnME) through the full pipeline locally: chunks, monotonic merged timestamps, clips in-bounds, storyline tags sensible, every caption ends `#UFCClips`
2. Export both formats, play in Chrome + QuickTime, .srt loads in VLC
3. `npx tsc --noEmit` + `npm run build` clean
4. Repeat the full flow on PROD immediately after Phase 2 (route body/duration limits differ from dev) and again at the end

## Demo script (60s)

Drop in the Countdown episode → staged progress → clip cards ranked by virality, badged by storyline ("McGregor redemption", "Pimblett rivalry") → play top clip: karaoke captions bounce, caption below already reads campaign-ready with #UFCClips → one click → 9:16 burned-caption vertical renders in-browser → coverage strip shows which storylines still need clips.
