import { invoke } from "@tauri-apps/api/core";

export type LyricWord = {
  start: number;
  end: number;
  text: string;
};

export type LyricLine = {
  start: number | null;
  end: number | null;
  text: string;
  translation: string | null;
  words: LyricWord[];
};

export type LyricDoc = {
  source: string;
  format: string;
  encoding: string;
  synced: boolean;
  offsetMs: number;
  lines: LyricLine[];
};

export const getLyrics = (path: string, encoding?: string | null) =>
  invoke<LyricDoc | null>("lyrics_get", {
    path,
    encoding: encoding ?? null,
  });
