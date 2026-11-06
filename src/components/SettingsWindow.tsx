import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useDragControls } from "framer-motion";
import { AudioLines, FolderInput, Info, Keyboard, Minus, Palette, Settings2, SlidersHorizontal, Speaker, X, RotateCcw, Trash2, Check } from "lucide-react";
import { ACCENTS, useActions, useCurrentTrack, usePlayer } from "../store/PlayerStore";
import { EQ_FREQS, getEngine } from "../lib/audioEngine";
import { formatBytes, formatDurationLong } from "../lib/utils";
import { cn } from "../utils/cn";
import { Kbd, Select, Slider, SPRING, Switch } from "./ui";
import { Logo } from "./Shell";
import type { AccentKey } from "../types";
import { inTauri } from "../lib/tauri";
import { getLibraryStats, type LibraryStats } from "../lib/nativeLibrary";

const SECTIONS = [
  { id: "general", label: "常规设置", icon: Settings2 },
  { id: "audio", label: "音频与输出", icon: Speaker },
  { id: "eq", label: "音效与均衡器", icon: SlidersHorizontal },
  { id: "keys", label: "全局快捷键", icon: Keyboard },
  { id: "look", label: "外观与玻璃", icon: Palette },
  { id: "about", label: "关于 MateMusic", icon: Info },
] as const;

export const EQ_PRESETS: Record<string, { name: string; bands: number[] }> = {
  flat: { name: "平坦 Flat", bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  pop: { name: "流行 Pop", bands: [-1, 1, 3, 4, 3, 0, -1, -1, 1, 2] },
  rock: { name: "摇滚 Rock", bands: [5, 4, 2, -1, -2, -1, 2, 3, 4, 5] },
  jazz: { name: "爵士 Jazz", bands: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3] },
  classical: { name: "古典 Classical", bands: [4, 3, 2, 1, -1, -1, 0, 2, 3, 4] },
  bass: { name: "低音增强 Bass", bands: [7, 6, 4, 2, 0, 0, 0, 0, 0, 0] },
  vocal: { name: "人声 Vocal", bands: [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1] },
  electronic: { name: "电子 Electronic", bands: [5, 4, 1, 0, -2, 1, 0, 1, 4, 5] },
  treble: { name: "高音增强 Treble", bands: [0, 0, 0, 0, 0, 1, 3, 5, 6, 7] },
};

function Section({ id, title, desc, children }: { id: string; title: string; desc: string; children: React.ReactNode }) {
  return (
    <section id={`mm-set-${id}`} data-section={id} className="scroll-mt-4 pb-8">
      <h2 className="truncate text-[18px] font-bold tracking-tight">{title}</h2>
      <p className="mt-0.5 truncate text-[12px] text-white/45">{desc}</p>
      <div className="glass-soft mt-4 flex flex-col divide-y divide-white/[0.07] rounded-2xl">{children}</div>
    </section>
  );
}

function Row({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[58px] min-w-0 items-center gap-4 px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13.5px] font-medium text-white/90">{title}</span>
        {desc && <span className="mt-0.5 text-[11.5px] leading-relaxed text-white/45">{desc}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-3">{children}</div>
    </div>
  );
}

function SliderRow({ title, desc, value, min, max, step, onChange, display }: { title: string; desc?: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; display: string }) {
  return (
    <Row title={title} desc={desc}>
      <Slider value={value} min={min} max={max} step={step} onChange={onChange} className="w-44" ariaLabel={title} />
      <span className="w-14 shrink-0 text-right text-[12px] tabular-nums text-white/70">{display}</span>
    </Row>
  );
}

