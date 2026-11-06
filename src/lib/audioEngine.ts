export const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export interface EngineHandlers {
  time: (t: number) => void;
  duration: (d: number) => void;
  buffered: (b: number) => void;
  playing: (p: boolean) => void;
  waiting: (w: boolean) => void;
  ended: () => void;
  error: (msg: string) => void;
}

type SinkCapable = { setSinkId?: (id: string) => Promise<void> };

export class AudioEngine {
  readonly fx: HTMLAudioElement;
  readonly raw: HTMLAudioElement;
  private active: HTMLAudioElement;
  private ctx?: AudioContext;
  private graphFailed = false;
  private filters: BiquadFilterNode[] = [];
  private preampNode?: GainNode;
  private compressor?: DynamicsCompressorNode;
  private makeup?: GainNode;
  private analyser?: AnalyserNode;
  private fadeGain?: GainNode;
  private master?: GainNode;
  private noCors = new Set<string>();
  private handlers: Partial<EngineHandlers> = {};
  private raf = 0;
  private lastEmit = 0;
  private pendingSeek: number | null = null;
  private wantPlay = false;
  private fadeTimer = 0;

  volume = 0.8;
  muted = false;
  rate = 1;
  preservePitch = true;
  fadeEnabled = true;
  fadeMs = 400;
  normalize = false;
  eq = { enabled: true, bands: new Array(10).fill(0) as number[], preamp: 0 };
  sinkId = "";

  constructor() {
    this.fx = document.createElement("audio");
    this.fx.crossOrigin = "anonymous";
    this.fx.preload = "auto";
    this.raw = document.createElement("audio");
    this.raw.preload = "auto";
    this.fx.setAttribute("data-mm", "fx");
    this.raw.setAttribute("data-mm", "raw");
    this.fx.style.display = this.raw.style.display = "none";
    document.body.appendChild(this.fx);
    document.body.appendChild(this.raw);
    this.active = this.fx;
    [this.fx, this.raw].forEach((el) => this.bind(el));
  }

  on(h: Partial<EngineHandlers>) {
    this.handlers = { ...this.handlers, ...h };
  }

  get element() {
    return this.active;
  }
  get usingFx() {
    return this.active === this.fx && !!this.ctx && !this.graphFailed;
  }
  get currentTime() {
    return this.active.currentTime || 0;
  }
  get duration() {
    const d = this.active.duration;
    return isFinite(d) ? d : 0;
  }
  get paused() {
    return this.active.paused;
  }

  private bind(el: HTMLAudioElement) {
    const guard = (fn: () => void) => () => {
      if (el === this.active) fn();
    };
    el.addEventListener("loadedmetadata", guard(() => {
      this.handlers.duration?.(this.duration);
      if (this.pendingSeek != null) {
        const t = Math.min(this.pendingSeek, Math.max(0, this.duration - 0.5));
        el.currentTime = t;
        this.pendingSeek = null;
        this.handlers.time?.(t);
      }
    }));
    el.addEventListener("durationchange", guard(() => this.handlers.duration?.(this.duration)));
    el.addEventListener("progress", guard(() => this.emitBuffered()));
    el.addEventListener("play", guard(() => {
      this.handlers.playing?.(true);
      this.loop();
    }));
    el.addEventListener("pause", guard(() => {
      this.handlers.playing?.(false);
      cancelAnimationFrame(this.raf);
      this.handlers.time?.(el.currentTime);
    }));
    el.addEventListener("waiting", guard(() => this.handlers.waiting?.(true)));
    el.addEventListener("playing", guard(() => this.handlers.waiting?.(false)));
    el.addEventListener("canplay", guard(() => this.handlers.waiting?.(false)));
    el.addEventListener("seeked", guard(() => this.handlers.time?.(el.currentTime)));
    el.addEventListener("ended", guard(() => this.handlers.ended?.()));
    el.addEventListener("error", guard(() => this.onError(el)));
  }

  private onError(el: HTMLAudioElement) {
    const src = el.currentSrc || el.src;
    if (!src) return;
    // CORS-blocked remote stream: retry through the raw (non Web-Audio) element.
    if (el === this.fx && /^https?:/i.test(src) && !this.noCors.has(src)) {
      this.noCors.add(src);
      const at = el.currentTime || this.pendingSeek || 0;
      this.load(src, { autoplay: this.wantPlay, startAt: at });
      return;
    }
    const code = el.error?.code;
    const msg =
      code === 2 ? "网络错误，音频流加载失败" : code === 3 ? "音频解码失败，文件可能已损坏" : code === 4 ? "不支持的音频格式或资源不可用" : "播放出错";
    this.handlers.waiting?.(false);
    this.handlers.error?.(msg);
  }

