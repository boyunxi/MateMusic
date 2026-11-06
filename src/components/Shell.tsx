import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Clock3, Copy, Disc3, FolderInput, Heart, Library, ListMusic, Minus, PanelLeftClose, PanelLeftOpen, Search, Settings2, Square, Upload, X,
} from "lucide-react";
import { useActions, useCurrentTrack, usePlayer } from "../store/PlayerStore";
import { CURATED_PLAYLISTS } from "../data/presets";
import { PRESET_TRACKS } from "../data/presets";
import { cn } from "../utils/cn";
import { Kbd, SPRING } from "./ui";
import type { NavKey } from "../types";
import { appWindow, inTauri } from "../lib/tauri";
import { getCurrentWindow } from "@tauri-apps/api/window";

type ResizeDirection = "East" | "North" | "NorthEast" | "NorthWest" | "South" | "SouthEast" | "SouthWest" | "West";

/* ---------------- Frameless resize handles ---------------- */
export function ResizeHandles() {
  if (!inTauri) return null;
  const start = (direction: ResizeDirection) => (event: React.PointerEvent) => {
    event.preventDefault();
    void getCurrentWindow().startResizeDragging(direction);
  };
  const edge = "fixed z-[130]";
  return (
    <>
      <div className={`${edge} left-0 top-3 bottom-3 w-1 cursor-ew-resize`} onPointerDown={start("West")} />
      <div className={`${edge} right-0 top-3 bottom-3 w-1 cursor-ew-resize`} onPointerDown={start("East")} />
      <div className={`${edge} left-3 right-3 top-0 h-1 cursor-ns-resize`} onPointerDown={start("North")} />
      <div className={`${edge} left-3 right-3 bottom-0 h-1 cursor-ns-resize`} onPointerDown={start("South")} />
      <div className={`${edge} left-0 top-0 h-3 w-3 cursor-nwse-resize`} onPointerDown={start("NorthWest")} />
      <div className={`${edge} right-0 top-0 h-3 w-3 cursor-nesw-resize`} onPointerDown={start("NorthEast")} />
      <div className={`${edge} left-0 bottom-0 h-3 w-3 cursor-nesw-resize`} onPointerDown={start("SouthWest")} />
      <div className={`${edge} right-0 bottom-0 h-3 w-3 cursor-nwse-resize`} onPointerDown={start("SouthEast")} />
    </>
  );
}

/* ---------------- Ambient background ---------------- */
export function AmbientBackground() {
  const track = useCurrentTrack();
  const { settings } = usePlayer();
  const [a, b, c] = track?.palette ?? PRESET_TRACKS[0].palette;
  const anim = settings.dynamicBackground && !settings.reduceMotion;
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      <div className="absolute inset-0 transition-colors duration-[1600ms]" style={{ backgroundColor: c }} />
      <div className="absolute inset-0 bg-[#06050b]/70" />
      <div className="absolute inset-0" style={{ opacity: "var(--mm-ambient)" }}>
        <div
          className={cn("absolute -left-[15%] -top-[25%] h-[75%] w-[60%] rounded-full blur-[120px] transition-colors duration-[1600ms]", anim && "mm-aurora-a")}
          style={{ backgroundColor: a, opacity: 0.55 }}
        />
        <div
          className={cn("absolute -right-[10%] top-[10%] h-[70%] w-[50%] rounded-full blur-[130px] transition-colors duration-[1600ms]", anim && "mm-aurora-b")}
          style={{ backgroundColor: b, opacity: 0.5 }}
        />
        <div
          className={cn("absolute -bottom-[30%] left-[25%] h-[60%] w-[55%] rounded-full blur-[140px] transition-colors duration-[1600ms]", anim && "mm-aurora-c")}
          style={{ backgroundColor: a, opacity: 0.3 }}
        />
      </div>
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_40%,rgba(0,0,0,0.55)_100%)]" />
      <div
        className="absolute inset-0 opacity-[0.06] mix-blend-overlay"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")",
        }}
      />
    </div>
  );
}

/* ---------------- Logo ---------------- */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <div
      className="relative grid shrink-0 place-items-center rounded-[10px] bg-gradient-to-br from-accent to-accent2 shadow-[inset_0_1px_1px_rgba(255,255,255,0.6),0_6px_18px_color-mix(in_oklab,var(--mm-accent)_45%,transparent)]"
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 24 24" className="h-[62%] w-[62%] text-black/80" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 18V7l5 6 5-6v11" />
        <circle cx="18.5" cy="16.5" r="2.5" />
        <path d="M21 16.5V5" />
      </svg>
    </div>
  );
}

