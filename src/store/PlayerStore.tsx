import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import type { LoopMode, NavKey, Settings, Toast, Track } from "../types";
import { PRESET_TRACKS } from "../data/presets";
import { getEngine } from "../lib/audioEngine";
import { db, type StoredTrack } from "../lib/db";
import { parseFileName, parseMetadata, probeDuration } from "../lib/metadata";
import { extractPalette, generatedCover, hashString, paletteFromSeed } from "../lib/utils";
import { inTauri, pickAudioFiles, pickMusicFolder } from "../lib/tauri";
import { enterMiniWindow, exitMiniWindow } from "../lib/windowBounds";
import { nativePlayer, type NativeSnapshot, type OutputMode } from "../lib/nativePlayer";
import {
  clearLibrary,
  fetchLibraryTracks,
  importLibraryFiles,
  importLibraryFolder,
  loadTrackLyrics,
  removeLibraryTracks,
  subscribeLibraryChanged,
  subscribeScan,
} from "../lib/nativeLibrary";

/* ------------------------------------------------------------------ */
/*  Defaults                                                           */
/* ------------------------------------------------------------------ */

export const DEFAULT_SETTINGS: Settings = {
  restoreSession: true,
  rememberProgress: true,
  defaultRate: 1,
  closeBehavior: "sleep",
  doubleClickAction: "play",
  outputDeviceId: "",
  outputMode: "shared",
  normalize: false,
  preservePitch: true,
  fade: true,
  fadeMs: 400,
  eqEnabled: true,
  eqPreset: "flat",
  eqBands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  preamp: 0,
  shortcutsEnabled: true,
  blur: 40,
  glassAlpha: 0.07,
  accent: "cover",
  ambientIntensity: 0.85,
  dynamicBackground: true,
  reduceMotion: false,
  lyricSize: 26,
  dockStyle: "floating",
  showSpectrum: true,
};

export const ACCENTS: Record<Exclude<Settings["accent"], "cover">, { name: string; a: string; b: string }> = {
  aurora: { name: "极光紫", a: "#a78bfa", b: "#22d3ee" },
  amber: { name: "琥珀暖", a: "#fbbf24", b: "#fb7185" },
  glacier: { name: "冰川冷", a: "#38bdf8", b: "#818cf8" },
  mint: { name: "薄荷青", a: "#34d399", b: "#22d3ee" },
  rose: { name: "玫瑰粉", a: "#fb7185", b: "#c084fc" },
};

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

export type WindowMode = "normal" | "mini" | "sleep";

export interface PlayerState {
  tracks: Track[];
  localLoaded: boolean;
  queue: string[];
  currentId: string | null;
  isPlaying: boolean;
  waiting: boolean;
  loopMode: LoopMode;
  volume: number;
  muted: boolean;
  rate: number;
  liked: string[];
  recent: string[];
  nav: NavKey;
  activePlaylist: string | null;
  sidebarCollapsed: boolean;
  immersive: boolean;
  queueOpen: boolean;
  settingsOpen: boolean;
  settingsMinimized: boolean;
  floatingLyrics: boolean;
  search: string;
  windowMode: WindowMode;
  settings: Settings;
  toasts: Toast[];
  importing: { total: number; done: number } | null;
  nativeActive: boolean;
  native: NativeSnapshot | null;
}

type Action =
  | { type: "PATCH"; patch: Partial<PlayerState> }
  | { type: "SETTINGS"; patch: Partial<Settings> }
  | { type: "ADD_TRACKS"; tracks: Track[] }
  | { type: "SYNC_LIBRARY"; tracks: Track[] }
  | { type: "REMOVE_TRACKS"; ids: string[] }
  | { type: "UPDATE_TRACK"; id: string; patch: Partial<Track> }
  | { type: "PLAY_START"; id: string }
  | { type: "TOGGLE_LIKE"; id: string }
  | { type: "QUEUE_SET"; ids: string[] }
  | { type: "QUEUE_ADD"; ids: string[] }
  | { type: "QUEUE_NEXT"; id: string }
  | { type: "QUEUE_REMOVE"; id: string }
  | { type: "TOAST_ADD"; toast: Toast }
  | { type: "TOAST_REMOVE"; id: number };

