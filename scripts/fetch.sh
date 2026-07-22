#!/usr/bin/env bash
# Fetch a UFC 329 campaign source video for HookShot.
# Campaign links are provided to authorized participants — run this locally
# (Vercel can't download from YouTube), then drop the mp4 into the web app.
#
# Usage: ./scripts/fetch.sh <youtube-url | "ytsearch1:title terms"> [section]
#   section example: *00:10:00-00:25:00   (passed to yt-dlp --download-sections)
#   All campaign sources + ready commands: lib/campaign.ts (or the app's Sources panel)
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <youtube-url | \"ytsearch1:title terms\"> [section like *00:10:00-00:25:00]" >&2
  exit 1
fi

if ! command -v yt-dlp >/dev/null 2>&1; then
  echo "yt-dlp not found. Install it first: brew install yt-dlp" >&2
  exit 1
fi

cd "$(dirname "$0")/.."
mkdir -p campaign

args=(
  -f "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[ext=mp4]"
  --merge-output-format mp4
  -o "campaign/%(title).80s.mp4"
)
if [[ $# -ge 2 ]]; then
  args+=(--download-sections "$2")
fi

yt-dlp "${args[@]}" "$1"

echo
echo "Saved under: $(pwd)/campaign/"
echo "Drop the mp4 into the HookShot web app to start clipping."
