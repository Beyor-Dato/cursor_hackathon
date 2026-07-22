
## Rebuilding the deck PDF

```bash
cd docs/deck
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu \
  --no-pdf-header-footer --virtual-time-budget=6000 \
  --print-to-pdf="../HookShot-How-It-Works.pdf" "file://$PWD/index.html"
```

Slides are 1280x720 sections in `index.html`; `fonts.css` carries the latin woff2 subsets
inline as data URIs, so the render is self-contained and offline-safe.
