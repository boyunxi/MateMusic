import { invoke } from "@tauri-apps/api/core";

export type PlaybackStateRow = {
  queueJson: string | null;
  currentIndex: number;
  mode: string | null;
  position: number;
};

export const getPlaybackState = () =>
  invoke<PlaybackStateRow | null>("playback_get_state");

export const savePlaybackState = (
  queueJson: string,
  currentIndex: number,
  mode: string,
  position: number,
) =>
  invoke<void>("playback_save_state", {
    queueJson,
    currentIndex,
    mode,
    position,
  });
