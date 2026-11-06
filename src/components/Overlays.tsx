import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, Info, Loader2, Maximize2, Power, Upload, XCircle } from "lucide-react";
import { useActions, useCurrentTrack, usePlayer } from "../store/PlayerStore";
import { cn } from "../utils/cn";
import { Cover, IconButton, SPRING } from "./ui";
import { ProgressRow, TransportControls } from "./Dock";
import { LikeButton } from "./TrackTable";
import { AmbientBackground, Logo } from "./Shell";
import { inTauri, onNativeDrop } from "../lib/tauri";

export function Toasts() {
  const { toasts } = usePlayer();
  return (
    <div className="pointer-events-none absolute left-1/2 top-16 z-[90] flex w-[360px] -translate-x-1/2 flex-col items-center gap-2">
      <AnimatePresence>
        {toasts.map((t) => {
          const Icon = t.tone === "success" ? CheckCircle2 : t.tone === "error" ? XCircle : Info;
          return (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: -14, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.95 }}
              transition={SPRING}
              className="glass-strong flex h-10 max-w-full min-w-0 items-center gap-2 rounded-full px-4 text-[12.5px]"
            >
              <Icon className={cn("h-4 w-4 shrink-0", t.tone === "success" ? "text-emerald-300" : t.tone === "error" ? "text-rose-300" : "text-accent")} />
              <span className="min-w-0 truncate">{t.text}</span>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

export function ImportProgress() {
  const { importing } = usePlayer();
  return (
    <AnimatePresence>
      {importing && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          className="glass-strong absolute bottom-[112px] left-1/2 z-[85] flex h-12 w-[320px] -translate-x-1/2 items-center gap-3 rounded-2xl px-4"
        >
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate text-[12px] tabular-nums">
              正在导入并解析 {importing.done} / {importing.total}
            </span>
            <div className="neu-inset h-1 overflow-hidden rounded-full">
              <motion.div className="h-full rounded-full bg-gradient-to-r from-accent to-accent2" animate={{ width: `${(importing.done / importing.total) * 100}%` }} />
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function useDropImport() {
  const a = useActions();
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    if (inTauri) {
      let alive = true;
      let unlisten: (() => void) | undefined;
      void onNativeDrop((event) => {
        if (!alive) return;
        if (event.type === "enter" || event.type === "over") setOver(true);
        else if (event.type === "leave") setOver(false);
        else if (event.type === "drop") {
          setOver(false);
          if (event.paths.length) void a.importPaths(event.paths);
        }
      }).then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      });
      return () => {
        alive = false;
        unlisten?.();
      };
    }
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current++;
      setOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setOver(false);
    };
    const overFn = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      if (e.dataTransfer?.files?.length) void a.importFiles(e.dataTransfer.files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", overFn);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", overFn);
      window.removeEventListener("drop", drop);
    };
  }, [a]);
  return over;
}

export function DropOverlay({ show }: { show: boolean }) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="pointer-events-none absolute inset-0 z-[95] grid place-items-center bg-black/50 backdrop-blur-md">
          <motion.div initial={{ scale: 0.9 }} animate={{ scale: 1 }} transition={SPRING} className="glass flex h-[260px] w-[440px] flex-col items-center justify-center rounded-[28px] border-2 border-dashed border-accent/60">
            <div className="neu-primary mb-5 grid h-16 w-16 shrink-0 place-items-center rounded-2xl text-black/80">
              <Upload className="h-7 w-7" />
            </div>
            <p className="text-[17px] font-semibold">松开以导入音乐</p>
            <p className="mt-1.5 text-[12.5px] text-white/55">支持 MP3 / FLAC / WAV，以及同名 .lrc 歌词</p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ---------------- Mini mode ---------------- */
export function MiniPlayer() {
  const s = usePlayer();
  const a = useActions();
  const track = useCurrentTrack();
  return (
    <div className="relative grid h-full w-full place-items-center">
      <AmbientBackground />
      <motion.div
        drag
        dragMomentum={false}
        initial={{ opacity: 0, scale: 0.9, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={SPRING}
        className="glass relative flex w-[400px] cursor-grab flex-col gap-4 overflow-hidden rounded-[28px] p-5 active:cursor-grabbing"
      >
        <div className="flex min-w-0 items-center gap-2">
          <Logo size={22} />
          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-white/60">MateMusic · 迷你模式</span>
          <IconButton label="还原窗口" size="sm" icon={<Maximize2 className="h-4 w-4" />} onClick={() => a.setWindowMode("normal")} />
        </div>
        <div className="flex min-w-0 items-center gap-4">
          {track ? (
            <Cover src={track.cover} alt={track.title} seed={track.id} className={cn("h-20 w-20 rounded-full shadow-[0_10px_30px_rgba(0,0,0,0.5)] ring-2 ring-white/15 mm-spin", !s.isPlaying && "paused")} />
          ) : (
            <div className="neu-inset h-20 w-20 shrink-0 rounded-full" />
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[16px] font-semibold">{track?.title ?? "未在播放"}</span>
            <span className="truncate text-[12.5px] text-white/50">{track ? track.artist : "选择歌曲开始聆听"}</span>
          </div>
          {track && <LikeButton id={track.id} />}
        </div>
        <ProgressRow />
        <TransportControls />
      </motion.div>
    </div>
  );
}

export function SleepScreen() {
  const a = useActions();
  return (
    <div className="relative grid h-full w-full place-items-center bg-[#06050b]">
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={SPRING} className="flex flex-col items-center text-center">
        <Logo size={64} />
        <p className="mt-6 text-[20px] font-semibold">MateMusic 已休眠</p>
        <p className="mt-1.5 text-[13px] text-white/45">播放已暂停，你的队列与进度已被安全保存。</p>
        <button onClick={() => a.setWindowMode("normal")} className="neu-primary mt-7 flex h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-6 text-[13.5px] font-semibold text-black/85">
          <Power className="h-4 w-4 shrink-0" />
          重新打开
        </button>
      </motion.div>
    </div>
  );
}

/* ---------------- Keyboard shortcuts ---------------- */
export function useShortcuts() {
  const s = usePlayer();
  const a = useActions();
  const ref = useRef(s);
  ref.current = s;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const st = ref.current;
      const target = e.target as HTMLElement;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        a.openSettings();
        return;
      }
      if (e.key === "Escape") {
        if (st.immersive) a.setImmersive(false);
        else if (st.queueOpen) a.setQueueOpen(false);
        else if (st.settingsOpen && !st.settingsMinimized) a.closeSettings();
        return;
      }
      if (!st.settings.shortcutsEnabled || typing || st.windowMode === "sleep") return;
      if (target?.getAttribute("role") === "slider" && e.key.startsWith("Arrow")) return;
      const ctrl = e.ctrlKey || e.metaKey;
      switch (e.key) {
        case " ":
          if (target?.tagName === "BUTTON") return;
          e.preventDefault();
          a.togglePlay();
          break;
        case "ArrowRight":
          e.preventDefault();
          if (ctrl) a.next();
          else a.seekBy(5);
          break;
        case "ArrowLeft":
          e.preventDefault();
          if (ctrl) a.prev();
          else a.seekBy(-5);
          break;
        case "ArrowUp":
          e.preventDefault();
          a.setVolume((st.muted ? 0 : st.volume) + 0.05);
          break;
        case "ArrowDown":
          e.preventDefault();
          a.setVolume((st.muted ? 0 : st.volume) - 0.05);
          break;
        default: {
          if (ctrl || e.altKey) return;
          const k = e.key.toLowerCase();
          if (k === "m") a.toggleMute();
          else if (k === "l" && st.currentId) a.toggleLike(st.currentId);
          else if (k === "f" && st.currentId) a.setImmersive(!st.immersive);
          else if (k === "q") a.toggleQueue();
        }
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [a]);
}
