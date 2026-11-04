import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChangeEvent, CSSProperties } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  Disc3,
  FolderOpen,
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
  setTrackVolume,
  subscribePlayer,
} from "../../lib/player";
import type { PlayerSnapshot } from "../../lib/player";

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

const CODEC_NAMES: Record<string, string> = {
  pcm_s16le: "PCM 16",
  pcm_s24le: "PCM 24",
  pcm_s32le: "PCM 32",
  pcm_f32le: "PCM F32",
};

function formatTime(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function formatHz(rate: number) {
  if (!rate) return "未知";
  return rate % 1000 === 0 ? `${rate / 1000} kHz` : `${(rate / 1000).toFixed(1)} kHz`;
}

function prettifyCodec(codec: string) {
  return CODEC_NAMES[codec] ?? codec.toUpperCase();
}

function folderOf(path: string) {
  const parts = path.split(/[\\/]/);
  return parts.length > 1 ? parts[parts.length - 2] : "";
}

const NAV = [
  { label: "曲库", icon: Library },
  { label: "正在播放", icon: Disc3 },
  { label: "歌词", icon: Mic2 },
  { label: "设置", icon: Settings2 },
];

export default function GlassDemo() {
  const reduced = useReducedMotion();
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

  const track = TRACKS[index];
  const loaded = snapshot?.loaded ? snapshot : null;
  const real = loaded !== null;
  const isPlaying = loaded ? loaded.playing : playing;
  const duration = loaded ? loaded.duration : track.duration;
  const progress = duration > 0 ? Math.min(time / duration, 1) : 0;

  const displayTitle = loaded ? loaded.title : track.title;
  const displayArtist = loaded ? "本地文件" : track.artist;
  const displayAlbum = loaded ? folderOf(loaded.path) || "本地曲目" : `${track.album} · ${track.year}`;
  const badges = loaded
    ? [
        prettifyCodec(loaded.codec),
        loaded.bits ? `${loaded.bits} bit` : "位深未知",
        formatHz(loaded.sampleRate),
      ]
    : ["FLAC", "24 bit", "96 kHz"];
  const artClass = loaded ? "art-aurora" : `art-${track.art}`;
  const coverKey = loaded ? loaded.path : track.art;

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

  const errorText = loaded?.error ?? bridgeError;

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
            {NAV.map(({ label, icon: Icon }, i) => (
              <button key={label} className={`nav-item ${i === 1 ? "is-active" : ""}`} type="button">
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
            <p className="tuning-note">{real ? "真实播放 · WASAPI 共享" : "演示模式 · 未接入音频"}</p>
          </section>
        </aside>

        <main className="now glass">
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

          {errorText && <p className="error-line">{errorText}</p>}

          <section className="hero">
            <motion.div
              key={coverKey}
              className={`cover ${artClass}`}
              initial={reduced ? false : { opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            >
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
                  ? `${prettifyCodec(loaded.codec)} · ${loaded.bits ?? "?"} bit · ${formatHz(loaded.sampleRate)}`
                  : "FLAC · 24 bit · 96 kHz"}
              </strong>
            </div>
            <div>
              <span>解码</span>
              <strong>PCM · 32 bit float</strong>
            </div>
            <div>
              <span>输出</span>
              <strong>
                {loaded
                  ? `${loaded.outputMode} · ${formatHz(loaded.outputRate)}`
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
                <button type="button" className="icon-button" aria-label="随机播放" disabled={real}>
                  <Shuffle size={17} />
                </button>
                <button type="button" className="icon-button" aria-label="循环" disabled={real}>
                  <Repeat size={17} />
                </button>
              </div>

              <div className="transport-main">
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => selectTrack((index - 1 + TRACKS.length) % TRACKS.length)}
                  disabled={real}
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
                  onClick={() => selectTrack((index + 1) % TRACKS.length)}
                  disabled={real}
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
        </main>

        <aside className="queue glass">
          <header className="queue-head">
            <h2>
              <ListMusic size={16} /> 播放队列
            </h2>
            <span>{loaded ? "1 首" : `${TRACKS.length} 首`}</span>
          </header>

          <ul className="queue-list">
            {loaded ? (
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
            {loaded ? "曲库与队列将在 M2 接入" : "拖拽排序将在正式版接入"}
          </footer>
        </aside>
      </div>
    </div>
  );
}
