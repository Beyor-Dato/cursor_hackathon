import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// Full-bleed variant of app/icon.svg (keep the glyph paths in sync) —
// iOS applies its own corner mask and fills transparency with black.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <radialGradient id="glow" cx="0.5" cy="0" r="1">
      <stop offset="0" stop-color="#e01b2c" stop-opacity="0.28"/>
      <stop offset="0.65" stop-color="#e01b2c" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="64" height="64" fill="#0a0a0d"/>
  <rect width="64" height="64" fill="url(#glow)"/>
  <path d="M20 14h9L24 50h-9z" fill="#f2f0ea"/>
  <path d="M41 14h9L45 50h-9z" fill="#f5b52e"/>
  <path d="M27 23.5 41 32 27 40.5z" fill="#e01b2c"/>
</svg>`;

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`data:image/svg+xml,${encodeURIComponent(svg)}`}
          width={180}
          height={180}
          alt=""
        />
      </div>
    ),
    size
  );
}
