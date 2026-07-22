import type { Metadata, Viewport } from "next";
import { Anton, Barlow, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const anton = Anton({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-anton",
});

const barlow = Barlow({
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
  subsets: ["latin"],
  variable: "--font-barlow",
});

const plexMono = IBM_Plex_Mono({
  weight: ["400", "600"],
  subsets: ["latin"],
  variable: "--font-plex-mono",
});

const TITLE = "HookShot — AI Clip Machine";
const DESCRIPTION =
  "Paste a YouTube link or drop any footage and get viral-ready vertical shorts: audience-aware clips, karaoke captions, jump cuts, one-click exports. The video never leaves your browser.";

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000");

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: TITLE,
    template: "%s · HookShot",
  },
  description: DESCRIPTION,
  applicationName: "HookShot",
  keywords: [
    "clipping",
    "shorts",
    "captions",
    "viral clips",
    "opus clip alternative",
    "youtube to shorts",
  ],
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    siteName: "HookShot",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0d",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${anton.variable} ${barlow.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full font-sans">{children}</body>
    </html>
  );
}
