import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Clock3, Heart, ListEnd, ListPlus, MoreHorizontal, Play, Trash2, Pause } from "lucide-react";
import type { Track } from "../types";
import { useActions, usePlayer } from "../store/PlayerStore";
import { formatTime } from "../lib/utils";
import { cn } from "../utils/cn";
import { Bars, Cover, QualityBadge } from "./ui";

const ROW_H = 56;
const COLS = "grid-cols-[52px_minmax(0,1fr)_minmax(0,0.65fr)_76px_44px_64px_44px]";

export function LikeButton({ id, size = "md" }: { id: string; size?: "sm" | "md" }) {
  const { liked } = usePlayer();
  const a = useActions();
  const on = liked.includes(id);
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.7 }}
      onClick={(e) => {
        e.stopPropagation();
        a.toggleLike(id);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      aria-label={on ? "取消喜欢" : "喜欢"}
      title={on ? "取消喜欢 (L)" : "喜欢 (L)"}
      className={cn("relative grid shrink-0 place-items-center rounded-full transition-colors", size === "sm" ? "h-8 w-8" : "h-9 w-9", on ? "text-rose-400" : "text-white/40 hover:text-white")}
    >
      <motion.span key={on ? "on" : "off"} initial={{ scale: on ? 0.4 : 1 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 600, damping: 14 }}>
        <Heart className={cn("shrink-0", size === "sm" ? "h-4 w-4" : "h-[17px] w-[17px]", on && "fill-current drop-shadow-[0_0_8px_rgba(251,113,133,0.7)]")} />
      </motion.span>
      <AnimatePresence>
        {on && (
          <motion.span
            key="ring"
            initial={{ scale: 0.3, opacity: 0.8 }}
            animate={{ scale: 1.8, opacity: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5 }}
            className="pointer-events-none absolute inset-1 rounded-full border-2 border-rose-400"
          />
        )}
      </AnimatePresence>
    </motion.button>
  );
}

interface MenuState {
  track: Track;
  x: number;
  y: number;
}

