import { convertFileSrc, invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";

export const inTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const audioExtensions = [
  "mp3",
  "flac",
  "wav",
  "m4a",
  "aac",
  "ogg",
  "opus",
  "aiff",
  "aif",
  "alac",
  "ape",
  "wma",
  "dsf",
  "dff",
  "wv",
  "cue",
];

export function invoke<T>(command: string, args?: Record<string, unknown>) {
  return tauriInvoke<T>(command, args);
}

export function tauriListen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, (entry) => handler(entry.payload));
}

export function assetUrl(path: string): string {
  if (!path) return "";
  if (!inTauri) return path;
  try {
    return convertFileSrc(path);
  } catch {
    return path;
  }
}

export async function pickAudioFiles(): Promise<string[]> {
  if (!inTauri) return [];
  const selected = await open({
    multiple: true,
    directory: false,
    title: "导入音乐",
    filters: [{ name: "音频与歌词", extensions: audioExtensions }],
  });
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}

export async function pickMusicFolder(): Promise<string | null> {
  if (!inTauri) return null;
  const selected = await open({
    multiple: false,
    directory: true,
    title: "选择音乐文件夹",
  });
  return typeof selected === "string" ? selected : null;
}

export const appWindow = {
  minimize: () => getCurrentWindow().minimize(),
  toggleMaximize: () => getCurrentWindow().toggleMaximize(),
  isMaximized: () => getCurrentWindow().isMaximized(),
  close: () => getCurrentWindow().close(),
};

export type NativeDropEvent = {
  type: "enter" | "over" | "drop" | "leave";
  paths: string[];
};

export async function onNativeDrop(handler: (event: NativeDropEvent) => void): Promise<UnlistenFn> {
  if (!inTauri) return () => {};
  return getCurrentWebview().onDragDropEvent((event) => {
    handler(event.payload as NativeDropEvent);
  });
}
