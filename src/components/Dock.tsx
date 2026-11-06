import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronUp, Gauge, ListMusic, Loader2, MicVocal, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume, Volume1, Volume2, VolumeX } from "lucide-react";
import { useActions, useCurrentTrack, usePlayer, useTime } from "../store/PlayerStore";
import { findLyricIndex, formatTime, parseLrc } from "../lib/utils";
import { cn } from "../utils/cn";
import { Cover, IconButton, QualityBadge, Slider } from "./ui";
import { LikeButton } from "./TrackTable";

export function useLyrics() {
  const track = useCurrentTrack();
  const { currentTime } = useTime();
  const lines = useMemo(() => parseLrc(track?.lrc), [track?.lrc]);
  const index = useMemo(() => findLyricIndex(lines, currentTime), [lines, currentTime]);
  return { track, lines, index };
}

export function ProgressRow({ className }: { className?: string }) {
  const { currentTime, duration, buffered } = useTime();
  const track = useCurrentTrack();
  const a = useActions();
  const dur = duration || track?.duration || 0;
  const [scrub, setScrub] = useState<number | null>(null);
  return (
    <div className={cn("flex w-full min-w-0 items-center gap-3", className)}>
      <span className="w-11 shrink-0 text-right text-[11.5px] tabular-nums text-white/55">{formatTime(scrub ?? currentTime)}</span>
      <Slider
        ariaLabel="播放进度"
        value={currentTime}
        max={dur || 1}
        buffered={buffered}
        onChange={setScrub}
        onCommit={(v) => {
          setScrub(null);
          a.seek(v);
        }}
        tip={(v) => formatTime(v)}
        className="min-w-0 flex-1"
      />
      <span className="w-11 shrink-0 text-[11.5px] tabular-nums text-white/55">{formatTime(dur)}</span>
    </div>
  );
}

export function TransportControls({ size = "md" }: { size?: "md" | "lg" }) {
  const s = usePlayer();
  const a = useActions();
  const lg = size === "lg";
  return (
    <div className={cn("flex shrink-0 items-center justify-center", lg ? "gap-5" : "gap-3")}>
      <IconButton
        label={s.loopMode === "shuffle" ? "关闭随机播放" : "随机播放"}
        icon={<Shuffle className="h-[17px] w-[17px]" />}
        size={lg ? "md" : "sm"}
        active={s.loopMode === "shuffle"}
        onClick={a.toggleShuffle}
      />
      <IconButton label="上一首 (Ctrl+←)" icon={<SkipBack className={cn("fill-current", lg ? "h-5 w-5" : "h-[18px] w-[18px]")} />} size={lg ? "lg" : "md"} variant={lg ? "neu" : "ghost"} onClick={a.prev} />
      <button
        onClick={a.togglePlay}
        aria-label={s.isPlaying ? "暂停" : "播放"}
        title={s.isPlaying ? "暂停 (Space)" : "播放 (Space)"}
        className={cn("neu-primary relative grid shrink-0 place-items-center rounded-full text-black/85", lg ? "h-[72px] w-[72px]" : "h-11 w-11")}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span key={s.isPlaying ? "pause" : "play"} initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.5, opacity: 0 }} transition={{ duration: 0.14 }}>
            {s.isPlaying ? <Pause className={cn("fill-current", lg ? "h-7 w-7" : "h-[18px] w-[18px]")} /> : <Play className={cn("ml-0.5 fill-current", lg ? "h-7 w-7" : "h-[18px] w-[18px]")} />}
          </motion.span>
        </AnimatePresence>
        {s.waiting && s.isPlaying && <Loader2 className={cn("absolute animate-spin text-black/40", lg ? "h-[84px] w-[84px]" : "h-[54px] w-[54px]")} strokeWidth={1} />}
      </button>
      <IconButton label="下一首 (Ctrl+→)" icon={<SkipForward className={cn("fill-current", lg ? "h-5 w-5" : "h-[18px] w-[18px]")} />} size={lg ? "lg" : "md"} variant={lg ? "neu" : "ghost"} onClick={() => a.next()} />
      <IconButton
        label={s.loopMode === "one" ? "单曲循环" : "列表循环"}
        icon={s.loopMode === "one" ? <Repeat1 className="h-[17px] w-[17px]" /> : <Repeat className="h-[17px] w-[17px]" />}
        size={lg ? "md" : "sm"}
        active={s.loopMode !== "shuffle"}
        onClick={() => a.setLoop(s.loopMode === "one" ? "list" : "one")}
      />
    </div>
  );
}

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

