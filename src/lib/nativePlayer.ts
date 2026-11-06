import type { UnlistenFn } from "@tauri-apps/api/event";
import { inTauri, invoke, tauriListen } from "./tauri";

export type BitPerfectVerdict = "idle" | "bit-perfect" | "unverifiable" | "not-bit-perfect";

export interface NativeSnapshot {
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
  segmentStart: number;
  speed: number;
  volume: number;
  outputBits: number | null;
  bitPerfect: boolean;
  bitPerfectVerdict: BitPerfectVerdict;
  bitPerfectReasons: string[];
  error: string | null;
  note: string | null;
}

export type OutputMode = "shared" | "exclusive" | "asio";

export interface AsioStatus {
  enabled: boolean;
  driverFound: boolean;
  drivers: string[];
  message: string;
}

let latest: NativeSnapshot | null = null;

export const nativePlayer = {
  available: inTauri,
  get snapshot() {
    return latest;
  },
  get currentTime() {
    return latest?.position ?? 0;
  },
  get playing() {
    return latest?.playing ?? false;
  },
  async load(path: string, options: { startAt?: number; cueStart?: number | null; cueEnd?: number | null; autoplay?: boolean } = {}) {
    await invoke("player_load", {
      path,
      start: options.cueStart ?? options.startAt ?? null,
      end: options.cueEnd ?? null,
      autoplay: options.autoplay ?? true,
    });
  },
  play: () => invoke<void>("player_play"),
  pause: () => invoke<void>("player_pause"),
  seek: (position: number) => invoke<void>("player_seek", { position }),
  setVolume: (volume: number) => invoke<void>("player_set_volume", { volume }),
  setSpeed: (speed: number) => invoke<void>("player_set_speed", { speed }),
  setOutputMode: (mode: OutputMode) => invoke<void>("player_set_output_mode", { mode }),
  getState: () => invoke<NativeSnapshot>("player_state"),
  setMetadata: (title: string, artist: string, album: string) =>
    invoke<void>("smtc_set_metadata", { title, artist, album }),
  smtcAvailable: () => invoke<boolean>("smtc_available"),
  asioStatus: () => invoke<AsioStatus>("audio_asio_status"),
  async subscribe(handler: (snapshot: NativeSnapshot) => void): Promise<UnlistenFn> {
    if (!inTauri) return () => {};
    const unlisten = await tauriListen<NativeSnapshot>("playback://state", (snapshot) => {
      latest = snapshot;
      handler(snapshot);
    });
    latest = await this.getState();
    return unlisten;
  },
  async subscribeShortcut(handler: (action: string) => void): Promise<UnlistenFn> {
    if (!inTauri) return () => {};
    return tauriListen<string>("shortcut://action", handler);
  },
};
