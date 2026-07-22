export type Word = { w: string; s: number; e: number };

export type Seg = { s: number; e: number; text: string };

export type Transcript = {
  words: Word[];
  segs: Seg[];
  duration: number;
};

export const STORYLINES = {
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
} as const;

export type Storyline = keyof typeof STORYLINES;

export type Clip = {
  start_s: number;
  end_s: number;
  storyline: Storyline;
  hook_title: string;
  first_3s_hook: string;
  caption: string;
  hashtags: string[];
  virality: {
    total: number;
    hook: number;
    emotion: number;
    quotability: number;
    loopability: number;
  };
  reasoning: string;
  compliance: {
    in_fight_broadcast_risk: boolean;
    walkout_risk: boolean;
    low_value_risk: "low" | "med" | "high";
  };
};

export type StoredClip = Clip & { videoName: string; savedAt: number };