function reducer(s: PlayerState, a: Action): PlayerState {
  switch (a.type) {
    case "PATCH":
      return { ...s, ...a.patch };
    case "SETTINGS":
      return { ...s, settings: { ...s.settings, ...a.patch } };
    case "ADD_TRACKS": {
      const exist = new Set(s.tracks.map((t) => t.id));
      const fresh = a.tracks.filter((t) => !exist.has(t.id));
      return { ...s, tracks: [...s.tracks, ...fresh] };
    }
    case "SYNC_LIBRARY": {
      const keep = s.tracks.filter((t) => !t.id.startsWith("lib-"));
      const tracks = [...keep, ...a.tracks];
      const ids = new Set(tracks.map((t) => t.id));
      return {
        ...s,
        tracks,
        queue: s.queue.filter((id) => ids.has(id)),
        liked: s.liked.filter((id) => ids.has(id)),
        recent: s.recent.filter((id) => ids.has(id)),
        currentId: s.currentId && !ids.has(s.currentId) ? null : s.currentId,
      };
    }
    case "REMOVE_TRACKS": {
      const del = new Set(a.ids);
      return {
        ...s,
        tracks: s.tracks.filter((t) => !del.has(t.id)),
        queue: s.queue.filter((id) => !del.has(id)),
        liked: s.liked.filter((id) => !del.has(id)),
        recent: s.recent.filter((id) => !del.has(id)),
        currentId: s.currentId && del.has(s.currentId) ? null : s.currentId,
      };
    }
    case "UPDATE_TRACK":
      return { ...s, tracks: s.tracks.map((t) => (t.id === a.id ? { ...t, ...a.patch } : t)) };
    case "PLAY_START":
      return { ...s, currentId: a.id, recent: [a.id, ...s.recent.filter((r) => r !== a.id)].slice(0, 60) };
    case "TOGGLE_LIKE":
      return { ...s, liked: s.liked.includes(a.id) ? s.liked.filter((x) => x !== a.id) : [a.id, ...s.liked] };
    case "QUEUE_SET":
      return { ...s, queue: [...new Set(a.ids)] };
    case "QUEUE_ADD":
      return { ...s, queue: [...s.queue, ...a.ids.filter((id) => !s.queue.includes(id))] };
    case "QUEUE_NEXT": {
      const q = s.queue.filter((x) => x !== a.id);
      const idx = s.currentId ? q.indexOf(s.currentId) : -1;
      q.splice(idx + 1, 0, a.id);
      return { ...s, queue: q };
    }
    case "QUEUE_REMOVE":
      return { ...s, queue: s.queue.filter((x) => x !== a.id) };
    case "TOAST_ADD":
      return { ...s, toasts: [...s.toasts.slice(-3), a.toast] };
    case "TOAST_REMOVE":
      return { ...s, toasts: s.toasts.filter((t) => t.id !== a.id) };
  }
}

const LS_KEY = "matemusic:state:v1";
const LS_TIME = "matemusic:time:v1";
const LS_AUDIO_MODE_MIGRATION = "matemusic:audio-mode-migration:v1";

function loadPersisted(): Partial<PlayerState> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw);
    const settings = { ...DEFAULT_SETTINGS, ...(p.settings || {}) };
    // The previous build defaulted to WASAPI exclusive, which locks the sound
    // card and stalls browser video playback. Move existing installs to shared
    // once; users can still opt back into exclusive explicitly.
    if (!localStorage.getItem(LS_AUDIO_MODE_MIGRATION)) {
      if (settings.outputMode === "exclusive") settings.outputMode = "shared";
      localStorage.setItem(LS_AUDIO_MODE_MIGRATION, "1");
    }
    return { ...p, settings };
  } catch {
    return {};
  }
}

function initState(): PlayerState {
  const p = loadPersisted();
  return {
    tracks: PRESET_TRACKS,
    localLoaded: false,
    queue: p.queue?.length ? p.queue : PRESET_TRACKS.map((t) => t.id),
    currentId: p.currentId ?? null,
    isPlaying: false,
    waiting: false,
    loopMode: p.loopMode ?? "list",
    volume: p.volume ?? 0.8,
    muted: p.muted ?? false,
    rate: p.rate ?? (p.settings?.defaultRate || 1),
    liked: p.liked ?? ["preset-disco-lounge"],
    recent: p.recent ?? [],
    nav: "library",
    activePlaylist: null,
    sidebarCollapsed: p.sidebarCollapsed ?? false,
    immersive: false,
    queueOpen: false,
    settingsOpen: false,
    settingsMinimized: false,
    floatingLyrics: p.floatingLyrics ?? false,
    search: "",
    windowMode: "normal",
    settings: p.settings ?? DEFAULT_SETTINGS,
    toasts: [],
    importing: null,
    nativeActive: false,
    native: null,
  };
}

