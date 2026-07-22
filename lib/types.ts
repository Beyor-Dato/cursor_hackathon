/** UFC 329 campaign storyline tags — one per clip. */
export type Storyline =
  | "mcgregor"
  | "holloway"
  | "saint_denis"
  | "pimblett"
  | "royval"
  | "kavanagh"
  | "green_mckinney"
  | "whittaker"
  | "steveson"
  | "general";

export const STORYLINES: Record<Storyline, string> = {
  mcgregor: "McGregor Return",
  holloway: "Holloway New Weight",
  saint_denis: "Saint-Denis God of War",
  pimblett: "Paddy Pimblett",
  royval: "Royval Comeback",
  kavanagh: "Kavanagh Prospect",
  green_mckinney: "Green vs McKinney",
  whittaker: "Whittaker at LHW",
  steveson: "Gable Steveson Debut",
  general: "General Hype",
};

export type Virality = {
  total: number;
  hook: number;
  emotion: number;
  quotability: number;
  loopability: number;
};

export type Compliance = {
  in_fight_broadcast_risk: boolean;
  walkout_risk: boolean;
  low_value_risk: "low" | "med" | "high";
};

/** One contiguous span of source video (seconds). */
export type ClipSegment = { start_s: number; end_s: number };

export type Clip = {
  start_s: number;
  end_s: number;
  /**
   * Optional jump-cut assembly: 1-3 sorted, non-overlapping spans stitched
   * with fast transitions. Omitted = the single span start_s..end_s.
   */
  segments?: ClipSegment[];
  storyline: Storyline;
  hook_title: string;
  first_3s_hook: string;
  caption: string;
  hashtags: string[];
  virality: Virality;
  reasoning: string;
  compliance: Compliance;
};

export type StoredClip = Clip & { videoName: string; savedAt: number };

/** Word-level timestamp from Whisper (seconds). */
export type TranscriptWord = {
  word: string;
  start: number;
  end: number;
};

/** Segment-level timestamp from Whisper (seconds). */
export type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
};

/** Client-side audio chunk ready for /api/transcribe (<4MB each). */
export type AudioChunk = {
  blob: Blob;
  offset: number;
  index: number;
};

/** Per-chunk Whisper API response before merge. */
export type ChunkTranscript = {
  words: TranscriptWord[];
  segments: TranscriptSegment[];
  duration: number;
};

/** Merged full-video transcript (client-side). */
export type MergedTranscript = {
  words: TranscriptWord[];
  segments: TranscriptSegment[];
  duration: number;
};

/** Compact word type used by srt/karaoke (seconds). */
export type Word = { w: string; s: number; e: number };

/** Compact segment type used by timeline export (seconds). */
export type Seg = { s: number; e: number; text: string };

/** @deprecated Use MergedTranscript — kept for Phase 3 compat. */
export type Transcript = {
  words: Word[];
  segs: Seg[];
  duration: number;
};
