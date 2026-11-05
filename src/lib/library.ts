import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { inTauri } from "./player";

export type LibraryTrack = {
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
};

export type TrackPage = {
  total: number;
  tracks: LibraryTrack[];
};

export type FolderRow = {
  id: number;
  path: string;
  lastScanAt: number | null;
  trackCount: number;
};

export type LibraryStats = {
  tracks: number;
  folders: number;
  albums: number;
  artists: number;
  totalDuration: number;
};

export type ScanStatus = {
  scanning: boolean;
  folder: string;
  scanned: number;
  imported: number;
  skipped: number;
  errors: number;
  current: string;
};

export type PlaylistRow = {
  id: number;
  name: string;
  createdAt: number;
  trackCount: number;
};

export type TrackQuery = {
  search?: string | null;
  sort?: string | null;
  limit?: number;
  offset?: number;
};

export const importFolder = (path: string) =>
  invoke<void>("library_import_folder", { path });

export const cancelScan = () => invoke<void>("library_cancel_scan");
export const getScanStatus = () => invoke<ScanStatus>("library_scan_status");
export const getTracks = (query: TrackQuery) =>
  invoke<TrackPage>("library_get_tracks", {
    search: query.search ?? null,
    sort: query.sort ?? null,
    limit: query.limit ?? 500,
    offset: query.offset ?? 0,
  });
export const getFolders = () => invoke<FolderRow[]>("library_get_folders");
export const getStats = () => invoke<LibraryStats>("library_stats");
export const getSettings = () => invoke<Record<string, string>>("settings_get_all");
export const setSetting = (key: string, value: string) =>
  invoke<void>("settings_set", { key, value });

export const subscribeScan = (onStatus: (status: ScanStatus) => void) =>
  listen<ScanStatus>("scan://progress", (event) => onStatus(event.payload));

export const subscribeLibraryChanged = (onChange: () => void) =>
  listen("library://changed", () => onChange());

export const getPlaylists = () => invoke<PlaylistRow[]>("playlist_list");
export const createPlaylist = (name: string) =>
  invoke<number>("playlist_create", { name });
export const renamePlaylist = (id: number, name: string) =>
  invoke<void>("playlist_rename", { id, name });
export const deletePlaylist = (id: number) =>
  invoke<void>("playlist_delete", { id });
export const addTrackToPlaylist = (playlistId: number, trackId: number) =>
  invoke<boolean>("playlist_add_track", { playlistId, trackId });
export const removeTrackFromPlaylist = (playlistId: number, trackId: number) =>
  invoke<void>("playlist_remove_track", { playlistId, trackId });
export const getPlaylistTracks = (playlistId: number) =>
  invoke<LibraryTrack[]>("playlist_get_tracks", { playlistId });

export function coverUrl(path: string | null | undefined): string | null {
  if (!path || !inTauri) return null;
  try {
    return convertFileSrc(path);
  } catch {
    return null;
  }
}

const ART_CLASSES = ["art-aurora", "art-circuit", "art-orbit", "art-winter", "art-tidal"];

export function coverArtClass(seed: number) {
  return ART_CLASSES[Math.abs(Math.trunc(seed)) % ART_CLASSES.length];
}