function RateButton() {
  const s = usePlayer();
  const a = useActions();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [open]);
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        title="播放倍速"
        className={cn("flex h-8 w-[54px] shrink-0 items-center justify-center gap-1 rounded-full text-[11.5px] font-semibold tabular-nums transition hover:bg-white/10 active:scale-95", s.rate !== 1 ? "text-accent" : "text-white/60")}
      >
        <Gauge className="h-3.5 w-3.5 shrink-0" />
        {Number.isInteger(Math.round(s.rate * 100) / 10) ? s.rate.toFixed(1) : s.rate.toFixed(2)}x
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96 }}
            transition={{ duration: 0.15 }}
            className="glass-strong absolute bottom-11 left-1/2 z-50 w-28 -translate-x-1/2 rounded-2xl p-1.5"
          >
            {RATES.map((r) => (
              <button
                key={r}
                onClick={() => {
                  a.setRate(r);
                  setOpen(false);
                }}
                className={cn("flex h-8 w-full items-center justify-center rounded-xl text-[12.5px] tabular-nums transition hover:bg-white/10", r === s.rate ? "text-accent" : "text-white/80")}
              >
                {r.toFixed(2)}x
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function VolumeControl({ compact }: { compact?: boolean }) {
  const s = usePlayer();
  const a = useActions();
  const v = s.muted ? 0 : s.volume;
  const Icon = v === 0 ? VolumeX : v < 0.33 ? Volume : v < 0.66 ? Volume1 : Volume2;
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <IconButton label={s.muted ? "取消静音 (M)" : "静音 (M)"} icon={<Icon className="h-[18px] w-[18px]" />} size="sm" onClick={a.toggleMute} />
      <Slider ariaLabel="音量" value={v} onChange={a.setVolume} className={compact ? "w-16 xl:w-20" : "w-24"} />
      <span className={cn("w-9 shrink-0 text-right text-[11px] tabular-nums text-white/45", compact && "hidden xl:block")}>{Math.round(v * 100)}%</span>
    </div>
  );
}

export function Dock() {
  const s = usePlayer();
  const a = useActions();
  const track = useCurrentTrack();
  const floating = s.settings.dockStyle === "floating";

  return (
    <div className={cn("relative z-30 shrink-0", floating ? "px-4 pb-4" : "")}>
      <footer
        className={cn(
          "glass grid h-20 shrink-0 grid-cols-[minmax(0,1fr)_minmax(380px,1.35fr)_minmax(0,1fr)] items-center gap-5 px-4",
          floating ? "rounded-[24px]" : "rounded-none border-x-0 border-b-0",
        )}
      >
        {/* Left */}
        <div className="flex min-w-0 items-center gap-3">
          <button
            onClick={() => track && a.setImmersive(true)}
            disabled={!track}
            title="展开沉浸式播放 (F)"
            className="group relative h-14 w-14 shrink-0 overflow-hidden rounded-xl shadow-[0_8px_20px_rgba(0,0,0,0.45)] ring-1 ring-white/15 transition active:scale-95"
          >
            {track ? (
              <Cover src={track.cover} alt={track.title} seed={track.id} className="h-14 w-14" />
            ) : (
              <div className="neu-inset grid h-14 w-14 place-items-center">
                <ListMusic className="h-5 w-5 text-white/30" />
              </div>
            )}
            {track && (
              <span className="absolute inset-0 grid place-items-center bg-black/45 opacity-0 backdrop-blur-[2px] transition group-hover:opacity-100">
                <ChevronUp className="h-6 w-6 shrink-0 text-white transition-transform group-hover:-translate-y-0.5" />
              </span>
            )}
          </button>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[14px] font-semibold text-white/95">{track?.title ?? "MateMusic"}</span>
            <span className="truncate text-[12px] text-white/50">{track ? `${track.artist} · ${track.album}` : "选择一首歌开始聆听"}</span>
          </div>
          {track && <LikeButton id={track.id} />}
        </div>

        {/* Center */}
        <div className="flex min-w-0 flex-col items-center justify-center gap-0.5">
          <TransportControls />
          <ProgressRow />
        </div>

        {/* Right */}
        <div className="flex min-w-0 items-center justify-end gap-1">
          {track && <QualityBadge quality={track.quality} format={track.format} hiRes={track.hiRes} className="mr-1 hidden xl:inline-flex" />}
          <RateButton />
          <IconButton label="桌面歌词" icon={<MicVocal className="h-[17px] w-[17px]" />} size="sm" active={s.floatingLyrics} onClick={a.toggleFloatingLyrics} />
          <VolumeControl compact />
          <IconButton
            label="播放队列"
            icon={<ListMusic className="h-[18px] w-[18px]" />}
            size="sm"
            active={s.queueOpen}
            onClick={a.toggleQueue}
          />
        </div>
      </footer>
    </div>
  );
}

/** Floating "desktop lyric" capsule shown above the dock. */
export function FloatingLyrics() {
  const s = usePlayer();
  const { lines, index, track } = useLyrics();
  if (!s.floatingLyrics || !track) return null;
  const text = lines.length ? (index >= 0 ? lines[index].text : `${track.title} — ${track.artist}`) : "暂无歌词";
  const nextText = lines[index + 1]?.text;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-[108px] z-30 flex justify-center px-8">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="glass pointer-events-auto flex h-[58px] w-[min(640px,70%)] min-w-0 flex-col items-center justify-center overflow-hidden rounded-2xl px-6"
      >
        <AnimatePresence mode="wait">
          <motion.span
            key={`${track.id}-${index}`}
            initial={{ opacity: 0, y: 10, filter: "blur(4px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -10, filter: "blur(4px)" }}
            transition={{ duration: 0.28 }}
            className="w-full truncate bg-gradient-to-r from-accent to-accent2 bg-clip-text text-center text-[16px] font-semibold text-transparent"
          >
            {text}
          </motion.span>
        </AnimatePresence>
        {nextText && <span className="w-full truncate text-center text-[11.5px] text-white/40">{nextText}</span>}
      </motion.div>
    </div>
  );
}
