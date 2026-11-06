export type TrackSource = "preset" | "local";

export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number; // seconds
  src: string;
  cover: string;
  palette: [string, string, string];
  lrc?: string;
  source: TrackSource;
  format: string; // MP3 / FLAC / WAV
  quality: string; // e.g. "320 kbps" / "Hi-Res" / "Lossless"
  hiRes?: boolean;
  tags?: string[];
  addedAt: number;
  fileSize?: number;
  /** Absolute path on disk (Tauri library tracks). */
  path?: string;
  /** SQLite track id (Tauri library tracks). */
  libraryId?: number;
  cueStart?: number;
  cueEnd?: number;
  /** Format cannot be decoded by the bundled native engine. */
  unsupported?: boolean;
}

export type LoopMode = "list" | "one" | "shuffle";
export type NavKey = "library" | "local" | "recent" | "liked" | "playlists";
export type AccentKey = "cover" | "aurora" | "amber" | "glacier" | "mint" | "rose";
export type DockStyle = "floating" | "bar";

export interface Settings {
  restoreSession: boolean;
  rememberProgress: boolean;
  defaultRate: number;
  closeBehavior: "sleep" | "mini";
  doubleClickAction: "play" | "queue";
  outputDeviceId: string;
  outputMode: "shared" | "exclusive" | "asio";
  normalize: boolean;
  preservePitch: boolean;
  fade: boolean;
  fadeMs: number;
  eqEnabled: boolean;
  eqPreset: string;
  eqBands: number[]; // 10 bands, dB
  preamp: number; // dB
  shortcutsEnabled: boolean;
  blur: number; // px
  glassAlpha: number; // 0..0.3
  accent: AccentKey;
  ambientIntensity: number; // 0..1
  dynamicBackground: boolean;
  reduceMotion: boolean;
  lyricSize: number;
  dockStyle: DockStyle;
  showSpectrum: boolean;
}

export interface Toast {
  id: number;
  text: string;
  tone?: "info" | "success" | "error";
}

export interface LyricLine {
  time: number;
  text: string;
}
