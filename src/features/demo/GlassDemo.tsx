import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Disc3,
  FolderOpen,
  GripVertical,
  Heart,
  Library,
  ListMusic,
  Maximize2,
  Mic2,
  Moon,
  Pause,
  Play,
  Repeat,
  Settings2,
  Shuffle,
  SkipBack,
  SkipForward,
  Sun,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  getPlayerState,
  inTauri,
  loadTrack,
  pauseTrack,
  pickAudioFile,
  playTrack,
  seekTrack,
  setOutputMode,
  setTrackVolume,
  subscribePlayer,
} from "../../lib/player";
import type { PlayerSnapshot } from "../../lib/player";
import { formatHz, formatTime, prettifyCodec } from "../../lib/format";
import {
  cancelScan,
  coverArtClass,
  coverUrl,
  getScanStatus,
  getSettings,
  setSetting,
  subscribeScan,
} from "../../lib/library";
import type { LibraryTrack, ScanStatus } from "../../lib/library";
import { getPlaybackState, savePlaybackState } from "../../lib/playback";
import ToastHost from "../../components/ToastHost";
import LibraryView from "../library/LibraryView";
import { useAppStore } from "../../store/useAppStore";
import { useToastStore } from "../../store/useToastStore";
import type { PlayMode, View } from "../../store/useAppStore";

type Track = {
  id: string;
  title: string;
  artist: string;
  album: string;
  year: number;
  duration: number;
  art: string;
};

const TRACKS: Track[] = [
  {
    id: "aurora-drift",
    title: "Aurora Drift",
    artist: "Nova Fields",
    album: "Glass Horizon",
    year: 2025,
    duration: 342,
    art: "aurora",
  },
  {
    id: "midnight-circuit",
    title: "Midnight Circuit",
    artist: "Kite & Harbor",
    album: "Soft Machines",
    year: 2024,
    duration: 258,
    art: "circuit",
  },
  {
    id: "paper-satellites",
    title: "Paper Satellites",
    artist: "Lumen Choir",
    album: "Slow Orbit",
    year: 2025,
    duration: 365,
    art: "orbit",
  },
  {
    id: "winter-glass",
    title: "Winter Glass",
    artist: "Aya Mori",
    album: "Still Light",
    year: 2023,
    duration: 237,
    art: "winter",
  },
  {
    id: "tidal-memory",
    title: "Tidal Memory",
    artist: "Nova Fields",
    album: "Glass Horizon",
    year: 2025,
    duration: 311,
    art: "tidal",
  },
];

const LYRICS = [
  { t: 0, text: "玻璃后面，光在缓慢流动" },
  { t: 28, text: "我们把夜晚调成青色" },
  { t: 62, text: "一圈一圈，像旧唱片的纹路" },
  { t: 95, text: "你在回声里叫我的名字" },
  { t: 128, text: "让所有频率都安静下来" },
  { t: 160, text: "城市在窗外退成一条线" },
  { t: 195, text: "别急着醒来，还没到天亮" },
  { t: 228, text: "让低音托住漂浮的我们" },
  { t: 262, text: "晨雾正爬上玻璃的边缘" },
  { t: 300, text: "而光，仍在缓慢地流动" },
];

const LINE_HEIGHT = 38;

const MODE_LABELS: Record<PlayMode, string> = {
  sequential: "顺序播放",
  "repeat-all": "列表循环",
  "repeat-one": "单曲循环",
  shuffle: "随机播放",
};

function folderOf(path: string) {
  const parts = path.split(/[\\/]/);
  return parts.length > 1 ? parts[parts.length - 2] : "";
}

const NAV: { label: string; icon: typeof Library; view: View }[] = [
  { label: "曲库", icon: Library, view: "library" },
  { label: "正在播放", icon: Disc3, view: "now" },
  { label: "歌词", icon: Mic2, view: "lyrics" },
  { label: "设置", icon: Settings2, view: "settings" },
];