  private emitBuffered() {
    const el = this.active;
    try {
      const b = el.buffered;
      const t = el.currentTime;
      let end = 0;
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) <= t + 0.5) end = Math.max(end, b.end(i));
      }
      this.handlers.buffered?.(end);
    } catch {
      /* noop */
    }
  }

  private loop = () => {
    cancelAnimationFrame(this.raf);
    const tick = (now: number) => {
      if (now - this.lastEmit > 90) {
        this.lastEmit = now;
        this.handlers.time?.(this.active.currentTime);
        this.emitBuffered();
      }
      if (!this.active.paused) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  };

  private ensureGraph() {
    if (this.ctx || this.graphFailed) return;
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx({ latencyHint: "playback" });
      const source = ctx.createMediaElementSource(this.fx);
      this.preampNode = ctx.createGain();
      this.filters = EQ_FREQS.map((f, i) => {
        const b = ctx.createBiquadFilter();
        b.type = i === 0 ? "lowshelf" : i === EQ_FREQS.length - 1 ? "highshelf" : "peaking";
        b.frequency.value = f;
        b.Q.value = 1.1;
        return b;
      });
      this.compressor = ctx.createDynamicsCompressor();
      this.makeup = ctx.createGain();
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.8;
      this.fadeGain = ctx.createGain();
      this.master = ctx.createGain();
      let node: AudioNode = source.connect(this.preampNode);
      for (const f of this.filters) node = node.connect(f);
      node.connect(this.compressor).connect(this.makeup).connect(this.analyser).connect(this.fadeGain).connect(this.master).connect(ctx.destination);
      this.ctx = ctx;
      this.fx.volume = 1;
      this.applyEq();
      this.applyNormalize();
      this.applyVolume();
      if (this.sinkId) void this.setSink(this.sinkId);
    } catch (e) {
      console.warn("[MateMusic] Web Audio graph unavailable, falling back", e);
      this.graphFailed = true;
    }
  }

  load(src: string, opts: { autoplay?: boolean; startAt?: number } = {}) {
    window.clearTimeout(this.fadeTimer);
    const useRaw = this.noCors.has(src);
    const next = useRaw ? this.raw : this.fx;
    const other = next === this.fx ? this.raw : this.fx;
    other.pause();
    if (other.getAttribute("src")) {
      other.removeAttribute("src");
      other.load();
    }
    this.active = next;
    this.pendingSeek = opts.startAt && opts.startAt > 0 ? opts.startAt : null;
    next.src = src;
    next.playbackRate = this.rate;
    next.defaultPlaybackRate = this.rate;
    this.applyPitch();
    this.applyVolume();
    this.handlers.time?.(opts.startAt || 0);
    this.handlers.buffered?.(0);
    this.handlers.duration?.(0);
    next.load();
    this.wantPlay = !!opts.autoplay;
    if (opts.autoplay) void this.play();
  }

  async play() {
    this.wantPlay = true;
    window.clearTimeout(this.fadeTimer);
    const el = this.active;
    if (!el.getAttribute("src")) return;
    if (el === this.fx) this.ensureGraph();
    if (this.ctx && this.ctx.state === "suspended") await this.ctx.resume().catch(() => undefined);
    if (this.fadeGain && this.ctx) {
      const g = this.fadeGain.gain;
      const now = this.ctx.currentTime;
      g.cancelScheduledValues(now);
      if (this.fadeEnabled && el === this.fx) {
        g.setValueAtTime(0.0001, now);
        g.linearRampToValueAtTime(1, now + this.fadeMs / 1000);
      } else g.setValueAtTime(1, now);
    }
    try {
      await el.play();
    } catch (e) {
      const err = e as DOMException;
      if (err.name !== "AbortError") {
        this.wantPlay = false;
        this.handlers.playing?.(false);
        if (err.name === "NotAllowedError") this.handlers.error?.("浏览器阻止了自动播放，请点击播放按钮");
      }
    }
  }

  pause() {
    this.wantPlay = false;
    const el = this.active;
    if (this.fadeEnabled && this.fadeGain && this.ctx && el === this.fx && !el.paused) {
      const g = this.fadeGain.gain;
      const now = this.ctx.currentTime;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0.0001, now + this.fadeMs / 1000);
      window.clearTimeout(this.fadeTimer);
      this.handlers.playing?.(false);
      this.fadeTimer = window.setTimeout(() => el.pause(), this.fadeMs);
    } else el.pause();
  }

  toggle() {
    if (this.active.paused || !this.wantPlay) void this.play();
    else this.pause();
  }

  seek(t: number) {
    const el = this.active;
    if (!el.getAttribute("src")) return;
    if (el.readyState < 1) {
      this.pendingSeek = t;
      return;
    }
    el.currentTime = Math.max(0, Math.min(t, this.duration || t));
    this.handlers.time?.(el.currentTime);
  }

  stop() {
    this.wantPlay = false;
    [this.fx, this.raw].forEach((el) => {
      el.pause();
      el.removeAttribute("src");
      el.load();
    });
    this.handlers.time?.(0);
    this.handlers.duration?.(0);
    this.handlers.playing?.(false);
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    this.applyVolume();
  }
  setMuted(m: boolean) {
    this.muted = m;
    this.applyVolume();
  }
  private applyVolume() {
    const g = this.muted ? 0 : this.volume * this.volume;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(g, this.ctx.currentTime, 0.02);
      this.fx.volume = 1;
    } else this.fx.volume = g;
    this.raw.volume = g;
  }

  setRate(r: number) {
    this.rate = r;
    [this.fx, this.raw].forEach((el) => {
      el.playbackRate = r;
      el.defaultPlaybackRate = r;
    });
  }
  setPreservePitch(p: boolean) {
    this.preservePitch = p;
    this.applyPitch();
  }
  private applyPitch() {
    [this.fx, this.raw].forEach((el) => {
      (el as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = this.preservePitch;
    });
  }

  setEq(enabled: boolean, bands: number[], preamp: number) {
    this.eq = { enabled, bands: [...bands], preamp };
    this.applyEq();
  }
  private applyEq() {
    if (!this.ctx || !this.preampNode) return;
    const now = this.ctx.currentTime;
    const { enabled, bands, preamp } = this.eq;
    this.preampNode.gain.setTargetAtTime(enabled ? Math.pow(10, preamp / 20) : 1, now, 0.03);
    this.filters.forEach((f, i) => f.gain.setTargetAtTime(enabled ? bands[i] || 0 : 0, now, 0.03));
  }

  setNormalize(n: boolean) {
    this.normalize = n;
    this.applyNormalize();
  }
  private applyNormalize() {
    if (!this.compressor || !this.makeup || !this.ctx) return;
    const c = this.compressor;
    const now = this.ctx.currentTime;
    if (this.normalize) {
      c.threshold.setValueAtTime(-24, now);
      c.knee.setValueAtTime(24, now);
      c.ratio.setValueAtTime(4, now);
      c.attack.setValueAtTime(0.004, now);
      c.release.setValueAtTime(0.25, now);
      this.makeup.gain.setTargetAtTime(1.35, now, 0.05);
    } else {
      c.threshold.setValueAtTime(0, now);
      c.knee.setValueAtTime(0, now);
      c.ratio.setValueAtTime(1, now);
      this.makeup.gain.setTargetAtTime(1, now, 0.05);
    }
  }

  setFade(enabled: boolean, ms: number) {
    this.fadeEnabled = enabled;
    this.fadeMs = ms;
  }

  async setSink(id: string): Promise<boolean> {
    this.sinkId = id;
    let ok = true;
    try {
      const ctx = this.ctx as (AudioContext & SinkCapable) | undefined;
      if (ctx?.setSinkId) await ctx.setSinkId(id || "");
      const raw = this.raw as HTMLAudioElement & SinkCapable;
      if (raw.setSinkId) await raw.setSinkId(id || "");
      if (!ctx) {
        const fx = this.fx as HTMLAudioElement & SinkCapable;
        if (fx.setSinkId) await fx.setSinkId(id || "");
      }
    } catch (e) {
      console.warn("[MateMusic] setSinkId failed", e);
      ok = false;
    }
    return ok;
  }

  get supportsSink() {
    return typeof (this.raw as HTMLAudioElement & SinkCapable).setSinkId === "function";
  }

  /** Fills `arr` with frequency data. Returns false when no real analyser is available. */
  getFrequencyData(arr: Uint8Array<ArrayBuffer>): boolean {
    if (this.analyser && this.usingFx && !this.active.paused) {
      this.analyser.getByteFrequencyData(arr);
      return true;
    }
    return false;
  }
}

let instance: AudioEngine | null = null;
export function getEngine(): AudioEngine {
  if (!instance) instance = new AudioEngine();
  return instance;
}