/* ---------------- Title bar ---------------- */
export function TitleBar() {
  const s = usePlayer();
  const a = useActions();
  const inputRef = useRef<HTMLInputElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!inTauri) return;
    void appWindow.isMaximized().then(setMaximized).catch(() => {});
  }, []);

  useEffect(() => {
    const h = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", h);
    const k = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w" && inTauri) {
        e.preventDefault();
        void appWindow.close();
      }
    };
    window.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("fullscreenchange", h);
      window.removeEventListener("keydown", k);
    };
  }, []);

  const toggleFullscreen = () => {
    if (inTauri) {
      void appWindow.toggleMaximize().then(() => appWindow.isMaximized().then(setMaximized)).catch(() => {});
      return;
    }
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => a.toast("当前环境不支持最大化", "error"));
  };

  const winBtn = "grid h-8 w-10 shrink-0 place-items-center rounded-lg text-white/60 transition-all hover:bg-white/10 hover:text-white active:scale-95";

  return (
    <header data-tauri-drag-region className="relative z-20 flex h-14 shrink-0 items-center gap-4 px-4">
      <div data-tauri-drag-region className="flex w-[220px] min-w-0 shrink-0 items-center gap-2.5">
        <Logo />
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[15px] font-semibold tracking-tight">MateMusic</span>
          <span className="truncate text-[10px] uppercase tracking-[0.2em] text-white/40">Spatial Player</span>
        </div>
      </div>

      <div className="flex min-w-0 flex-1 justify-center">
        <label className="glass-soft group flex h-9 w-full max-w-[460px] min-w-0 items-center gap-2 rounded-full px-3.5 transition focus-within:border-accent/50 focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--mm-accent)_18%,transparent)]">
          <Search className="h-4 w-4 shrink-0 text-white/45 group-focus-within:text-accent" />
          <input
            ref={inputRef}
            value={s.search}
            onChange={(e) => a.setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && (a.setSearch(""), (e.target as HTMLInputElement).blur())}
            placeholder="搜索歌曲、歌手、专辑…"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-white outline-none placeholder:text-white/35"
          />
          {s.search ? (
            <button onClick={() => a.setSearch("")} className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-white/15 text-white/70 hover:bg-white/25" aria-label="清空搜索">
              <X className="h-3 w-3" />
            </button>
          ) : (
            <span className="hidden shrink-0 items-center gap-1 lg:flex">
              <Kbd>Ctrl</Kbd>
              <Kbd>K</Kbd>
            </span>
          )}
        </label>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <button
          onClick={() => void a.pickFiles()}
          className="neu-btn mr-1 flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-3.5 text-[12.5px] font-medium text-white/85"
        >
          <Upload className="h-4 w-4 shrink-0" />
          导入音乐
        </button>
        <button title="设置 (Ctrl+,)" onClick={a.openSettings} className={cn(winBtn, "w-9 rounded-full", s.settingsOpen && "text-accent")}>
          <Settings2 className="h-[18px] w-[18px]" />
        </button>
        <span className="mx-2 h-5 w-px shrink-0 bg-white/15" />
        <button title="最小化（迷你模式）" onClick={() => a.setWindowMode("mini")} className={winBtn}>
          <Minus className="h-4 w-4" />
        </button>
        <button title={fullscreen || maximized ? "还原" : "最大化"} onClick={toggleFullscreen} className={winBtn}>
          {fullscreen || maximized ? <Copy className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
        </button>
        <button
          title={s.settings.closeBehavior === "mini" ? "关闭（缩为迷你播放器，Ctrl+W 退出）" : "关闭（进入休眠，Ctrl+W 退出）"}
          onClick={() => a.setWindowMode(s.settings.closeBehavior === "mini" ? "mini" : "sleep")}
          className={cn(winBtn, "hover:bg-rose-500/85 hover:text-white")}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}

/* ---------------- Sidebar ---------------- */
const NAV: { key: NavKey; label: string; icon: typeof Library }[] = [
  { key: "library", label: "我的曲库", icon: Library },
  { key: "local", label: "本地导入", icon: FolderInput },
  { key: "recent", label: "最近播放", icon: Clock3 },
  { key: "liked", label: "我喜欢的", icon: Heart },
  { key: "playlists", label: "精选歌单", icon: ListMusic },
];

function FadeLabel({ show, children, className }: { show: boolean; children: React.ReactNode; className?: string }) {
  return (
    <motion.span
      initial={false}
      animate={{ opacity: show ? 1 : 0, x: show ? 0 : -8 }}
      transition={{ duration: 0.18 }}
      className={cn("min-w-0 flex-1 overflow-hidden truncate whitespace-nowrap text-left", className)}
    >
      {children}
    </motion.span>
  );
}

export function Sidebar() {
  const s = usePlayer();
  const a = useActions();
  const track = useCurrentTrack();
  const open = !s.sidebarCollapsed;
  const counts: Record<NavKey, number> = {
    library: s.tracks.length,
    local: s.tracks.filter((t) => t.source === "local").length,
    recent: s.recent.length,
    liked: s.liked.length,
    playlists: CURATED_PLAYLISTS.length,
  };

  return (
    <motion.aside
      initial={false}
      animate={{ width: open ? 236 : 76 }}
      transition={SPRING}
      className="glass relative flex h-full min-h-0 shrink-0 flex-col overflow-hidden rounded-[22px] py-3"
    >
      <div className="flex h-8 shrink-0 items-center px-[22px]">
        <FadeLabel show={open} className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-white/35">
          浏览
        </FadeLabel>
      </div>
      <nav className="flex shrink-0 flex-col gap-1 px-2.5">
        {NAV.map((n) => {
          const active = s.nav === n.key;
          const Icon = n.icon;
          return (
            <button
              key={n.key}
              title={open ? undefined : n.label}
              onClick={() => a.setNav(n.key)}
              className={cn(
                "relative flex h-11 w-full min-w-0 shrink-0 items-center rounded-xl text-[13.5px] transition-colors active:scale-[0.98]",
                active ? "text-white" : "text-white/60 hover:bg-white/[0.06] hover:text-white",
              )}
            >
              {active && (
                <motion.span
                  layoutId="nav-active"
                  transition={SPRING}
                  className="absolute inset-0 rounded-xl border border-white/15 bg-white/[0.11] shadow-[inset_0_1px_1px_rgba(255,255,255,0.2),0_6px_18px_rgba(0,0,0,0.25)]"
                />
              )}
              <span className="relative grid h-11 w-[51px] shrink-0 place-items-center">
                <Icon className={cn("h-[19px] w-[19px] shrink-0", active && "text-accent drop-shadow-[0_0_6px_var(--mm-accent)]")} />
              </span>
              <FadeLabel show={open} className="relative font-medium">
                {n.label}
              </FadeLabel>
              <motion.span
                initial={false}
                animate={{ opacity: open ? 1 : 0 }}
                className="relative mr-3 shrink-0 text-[11px] tabular-nums text-white/35"
              >
                {counts[n.key]}
              </motion.span>
            </button>
          );
        })}
      </nav>

      <div className="mt-4 flex h-8 shrink-0 items-center px-[22px]">
        <FadeLabel show={open} className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-white/35">
          歌单
        </FadeLabel>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden px-2.5 no-scrollbar">
        {CURATED_PLAYLISTS.map((p) => {
          const active = s.nav === "playlists" && s.activePlaylist === p.id;
          return (
            <button
              key={p.id}
              title={open ? undefined : p.name}
              onClick={() => a.openPlaylist(p.id)}
              className={cn(
                "flex h-10 w-full min-w-0 shrink-0 items-center rounded-xl text-[13px] transition active:scale-[0.98]",
                active ? "bg-white/[0.09] text-white" : "text-white/55 hover:bg-white/[0.05] hover:text-white",
              )}
            >
              <span className="grid h-10 w-[51px] shrink-0 place-items-center">
                <span className="h-6 w-6 shrink-0 rounded-lg shadow-[inset_0_1px_1px_rgba(255,255,255,0.4)]" style={{ background: p.gradient }} />
              </span>
              <FadeLabel show={open}>{p.name}</FadeLabel>
            </button>
          );
        })}
      </div>

      <AnimatePresence initial={false}>
        {open && track && (
          <motion.button
            key="np"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            onClick={() => a.setImmersive(true)}
            className="glass-soft mx-2.5 mb-2 flex h-14 w-[212px] min-w-0 shrink-0 items-center gap-2.5 overflow-hidden rounded-2xl px-2 text-left transition hover:bg-white/10"
          >
            <span className="relative h-10 w-10 shrink-0">
              <img src={track.cover} alt="" className={cn("h-10 w-10 shrink-0 rounded-full object-cover mm-spin", !s.isPlaying && "paused")} />
              <span className="absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/40 bg-black/70" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[12.5px] font-medium">{track.title}</span>
              <span className="truncate text-[11px] text-white/45">{track.artist}</span>
            </span>
            <Disc3 className="h-4 w-4 shrink-0 text-accent" />
          </motion.button>
        )}
      </AnimatePresence>

      <div className="shrink-0 px-2.5">
        <button
          onClick={a.toggleSidebar}
          title={open ? "折叠侧栏" : "展开侧栏"}
          className="flex h-10 w-full min-w-0 items-center rounded-xl text-white/50 transition hover:bg-white/[0.06] hover:text-white active:scale-[0.98]"
        >
          <span className="grid h-10 w-[51px] shrink-0 place-items-center">
            {open ? <PanelLeftClose className="h-[18px] w-[18px]" /> : <PanelLeftOpen className="h-[18px] w-[18px]" />}
          </span>
          <FadeLabel show={open} className="text-[12.5px]">
            折叠侧栏
          </FadeLabel>
        </button>
      </div>
    </motion.aside>
  );
}
