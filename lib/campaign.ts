/** Official UFC 329 campaign content sources (provided by the campaign brief). */

export type CampaignSource = {
  id: string;
  label: string;
  kind: "video" | "livestream" | "search";
  /** Direct URL when the brief provided one; otherwise a yt-dlp ytsearch query. */
  ref: string;
  note?: string;
};

export const CAMPAIGN_SOURCES: CampaignSource[] = [
  {
    id: "target",
    label: "Primary target video",
    kind: "video",
    ref: "https://www.youtube.com/watch?v=n0yNW7UxnME",
  },
  {
    id: "countdown",
    label: "UFC 329 Countdown — McGregor vs Holloway 2",
    kind: "search",
    ref: "ytsearch1:UFC 329 Countdown McGregor vs Holloway 2",
  },
  {
    id: "embedded-1",
    label: "Embedded: Vlog Series — Episode 1",
    kind: "search",
    ref: "ytsearch1:UFC 329 Embedded Vlog Series Episode 1",
  },
  {
    id: "embedded-2",
    label: "Embedded: Vlog Series — Episode 2",
    kind: "search",
    ref: "ytsearch1:UFC 329 Embedded Vlog Series Episode 2",
  },
  {
    id: "embedded-3",
    label: "Embedded: Vlog Series — Episode 3",
    kind: "search",
    ref: "ytsearch1:UFC 329 Embedded Vlog Series Episode 3",
  },
  {
    id: "embedded-5",
    label: "Embedded: Vlog Series — Episode 5",
    kind: "search",
    ref: "ytsearch1:UFC 329 Embedded Vlog Series Episode 5",
  },
  {
    id: "media-day",
    label: "UFC 329 Media Day",
    kind: "search",
    ref: "ytsearch1:UFC 329 McGregor Holloway media day",
  },
  {
    id: "presser-1",
    label: "Press Conference (livestream 1)",
    kind: "livestream",
    ref: "https://www.youtube.com/live/f97KA9Wfjzo",
    note: "long — fetch a section, e.g. *00:10:00-00:40:00",
  },
  {
    id: "presser-2",
    label: "Press Conference (livestream 2)",
    kind: "livestream",
    ref: "https://youtube.com/live/GNWbZ15APww",
    note: "long — fetch a section, e.g. *00:10:00-00:40:00",
  },
  {
    id: "weighin-show-1",
    label: "Weigh-In Show (livestream 1)",
    kind: "livestream",
    ref: "https://youtube.com/live/NqYhPc4WzXc",
    note: "long — fetch a section",
  },
  {
    id: "weighin-show-2",
    label: "Weigh-In Show (livestream 2)",
    kind: "livestream",
    ref: "https://youtube.com/live/DBe8vPqjjD8",
    note: "long — fetch a section",
  },
  {
    id: "weighins",
    label: "McGregor vs Holloway 2 Weigh-Ins",
    kind: "search",
    ref: "ytsearch1:McGregor vs Holloway 2 Weigh-Ins UFC 329",
  },
  {
    id: "rerank",
    label: "Conor Ranks the Best UFC Fighters of All Time (Re-Rank)",
    kind: "search",
    ref: "ytsearch1:Conor McGregor Ranks the Best UFC Fighters of All Time Re-Rank",
  },
];

/** Terminal command a user copies to pull this source locally. */
export function fetchCommand(src: CampaignSource): string {
  const arg = src.kind === "video" || src.kind === "livestream" ? src.ref : `"${src.ref}"`;
  const section = src.kind === "livestream" ? ' "*00:10:00-00:40:00"' : "";
  return `./scripts/fetch.sh ${arg}${section}`;
}