function SortableQueueItem({
  item,
  active,
  playing,
  onPlay,
}: {
  item: LibraryTrack;
  active: boolean;
  playing: boolean;
  onPlay: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id });
  const cover = coverUrl(item.coverPath);
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <li ref={setNodeRef} style={style} className={`queue-row ${isDragging ? "is-dragging" : ""}`}>
      <button
        type="button"
        className="queue-drag"
        {...attributes}
        {...listeners}
        aria-label="拖拽排序"
      >
        <GripVertical size={14} />
      </button>
      <button
        type="button"
        className={`queue-item ${active ? "is-active" : ""}`}
        onClick={onPlay}
      >
        <span className={`queue-art ${coverArtClass(item.id)}`}>
          {cover && <img src={cover} alt="" loading="lazy" />}
        </span>
        <span className="queue-meta">
          <strong>{item.title}</strong>
          <em>{item.artist ?? "未知艺术家"}</em>
        </span>
        {active && playing ? (
          <span className="equalizer" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        ) : (
          <span className="queue-time">{formatTime(item.duration)}</span>
        )}
      </button>
    </li>
  );
}

export default function GlassDemo() {
  const reduced = useReducedMotion();
  const settingsLoaded = useRef(false);
  const finishedRef = useRef("");
  const restoredRef = useRef(false);
  const positionRef = useRef(0);
  const scanToastId = useRef<number | null>(null);
  const lastErrorRef = useRef("");
  const shownNotesRef = useRef<Set<string>>(new Set());
  const [restoreReady, setRestoreReady] = useState(!inTauri);
  const [scan, setScan] = useState<ScanStatus | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    new URLSearchParams(window.location.search).get("theme") === "light" ? "light" : "dark",
  );
  const [blur, setBlur] = useState(24);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [time, setTime] = useState(18);
  const [volume, setVolume] = useState(0.72);
  const [liked, setLiked] = useState(false);
  const [snapshot, setSnapshot] = useState<PlayerSnapshot | null>(null);
  const [opening, setOpening] = useState(false);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [outputPreference, setOutputPreference] = useState<"exclusive" | "shared">("exclusive");

  const view = useAppStore((state) => state.view);
  const setView = useAppStore((state) => state.setView);
  const queue = useAppStore((state) => state.queue);
  const currentIndex = useAppStore((state) => state.currentIndex);
  const playMode = useAppStore((state) => state.mode);
  const setPlayMode = useAppStore((state) => state.setMode);
  const playQueueIndex = useAppStore((state) => state.playIndex);
  const nextTrack = useAppStore((state) => state.next);
  const prevTrack = useAppStore((state) => state.prev);
  const moveQueue = useAppStore((state) => state.move);
  const pushToast = useToastStore((state) => state.push);
  const updateToast = useToastStore((state) => state.update);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const track = TRACKS[index];
  const loaded = snapshot?.loaded ? snapshot : null;
  const real = loaded !== null;
  const isPlaying = loaded ? loaded.playing : playing;
  const duration = loaded ? loaded.duration : track.duration;
  const progress = duration > 0 ? Math.min(time / duration, 1) : 0;

  const currentQueueTrack = currentIndex >= 0 ? queue[currentIndex] ?? null : null;
  const queueTrack =
    loaded && currentQueueTrack && currentQueueTrack.path === loaded.path
      ? currentQueueTrack
      : null;

  const displayCodec = queueTrack?.codec ?? loaded?.codec;
  const displayBits = queueTrack?.bits ?? loaded?.bits;
  const displayRate = queueTrack?.sampleRate ?? loaded?.sampleRate;
  const displayTitle = queueTrack?.title ?? (loaded ? loaded.title : track.title);
  const displayArtist = queueTrack?.artist ?? (loaded ? "本地文件" : track.artist);
  const displayAlbum =
    queueTrack?.album ?? (loaded ? folderOf(loaded.path) || "本地曲目" : `${track.album} · ${track.year}`);
  const badges = loaded
    ? [
        displayCodec ? prettifyCodec(displayCodec) : "未知",
        displayBits ? `${displayBits} bit` : "位深未知",
        formatHz(displayRate ?? 0),
      ]
    : ["FLAC", "24 bit", "96 kHz"];
  const artClass = queueTrack
    ? coverArtClass(queueTrack.id)
    : loaded
      ? "art-aurora"
      : `art-${track.art}`;
  const heroCover = coverUrl(queueTrack?.coverPath ?? null);
  const coverKey = queueTrack ? `lib-${queueTrack.id}` : loaded ? loaded.path : track.art;

  const applySnapshot = useCallback((state: PlayerSnapshot) => {
    setSnapshot(state);
    if (state.loaded) setTime(state.position);
  }, []);

  useEffect(() => {
    if (!inTauri) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void getPlayerState()
      .then((state) => {
        if (!disposed) applySnapshot(state);
      })
      .catch((err) => setBridgeError(String(err)));

    void subscribePlayer((state) => {
      if (!disposed) applySnapshot(state);
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((err) => setBridgeError(String(err)));

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [applySnapshot]);

  useEffect(() => {
    if (!inTauri) {
      settingsLoaded.current = true;
      setRestoreReady(true);
      return;
    }
    void getSettings()
      .then((settings) => {
        if (settings.theme === "light" || settings.theme === "dark") setTheme(settings.theme);
        const storedBlur = Number(settings.glassBlur);
        if (Number.isFinite(storedBlur) && storedBlur >= 0 && storedBlur <= 48) setBlur(storedBlur);
        const storedVolume = Number(settings.volume);
        if (Number.isFinite(storedVolume) && storedVolume >= 0 && storedVolume <= 1) {
          setVolume(storedVolume);
        }
        if (settings.outputMode === "exclusive" || settings.outputMode === "shared") {
          setOutputPreference(settings.outputMode);
        }
        settingsLoaded.current = true;
      })
      .catch(() => {
        settingsLoaded.current = true;
      });
  }, []);

  useEffect(() => {
    if (!inTauri || restoredRef.current) return;
    restoredRef.current = true;
    void (async () => {
      try {
        const state = await getPlaybackState();
        if (state?.queueJson) {
          const parsed = JSON.parse(state.queueJson);
          if (Array.isArray(parsed)) {
            const restored: LibraryTrack[] = parsed.filter(
              (item): item is LibraryTrack =>
                !!item &&
                typeof item.id === "number" &&
                typeof item.path === "string" &&
                typeof item.title === "string",
            );
            if (restored.length > 0) {
              const modes: PlayMode[] = ["sequential", "repeat-all", "repeat-one", "shuffle"];
              const mode = modes.includes(state.mode as PlayMode)
                ? (state.mode as PlayMode)
                : "sequential";
              const index = Math.max(0, Math.min(state.currentIndex, restored.length - 1));
              useAppStore.getState().restore(restored, index, mode);
              const engine = await getPlayerState();
              if (!engine.loaded) useAppStore.getState().setView("library");
            }
          }
        }
      } catch {
        // 损坏的持久化状态不影响启动
      } finally {
        setRestoreReady(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!inTauri || !restoreReady) return;
    const timer = setTimeout(() => {
      const state = useAppStore.getState();
      void savePlaybackState(
        JSON.stringify(state.queue),
        state.currentIndex,
        state.mode,
        positionRef.current,
      );
    }, 400);
    return () => clearTimeout(timer);
  }, [queue, currentIndex, playMode, restoreReady]);

  useEffect(() => {
    if (!inTauri || !restoreReady) return;
    const timer = setInterval(() => {
      const state = useAppStore.getState();
      if (state.queue.length > 0) {
        void savePlaybackState(
          JSON.stringify(state.queue),
          state.currentIndex,
          state.mode,
          positionRef.current,
        );
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [restoreReady]);

  useEffect(() => {
    if (!inTauri) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getScanStatus()
      .then((status) => {
        if (!disposed) setScan(status);
      })
      .catch(() => {});
    void subscribeScan((status) => setScan(status)).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!inTauri || !scan) return;
    if (scan.scanning) {
      const message = `正在扫描：${scan.scanned} 已看 · ${scan.imported} 入库${
        scan.errors > 0 ? ` · ${scan.errors} 错误` : ""
      }`;
      if (scanToastId.current == null) {
        scanToastId.current = pushToast({
          kind: "info",
          message,
          duration: 0,
          actionLabel: "取消",
          onAction: () => void cancelScan(),
        });
      } else {
        updateToast(scanToastId.current, { message });
      }
    } else if (scanToastId.current != null) {
      updateToast(scanToastId.current, {
        kind: "success",
        message: `扫描完成：入库 ${scan.imported} 首，跳过 ${scan.skipped} 首`,
        duration: 4200,
        actionLabel: undefined,
        onAction: undefined,
      });
      scanToastId.current = null;
    }
  }, [scan, pushToast, updateToast]);

  useEffect(() => {
    if (!snapshot?.loaded) return;
    positionRef.current = snapshot.position;
  }, [snapshot?.loaded, snapshot?.position]);

  useEffect(() => {
    if (!inTauri || !settingsLoaded.current) return;
    void setSetting("theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!inTauri || !settingsLoaded.current) return;
    void setSetting("glassBlur", String(blur));
  }, [blur]);

  useEffect(() => {
    if (!inTauri || !settingsLoaded.current) return;
    void setSetting("volume", String(volume));
  }, [volume]);

  useEffect(() => {
    if (!inTauri || !settingsLoaded.current) return;
    void setSetting("outputMode", outputPreference);
  }, [outputPreference]);

  // 演示模式的模拟时钟
  useEffect(() => {
    if (real || !playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setTime((t) => Math.min(t + dt, track.duration));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [real, playing, track.duration]);

  // 真实播放时用事件位置校准，并在两次事件之间平滑推进
  useEffect(() => {
    if (!real || !isPlaying) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setTime((t) => (duration > 0 ? Math.min(t + dt, duration) : t + dt));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [real, isPlaying, duration]);

  useEffect(() => {
    if (real || time < track.duration) return;
    setIndex((i) => (i + 1) % TRACKS.length);
    setTime(0);
  }, [real, time, track.duration]);

  useEffect(() => {
    if (!snapshot?.finished) finishedRef.current = "";
  }, [snapshot?.finished]);

  useEffect(() => {
    if (!loaded || !snapshot?.finished) return;
    const key = `${snapshot.path}:${snapshot.duration}`;
    if (finishedRef.current === key) return;
    finishedRef.current = key;
    nextTrack(true);
  }, [loaded, snapshot?.finished, snapshot?.path, snapshot?.duration, nextTrack]);

  useEffect(() => {
    if (loaded) void setTrackVolume(volume);
  }, [loaded?.path]);

  const activeIndex = useMemo(() => {
    let active = 0;
    LYRICS.forEach((line, i) => {
      if (time >= line.t) active = i;
    });
    return active;
  }, [time]);

  const lyricOffset = Math.min(Math.max(activeIndex - 2, 0), LYRICS.length - 5);

  const selectTrack = (next: number) => {
    setIndex(next);
    setTime(0);
    setPlaying(true);
  };

  const seek = (e: ChangeEvent<HTMLInputElement>) => setTime(Number(e.target.value));

  const commitSeek = () => {
    if (loaded) void seekTrack(Math.max(0, Math.min(time, loaded.duration || time)));
  };

  const togglePlay = () => {
    if (loaded) {
      if (loaded.playing) void pauseTrack();
      else void playTrack();
    } else {
      setPlaying((v) => !v);
    }
  };

  const changeVolume = (value: number) => {
    setVolume(value);
    if (loaded) void setTrackVolume(value);
  };

  const changeOutputMode = (mode: "exclusive" | "shared") => {
    setOutputPreference(mode);
    if (loaded) void setOutputMode(mode);
  };

  const handleOpen = async () => {
    if (!inTauri) return;
    setOpening(true);
    setBridgeError(null);
    try {
      const path = await pickAudioFile();
      if (!path) return;
      await setTrackVolume(volume);
      await loadTrack(path);
    } catch (err) {
      setBridgeError(String(err));
    } finally {
      setOpening(false);
    }
  };

  const cycleMode = () => {
    const order: PlayMode[] = ["sequential", "repeat-all", "repeat-one", "shuffle"];
    setPlayMode(order[(order.indexOf(playMode) + 1) % order.length]);
  };

  const toggleShuffle = () => setPlayMode(playMode === "shuffle" ? "sequential" : "shuffle");
  const cycleRepeat = () =>
    setPlayMode(
      playMode === "repeat-all" ? "repeat-one" : playMode === "repeat-one" ? "sequential" : "repeat-all",
    );

  const errorText = loaded?.error ?? bridgeError;
  const hasQueue = queue.length > 0;

  useEffect(() => {
    if (!errorText) {
      lastErrorRef.current = "";
      return;
    }
    if (lastErrorRef.current === errorText) return;
    lastErrorRef.current = errorText;
    pushToast({ kind: "error", message: errorText, duration: 6000 });
  }, [errorText, pushToast]);

  useEffect(() => {
    const note = loaded?.note;
    if (!note || shownNotesRef.current.has(note)) return;
    shownNotesRef.current.add(note);
    pushToast({ kind: "warning", message: note, duration: 6000 });
  }, [loaded?.note, pushToast]);

  const handleQueueDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = queue.findIndex((item) => item.id === active.id);
    const to = queue.findIndex((item) => item.id === over.id);
    if (from >= 0 && to >= 0) moveQueue(from, to);
  };

  return (
    <div className="demo" data-theme={theme} style={{ "--glass-blur": `${blur}px` } as CSSProperties}>
      <div className="backdrop" aria-hidden="true">
        <div className="aurora" />
        <div className="aurora aurora-alt" />
        <div className="veil" />
        <div className="grain" />
      </div>

      <div className="layout">
        <aside className="rail glass">
          <div className="brand">
            <span className="brand-mark" />
            <span className="brand-name">MateMusic</span>
          </div>

          <nav className="nav">
            {NAV.map(({ label, icon: Icon, view: target }) => (
              <button
                key={label}
                className={`nav-item ${view === target ? "is-active" : ""}`}
                type="button"
                onClick={() => setView(target)}
              >
                <Icon size={18} strokeWidth={1.8} />
                <span>{label}</span>
              </button>
            ))}
          </nav>

          <div className="rail-spacer" />

          <section className="tuning">
            <p className="tuning-title">演示参数</p>
            <div className="segmented" role="group" aria-label="主题">
              <button
                type="button"
                className={theme === "dark" ? "is-active" : ""}
                onClick={() => setTheme("dark")}
                aria-pressed={theme === "dark"}
              >
                <Moon size={14} /> 深色
              </button>
              <button
                type="button"
                className={theme === "light" ? "is-active" : ""}
                onClick={() => setTheme("light")}
                aria-pressed={theme === "light"}
              >
                <Sun size={14} /> 浅色
              </button>
            </div>
            <label className="slider-label">
              <span>
                玻璃模糊 <em>{blur}px</em>
              </span>
              <input
                className="range is-small"
                type="range"
                min={0}
                max={48}
                value={blur}
                onChange={(e) => setBlur(Number(e.target.value))}
                style={{ "--pct": `${(blur / 48) * 100}%` } as CSSProperties}
                aria-label="玻璃模糊强度"
              />
            </label>
            <p className="tuning-title is-spaced">输出模式</p>
            <div className="segmented" role="group" aria-label="输出模式">
              <button
                type="button"
                className={outputPreference === "exclusive" ? "is-active" : ""}
                onClick={() => changeOutputMode("exclusive")}
                aria-pressed={outputPreference === "exclusive"}
              >
                独占优先
              </button>
              <button
                type="button"
                className={outputPreference === "shared" ? "is-active" : ""}
                onClick={() => changeOutputMode("shared")}
                aria-pressed={outputPreference === "shared"}
              >
                共享
              </button>
            </div>
            <p className="tuning-note">
              {loaded ? `${loaded.outputMode} · ${loaded.outputFormat}` : "演示模式 · 未接入音频"}
            </p>
          </section>
        </aside>

        <main className="now glass">
          {view === "library" ? (
            <LibraryView />
          ) : view === "lyrics" ? (
            <section className="placeholder-view">
              <p className="eyebrow">歌词</p>
              <h1>歌词页</h1>
              <p>歌词解析、双语与逐字高亮将在 M3 接入。当前真实播放不展示模拟歌词。</p>
            </section>
          ) : view === "settings" ? (
            <section className="placeholder-view">
              <p className="eyebrow">设置</p>
              <h1>设置</h1>
              <p>
                主题、玻璃模糊、音量与输出模式会持久化；输出设备、曲库目录管理与快捷键将在后续接入。
              </p>
            </section>
          ) : (
            <>
              <header className="now-head">
                <p className="eyebrow">正在播放</p>
                <div className="head-actions">
                  {inTauri && (
                    <button className="open-file" type="button" onClick={handleOpen} disabled={opening}>
                      <FolderOpen size={15} />
                      {opening ? "读取中…" : real ? "更换音频" : "打开音频"}
                    </button>
                  )}
                  <span className="output-chip">
                    <i className="pulse" />
                    {loaded
                      ? `${loaded.outputMode} · ${formatHz(loaded.outputRate)}`
                      : "演示模式 · 未接入音频"}
                  </span>
                </div>
              </header>

              <section className="hero">
                <motion.div
                  key={coverKey}
                  className={`cover ${artClass} ${heroCover ? "has-image" : ""}`}
                  initial={reduced ? false : { opacity: 0, scale: 0.97 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                >
                  {heroCover && <img className="cover-image" src={heroCover} alt="" />}
                  <span className="cover-ring" />
                  <span className="cover-sheen" />
                </motion.div>

                <div className="meta">
                  <motion.div
                    key={coverKey}
                    initial={reduced ? false : { opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                  >
                    <h1>{displayTitle}</h1>
                    <p className="artist">{displayArtist}</p>
                    <p className="album">{displayAlbum}</p>
                    <div className="badges">
                      {badges.map((badge, i) => (
                        <span key={`${badge}-${i}`}>{badge}</span>
                      ))}
                    </div>
                  </motion.div>

                  <div className="meta-actions">
                    <button
                      type="button"
                      className={`icon-button ${liked ? "is-liked" : ""}`}
                      onClick={() => setLiked((v) => !v)}
                      aria-label={liked ? "取消收藏" : "收藏"}
                      aria-pressed={liked}
                    >
                      <Heart size={18} fill={liked ? "currentColor" : "none"} />
                    </button>
                    <button type="button" className="icon-button" aria-label="沉浸模式">
                      <Maximize2 size={18} />
                    </button>
                  </div>
                </div>
              </section>

              <section className="audio-info" aria-label="音频参数">
                <div>
                  <span>源文件</span>
                  <strong>
                    {loaded
                      ? `${displayCodec ? prettifyCodec(displayCodec) : "未知"} · ${displayBits ?? "?"} bit · ${formatHz(displayRate ?? 0)}`
                      : "FLAC · 24 bit · 96 kHz"}
                  </strong>
                </div>
                <div>
                  <span>解码</span>
                  <strong>PCM · 32 bit float</strong>
                </div>
                <div>
                  <span>输出</span>
                  <strong
                    title={
                      loaded
                        ? `${loaded.outputMode} · ${formatHz(loaded.outputRate)} · ${loaded.outputFormat}`
                        : undefined
                    }
                  >
                    {loaded
                      ? `${loaded.outputMode} · ${formatHz(loaded.outputRate)} · ${loaded.outputFormat}`
                      : "WASAPI 独占 · 96 kHz"}
                  </strong>
                </div>
              </section>

              <section className="lyrics" aria-label="歌词">
                {loaded ? (
                  <div className="lyric-placeholder">
                    <p>正在播放本地文件</p>
                    <p>歌词解析将在 M3 接入，当前不展示模拟歌词</p>
                  </div>
                ) : (
                  <div className="lyric-viewport">
                    <div
                      className="lyric-track"
                      style={{ transform: `translateY(${-lyricOffset * LINE_HEIGHT}px)` }}
                    >
                      {LYRICS.map((line, i) => (
                        <button
                          key={line.t}
                          type="button"
                          className={`lyric-line ${i === activeIndex ? "is-active" : ""}`}
                          onClick={() => setTime(line.t)}
                        >
                          {line.text}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </section>

              <section className="transport">
                <input
                  className="range progress"
                  type="range"
                  min={0}
                  max={duration || 1}
                  step={0.1}
                  value={Math.min(time, duration || 1)}
                  onChange={seek}
                  onPointerUp={commitSeek}
                  onKeyUp={commitSeek}
                  style={{ "--pct": `${progress * 100}%` } as CSSProperties}
                  aria-label="播放进度"
                />
                <div className="times">
                  <span>{formatTime(time)}</span>
                  <span>-{formatTime(Math.ceil(Math.max(duration - time, 0)))}</span>
                </div>

                <div className="transport-row">
                  <div className="transport-side">
                    <button
                      type="button"
                      className={`icon-button ${playMode === "shuffle" ? "is-active-mode" : ""}`}
                      onClick={toggleShuffle}
                      aria-label="随机播放"
                      aria-pressed={playMode === "shuffle"}
                    >
                      <Shuffle size={17} />
                    </button>
                    <button
                      type="button"
                      className={`icon-button ${playMode.startsWith("repeat") ? "is-active-mode" : ""}`}
                      onClick={cycleRepeat}
                      aria-label="循环模式"
                    >
                      <Repeat size={17} />
                    </button>
                  </div>

                  <div className="transport-main">
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => (hasQueue ? prevTrack() : selectTrack((index - 1 + TRACKS.length) % TRACKS.length))}
                      disabled={!hasQueue && real}
                      aria-label="上一首"
                    >
                      <SkipBack size={20} fill="currentColor" />
                    </button>
                    <button
                      type="button"
                      className="play-button"
                      onClick={togglePlay}
                      aria-label={isPlaying ? "暂停" : "播放"}
                    >
                      {isPlaying ? (
                        <Pause size={22} fill="currentColor" />
                      ) : (
                        <Play size={22} fill="currentColor" />
                      )}
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => (hasQueue ? nextTrack() : selectTrack((index + 1) % TRACKS.length))}
                      disabled={!hasQueue && real}
                      aria-label="下一首"
                    >
                      <SkipForward size={20} fill="currentColor" />
                    </button>
                  </div>

                  <div className="volume">
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => changeVolume(volume > 0 ? 0 : 0.72)}
                      aria-label={volume > 0 ? "静音" : "取消静音"}
                    >
                      {volume > 0 ? <Volume2 size={17} /> : <VolumeX size={17} />}
                    </button>
                    <input
                      className="range is-volume"
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={volume}
                      onChange={(e) => changeVolume(Number(e.target.value))}
                      style={{ "--pct": `${volume * 100}%` } as CSSProperties}
                      aria-label="音量"
                    />
                  </div>
                </div>
              </section>
            </>
          )}
        </main>

        <aside className="queue glass">
          <header className="queue-head">
            <h2>
              <ListMusic size={16} /> 播放队列
            </h2>
            <span>{hasQueue ? `${queue.length} 首` : loaded ? "1 首" : `${TRACKS.length} 首`}</span>
          </header>
          <ul className="queue-list">
            {hasQueue ? (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleQueueDragEnd}
              >
                <SortableContext
                  items={queue.map((item) => item.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {queue.map((item, i) => (
                    <SortableQueueItem
                      key={item.id}
                      item={item}
                      active={i === currentIndex}
                      playing={loaded?.playing ?? false}
                      onPlay={() => playQueueIndex(i)}
                    />
                  ))}
                </SortableContext>
              </DndContext>
            ) : loaded ? (
              <li>
                <div className="queue-item is-active is-static">
                  <span className={`queue-art ${artClass}`} />
                  <span className="queue-meta">
                    <strong>{loaded.title}</strong>
                    <em>本地文件 · {prettifyCodec(loaded.codec)}</em>
                  </span>
                  {loaded.playing ? (
                    <span className="equalizer" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                  ) : (
                    <span className="queue-time">{formatTime(loaded.duration)}</span>
                  )}
                </div>
              </li>
            ) : inTauri ? (
              <li className="queue-empty">
                队列为空
                <br />
                <span>从曲库双击播放，或点 + 加入队列</span>
              </li>
            ) : (
              TRACKS.map((item, i) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`queue-item ${i === index ? "is-active" : ""}`}
                    onClick={() => selectTrack(i)}
                  >
                    <span className={`queue-art art-${item.art}`} />
                    <span className="queue-meta">
                      <strong>{item.title}</strong>
                      <em>{item.artist}</em>
                    </span>
                    {i === index ? (
                      <span className="equalizer" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                    ) : (
                      <span className="queue-time">{formatTime(item.duration)}</span>
                    )}
                  </button>
                </li>
              ))
            )}
          </ul>

          <footer className="queue-foot">
            {hasQueue ? (
              <>
                <button className="queue-mode" type="button" onClick={cycleMode}>
                  {MODE_LABELS[playMode]}
                </button>
                <span>{playMode === "shuffle" ? "随机续播" : "按序续播"}</span>
              </>
            ) : (
              <span>{loaded ? "可直接播放当前文件" : "拖拽排序将在后续接入"}</span>
            )}
          </footer>
        </aside>
      </div>
      <ToastHost />
    </div>
  );
}
