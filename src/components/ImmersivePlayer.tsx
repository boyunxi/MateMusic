import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, FileText, LocateFixed, Maximize2, Minus, Plus, Settings2, Upload } from "lucide-react";
import { useActions, useCurrentTrack, usePlayer } from "../store/PlayerStore";
import { getEngine } from "../lib/audioEngine";
import { cn } from "../utils/cn";
import { Cover, IconButton, QualityBadge, SPRING_SOFT } from "./ui";
import { LikeButton } from "./TrackTable";
import { ProgressRow, TransportControls, useLyrics, VolumeControl } from "./Dock";

/* ---------------- Spectrum ---------------- */
export function Spectrum({ className, bars = 56 }: { className?: string; bars?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { isPlaying } = usePlayer();
  const playingRef = useRef(isPlaying);
  playingRef.current = isPlaying;

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const engine = getEngine();
    const data = new Uint8Array(new ArrayBuffer(256));
    const heights = new Float32Array(bars);
    let raf = 0;
    let colorA = "#a78bfa";
    let colorB = "#22d3ee";
    let lastColor = 0;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, canvas.clientWidth * dpr);
      canvas.height = Math.max(1, canvas.clientHeight * dpr);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const draw = (now: number) => {
      if (now - lastColor > 800) {
        lastColor = now;
        const cs = getComputedStyle(document.documentElement);
        colorA = cs.getPropertyValue("--mm-accent").trim() || colorA;
        colorB = cs.getPropertyValue("--mm-accent2").trim() || colorB;
      }
      const real = engine.getFrequencyData(data);
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      const gap = W / bars;
      const bw = Math.max(2, gap * 0.56);
      const grad = ctx.createLinearGradient(0, H, W, 0);
      grad.addColorStop(0, colorA);
      grad.addColorStop(1, colorB);
      ctx.fillStyle = grad;
      ctx.shadowColor = colorA;
      ctx.shadowBlur = 12;
      for (let i = 0; i < bars; i++) {
        let target: number;
        if (real) {
          const lo = Math.floor(2 * Math.pow(170 / 2, i / bars));
          const hi = Math.max(lo + 1, Math.floor(2 * Math.pow(170 / 2, (i + 1) / bars)));
          let sum = 0;
          for (let k = lo; k < hi; k++) sum += data[k];
          target = sum / (hi - lo) / 255;
          target = Math.pow(target, 1.4) * (1 + i / bars * 0.6);
        } else if (playingRef.current) {
          const t = now / 1000;
          const env = 0.55 + 0.45 * Math.sin(t * 2.1 + i * 0.05);
          target = (0.25 + 0.5 * Math.abs(Math.sin(t * 3.3 + i * 0.55) * Math.cos(t * 1.7 + i * 0.21))) * env * (1 - (i / bars) * 0.45);
        } else target = 0;
        heights[i] += (Math.min(1, target) - heights[i]) * (target > heights[i] ? 0.45 : 0.12);
        const h = Math.max(bw * 0.6, heights[i] * H * 0.92);
        const x = i * gap + (gap - bw) / 2;
        const y = (H - h) / 2;
        if (typeof ctx.roundRect === "function") {
          ctx.beginPath();
          ctx.roundRect(x, y, bw, h, bw / 2);
          ctx.fill();
        } else ctx.fillRect(x, y, bw, h);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [bars]);

  return <canvas ref={ref} className={cn("block w-full shrink-0", className)} />;
}

/* ---------------- Turntable ---------------- */
function Turntable() {
  const track = useCurrentTrack();
  const { isPlaying } = usePlayer();
  const wrap = useRef<HTMLDivElement>(null);
  const [S, setS] = useState(360);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setS(Math.max(200, Math.min(el.clientWidth, el.clientHeight, 500))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!track) return null;
  const platter = S * 0.82;
  return (
    <div ref={wrap} className="flex min-h-0 w-full flex-1 items-center justify-center">
      <div
        className="relative shrink-0 rounded-[28px] border border-white/15 bg-gradient-to-br from-white/[0.12] to-white/[0.02] shadow-[inset_0_1px_1px_rgba(255,255,255,0.3),inset_0_-12px_30px_rgba(0,0,0,0.35),0_40px_80px_rgba(0,0,0,0.55)] backdrop-blur-2xl"
        style={{ width: S, height: S }}
      >
        {/* platter */}
        <div
          className="absolute rounded-full bg-gradient-to-br from-zinc-600/60 to-zinc-900/80 shadow-[inset_0_2px_3px_rgba(255,255,255,0.25),0_14px_30px_rgba(0,0,0,0.6)]"
          style={{ width: platter, height: platter, left: S * 0.06, top: S * 0.09 }}
        >
          <motion.div
            animate={{ scale: isPlaying ? 1 : 0.965 }}
            transition={SPRING_SOFT}
            className="absolute inset-[3%] overflow-hidden rounded-full shadow-[0_6px_18px_rgba(0,0,0,0.7)]"
          >
            <div className={cn("mm-spin absolute inset-0 rounded-full vinyl-grooves", !isPlaying && "paused")}>
              <div className="absolute inset-[30%] overflow-hidden rounded-full ring-4 ring-black/60">
                <Cover src={track.cover} alt={track.title} seed={track.id} className="h-full w-full" />
              </div>
              <div className="absolute left-1/2 top-1/2 h-[4%] w-[4%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-gradient-to-br from-zinc-200 to-zinc-500 shadow-[0_0_0_3px_rgba(0,0,0,0.6)]" />
            </div>
            {/* static reflections */}
            <div className="pointer-events-none absolute inset-0 rounded-full bg-[conic-gradient(from_200deg,transparent_0deg,rgba(255,255,255,0.12)_30deg,transparent_70deg,transparent_180deg,rgba(255,255,255,0.08)_220deg,transparent_260deg)]" />
          </motion.div>
        </div>

        {/* tonearm */}
        <div className="absolute" style={{ left: S * 0.86, top: S * 0.1 }}>
          <div
            className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full bg-gradient-to-br from-zinc-200 to-zinc-500 shadow-[0_6px_14px_rgba(0,0,0,0.5),inset_0_1px_2px_rgba(255,255,255,0.8)]"
            style={{ width: S * 0.13, height: S * 0.13 }}
          >
            <div className="absolute inset-[28%] rounded-full bg-gradient-to-br from-zinc-700 to-zinc-900 shadow-inner" />
          </div>
          <motion.div
            initial={false}
            animate={{ rotate: isPlaying ? 25 : 2 }}
            transition={{ type: "spring", stiffness: 60, damping: 14 }}
            className="absolute"
            style={{ width: 0, height: 0, transformOrigin: "0 0" }}
          >
            <div
              className="absolute -translate-x-1/2 rounded-full bg-gradient-to-r from-zinc-400 via-zinc-100 to-zinc-400 shadow-[0_4px_10px_rgba(0,0,0,0.5)]"
              style={{ width: Math.max(4, S * 0.016), height: S * 0.6, top: 0 }}
            />
            <div
              className="absolute -translate-x-1/2 rounded-[4px] bg-gradient-to-b from-zinc-300 to-zinc-600 shadow-[0_4px_10px_rgba(0,0,0,0.55)]"
              style={{ width: S * 0.055, height: S * 0.09, top: S * 0.58, transform: "translateX(-50%) rotate(18deg)" }}
            />
          </motion.div>
        </div>

        {/* controls */}
        <div className="absolute bottom-[5%] right-[5%] flex items-center gap-2">
          <span className={cn("h-2 w-2 shrink-0 rounded-full transition", isPlaying ? "bg-emerald-400 shadow-[0_0_10px_#34d399]" : "bg-white/20")} />
          <span className="neu-btn grid shrink-0 place-items-center rounded-full text-[10px] font-bold tabular-nums text-white/70" style={{ width: S * 0.1, height: S * 0.1 }}>
            33
          </span>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Lyrics ---------------- */
function LyricsPanel() {
  const s = usePlayer();
  const a = useActions();
  const { lines, index, track } = useLyrics();
  const box = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const userUntil = useRef(0);
  const [detached, setDetached] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const center = (smooth = true) => {
    const el = lineRefs.current[Math.max(0, index)];
    const c = box.current;
    if (!el || !c) return;
    c.scrollTo({ top: el.offsetTop - c.clientHeight / 2 + el.clientHeight / 2, behavior: smooth ? "smooth" : "auto" });
  };

  useEffect(() => {
    if (Date.now() < userUntil.current) return;
    center();
  }, [index, lines]); // eslint-disable-line

  useEffect(() => {
    const t = window.setTimeout(() => center(false), 60);
    return () => window.clearTimeout(t);
  }, [track?.id, s.settings.lyricSize]); // eslint-disable-line

  useEffect(() => {
    if (!detached) return;
    const t = window.setInterval(() => {
      if (Date.now() >= userUntil.current) {
        setDetached(false);
        center();
      }
    }, 500);
    return () => window.clearInterval(t);
  }, [detached]); // eslint-disable-line

  const markUser = () => {
    userUntil.current = Date.now() + 3500;
    setDetached(true);
  };

  const importLrc = async (f?: File) => {
    if (!f || !track) return;
    a.setLyrics(track.id, await f.text());
    a.toast("歌词已导入", "success");
  };

  if (!track) return null;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2">
        <FileText className="h-4 w-4 shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold uppercase tracking-[0.2em] text-white/45">Lyrics · 歌词</span>
        <IconButton label="缩小字号" size="sm" icon={<Minus className="h-4 w-4" />} onClick={() => a.updateSettings({ lyricSize: Math.max(16, s.settings.lyricSize - 2) })} />
        <span className="w-8 shrink-0 text-center text-[11px] tabular-nums text-white/45">{s.settings.lyricSize}</span>
        <IconButton label="放大字号" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => a.updateSettings({ lyricSize: Math.min(40, s.settings.lyricSize + 2) })} />
        <IconButton label="导入 / 替换 LRC 歌词" size="sm" icon={<Upload className="h-4 w-4" />} onClick={() => fileRef.current?.click()} />
        <input ref={fileRef} type="file" accept=".lrc,text/plain" className="hidden" onChange={(e) => (importLrc(e.target.files?.[0]), (e.target.value = ""))} />
      </div>

      {lines.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 text-center">
          <p className="text-[22px] font-semibold text-white/80">纯音乐，请静心聆听</p>
          <p className="max-w-xs text-[12.5px] text-white/45">当前歌曲没有时间轴歌词。你可以导入一个 .lrc 文件，MateMusic 会自动同步滚动。</p>
          <button onClick={() => fileRef.current?.click()} className="neu-btn flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-5 text-[13px] font-medium">
            <Upload className="h-4 w-4 shrink-0" />
            导入 LRC 歌词
          </button>
        </div>
      ) : (
        <div className="relative min-h-0 flex-1">
          <div
            ref={box}
            onWheel={markUser}
            onTouchMove={markUser}
            onPointerDown={(e) => e.target === box.current && markUser()}
            className="no-scrollbar h-full min-h-0 overflow-y-auto"
            style={{
              maskImage: "linear-gradient(to bottom, transparent 0%, black 18%, black 82%, transparent 100%)",
              WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 18%, black 82%, transparent 100%)",
            }}
          >
            <div className="py-[45%] pr-6">
              {lines.map((l, i) => {
                const active = i === index;
                const dist = Math.abs(i - index);
                return (
                  <button
                    key={`${l.time}-${i}`}
                    ref={(el) => {
                      lineRefs.current[i] = el;
                    }}
                    onClick={() => {
                      a.seek(l.time);
                      userUntil.current = 0;
                      setDetached(false);
                    }}
                    className={cn(
                      "group block w-full origin-left rounded-2xl px-4 py-3 text-left font-bold leading-snug transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-white/[0.06]",
                      active ? "scale-100 text-white opacity-100" : "scale-[0.94] text-white/90 opacity-40 blur-[0.5px] hover:opacity-70 hover:blur-0",
                      !active && dist > 3 && "opacity-25 blur-[1px]",
                    )}
                    style={{
                      fontSize: "var(--mm-lyric-size)",
                      textShadow: active ? "0 0 24px color-mix(in oklab, var(--mm-accent) 70%, transparent), 0 0 2px rgba(255,255,255,0.6)" : "none",
                    }}
                  >
                    <span className="break-words">{l.text}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <AnimatePresence>
            {detached && (
              <motion.button
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                onClick={() => {
                  userUntil.current = 0;
                  setDetached(false);
                  center();
                }}
                className="glass absolute bottom-4 right-6 flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-[12px]"
              >
                <LocateFixed className="h-3.5 w-3.5 shrink-0 text-accent" />
                回到当前歌词
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

/* ---------------- Immersive ---------------- */
export function ImmersivePlayer() {
  const s = usePlayer();
  const a = useActions();
  const track = useCurrentTrack();
  const [a1, a2, a3] = track?.palette ?? ["#7c3aed", "#0891b2", "#0b0b14"];

  return (
    <AnimatePresence>
      {s.immersive && track && (
        <motion.div
          key="immersive"
          initial={{ y: "100%", opacity: 0.6, borderRadius: 40 }}
          animate={{ y: 0, opacity: 1, borderRadius: 0 }}
          exit={{ y: "100%", opacity: 0.6, borderRadius: 40 }}
          transition={{ type: "spring", stiffness: 260, damping: 32, mass: 0.9 }}
          className="absolute inset-0 z-50 flex min-h-0 flex-col overflow-hidden"
        >
          {/* background */}
          <div className="pointer-events-none absolute inset-0" aria-hidden>
            <div className="absolute inset-0 transition-colors duration-1000" style={{ backgroundColor: a3 }} />
            <img src={track.cover} alt="" className="absolute inset-0 h-full w-full scale-125 object-cover opacity-50 blur-[90px]" />
            <div className={cn("absolute -left-[10%] top-[-20%] h-[70%] w-[55%] rounded-full opacity-50 blur-[120px] transition-colors duration-1000", !s.settings.reduceMotion && "mm-aurora-a")} style={{ backgroundColor: a1 }} />
            <div className={cn("absolute bottom-[-25%] right-[-10%] h-[75%] w-[55%] rounded-full opacity-45 blur-[130px] transition-colors duration-1000", !s.settings.reduceMotion && "mm-aurora-b")} style={{ backgroundColor: a2 }} />
            <div className="absolute inset-0 bg-black/45 backdrop-blur-3xl" />
          </div>

          {/* top bar */}
          <div data-tauri-drag-region className="relative flex h-16 shrink-0 items-center gap-3 px-6">
            <IconButton label="收起 (Esc)" variant="neu" icon={<ChevronDown className="h-5 w-5" />} onClick={() => a.setImmersive(false)} />
            <div className="flex min-w-0 flex-1 flex-col items-center">
              <span className="truncate text-[11px] font-semibold uppercase tracking-[0.25em] text-white/45">Now Playing</span>
              <span className="truncate text-[13px] text-white/75">{track.album}</span>
            </div>
            <QualityBadge quality={track.quality} format={track.format} hiRes={track.hiRes} />
            <div className="glass-soft flex h-10 shrink-0 items-center rounded-full pl-1 pr-3">
              <VolumeControl compact />
            </div>
            <IconButton
              label="全屏"
              icon={<Maximize2 className="h-4 w-4" />}
              onClick={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.())}
            />
            <IconButton label="设置" icon={<Settings2 className="h-[18px] w-[18px]" />} onClick={a.openSettings} />
          </div>

          {/* content */}
          <div className="relative grid min-h-0 flex-1 grid-cols-2 gap-10 px-12 pb-8">
            <div className="flex h-full min-h-0 min-w-0 flex-col items-center gap-4">
              <Turntable />
              <div className="flex w-full max-w-[520px] min-w-0 shrink-0 items-center gap-3">
                <div className="flex min-w-0 flex-1 flex-col">
                  <motion.h2 key={track.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="truncate text-[26px] font-bold tracking-tight">
                    {track.title}
                  </motion.h2>
                  <span className="truncate text-[14px] text-white/55">{track.artist}</span>
                </div>
                <LikeButton id={track.id} />
              </div>
              {s.settings.showSpectrum && <Spectrum className="h-12 max-w-[520px]" />}
              <ProgressRow className="max-w-[520px]" />
              <div className="flex w-full max-w-[520px] shrink-0 items-center justify-center">
                <TransportControls size="lg" />
              </div>
            </div>
            <div className="h-full min-h-0 min-w-0">
              <LyricsPanel />
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