function EqCurve({ bands, enabled }: { bands: number[]; enabled: boolean }) {
  const W = 600, H = 160;
  const pts = bands.map((g, i) => [((i + 0.5) / bands.length) * W, H / 2 - (g / 12) * (H / 2 - 12)] as const);
  let d = `M 0 ${pts[0][1]} L ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2[0]} ${p2[1]}`;
  }
  d += ` L ${W} ${pts[pts.length - 1][1]}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={cn("pointer-events-none absolute inset-0 h-full w-full transition-opacity", !enabled && "opacity-30")}>
      <defs>
        <linearGradient id="eqfill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--mm-accent)" stopOpacity="0.35" />
          <stop offset="1" stopColor="var(--mm-accent)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="eqline" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="var(--mm-accent)" />
          <stop offset="1" stopColor="var(--mm-accent2)" />
        </linearGradient>
      </defs>
      <line x1="0" x2={W} y1={H / 2} y2={H / 2} stroke="rgba(255,255,255,0.12)" strokeDasharray="4 6" />
      <path d={`${d} L ${W} ${H} L 0 ${H} Z`} fill="url(#eqfill)" />
      <path d={d} fill="none" stroke="url(#eqline)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function ConfirmButton({ label, confirmLabel, onConfirm, icon: Icon = Trash2 }: { label: string; confirmLabel: string; onConfirm: () => void; icon?: typeof Trash2 }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 3000);
    return () => window.clearTimeout(t);
  }, [armed]);
  return (
    <button
      onClick={() => (armed ? (onConfirm(), setArmed(false)) : setArmed(true))}
      className={cn(
        "flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-[12px] font-medium transition active:scale-95",
        armed ? "bg-rose-500/85 text-white shadow-[0_0_16px_rgba(244,63,94,0.5)]" : "neu-btn text-white/80",
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {armed ? confirmLabel : label}
    </button>
  );
}

const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ["Space"], label: "播放 / 暂停" },
  { keys: ["Ctrl", "→"], label: "下一首" },
  { keys: ["Ctrl", "←"], label: "上一首" },
  { keys: ["→"], label: "快进 5 秒" },
  { keys: ["←"], label: "快退 5 秒" },
  { keys: ["↑"], label: "音量 +5%" },
  { keys: ["↓"], label: "音量 -5%" },
  { keys: ["M"], label: "静音 / 取消静音" },
  { keys: ["L"], label: "喜欢当前歌曲" },
  { keys: ["F"], label: "打开 / 收起沉浸式播放" },
  { keys: ["Q"], label: "打开 / 关闭播放队列" },
  { keys: ["Ctrl", "K"], label: "聚焦全局搜索" },
  { keys: ["Ctrl", ","], label: "打开设置" },
  { keys: ["Esc"], label: "退出沉浸式 / 关闭面板" },
];

export function SettingsWindow() {
  const s = usePlayer();
  const a = useActions();
  const track = useCurrentTrack();
  const st = s.settings;
  const drag = useDragControls();
  const bounds = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string>("general");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [libStats, setLibStats] = useState<LibraryStats | null>(null);
  const lockSpy = useRef(0);
  const engine = getEngine();

  useEffect(() => {
    if (!inTauri || !s.settingsOpen) return;
    void getLibraryStats().then(setLibStats).catch(() => {});
  }, [s.settingsOpen, s.tracks.length]);

  // Output device discovery
  useEffect(() => {
    if (!s.settingsOpen || !navigator.mediaDevices?.enumerateDevices) return;
    const load = () =>
      navigator.mediaDevices
        .enumerateDevices()
        .then((d) => setDevices(d.filter((x) => x.kind === "audiooutput" && x.deviceId !== "default" && x.deviceId !== "communications")))
        .catch(() => setDevices([]));
    load();
    navigator.mediaDevices.addEventListener?.("devicechange", load);
    return () => navigator.mediaDevices.removeEventListener?.("devicechange", load);
  }, [s.settingsOpen]);

  // Scroll-spy
  useEffect(() => {
    if (!s.settingsOpen) return;
    const root = canvas.current;
    if (!root) return;
    const onScroll = () => {
      if (Date.now() < lockSpy.current) return;
      const secs = Array.from(root.querySelectorAll<HTMLElement>("[data-section]"));
      const top = root.scrollTop + 40;
      let cur = secs[0]?.dataset.section ?? "general";
      for (const el of secs) if (el.offsetTop <= top) cur = el.dataset.section!;
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) cur = secs[secs.length - 1]?.dataset.section ?? cur;
      setActive(cur);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => root.removeEventListener("scroll", onScroll);
  }, [s.settingsOpen]);

  const jump = (id: string) => {
    setActive(id);
    lockSpy.current = Date.now() + 700;
    const el = canvas.current?.querySelector<HTMLElement>(`#mm-set-${id}`);
    if (el && canvas.current) canvas.current.scrollTo({ top: el.offsetTop - 16, behavior: "smooth" });
  };

  const setBand = (i: number, v: number) => {
    const bands = [...st.eqBands];
    bands[i] = Math.round(v * 2) / 2;
    a.updateSettings({ eqBands: bands, eqPreset: "custom" });
  };

  const localStats = useMemo(() => {
    const locals = s.tracks.filter((t) => t.source === "local");
    return { count: locals.length, bytes: locals.reduce((x, t) => x + (t.fileSize || 0), 0) };
  }, [s.tracks]);

  const accentOptions: { key: AccentKey; name: string; a: string; b: string }[] = [
    { key: "cover", name: "跟随封面", a: track?.palette[0] ?? "#a78bfa", b: track?.palette[1] ?? "#22d3ee" },
    ...(Object.entries(ACCENTS) as [Exclude<AccentKey, "cover">, { name: string; a: string; b: string }][]).map(([key, v]) => ({ key, ...v })),
  ];

  const winBtn = "grid h-8 w-10 shrink-0 place-items-center rounded-lg text-white/60 transition hover:bg-white/10 hover:text-white active:scale-95";

  return (
    <>
      <div ref={bounds} className="pointer-events-none absolute inset-2 z-[60]">
        <AnimatePresence>
          {s.settingsOpen && (
            <motion.div
              key="settings-window"
              drag
              dragListener={false}
              dragControls={drag}
              dragMomentum={false}
              dragElastic={0}
              dragConstraints={bounds}
              initial={{ opacity: 0, scale: 0.92, y: 24 }}
              animate={s.settingsMinimized ? { opacity: 0, scale: 0.4, y: 260, transitionEnd: { visibility: "hidden" } } : { opacity: 1, scale: 1, y: 0, visibility: "visible" }}
              exit={{ opacity: 0, scale: 0.92, y: 24 }}
              transition={SPRING}
              className="glass-strong pointer-events-auto absolute left-1/2 top-1/2 -ml-[440px] -mt-[300px] flex h-[600px] max-h-[calc(100vh-24px)] w-[880px] max-w-[calc(100vw-24px)] min-h-0 flex-col overflow-hidden rounded-[22px]"
              role="dialog"
              aria-label="MateMusic 设置"
            >
              {/* window chrome */}
              <div
                onPointerDown={(e) => drag.start(e)}
                className="flex h-12 shrink-0 cursor-grab touch-none items-center gap-2.5 border-b border-white/[0.08] pl-4 pr-2 active:cursor-grabbing"
              >
                <Logo size={22} />
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">设置 — MateMusic</span>
                <span className="shrink-0 text-[11px] text-white/35">拖拽标题栏移动窗口</span>
                <button onPointerDown={(e) => e.stopPropagation()} onClick={() => a.minimizeSettings(true)} className={winBtn} title="最小化">
                  <Minus className="h-4 w-4" />
                </button>
                <button onPointerDown={(e) => e.stopPropagation()} onClick={a.closeSettings} className={cn(winBtn, "hover:bg-rose-500/85 hover:text-white")} title="关闭">
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="flex min-h-0 flex-1">
                {/* nav */}
                <nav className="flex w-48 shrink-0 flex-col gap-1 border-r border-white/[0.08] p-2.5">
                  {SECTIONS.map((sec) => (
                    <button
                      key={sec.id}
                      onClick={() => jump(sec.id)}
                      className={cn(
                        "relative flex h-10 w-full min-w-0 shrink-0 items-center gap-2.5 rounded-xl px-3 text-[13px] transition-colors active:scale-[0.98]",
                        active === sec.id ? "text-white" : "text-white/55 hover:bg-white/[0.05] hover:text-white",
                      )}
                    >
                      {active === sec.id && (
                        <motion.span layoutId="set-nav" transition={SPRING} className="absolute inset-0 rounded-xl border border-white/12 bg-white/[0.1] shadow-[inset_0_1px_1px_rgba(255,255,255,0.18)]" />
                      )}
                      <sec.icon className={cn("relative h-4 w-4 shrink-0", active === sec.id && "text-accent")} />
                      <span className="relative min-w-0 flex-1 truncate text-left">{sec.label}</span>
                    </button>
                  ))}
                </nav>

                {/* canvas */}
                <div ref={canvas} className="relative min-h-0 flex-1 overflow-y-auto px-7 pt-6">
                  <Section id="general" title="常规设置" desc="启动、会话与列表交互行为">
                    <Row title="启动时恢复上次播放" desc="重新打开时自动载入上次的歌曲与队列">
                      <Switch checked={st.restoreSession} onChange={(v) => a.updateSettings({ restoreSession: v })} />
                    </Row>
                    <Row title="记住播放进度" desc="恢复会话时从上次中断的位置继续">
                      <Switch checked={st.rememberProgress} onChange={(v) => a.updateSettings({ rememberProgress: v })} />
                    </Row>
                    <Row title="默认播放倍速" desc="立即生效，并作为新会话的默认值">
                      <Select<number>
                        value={st.defaultRate}
                        width="w-36"
                        onChange={(v) => {
                          a.updateSettings({ defaultRate: v });
                          a.setRate(v);
                        }}
                        options={[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => ({ value: r, label: `${r.toFixed(2)}x` }))}
                      />
                    </Row>
                    <Row title="点击关闭按钮时" desc="选择窗口关闭的行为">
                      <Select
                        value={st.closeBehavior}
                        width="w-40"
                        onChange={(v) => a.updateSettings({ closeBehavior: v })}
                        options={[
                          { value: "sleep", label: "暂停并休眠" },
                          { value: "mini", label: "缩为迷你播放器" },
                        ]}
                      />
                    </Row>
                    <Row title="双击歌曲时" desc="曲库表格中双击行的行为">
                      <Select
                        value={st.doubleClickAction}
                        width="w-40"
                        onChange={(v) => a.updateSettings({ doubleClickAction: v })}
                        options={[
                          { value: "play", label: "立即播放" },
                          { value: "queue", label: "加入播放队列" },
                        ]}
                      />
                    </Row>
                    <Row title="清空最近播放" desc={`当前共 ${s.recent.length} 条播放记录`}>
                      <ConfirmButton label="清空记录" confirmLabel="确认清空" onConfirm={a.clearRecent} />
                    </Row>
                  </Section>

                  <Section id="audio" title="音频与输出设备" desc={inTauri ? "Rust 音频核心：独占直通、Bit-Perfect 与系统媒体控制" : "输出路由、动态处理与播放过渡"}>
                    {inTauri ? (
                      <>
                        <Row title="输出模式" desc="独占模式绕过系统混音器，共享模式兼容其他应用；ASIO 仅在有可用驱动时生效">
                          <Select
                            value={st.outputMode}
                            width="w-44"
                            onChange={(v) => a.setOutputMode(v as "shared" | "exclusive" | "asio")}
                            options={[
                              { value: "shared", label: "共享 Shared" },
                              { value: "exclusive", label: "独占 Exclusive" },
                              { value: "asio", label: "ASIO" },
                            ]}
                          />
                        </Row>
                        <Row title="输出设备" desc={s.native?.loaded ? `${s.native.device} · ${s.native.outputRate} Hz / ${s.native.outputBits ?? s.native.bits ?? "?"} bit · ${s.native.outputFormat}` : "播放本地曲目后显示实际输出参数"}>
                          <span className="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-white/10 px-3 text-[11.5px] font-medium text-white/70">
                            <AudioLines className="h-3.5 w-3.5 shrink-0" />
                            {s.native?.outputMode ?? st.outputMode}
                          </span>
                        </Row>
                        <Row title="音频通路" desc={s.nativeActive ? "本地曲目由 Rust 核心解码并直通输出，WebView 只负责界面与状态" : "当前为精选/网络音源，使用 WebView 内 Web Audio 通路"}>
                          <span className={cn("flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-[11.5px] font-medium", s.nativeActive ? "bg-emerald-400/15 text-emerald-300" : "bg-white/10 text-white/60")}>
                            <AudioLines className="h-3.5 w-3.5 shrink-0" />
                            {s.nativeActive ? "Rust Core" : "Web Audio"}
                          </span>
                        </Row>
                        <Row title="Bit-Perfect" desc={s.native?.bitPerfectReasons?.length ? s.native.bitPerfectReasons.join(" · ") : "源文件采样格式与输出设备一致时，标记为 Bit-Perfect"}>
                          <span
                            className={cn(
                              "flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-[11.5px] font-medium",
                              s.native?.bitPerfectVerdict === "bit-perfect"
                                ? "bg-emerald-400/15 text-emerald-300"
                                : s.native?.bitPerfectVerdict === "not-bit-perfect"
                                  ? "bg-amber-400/15 text-amber-300"
                                  : "bg-white/10 text-white/60",
                            )}
                          >
                            <Check className="h-3.5 w-3.5 shrink-0" />
                            {s.native?.bitPerfectVerdict === "bit-perfect"
                              ? "Bit-Perfect"
                              : s.native?.bitPerfectVerdict === "not-bit-perfect"
                                ? "非直通"
                                : s.native?.bitPerfectVerdict === "unverifiable"
                                  ? "待验证"
                                  : "待机"}
                          </span>
                        </Row>
                      </>
                    ) : (
                      <>
                        <Row title="输出设备" desc={engine.supportsSink ? "切换音频输出到指定扬声器或耳机" : "当前浏览器不支持切换输出设备，将使用系统默认设备"}>
                          <Select
                            value={st.outputDeviceId}
                            width="w-56"
                            onChange={async (v) => {
                              a.updateSettings({ outputDeviceId: v });
                              const ok = await engine.setSink(v);
                              a.toast(ok ? "输出设备已切换" : "切换失败，已保持当前设备", ok ? "success" : "error");
                            }}
                            options={[{ value: "", label: "系统默认设备" }, ...devices.map((d, i) => ({ value: d.deviceId, label: d.label || `音频输出设备 ${i + 1}` }))]}
                          />
                        </Row>
                        <Row title="当前音频通路" desc={engine.usingFx ? "Web Audio 高保真通路：均衡器、标准化与实时频谱全部生效" : "直通模式：开始播放后将自动启用 Web Audio 处理通路"}>
                          <span className={cn("flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-[11.5px] font-medium", engine.usingFx ? "bg-emerald-400/15 text-emerald-300" : "bg-white/10 text-white/60")}>
                            <AudioLines className="h-3.5 w-3.5 shrink-0" />
                            {engine.usingFx ? "Web Audio" : "Direct"}
                          </span>
                        </Row>
                      </>
                    )}
                    <Row title="音量标准化" desc="使用动态压缩平衡不同歌曲之间的响度差异">
                      <Switch checked={st.normalize} onChange={(v) => a.updateSettings({ normalize: v })} />
                    </Row>
                    <Row title="变速时保持音调" desc="调整倍速时避免人声变调">
                      <Switch checked={st.preservePitch} onChange={(v) => a.updateSettings({ preservePitch: v })} />
                    </Row>
                    <Row title="播放 / 暂停淡入淡出" desc="让开始与暂停更柔和，避免爆音">
                      <Switch checked={st.fade} onChange={(v) => a.updateSettings({ fade: v })} />
                    </Row>
                    {st.fade && (
                      <SliderRow title="淡入淡出时长" value={st.fadeMs} min={100} max={1500} step={50} onChange={(v) => a.updateSettings({ fadeMs: v })} display={`${st.fadeMs} ms`} />
                    )}
                  </Section>

                  <Section id="eq" title="音效与均衡器" desc={inTauri ? "10 段参数均衡器；本地曲目由 Rust 独占通路直通，EQ 仅作用于精选/网络音源" : "10 段参数均衡器，实时作用于播放音频"}>
                    <Row title="启用均衡器">
                      <Select
                        value={st.eqPreset}
                        width="w-44"
                        onChange={(v) => v !== "custom" && a.updateSettings({ eqPreset: v, eqBands: [...EQ_PRESETS[v].bands] })}
                        options={[...Object.entries(EQ_PRESETS).map(([k, p]) => ({ value: k, label: p.name })), ...(st.eqPreset === "custom" ? [{ value: "custom", label: "自定义 Custom" }] : [])]}
                      />
                      <Switch checked={st.eqEnabled} onChange={(v) => a.updateSettings({ eqEnabled: v })} />
                    </Row>
                    <div className="px-4 pb-4 pt-3">
                      <div className={cn("neu-inset relative rounded-2xl px-3 pb-3 pt-4", !st.eqEnabled && "opacity-60")}>
                        <div className="relative h-[200px]">
                          <div className="absolute inset-x-0 top-6 bottom-6">
                            <EqCurve bands={st.eqBands} enabled={st.eqEnabled} />
                          </div>
                          <div className="relative grid h-full grid-cols-10">
                            {EQ_FREQS.map((f, i) => (
                              <div key={f} className="flex min-w-0 flex-col items-center gap-1">
                                <span className="h-5 shrink-0 text-[10.5px] font-semibold tabular-nums text-white/70">
                                  {st.eqBands[i] > 0 ? "+" : ""}
                                  {st.eqBands[i].toFixed(1)}
                                </span>
                                <div className="min-h-0 flex-1">
                                  <Slider orientation="vertical" value={st.eqBands[i]} min={-12} max={12} step={0.5} centerZero onChange={(v) => setBand(i, v)} ariaLabel={`${f} Hz`} />
                                </div>
                                <span className="h-5 shrink-0 text-[10.5px] tabular-nums text-white/45">{f >= 1000 ? `${f / 1000}k` : f}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                    <SliderRow title="前级增益 Preamp" desc="整体提升或衰减均衡前的信号电平" value={st.preamp} min={-12} max={12} step={0.5} onChange={(v) => a.updateSettings({ preamp: v })} display={`${st.preamp > 0 ? "+" : ""}${st.preamp.toFixed(1)} dB`} />
                    <Row title="重置均衡器" desc="恢复为平坦曲线与 0 dB 前级增益">
                      <button onClick={() => a.updateSettings({ eqBands: [...EQ_PRESETS.flat.bands], preamp: 0, eqPreset: "flat" })} className="neu-btn flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-[12px] font-medium text-white/80">
                        <RotateCcw className="h-3.5 w-3.5 shrink-0" />
                        重置
                      </button>
                    </Row>
                  </Section>

                  <Section id="keys" title="全局快捷键" desc="在主窗口任意位置生效（输入框聚焦时除外）">
                    <Row title="启用键盘快捷键">
                      <Switch checked={st.shortcutsEnabled} onChange={(v) => a.updateSettings({ shortcutsEnabled: v })} />
                    </Row>
                    <div className={cn("grid grid-cols-2 gap-x-6 gap-y-1 px-4 py-3 transition-opacity", !st.shortcutsEnabled && "opacity-40")}>
                      {SHORTCUTS.map((k) => (
                        <div key={k.label} className="flex h-10 min-w-0 items-center gap-3 border-b border-white/[0.05]">
                          <span className="min-w-0 flex-1 truncate text-[12.5px] text-white/75">{k.label}</span>
                          <span className="flex shrink-0 items-center gap-1">
                            {k.keys.map((x) => (
                              <Kbd key={x}>{x}</Kbd>
                            ))}
                          </span>
                        </div>
                      ))}
                    </div>
                  </Section>

                  <Section id="look" title="外观与玻璃" desc="所有修改即时作用于整个界面">
                    <div className="flex min-w-0 items-center gap-4 px-4 py-4">
                      <div className="relative h-[92px] w-[180px] shrink-0 overflow-hidden rounded-2xl" style={{ background: `linear-gradient(135deg, ${track?.palette[0] ?? "#7c3aed"}, ${track?.palette[1] ?? "#0891b2"})` }}>
                        <div className="absolute left-3 top-3 h-10 w-10 rounded-full bg-white/70" />
                        <div className="absolute bottom-3 right-4 h-8 w-16 rounded-full bg-black/50" />
                        <div className="glass absolute inset-3 left-8 top-6 grid place-items-center rounded-xl text-[11px] font-semibold text-white/90">实时预览</div>
                      </div>
                      <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-white/50">调整模糊度与透明度，打造从“冰霜磨砂”到“清透水晶”的不同质感。主题色温会同步影响按钮、进度条、频谱与歌词辉光。</p>
                    </div>
                    <SliderRow title="毛玻璃模糊度" value={st.blur} min={0} max={80} step={1} onChange={(v) => a.updateSettings({ blur: v })} display={`${st.blur}px`} />
                    <SliderRow title="玻璃透明度" value={st.glassAlpha} min={0.02} max={0.25} step={0.01} onChange={(v) => a.updateSettings({ glassAlpha: v })} display={`${Math.round(st.glassAlpha * 100)}%`} />
                    <SliderRow title="环境光强度" desc="背景极光随封面主色调流动的亮度" value={st.ambientIntensity} min={0} max={1} step={0.05} onChange={(v) => a.updateSettings({ ambientIntensity: v })} display={`${Math.round(st.ambientIntensity * 100)}%`} />
                    <Row title="主题色温">
                      <div className="flex shrink-0 items-center gap-2">
                        {accentOptions.map((o) => (
                          <button
                            key={o.key}
                            title={o.name}
                            onClick={() => a.updateSettings({ accent: o.key })}
                            className="relative grid h-8 w-8 shrink-0 place-items-center rounded-full transition active:scale-90"
                            style={{ background: `linear-gradient(135deg, ${o.a}, ${o.b})` }}
                          >
                            {st.accent === o.key && (
                              <motion.span layoutId="accent-ring" transition={SPRING} className="absolute -inset-1 rounded-full border-2 border-white/80" />
                            )}
                            {st.accent === o.key && <Check className="h-4 w-4 text-black/70" />}
                            {o.key === "cover" && st.accent !== o.key && <span className="text-[9px] font-bold text-black/70">AUTO</span>}
                          </button>
                        ))}
                      </div>
                    </Row>
                    <Row title="播放栏样式">
                      <Select
                        value={st.dockStyle}
                        width="w-40"
                        onChange={(v) => a.updateSettings({ dockStyle: v })}
                        options={[
                          { value: "floating", label: "悬浮胶囊" },
                          { value: "bar", label: "通栏底座" },
                        ]}
                      />
                    </Row>
                    <SliderRow title="沉浸式歌词字号" value={st.lyricSize} min={16} max={40} step={1} onChange={(v) => a.updateSettings({ lyricSize: v })} display={`${st.lyricSize}px`} />
                    <Row title="动态极光背景" desc="背景光斑缓慢流动">
                      <Switch checked={st.dynamicBackground} onChange={(v) => a.updateSettings({ dynamicBackground: v })} />
                    </Row>
                    <Row title="显示实时频谱" desc="沉浸式界面中的音频律动条">
                      <Switch checked={st.showSpectrum} onChange={(v) => a.updateSettings({ showSpectrum: v })} />
                    </Row>
                    <Row title="减少动效" desc="降低背景与流光动画，节省性能">
                      <Switch checked={st.reduceMotion} onChange={(v) => a.updateSettings({ reduceMotion: v })} />
                    </Row>
                  </Section>

                  <Section id="about" title="关于 MateMusic" desc="版本信息、致谢与数据">
                    <div className="flex min-w-0 items-center gap-4 px-4 py-5">
                      <Logo size={56} />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[20px] font-bold">MateMusic</span>
                        <span className="truncate text-[12px] tabular-nums text-white/50">Version 1.0.0 · Spatial Glass Edition</span>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {["React", "TypeScript", "Tailwind CSS", "Framer Motion", inTauri ? "Tauri 2 · Rust" : "Web Audio API", inTauri ? "SQLite · WASAPI" : "IndexedDB"].map((x) => (
                            <span key={x} className="shrink-0 rounded-full border border-white/12 bg-white/[0.05] px-2 py-0.5 text-[10.5px] text-white/60">
                              {x}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                    <Row title="内置曲目致谢" desc="内置音乐由 Kevin MacLeod (incompetech.com) 创作，基于 Creative Commons: By Attribution 4.0 许可，经 Internet Archive 提供。歌词为 MateMusic 原创意境词。">
                      <span className="shrink-0 rounded-md border border-white/15 px-2 py-0.5 text-[11px] text-white/60">CC BY 4.0</span>
                    </Row>
                    <Row
                      title="本地曲库"
                      desc={
                        inTauri
                          ? `${libStats?.tracks ?? localStats.count} 首歌曲 · ${libStats?.folders ?? 0} 个目录 · ${libStats?.albums ?? 0} 张专辑 · ${formatDurationLong(libStats?.totalDuration ?? 0)}（SQLite）`
                          : `${localStats.count} 首歌曲 · 占用 ${formatBytes(localStats.bytes)}（保存在本机浏览器 IndexedDB）`
                      }
                    >
                      {inTauri && (
                        <button onClick={() => void a.pickFolder()} className="neu-btn flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-[12px] font-medium text-white/80">
                          <FolderInput className="h-3.5 w-3.5 shrink-0" />
                          扫描文件夹
                        </button>
                      )}
                      <ConfirmButton label="清空本地曲库" confirmLabel="确认清空" onConfirm={() => void a.clearLocal()} />
                    </Row>
                    <Row title="恢复默认设置" desc="重置外观、音效与偏好，不会删除曲库">
                      <ConfirmButton label="恢复默认" confirmLabel="确认恢复" icon={RotateCcw} onConfirm={a.resetSettings} />
                    </Row>
                  </Section>
                  <div className="h-[40vh]" />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* minimized pill */}
      <AnimatePresence>
        {s.settingsOpen && s.settingsMinimized && (
          <motion.button
            key="settings-pill"
            initial={{ opacity: 0, y: 20, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.9 }}
            transition={SPRING}
            onClick={() => a.minimizeSettings(false)}
            className="glass-strong absolute bottom-[112px] right-6 z-[61] flex h-11 shrink-0 items-center gap-2.5 whitespace-nowrap rounded-full pl-2 pr-4 text-[12.5px] font-medium"
          >
            <Logo size={26} />
            设置 — MateMusic
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent shadow-[0_0_8px_var(--mm-accent)]" />
          </motion.button>
        )}
      </AnimatePresence>
    </>
  );
}
