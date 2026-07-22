import { ImageResponse } from "next/og";

export const alt = "HookShot — AI Clip Machine";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Same mark as app/icon.svg (keep the glyph paths in sync).
const mark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <radialGradient id="glow" cx="0.5" cy="0" r="1">
      <stop offset="0" stop-color="#e01b2c" stop-opacity="0.28"/>
      <stop offset="0.65" stop-color="#e01b2c" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="#131318"/>
  <rect width="64" height="64" rx="14" fill="url(#glow)"/>
  <path d="M20 14h9L24 50h-9z" fill="#f2f0ea"/>
  <path d="M41 14h9L45 50h-9z" fill="#f5b52e"/>
  <path d="M27 23.5 41 32 27 40.5z" fill="#e01b2c"/>
</svg>`;

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          backgroundColor: "#0a0a0d",
          backgroundImage:
            "radial-gradient(circle at 50% -20%, rgba(224,27,44,0.35), rgba(224,27,44,0) 60%)",
          color: "#f2f0ea",
          position: "relative",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            position: "absolute",
            right: -30,
            bottom: -90,
            fontSize: 420,
            fontWeight: 700,
            color: "rgba(242,240,234,0.05)",
            letterSpacing: -20,
          }}
        >
          9:16
        </div>

        <div
          style={{
            position: "absolute",
            top: 28,
            left: 28,
            right: 28,
            bottom: 28,
            border: "2px solid rgba(242,240,234,0.12)",
            display: "flex",
          }}
        />

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 56,
            padding: "0 84px",
            width: "100%",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`data:image/svg+xml,${encodeURIComponent(mark)}`}
            width={230}
            height={230}
            alt=""
          />

          <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
            <div
              style={{
                fontSize: 23,
                fontWeight: 700,
                letterSpacing: 5,
                color: "#f5b52e",
              }}
            >
PASTE A LINK · SHIP THE CLIP
            </div>

            <div
              style={{
                fontSize: 116,
                fontWeight: 700,
                letterSpacing: -3,
                lineHeight: 1,
                marginTop: 12,
                transform: "skewX(-6deg)",
              }}
            >
              HOOKSHOT
            </div>

            <div
              style={{
                width: 540,
                height: 12,
                backgroundColor: "#e01b2c",
                transform: "skewX(-20deg)",
                marginTop: 18,
                display: "flex",
              }}
            />

            <div
              style={{
                fontSize: 27,
                fontWeight: 700,
                letterSpacing: 8,
                marginTop: 24,
                color: "#f2f0ea",
              }}
            >
THE AI CLIP MACHINE
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 36 }}>
              {["VIDEO NEVER LEAVES THE BROWSER", "KARAOKE CAPTIONS", "JUMP CUTS"].map(
                (chip) => (
                  <div
                    key={chip}
                    style={{
                      display: "flex",
                      fontSize: 17,
                      fontWeight: 700,
                      letterSpacing: 1.5,
                      padding: "9px 15px",
                      border: "1.5px solid rgba(242,240,234,0.25)",
                      color: chip === "JUMP CUTS" ? "#f5b52e" : "#9a9aa5",
                    }}
                  >
                    {chip}
                  </div>
                )
              )}
            </div>
          </div>
        </div>
      </div>
    ),
    size
  );
}