export function TrackTable({ tracks, emptyNode }: { tracks: Track[]; emptyNode?: React.ReactNode }) {
  const s = usePlayer();
  const a = useActions();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const ids = tracks.map((t) => t.id);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, [tracks.length === 0]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    bodyRef.current?.addEventListener("scroll", close, { once: true });
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 6);
  const end = Math.min(tracks.length, Math.ceil((scrollTop + viewH) / ROW_H) + 6);
  const visible = tracks.slice(start, end);

  const activate = (t: Track) => {
    if (s.settings.doubleClickAction === "queue") a.addToQueue([t.id]);
    else a.playTrack(t.id, ids);
  };

  const openMenu = (e: React.MouseEvent, t: Track) => {
    e.preventDefault();
    e.stopPropagation();
    const x = Math.min(e.clientX, window.innerWidth - 220);
    const y = Math.min(e.clientY, window.innerHeight - 230);
    setMenu({ track: t, x, y });
  };

  return (
    <div className="glass flex min-h-0 flex-1 flex-col overflow-hidden rounded-[22px]">
      <div className={cn("grid h-10 shrink-0 items-center border-b border-white/[0.08] pl-2 pr-[14px] text-[11px] font-semibold uppercase tracking-[0.12em] text-white/40", COLS)}>
        <span className="text-center">#</span>
        <span className="min-w-0 truncate pl-1">标题</span>
        <span className="min-w-0 truncate">专辑</span>
        <span className="truncate">音质</span>
        <span />
        <span className="flex items-center justify-end">
          <Clock3 className="h-3.5 w-3.5 shrink-0" />
        </span>
        <span />
      </div>

      {tracks.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">{emptyNode}</div>
      ) : (
        <div
          ref={bodyRef}
          onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
          className="relative min-h-0 flex-1 overflow-y-auto px-2 pb-2"
          style={{ scrollbarGutter: "stable" }}
        >
          <div className="relative" style={{ height: tracks.length * ROW_H }}>
            {visible.map((t, i) => {
              const idx = start + i;
              const current = t.id === s.currentId;
              return (
                <div
                  key={t.id}
                  onDoubleClick={() => activate(t)}
                  onContextMenu={(e) => openMenu(e, t)}
                  className={cn(
                    "group absolute left-0 right-0 grid cursor-default items-center rounded-xl border border-transparent transition-colors duration-150",
                    COLS,
                    current ? "border-white/10 bg-white/[0.085] shadow-[inset_0_1px_1px_rgba(255,255,255,0.12)]" : "hover:border-white/[0.08] hover:bg-white/[0.055]",
                  )}
                  style={{ top: idx * ROW_H, height: ROW_H - 4 }}
                >
                  <div className="relative grid h-full shrink-0 place-items-center">
                    <span className={cn("text-[13px] tabular-nums text-white/40 transition-opacity group-hover:opacity-0", current && "opacity-0")}>
                      {String(idx + 1).padStart(2, "0")}
                    </span>
                    {current && (
                      <span className="absolute inset-0 grid place-items-center group-hover:opacity-0">
                        <Bars playing={s.isPlaying} />
                      </span>
                    )}
                    <button
                      onClick={() => (current ? a.togglePlay() : a.playTrack(t.id, ids))}
                      className="absolute inset-0 m-auto grid h-8 w-8 shrink-0 place-items-center rounded-full text-white opacity-0 transition hover:bg-white/15 active:scale-90 group-hover:opacity-100"
                      aria-label="播放"
                    >
                      {current && s.isPlaying ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current" />}
                    </button>
                  </div>
                  <div className="flex min-w-0 items-center gap-3 pl-1 pr-3">
                    <Cover src={t.cover} alt={t.title} seed={t.id} className="h-10 w-10 rounded-lg shadow-[0_4px_12px_rgba(0,0,0,0.4)]" />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className={cn("truncate text-[13.5px] font-medium", current ? "text-accent" : "text-white/90")}>{t.title}</span>
                      <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-white/45">
                        {t.source === "local" && <span className="shrink-0 rounded border border-white/15 px-1 text-[9.5px] leading-[14px] text-white/50">本地</span>}
                        <span className="truncate">{t.artist}</span>
                      </span>
                    </div>
                  </div>
                  <span className="min-w-0 truncate pr-3 text-[12.5px] text-white/45">{t.album}</span>
                  <span className="flex min-w-0 items-center">
                    {t.unsupported ? (
                      <span
                        title="当前构建未包含该格式解码器（未引入 FFmpeg）"
                        className="shrink-0 rounded-full border border-rose-400/25 bg-rose-500/15 px-2 py-0.5 text-[10px] font-semibold text-rose-300"
                      >
                        不支持
                      </span>
                    ) : (
                      <QualityBadge quality={t.quality} format={t.format} hiRes={t.hiRes} />
                    )}
                  </span>
                  <span className="flex items-center justify-center">
                    <LikeButton id={t.id} size="sm" />
                  </span>
                  <span className="shrink-0 text-right text-[12.5px] tabular-nums text-white/45">{formatTime(t.duration)}</span>
                  <span className="flex items-center justify-center">
                    <button
                      onClick={(e) => openMenu(e, t)}
                      onMouseDown={(e) => e.stopPropagation()}
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-white/40 opacity-0 transition hover:bg-white/10 hover:text-white active:scale-90 group-hover:opacity-100"
                      aria-label="更多操作"
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <AnimatePresence>
        {menu && (
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.14 }}
            onMouseDown={(e) => e.stopPropagation()}
            className="glass-strong fixed z-[80] w-[208px] rounded-2xl p-1.5"
            style={{ left: menu.x, top: menu.y }}
          >
            <div className="flex min-w-0 items-center gap-2 border-b border-white/10 px-2 pb-2 pt-1">
              <Cover src={menu.track.cover} alt="" seed={menu.track.id} className="h-8 w-8 rounded-md" />
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{menu.track.title}</span>
            </div>
            {[
              { icon: Play, label: "立即播放", fn: () => a.playTrack(menu.track.id, ids) },
              { icon: ListEnd, label: "下一首播放", fn: () => a.playNext(menu.track.id) },
              { icon: ListPlus, label: "加入播放队列", fn: () => a.addToQueue([menu.track.id]) },
              { icon: Heart, label: s.liked.includes(menu.track.id) ? "取消喜欢" : "添加到我喜欢的", fn: () => a.toggleLike(menu.track.id) },
              ...(menu.track.source === "local" ? [{ icon: Trash2, label: "从曲库移除", fn: () => a.removeTracks([menu.track.id]), danger: true }] : []),
            ].map((it) => (
              <button
                key={it.label}
                onClick={() => {
                  it.fn();
                  setMenu(null);
                }}
                className={cn(
                  "mt-0.5 flex h-9 w-full min-w-0 items-center gap-2.5 rounded-xl px-2.5 text-[13px] transition hover:bg-white/10 active:scale-[0.98]",
                  "danger" in it && it.danger ? "text-rose-300" : "text-white/85",
                )}
              >
                <it.icon className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-left">{it.label}</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
