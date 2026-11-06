import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "../utils/cn";
import { clamp, generatedCover } from "../lib/utils";

export const SPRING = { type: "spring", stiffness: 380, damping: 34, mass: 0.8 } as const;
export const SPRING_SOFT = { type: "spring", stiffness: 220, damping: 30 } as const;

/* ---------------- Icon button ---------------- */
interface IconButtonProps {
  icon: ReactNode;
  label: string;
  onClick?: (e: React.MouseEvent) => void;
  active?: boolean;
  size?: "sm" | "md" | "lg";
  variant?: "ghost" | "neu" | "primary";
  className?: string;
  disabled?: boolean;
  badge?: ReactNode;
}
export function IconButton({ icon, label, onClick, active, size = "md", variant = "ghost", className, disabled, badge }: IconButtonProps) {
  const dims = size === "sm" ? "h-8 w-8" : size === "lg" ? "h-14 w-14" : "h-10 w-10";
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full outline-none transition-all duration-200 active:scale-95 disabled:pointer-events-none disabled:opacity-35 focus-visible:ring-2 focus-visible:ring-accent/60",
        dims,
        variant === "ghost" && "text-white/70 hover:bg-white/10 hover:text-white",
        variant === "neu" && "neu-btn text-white/85 hover:text-white",
        variant === "primary" && "neu-primary text-black/85",
        active && variant === "ghost" && "text-accent hover:text-accent bg-white/[0.06]",
        className,
      )}
    >
      {icon}
      {badge}
      {active && variant === "ghost" && <span className="absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-accent shadow-[0_0_6px_var(--mm-accent)]" />}
    </button>
  );
}

/* ---------------- Slider ---------------- */
interface SliderProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange?: (v: number) => void;
  onCommit?: (v: number) => void;
  buffered?: number;
  orientation?: "horizontal" | "vertical";
  className?: string;
  trackClassName?: string;
  tip?: (v: number) => string;
  ariaLabel?: string;
  centerZero?: boolean;
}
export function Slider({ value, min = 0, max = 1, step = 0, onChange, onCommit, buffered, orientation = "horizontal", className, trackClassName, tip, ariaLabel, centerZero }: SliderProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const vertical = orientation === "vertical";
  const range = max - min || 1;
  const shown = drag ?? value;
  const pct = clamp((shown - min) / range, 0, 1) * 100;
  const bufPct = buffered != null ? clamp((buffered - min) / range, 0, 1) * 100 : 0;

  const fromEvent = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    let ratio = vertical ? 1 - (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
    ratio = clamp(ratio, 0, 1);
    let v = min + ratio * range;
    if (step) v = Math.round(v / step) * step;
    return clamp(v, min, max);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const v = fromEvent(e);
    setDrag(v);
    onChange?.(v);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const v = fromEvent(e);
    setHover(v);
    if (drag != null) {
      setDrag(v);
      onChange?.(v);
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (drag == null) return;
    const v = fromEvent(e);
    setDrag(null);
    onCommit?.(v);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const s = step || range / 100;
    let v: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") v = clamp(value + s, min, max);
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") v = clamp(value - s, min, max);
    if (v != null) {
      e.preventDefault();
      e.stopPropagation();
      onChange?.(v);
      onCommit?.(v);
    }
  };

  const zeroPct = centerZero ? clamp((0 - min) / range, 0, 1) * 100 : 0;
  const fillStart = centerZero ? Math.min(zeroPct, pct) : 0;
  const fillSize = centerZero ? Math.abs(pct - zeroPct) : pct;
  const active = drag != null;

  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value * 100) / 100}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
      onPointerLeave={() => setHover(null)}
      onKeyDown={onKey}
      className={cn(
        "group relative flex shrink-0 cursor-pointer touch-none items-center outline-none",
        vertical ? "h-full w-6 flex-col justify-center" : "h-5 w-full",
        className,
      )}
    >
      <div
        className={cn(
          "neu-inset relative overflow-hidden rounded-full transition-all duration-200",
          vertical ? "h-full w-1.5 group-hover:w-2" : "h-1 w-full group-hover:h-1.5",
          active && (vertical ? "w-2" : "h-1.5"),
          trackClassName,
        )}
      >
        {buffered != null && (
          <div className="absolute inset-y-0 left-0 rounded-full bg-white/15 transition-[width] duration-500" style={{ width: `${bufPct}%` }}>
            <div className="absolute inset-0 animate-pulse bg-gradient-to-r from-transparent via-white/10 to-white/20" />
          </div>
        )}
        <div
          className="absolute rounded-full bg-gradient-to-r from-accent to-accent2 shadow-[0_0_12px_var(--mm-accent)]"
          style={
            vertical
              ? { left: 0, right: 0, bottom: `${fillStart}%`, height: `${fillSize}%`, backgroundImage: "linear-gradient(to top, var(--mm-accent), var(--mm-accent2))" }
              : { top: 0, bottom: 0, left: `${fillStart}%`, width: `${fillSize}%` }
          }
        />
      </div>
      <div
        className={cn(
          "pointer-events-none absolute h-3.5 w-3.5 shrink-0 rounded-full bg-white shadow-[0_0_0_3px_rgba(255,255,255,0.15),0_2px_8px_rgba(0,0,0,0.5)] transition-transform duration-200",
          active ? "scale-110" : "scale-0 group-hover:scale-100 group-focus-visible:scale-100",
        )}
        style={vertical ? { bottom: `calc(${pct}% - 7px)`, left: "calc(50% - 7px)" } : { left: `calc(${pct}% - 7px)` }}
      />
      {tip && (hover != null || active) && !vertical && (
        <div
          className="pointer-events-none absolute -top-8 shrink-0 -translate-x-1/2 rounded-md border border-white/15 bg-black/70 px-2 py-0.5 text-[11px] font-medium tabular-nums text-white backdrop-blur-md"
          style={{ left: `${clamp(((active ? shown : hover!) - min) / range, 0, 1) * 100}%` }}
        >
          {tip(active ? shown : hover!)}
        </div>
      )}
    </div>
  );
}