function lighten(hex: string, minL = 0.6): string {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16) / 255, g = parseInt(m.slice(2, 4), 16) / 255, b = parseInt(m.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  let l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  l = Math.max(l, minL);
  s = Math.max(s, 0.55);
  return `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
}

/* ------------------------------------------------------------------ */
/*  Contexts                                                           */
/* ------------------------------------------------------------------ */

export interface TimeState {
  currentTime: number;
  duration: number;
  buffered: number;
}

type Actions = ReturnType<typeof useBuildActions>;

const StateCtx = createContext<PlayerState | null>(null);
const ActionsCtx = createContext<Actions | null>(null);
const TimeCtx = createContext<TimeState>({ currentTime: 0, duration: 0, buffered: 0 });

export const usePlayer = () => useContext(StateCtx)!;
export const useActions = () => useContext(ActionsCtx)!;
export const useTime = () => useContext(TimeCtx);
export function useCurrentTrack(): Track | null {
  const s = usePlayer();
  return useMemo(() => s.tracks.find((t) => t.id === s.currentId) ?? null, [s.tracks, s.currentId]);
}

const AUDIO_RE = /\.(mp3|flac|wav|m4a|aac|ogg|opus|webm)$/i;

function useBuildActions(dispatch: React.Dispatch<Action>, stateRef: React.MutableRefObject<PlayerState>) {
  const history = useRef<string[]>([]);
  const toastSeq = useRef(1);

  return useMemo(() => {
    const engine = getEngine();
    const S = () => stateRef.current;
    const find = (id: string | null) => (id ? S().tracks.find((t) => t.id === id) : undefined);
    const playable = (t?: Track) => !!t;

    const toast = (text: string, tone: Toast["tone"] = "info") => {
      const id = toastSeq.current++;
      dispatch({ type: "TOAST_ADD", toast: { id, text, tone } });
      window.setTimeout(() => dispatch({ type: "TOAST_REMOVE", id }), 3200);
    };

    const startTrack = (id: string, autoplay = true, startAt = 0) => {
      const t = find(id);
      if (!t) return;
      dispatch({ type: "PLAY_START", id });
      if (inTauri && t.path) {
        engine.stop();
        dispatch({ type: "PATCH", patch: { nativeActive: true } });
        void nativePlayer
          .load(t.path, { autoplay, startAt, cueStart: t.cueStart, cueEnd: t.cueEnd })
          .catch((error) => toast(String(error), "error"));
        if (!t.lrc) {
          void loadTrackLyrics(t.path).then((lrc) => {
            if (lrc) dispatch({ type: "UPDATE_TRACK", id: t.id, patch: { lrc } });
          });
        }
      } else {
        if (stateRef.current.nativeActive) void nativePlayer.pause();
        dispatch({ type: "PATCH", patch: { nativeActive: false } });
        engine.load(t.src, { autoplay, startAt });
      }
    };

    const isLoaded = () =>
      stateRef.current.nativeActive
        ? !!nativePlayer.snapshot?.loaded
        : !!engine.element.getAttribute("src");

    const playTrack = (id: string, context?: string[]) => {
      if (context && context.length) dispatch({ type: "QUEUE_SET", ids: context });
      else if (!S().queue.includes(id)) dispatch({ type: "QUEUE_NEXT", id });
      const cur = S().currentId;
      if (cur && cur !== id) history.current.push(cur);
      if (cur === id && isLoaded()) {
        if (S().nativeActive) {
          void nativePlayer.seek(0).then(() => nativePlayer.play());
        } else {
          engine.seek(0);
          void engine.play();
        }
        return;
      }
      startTrack(id);
    };

    const validQueue = () => S().queue.filter((id) => playable(find(id)));

    const next = (auto = false) => {
      const s = S();
      const list = validQueue();
      if (!list.length) return;
      if (auto && s.loopMode === "one" && s.currentId) {
        if (s.nativeActive) {
          void nativePlayer.seek(0).then(() => nativePlayer.play());
        } else {
          engine.seek(0);
          void engine.play();
        }
        return;
      }
      let nextId: string;
      if (s.loopMode === "shuffle" && list.length > 1) {
        const pool = list.filter((x) => x !== s.currentId);
        nextId = pool[Math.floor(Math.random() * pool.length)];
      } else {
        const idx = s.currentId ? list.indexOf(s.currentId) : -1;
        nextId = list[(idx + 1) % list.length];
      }
      if (s.currentId) history.current.push(s.currentId);
      if (history.current.length > 100) history.current.shift();
      startTrack(nextId);
    };

    const prev = () => {
      const s = S();
      const time = s.nativeActive ? nativePlayer.currentTime : engine.currentTime;
      if (time > 3) {
        if (s.nativeActive) void nativePlayer.seek(0);
        else engine.seek(0);
        return;
      }
      const list = validQueue();
      if (!list.length) return;
      let prevId: string | undefined;
      if (s.loopMode === "shuffle") {
        while (history.current.length && !prevId) {
          const h = history.current.pop()!;
          if (find(h)) prevId = h;
        }
      }
      if (!prevId) {
        const idx = s.currentId ? list.indexOf(s.currentId) : 0;
        prevId = list[(idx - 1 + list.length) % list.length];
      }
      startTrack(prevId);
    };

    const togglePlay = () => {
      const s = S();
      if (!s.currentId || !isLoaded()) {
        const cur = s.currentId ? find(s.currentId) : undefined;
        const id = playable(cur) ? cur!.id : validQueue()[0] || s.tracks.find((t) => playable(t))?.id;
        if (id) startTrack(id);
        return;
      }
      if (s.nativeActive) {
        if (s.isPlaying) void nativePlayer.pause();
        else void nativePlayer.play();
        return;
      }
      engine.toggle();
    };

    const importFiles = async (input: FileList | File[]) => {
      const files = Array.from(input);
      const audio = files.filter((f) => AUDIO_RE.test(f.name) || f.type.startsWith("audio/"));
      const lrcFiles = files.filter((f) => /\.lrc$/i.test(f.name));
      const lrcMap = new Map<string, string>();
      for (const f of lrcFiles) lrcMap.set(f.name.replace(/\.lrc$/i, "").toLowerCase(), await f.text());

      if (!audio.length) {
        if (lrcMap.size) {
          let matched = 0;
          for (const [base, text] of lrcMap) {
            const t = S().tracks.find((x) => x.title.toLowerCase() === base || `${x.artist} - ${x.title}`.toLowerCase() === base);
            if (t) {
              matched++;
              setLyrics(t.id, text);
            }
          }
          toast(matched ? `已为 ${matched} 首歌曲匹配歌词` : "未找到可匹配的歌曲，请与音频文件一同导入", matched ? "success" : "error");
        } else toast("未检测到受支持的音频文件（mp3 / flac / wav）", "error");
        return;
      }

      dispatch({ type: "PATCH", patch: { importing: { total: audio.length, done: 0 } } });
      const added: Track[] = [];
      let skipped = 0;
      for (let i = 0; i < audio.length; i++) {
        const f = audio[i];
        const id = `local-${hashString(`${f.name}:${f.size}`).toString(36)}`;
        if (S().tracks.some((t) => t.id === id) || added.some((t) => t.id === id)) {
          skipped++;
          dispatch({ type: "PATCH", patch: { importing: { total: audio.length, done: i + 1 } } });
          continue;
        }
        const meta = await parseMetadata(f);
        const fromName = parseFileName(f.name);
        const title = meta.title || fromName.title;
        const artist = meta.artist || fromName.artist || "未知艺术家";
        const album = meta.album || "本地音乐";
        const src = URL.createObjectURL(f);
        const duration = await probeDuration(src);
        const coverUrl = meta.picture ? URL.createObjectURL(meta.picture) : generatedCover(id, title);
        const palette = (meta.picture ? await extractPalette(coverUrl) : null) || paletteFromSeed(id);
        const ext = (f.name.split(".").pop() || "audio").toUpperCase();
        let quality = "";
        let hiRes = false;
        if (ext === "FLAC" || ext === "WAV") {
          const bits = meta.bitsPerSample || 16;
          const sr = meta.sampleRate || 44100;
          hiRes = bits > 16 || sr > 48000;
          quality = `${bits}bit / ${(sr / 1000).toFixed(sr % 1000 ? 1 : 0)}kHz`;
        } else if (duration > 0) {
          quality = `${Math.round((f.size * 8) / duration / 1000)} kbps`;
        } else quality = "Unknown";
        const base = f.name.replace(/\.[^.]+$/, "").toLowerCase();
        const lrc = lrcMap.get(base) || (meta.lyrics && /\[\d{1,2}:\d{1,2}/.test(meta.lyrics) ? meta.lyrics : undefined);
        const track: Track = {
          id, title, artist, album, duration, src, cover: coverUrl, palette, lrc,
          source: "local", format: ext, quality, hiRes, addedAt: Date.now() + i, fileSize: f.size,
        };
        added.push(track);
        const rec: StoredTrack = {
          id, title, artist, album, duration, palette, lrc, source: "local", format: ext, quality, hiRes,
          addedAt: track.addedAt, fileSize: f.size, blob: f, coverBlob: meta.picture,
          coverFallback: meta.picture ? undefined : coverUrl,
        };
        void db.put(rec);
        dispatch({ type: "PATCH", patch: { importing: { total: audio.length, done: i + 1 } } });
      }
      if (added.length) {
        dispatch({ type: "ADD_TRACKS", tracks: added });
        dispatch({ type: "QUEUE_ADD", ids: added.map((t) => t.id) });
      }
      dispatch({ type: "PATCH", patch: { importing: null } });
      if (added.length) toast(`成功导入 ${added.length} 首本地音乐${skipped ? `，跳过 ${skipped} 首重复` : ""}`, "success");
      else if (skipped) toast(`${skipped} 首歌曲已存在于曲库`, "info");
      if (added.length && !S().currentId) startTrack(added[0].id, false);
    };

    const setLyrics = (id: string, lrc: string) => {
      dispatch({ type: "UPDATE_TRACK", id, patch: { lrc } });
      if (id.startsWith("local-")) void db.patch(id, { lrc });
    };

    const removeTracks = (ids: string[]) => {
      const s = S();
      const targets = ids.map((id) => find(id)).filter((t): t is Track => !!t);
      const nativeIds = targets.filter((t) => t.libraryId).map((t) => t.libraryId!);
      const locals = targets.filter((t) => t.source === "local").map((t) => t.id);
      if (!locals.length) return;
      if (nativeIds.length && inTauri) {
        void removeLibraryTracks(nativeIds).catch((error) => toast(String(error), "error"));
      }
      if (s.currentId && locals.includes(s.currentId)) {
        if (s.nativeActive) {
          void nativePlayer.pause();
          dispatch({ type: "PATCH", patch: { nativeActive: false } });
        } else {
          engine.stop();
        }
      }
      for (const id of locals) {
        const t = find(id);
        if (t) {
          if (t.src.startsWith("blob:")) URL.revokeObjectURL(t.src);
          if (t.cover.startsWith("blob:")) URL.revokeObjectURL(t.cover);
        }
        void db.remove(id);
      }
      dispatch({ type: "REMOVE_TRACKS", ids: locals });
      toast(`已从曲库移除 ${locals.length} 首本地歌曲`, "info");
    };

    const refreshLibrary = async (): Promise<Track[]> => {
      if (!inTauri) return [];
      try {
        const locals = await fetchLibraryTracks();
        dispatch({ type: "SYNC_LIBRARY", tracks: locals });
        dispatch({ type: "PATCH", patch: { localLoaded: true } });
        return locals;
      } catch (error) {
        toast(`读取曲库失败：${String(error)}`, "error");
        return [];
      }
    };

    const importPaths = async (paths: string[]) => {
      if (!inTauri || !paths.length) return;
      dispatch({ type: "PATCH", patch: { importing: { total: paths.length, done: 0 } } });
      try {
        await importLibraryFiles(paths);
        toast(`正在导入 ${paths.length} 个文件…`);
      } catch (error) {
        dispatch({ type: "PATCH", patch: { importing: null } });
        toast(String(error), "error");
      }
    };

    const pickFiles = async () => {
      if (!inTauri) {
        document.getElementById("mm-file-input")?.click();
        return;
      }
      try {
        const paths = await pickAudioFiles();
        if (paths.length) await importPaths(paths);
      } catch (error) {
        toast(String(error), "error");
      }
    };

    const pickFolder = async () => {
      if (!inTauri) {
        toast("浏览器模式请直接选择音频文件", "error");
        return;
      }
      try {
        const path = await pickMusicFolder();
        if (!path) return;
        dispatch({ type: "PATCH", patch: { importing: { total: 1, done: 0 } } });
        await importLibraryFolder(path);
        toast("正在扫描音乐文件夹…");
      } catch (error) {
        dispatch({ type: "PATCH", patch: { importing: null } });
        toast(String(error), "error");
      }
    };

    return {
      toast,
      playTrack,
      togglePlay,
      next,
      prev,
      seek: (t: number) => {
        if (S().nativeActive) void nativePlayer.seek(t);
        else engine.seek(t);
      },
      seekBy: (d: number) => {
        const base = S().nativeActive ? nativePlayer.currentTime : engine.currentTime;
        const t = Math.max(0, base + d);
        if (S().nativeActive) void nativePlayer.seek(t);
        else engine.seek(t);
      },
      setVolume: (v: number) => dispatch({ type: "PATCH", patch: { volume: Math.max(0, Math.min(1, v)), muted: false } }),
      nudgeVolume: (d: number) => {
        const v = Math.max(0, Math.min(1, S().volume + d));
        dispatch({ type: "PATCH", patch: { volume: v, muted: false } });
      },
      toggleMute: () => dispatch({ type: "PATCH", patch: { muted: !S().muted } }),
      setRate: (rate: number) => dispatch({ type: "PATCH", patch: { rate } }),
      setOutputMode: (mode: OutputMode) => {
        dispatch({ type: "SETTINGS", patch: { outputMode: mode } });
        if (!inTauri) return;
        void nativePlayer
          .setOutputMode(mode)
          .then(() =>
            toast(
              mode === "exclusive"
                ? "已切换独占输出：声卡被独占，其他应用可能无声或视频卡顿"
                : mode === "asio"
                  ? "已切换 ASIO 输出"
                  : "已切换共享输出，可与其他应用同时播放",
              mode === "exclusive" ? "info" : "success",
            ),
          )
          .catch((error) => toast(String(error), "error"));
      },
      setLoop: (loopMode: LoopMode) => dispatch({ type: "PATCH", patch: { loopMode } }),
      cycleLoop: () => {
        const order: LoopMode[] = ["list", "one", "shuffle"];
        const nextMode = order[(order.indexOf(S().loopMode) + 1) % order.length];
        dispatch({ type: "PATCH", patch: { loopMode: nextMode } });
        toast(nextMode === "list" ? "列表循环" : nextMode === "one" ? "单曲循环" : "随机播放");
      },
      toggleShuffle: () => dispatch({ type: "PATCH", patch: { loopMode: S().loopMode === "shuffle" ? "list" : "shuffle" } }),
      toggleLike: (id: string) => {
        const liked = S().liked.includes(id);
        dispatch({ type: "TOGGLE_LIKE", id });
        toast(liked ? "已取消喜欢" : "已添加到「我喜欢的」", liked ? "info" : "success");
      },
      addToQueue: (ids: string[]) => {
        dispatch({ type: "QUEUE_ADD", ids });
        toast(`已加入播放队列（${ids.length} 首）`, "success");
      },
      playNext: (id: string) => {
        dispatch({ type: "QUEUE_NEXT", id });
        toast("将在下一首播放", "success");
      },
      removeFromQueue: (id: string) => dispatch({ type: "QUEUE_REMOVE", id }),
      reorderQueue: (ids: string[]) => dispatch({ type: "QUEUE_SET", ids }),
      clearQueue: () => {
        const cur = S().currentId;
        dispatch({ type: "QUEUE_SET", ids: cur ? [cur] : [] });
        toast("已清空播放队列");
      },
      importFiles,
      importPaths,
      pickFiles,
      pickFolder,
      refreshLibrary,
      setLyrics,
      removeTracks,
      clearLocal: async () => {
        const ids = S().tracks.filter((t) => t.source === "local").map((t) => t.id);
        if (S().nativeActive) {
          void nativePlayer.pause();
          dispatch({ type: "PATCH", patch: { nativeActive: false } });
        }
        if (inTauri) {
          try {
            await clearLibrary();
          } catch (error) {
            toast(String(error), "error");
          }
        }
        await db.clear();
        if (ids.length) dispatch({ type: "REMOVE_TRACKS", ids });
        toast("已清空本地曲库", "info");
      },
      clearRecent: () => {
        dispatch({ type: "PATCH", patch: { recent: [] } });
        toast("已清空最近播放记录");
      },
      setNav: (nav: NavKey) => dispatch({ type: "PATCH", patch: { nav, activePlaylist: null } }),
      openPlaylist: (id: string | null) => dispatch({ type: "PATCH", patch: { nav: "playlists", activePlaylist: id } }),
      toggleSidebar: () => dispatch({ type: "PATCH", patch: { sidebarCollapsed: !S().sidebarCollapsed } }),
      setImmersive: (immersive: boolean) => dispatch({ type: "PATCH", patch: { immersive } }),
      toggleImmersive: () => dispatch({ type: "PATCH", patch: { immersive: !S().immersive } }),
      toggleQueue: () => dispatch({ type: "PATCH", patch: { queueOpen: !S().queueOpen } }),
      setQueueOpen: (queueOpen: boolean) => dispatch({ type: "PATCH", patch: { queueOpen } }),
      openSettings: () => dispatch({ type: "PATCH", patch: { settingsOpen: true, settingsMinimized: false } }),
      closeSettings: () => dispatch({ type: "PATCH", patch: { settingsOpen: false, settingsMinimized: false } }),
      minimizeSettings: (v: boolean) => dispatch({ type: "PATCH", patch: { settingsMinimized: v } }),
      setSearch: (search: string) => {
        const patch: Partial<PlayerState> = { search };
        if (search && S().nav === "playlists" && !S().activePlaylist) patch.nav = "library";
        dispatch({ type: "PATCH", patch });
      },
      toggleFloatingLyrics: () => dispatch({ type: "PATCH", patch: { floatingLyrics: !S().floatingLyrics } }),
      setWindowMode: (windowMode: WindowMode) => {
        const previous = S().windowMode;
        if (inTauri) {
          if (windowMode === "mini") void enterMiniWindow();
          else if (previous === "mini") void exitMiniWindow();
        }
        if (windowMode === "sleep") {
          engine.pause();
          if (S().nativeActive) void nativePlayer.pause();
        }
        dispatch({ type: "PATCH", patch: { windowMode, immersive: windowMode === "normal" ? S().immersive : false } });
      },
      updateSettings: (patch: Partial<Settings>) => dispatch({ type: "SETTINGS", patch }),
      resetSettings: () => {
        dispatch({ type: "SETTINGS", patch: DEFAULT_SETTINGS });
        toast("已恢复默认设置", "success");
      },
      startTrack,
    };
  }, [dispatch, stateRef]);
}

/* ------------------------------------------------------------------ */
/*  Provider                                                           */
/* ------------------------------------------------------------------ */

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, initState);
  const [time, setTime] = useState<TimeState>({ currentTime: 0, duration: 0, buffered: 0 });
  const stateRef = useRef(state);
  stateRef.current = state;
  const actions = useBuildActions(dispatch, stateRef);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const restored = useRef(false);

  // Engine → state wiring
  useEffect(() => {
    const engine = getEngine();
    let lastSave = 0;
    engine.on({
      time: (t) => {
        setTime((p) => (Math.abs(p.currentTime - t) < 0.01 ? p : { ...p, currentTime: t }));
        const now = Date.now();
        if (now - lastSave > 3000) {
          lastSave = now;
          try {
            localStorage.setItem(LS_TIME, JSON.stringify({ id: stateRef.current.currentId, t }));
          } catch {
            /* quota */
          }
        }
      },
      duration: (d) => {
        setTime((p) => ({ ...p, duration: d }));
        const s = stateRef.current;
        const cur = s.tracks.find((t) => t.id === s.currentId);
        if (cur && d > 0 && Math.abs(cur.duration - d) > 1) dispatch({ type: "UPDATE_TRACK", id: cur.id, patch: { duration: d } });
      },
      buffered: (b) => setTime((p) => (Math.abs(p.buffered - b) < 0.5 ? p : { ...p, buffered: b })),
      playing: (p) => dispatch({ type: "PATCH", patch: { isPlaying: p } }),
      waiting: (w) => dispatch({ type: "PATCH", patch: { waiting: w } }),
      ended: () => actionsRef.current.next(true),
      error: (msg) => actionsRef.current.toast(msg, "error"),
    });
  }, []);

  // Load local library from IndexedDB, then restore session (browser mode only)
  useEffect(() => {
    if (inTauri) return;
    if (restored.current) return;
    restored.current = true;
    (async () => {
      const recs = await db.all();
      const locals: Track[] = recs.map((r) => {
        const { blob, coverBlob, coverFallback, ...rest } = r;
        return {
          ...rest,
          src: URL.createObjectURL(blob),
          cover: coverBlob ? URL.createObjectURL(coverBlob) : coverFallback || generatedCover(r.id, r.title),
        };
      });
      if (locals.length) dispatch({ type: "ADD_TRACKS", tracks: locals });
      dispatch({ type: "PATCH", patch: { localLoaded: true } });
      const s = stateRef.current;
      const all = [...s.tracks, ...locals];
      const ids = new Set(all.map((t) => t.id));
      dispatch({ type: "QUEUE_SET", ids: s.queue.filter((q) => ids.has(q)) });
      dispatch({ type: "PATCH", patch: { liked: s.liked.filter((q) => ids.has(q)), recent: s.recent.filter((q) => ids.has(q)) } });
      const cur = all.find((t) => t.id === s.currentId);
      if (cur && s.settings.restoreSession) {
        let at = 0;
        try {
          const saved = JSON.parse(localStorage.getItem(LS_TIME) || "null");
          if (s.settings.rememberProgress && saved?.id === cur.id) at = saved.t || 0;
        } catch {
          /* noop */
        }
        getEngine().load(cur.src, { autoplay: false, startAt: at });
      } else if (!cur) {
        dispatch({ type: "PATCH", patch: { currentId: null } });
      }
    })();
  }, []);

  // Native (Rust) playback state
  useEffect(() => {
    if (!inTauri) return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    let lastError = "";
    let lastInfo = "";
    let wasFinished = false;
    void nativePlayer
      .subscribe((snap) => {
        if (!alive) return;
        const s = stateRef.current;
        const cur = s.tracks.find((t) => t.id === s.currentId);
        if (!cur?.path || cur.path !== snap.path) return;
        if (!s.nativeActive) dispatch({ type: "PATCH", patch: { nativeActive: true } });
        setTime({ currentTime: snap.position, duration: snap.duration, buffered: 0 });
        dispatch({ type: "PATCH", patch: { isPlaying: snap.playing, waiting: false } });
        if (snap.duration > 0 && Math.abs(cur.duration - snap.duration) > 1) {
          dispatch({ type: "UPDATE_TRACK", id: cur.id, patch: { duration: snap.duration } });
        }
        const info = [snap.loaded, snap.playing, snap.device, snap.outputMode, snap.outputRate, snap.outputBits, snap.bitPerfectVerdict, snap.error, snap.note].join("|");
        if (info !== lastInfo) {
          lastInfo = info;
          dispatch({ type: "PATCH", patch: { native: snap } });
        }
        if (snap.error && snap.error !== lastError) {
          lastError = snap.error;
          actionsRef.current.toast(snap.error, "error");
        }
        if (snap.finished && !wasFinished) actionsRef.current.next(true);
        wasFinished = snap.finished;
      })
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // Native library (SQLite) sync + session restore
  const nativeRestored = useRef(false);
  useEffect(() => {
    if (!inTauri) return;
    let alive = true;
    let refreshTimer = 0;
    const unlisteners: (() => void)[] = [];
    const refresh = () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        if (alive) void actionsRef.current.refreshLibrary();
      }, 250);
    };
    void subscribeScan((status) => {
      if (!alive) return;
      if (status.scanning) {
        dispatch({
          type: "PATCH",
          patch: { importing: { total: Math.max(status.scanned, 1), done: status.imported + status.skipped } },
        });
      } else {
        dispatch({ type: "PATCH", patch: { importing: null } });
        refresh();
        if (status.imported || status.skipped) {
          actionsRef.current.toast(
            `导入完成：新增 ${status.imported} 首${status.skipped ? `，跳过 ${status.skipped} 首重复` : ""}`,
            "success",
          );
        } else if (status.errors) {
          actionsRef.current.toast(`导入结束，${status.errors} 个文件解析失败`, "error");
        }
      }
    }).then((fn) => (alive ? unlisteners.push(fn) : fn()));
    void subscribeLibraryChanged(refresh).then((fn) => (alive ? unlisteners.push(fn) : fn()));

    void (async () => {
      const locals = await actionsRef.current.refreshLibrary();
      if (!alive || nativeRestored.current) return;
      nativeRestored.current = true;
      const s = stateRef.current;
      void nativePlayer.setOutputMode(s.settings.outputMode).catch(() => {});
      const all = [...s.tracks, ...locals];
      const cur = all.find((t) => t.id === s.currentId);
      if (cur && s.settings.restoreSession) {
        let at = 0;
        try {
          const saved = JSON.parse(localStorage.getItem(LS_TIME) || "null");
          if (s.settings.rememberProgress && saved?.id === cur.id) at = saved.t || 0;
        } catch {
          /* noop */
        }
        if (cur.path) {
          dispatch({ type: "PATCH", patch: { nativeActive: true } });
          void nativePlayer.load(cur.path, { autoplay: false, startAt: at, cueStart: cur.cueStart, cueEnd: cur.cueEnd });
          if (!cur.lrc) {
            void loadTrackLyrics(cur.path).then((lrc) => {
              if (lrc) dispatch({ type: "UPDATE_TRACK", id: cur.id, patch: { lrc } });
            });
          }
        } else if (cur.src) {
          dispatch({ type: "PATCH", patch: { nativeActive: false } });
          getEngine().load(cur.src, { autoplay: false, startAt: at });
        }
      } else if (!cur) {
        dispatch({ type: "PATCH", patch: { currentId: null } });
      }
    })();

    return () => {
      alive = false;
      window.clearTimeout(refreshTimer);
      for (const fn of unlisteners) fn();
    };
  }, []);

  // Global media shortcuts emitted by the Rust hotkey thread / SMTC
  useEffect(() => {
    if (!inTauri || !state.settings.shortcutsEnabled) return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    void nativePlayer
      .subscribeShortcut((action) => {
        const a = actionsRef.current;
        if (action === "toggle") a.togglePlay();
        else if (action === "previous") a.prev();
        else if (action === "next") a.next();
        else if (action === "volume-up") a.nudgeVolume(0.05);
        else if (action === "volume-down") a.nudgeVolume(-0.05);
        else if (action === "immersive") a.toggleImmersive();
        else if (action === "lyrics") a.toggleFloatingLyrics();
        else if (action === "queue") a.toggleQueue();
      })
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [state.settings.shortcutsEnabled]);

  // Persist
  useEffect(() => {
    const { loopMode, volume, muted, rate, liked, recent, sidebarCollapsed, floatingLyrics, settings, queue, currentId } = state;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ loopMode, volume, muted, rate, liked, recent, sidebarCollapsed, floatingLyrics, settings, queue, currentId }));
    } catch {
      /* quota */
    }
  }, [state.loopMode, state.volume, state.muted, state.rate, state.liked, state.recent, state.sidebarCollapsed, state.floatingLyrics, state.settings, state.queue, state.currentId]); // eslint-disable-line

  // Engine parameter sync
  const st = state.settings;
  useEffect(() => {
    getEngine().setVolume(state.volume);
    if (inTauri) void nativePlayer.setVolume(state.muted ? 0 : state.volume);
  }, [state.volume, state.muted]);
  useEffect(() => getEngine().setMuted(state.muted), [state.muted]);
  useEffect(() => {
    getEngine().setRate(state.rate);
    if (inTauri) void nativePlayer.setSpeed(state.rate);
  }, [state.rate]);
  useEffect(() => {
    if (inTauri) {
      void nativePlayer.setDsp(st.eqEnabled, st.eqBands, st.preamp, st.normalize).catch(() => {});
    }
  }, [st.eqEnabled, st.eqBands, st.preamp, st.normalize]);
  useEffect(() => getEngine().setEq(st.eqEnabled, st.eqBands, st.preamp), [st.eqEnabled, st.eqBands, st.preamp]);
  useEffect(() => getEngine().setNormalize(st.normalize), [st.normalize]);
  useEffect(() => getEngine().setPreservePitch(st.preservePitch), [st.preservePitch]);
  useEffect(() => getEngine().setFade(st.fade, st.fadeMs), [st.fade, st.fadeMs]);
  useEffect(() => {
    void getEngine().setSink(st.outputDeviceId);
  }, [st.outputDeviceId]);

  // Visual tokens → CSS variables
  const current = state.tracks.find((t) => t.id === state.currentId) ?? null;
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--mm-glass-blur", `${st.blur}px`);
    root.style.setProperty("--mm-glass-alpha", String(st.glassAlpha));
    root.style.setProperty("--mm-ambient", String(st.ambientIntensity));
    root.style.setProperty("--mm-lyric-size", `${st.lyricSize}px`);
    const pal = current?.palette ?? PRESET_TRACKS[0].palette;
    const acc = st.accent === "cover" ? { a: lighten(pal[0], 0.62), b: lighten(pal[1], 0.58) } : ACCENTS[st.accent];
    root.style.setProperty("--mm-accent", acc.a);
    root.style.setProperty("--mm-accent2", acc.b);
    root.classList.toggle("reduce-motion", st.reduceMotion);
  }, [st.blur, st.glassAlpha, st.ambientIntensity, st.lyricSize, st.accent, st.reduceMotion, current?.palette]);

  // Document title + Media Session + Windows SMTC
  useEffect(() => {
    document.title = current ? `${state.isPlaying ? "▶ " : ""}${current.title} · ${current.artist} — MateMusic` : "MateMusic · 高定音乐播放器";
    if (inTauri && current) {
      void nativePlayer.setMetadata(current.title, current.artist, current.album).catch(() => {});
    }
    if (!("mediaSession" in navigator) || !current) return;
    const abs = (u: string) => new URL(u, location.href).href;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: current.title,
        artist: current.artist,
        album: current.album,
        artwork: [{ src: abs(current.cover), sizes: "512x512" }],
      });
      navigator.mediaSession.playbackState = state.isPlaying ? "playing" : "paused";
    } catch {
      /* unsupported */
    }
  }, [current, state.isPlaying]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const a = () => actionsRef.current;
    const set = (k: MediaSessionAction, fn: MediaSessionActionHandler) => {
      try {
        navigator.mediaSession.setActionHandler(k, fn);
      } catch {
        /* unsupported action */
      }
    };
    set("play", () => a().togglePlay());
    set("pause", () => a().togglePlay());
    set("nexttrack", () => a().next());
    set("previoustrack", () => a().prev());
    set("seekto", (d) => d.seekTime != null && a().seek(d.seekTime));
    set("seekforward", () => a().seekBy(10));
    set("seekbackward", () => a().seekBy(-10));
  }, []);

  return (
    <ActionsCtx.Provider value={actions}>
      <StateCtx.Provider value={state}>
        <TimeCtx.Provider value={time}>{children}</TimeCtx.Provider>
      </StateCtx.Provider>
    </ActionsCtx.Provider>
  );
}

/** Ordered, filtered list helper shared by library views. */
export function useTrackLookup() {
  const { tracks } = usePlayer();
  return useCallback((ids: string[]) => {
    const map = new Map(tracks.map((t) => [t.id, t]));
    return ids.map((id) => map.get(id)).filter(Boolean) as Track[];
  }, [tracks]);
}
