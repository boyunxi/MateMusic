import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

export type PlayerSnapshot = {
  loaded: boolean;
  playing: boolean;
  position: number;
  duration: number;
  title: string;
  path: string;
  codec: string;
  sampleRate: number;
  bits: number | null;
  channels: number;
  outputMode: string;
  outputRate: number;
  outputChannels: number;
  outputFormat: string;
  device: string;
  underruns: number;
  finished: boolean;
  error: string | null;
  note: string | null;
};

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const AUDIO_EXTENSIONS = [
  "flac",
  "wav",
  "mp3",
  "m4a",
  "aac",
  "ogg",
  "opus",
  "aiff",
  "aif",
  "ape",
  "wma",
  "dsf",
  "dff",
];

export async function pickAudioFile(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    title: "选择音频文件",
    filters: [{ name: "音频", extensions: AUDIO_EXTENSIONS }],
  });
  return typeof selected === "string" ? selected : null;
}

export const loadTrack = (path: string) => invoke<void>("player_load", { path });
export const playTrack = () => invoke<void>("player_play");
export const pauseTrack = () => invoke<void>("player_pause");
export const seekTrack = (position: number) => invoke<void>("player_seek", { position });
export const setTrackVolume = (volume: number) => invoke<void>("player_set_volume", { volume });
export const setOutputMode = (mode: "exclusive" | "shared") =>
  invoke<void>("player_set_output_mode", { mode });
export const getPlayerState = () => invoke<PlayerSnapshot>("player_state");
export const subscribePlayer = (onState: (state: PlayerSnapshot) => void) =>
  listen<PlayerSnapshot>("playback://state", (event) => onState(event.payload));