/* ---------------- Switch ---------------- */
export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-7 w-12 shrink-0 rounded-full transition-colors duration-300 active:scale-95",
        checked ? "bg-gradient-to-r from-accent to-accent2 shadow-[inset_0_1px_3px_rgba(0,0,0,0.25),0_0_16px_color-mix(in_oklab,var(--mm-accent)_40%,transparent)]" : "neu-inset",
      )}
    >
      <motion.span
        layout
        transition={SPRING}
        className={cn(
          "absolute top-1 h-5 w-5 rounded-full bg-gradient-to-b from-white to-slate-200 shadow-[0_2px_6px_rgba(0,0,0,0.45),inset_0_-1px_1px_rgba(0,0,0,0.1)]",
          checked ? "right-1" : "left-1",
        )}
      />
    </button>
  );
}

/* ---------------- Select ---------------- */
export function Select<T extends string | number>({ value, options, onChange, className, width = "w-48" }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; className?: string; width?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [open]);
  const cur = options.find((o) => o.value === value);
  return (
    <div ref={ref} className={cn("relative shrink-0", width, className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="glass-soft flex h-9 w-full min-w-0 items-center gap-2 rounded-xl px-3 text-left text-[13px] text-white/90 transition hover:bg-white/10 active:scale-[0.98]"
      >
        <span className="min-w-0 flex-1 truncate">{cur?.label ?? "—"}</span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-white/50 transition-transform", open && "rotate-180")} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.16 }}
            className="glass-strong absolute right-0 z-50 mt-1.5 max-h-64 w-full min-w-[180px] overflow-y-auto rounded-xl p-1"
          >
            {options.map((o) => (
              <button
                key={String(o.value)}
                type="button"
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                className={cn(
                  "flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2.5 text-left text-[13px] transition hover:bg-white/10",
                  o.value === value ? "text-accent" : "text-white/80",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.value === value && <Check className="h-3.5 w-3.5 shrink-0" />}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ---------------- Visualizer bars ---------------- */
export function Bars({ playing, className }: { playing: boolean; className?: string }) {
  return (
    <span className={cn("mm-bars inline-flex h-3.5 w-4 shrink-0 items-end justify-between", !playing && "paused", className)}>
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className="block h-full w-[3px] rounded-full bg-accent shadow-[0_0_6px_var(--mm-accent)]" />
      ))}
    </span>
  );
}

/* ---------------- Cover ---------------- */
export function Cover({ src, alt, className, seed }: { src: string; alt: string; className?: string; seed?: string }) {
  const [err, setErr] = useState(false);
  useEffect(() => setErr(false), [src]);
  return (
    <img
      src={err ? generatedCover(seed || alt, alt) : src}
      alt={alt}
      draggable={false}
      onError={() => setErr(true)}
      className={cn("shrink-0 select-none object-cover", className)}
    />
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md border border-white/15 bg-white/[0.06] px-1.5 text-[11px] text-white/80 shadow-[inset_0_-2px_0_rgba(0,0,0,0.35)]">
      {children}
    </kbd>
  );
}

export function QualityBadge({ quality, format, hiRes, className }: { quality: string; format: string; hiRes?: boolean; className?: string }) {
  const lossless = format === "FLAC" || format === "WAV";
  const label = hiRes ? "Hi-Res" : lossless ? format : /^(\d+)/.test(quality) && parseInt(quality, 10) >= 300 ? "HQ" : "SQ";
  return (
    <span
      title={`${format} · ${quality}`}
      className={cn(
        "inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-md border px-1.5 text-[10px] font-semibold tracking-wide",
        hiRes ? "border-amber-300/50 bg-amber-300/10 text-amber-200" : lossless ? "border-accent/50 bg-accent/10 text-accent" : "border-white/20 bg-white/5 text-white/60",
        className,
      )}
    >
      {label}
    </span>
  );
}
