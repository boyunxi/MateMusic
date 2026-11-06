import type { UnlistenFn } from "@tauri-apps/api/event";
import type { Track } from "../types";
import { generatedCover, paletteFromSeed } from "./utils";
import { isNativeDecodable } from "./formats";
import { assetUrl, inTauri, invoke, tauriListen } from "./tauri";

export interface LibraryTrackRow {
  id: number;
  path: string;
  title: string;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  trackNo: number | null;
  discNo: number | null;
  year: number | null;
  genre: string | null;
  duration: number;
  codec: string | null;
  sampleRate: number | null;
  bits: number | null;
  channels: number | null;
  bitrate: number | null;
  coverPath: string | null;
  cuePath: string | null;
  cueStart: number | null;
  cueEnd: number | null;
}

export interface TrackPage {
  total: number;
  tracks: LibraryTrackRow[];
}

export interface LibraryStats {
  tracks: number;
  folders: number;
  albums: number;
  artists: number;
  totalDuration: number;
}

export interface ScanStatus {
  scanning: boolean;
  folder: string;
  scanned: number;
  imported: number;
  skipped: number;
  errors: number;
  current: string;
}

interface LyricWord {
  start: number;
  end: number;
  text: string;
}

interface LyricDoc {
  source: string;
  format: string;
  encoding: string;
  synced: boolean;
  offsetMs: number;
  lines: { start: number | null; end: number | null; text: string; translation: string | null; words: LyricWord[] }[];
}

const extensionOf = (path: string) => (path.split(".").pop() || "audio").toUpperCase();

function formatKhz(rate: number): string {
  return `${(rate / 1000).toFixed(rate % 1000 ? 1 : 0)}kHz`;
}

export function libraryRowToTrack(row: LibraryTrackRow): Track {
  const id = `lib-${row.id}`;
  const title = row.title || "未知曲目";
  const artist = row.artist || "未知艺术家";
  const album = row.album || "未知专辑";
  const format = extensionOf(row.path);
  const hiRes = (row.bits ?? 0) > 16 || (row.sampleRate ?? 0) > 48000;
  const quality =
    row.bits && row.sampleRate
      ? `${row.bits}bit / ${formatKhz(row.sampleRate)}`
      : row.bitrate
        ? `${Math.round(row.bitrate / 1000)} kbps`
        : format;
  return {
    id,
    title,
    artist,
    album,
    duration: row.duration || 0,
    src: "",
    cover: row.coverPath ? assetUrl(row.coverPath) : generatedCover(id, title),
    palette: paletteFromSeed(id),
    source: "local",
    format,
    quality,
    hiRes,
    addedAt: row.id,
    path: row.path,
    libraryId: row.id,
    cueStart: row.cueStart ?? undefined,
    cueEnd: row.cueEnd ?? undefined,
    unsupported: !isNativeDecodable(row.path),
  };
}

export async function fetchLibraryTracks(): Promise<Track[]> {
  if (!inTauri) return [];
  const rows: LibraryTrackRow[] = [];
  let offset = 0;
  while (offset < 50000) {
    const page = await invoke<TrackPage>("library_get_tracks", {
      search: null,
      sort: "default",
      limit: 1000,
      offset,
    });
    rows.push(...page.tracks);
    offset += page.tracks.length;
    if (!page.tracks.length || rows.length >= page.total) break;
  }
  return rows.map(libraryRowToTrack);
}

export const importLibraryFiles = (paths: string[]) =>
  invoke<void>("library_import_files", { paths });

export const importLibraryFolder = (path: string) =>
  invoke<void>("library_import_folder", { path });

export const removeLibraryTracks = (ids: number[]) =>
  invoke<void>("library_remove_tracks", { ids });

export const clearLibrary = () => invoke<void>("library_clear");

export const getLibraryStats = () => invoke<LibraryStats>("library_stats");

export const cancelLibraryScan = () => invoke<void>("library_cancel_scan");

export function subscribeScan(handler: (status: ScanStatus) => void): Promise<UnlistenFn> {
  if (!inTauri) return Promise.resolve(() => {});
  return tauriListen<ScanStatus>("scan://progress", handler);
}

export function subscribeLibraryChanged(handler: () => void): Promise<UnlistenFn> {
  if (!inTauri) return Promise.resolve(() => {});
  return tauriListen("library://changed", handler);
}

const lyricCache = new Map<string, string | null>();

function docToLrc(doc: LyricDoc): string {
  const lines = doc.lines.filter((line) => line.text.trim());
  if (!lines.length) return "";
  if (lines.every((line) => line.start != null)) {
    return lines
      .map((line) => {
        const t = Math.max(0, line.start ?? 0);
        const m = Math.floor(t / 60);
        const s = (t - m * 60).toFixed(2).padStart(5, "0");
        return `[${String(m).padStart(2, "0")}:${s}]${line.text.trim()}`;
      })
      .join("\n");
  }
  return lines.map((line) => line.text.trim()).join("\n");
}

export async function loadTrackLyrics(path: string): Promise<string | null> {
  if (!inTauri || !path) return null;
  if (lyricCache.has(path)) return lyricCache.get(path) ?? null;
  try {
    const doc = await invoke<LyricDoc | null>("lyrics_get", { path, encoding: null });
    const lrc = doc ? docToLrc(doc) : "";
    lyricCache.set(path, lrc || null);
    return lrc || null;
  } catch {
    lyricCache.set(path, null);
    return null;
  }
}
