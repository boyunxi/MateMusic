import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent, CSSProperties } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  Disc3,
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

function formatTime(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
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

  const track = TRACKS[index];
  const progress = Math.min(time / track.duration, 1);

  useEffect(() => {
    if (!playing) return;
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
  }, [playing, track.duration]);

  useEffect(() => {
    if (time < track.duration) return;
    setIndex((i) => (i + 1) % TRACKS.length);
    setTime(0);
  }, [time, track.duration]);

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
            <p className="tuning-note">视觉演示 · 音频未接入</p>
          </section>
        </aside>

        <main className="now glass">
          <header className="now-head">
            <p className="eyebrow">正在播放</p>
            <span className="output-chip">
              <i className="pulse" />
              WASAPI 独占 · 96 kHz / 24 bit
            </span>
          </header>

          <section className="hero">
            <motion.div
              key={track.art}
              className={`cover art-${track.art}`}
              initial={reduced ? false : { opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            >
              <span className="cover-ring" />
              <span className="cover-sheen" />
            </motion.div>

            <div className="meta">
              <motion.div
                key={track.id}
                initial={reduced ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              >
                <h1>{track.title}</h1>
                <p className="artist">{track.artist}</p>
                <p className="album">
                  {track.album} · {track.year}
                </p>
                <div className="badges">
                  <span>FLAC</span>
                  <span>24 bit</span>
                  <span>96 kHz</span>
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
              <strong>FLAC · 24 bit · 96 kHz</strong>
            </div>
            <div>
              <span>解码</span>
              <strong>PCM · 32 bit float</strong>
            </div>
            <div>
              <span>输出</span>
              <strong>WASAPI 独占 · 96 kHz</strong>
            </div>
          </section>

          <section className="lyrics" aria-label="歌词">
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
          </section>

          <section className="transport">
            <input
              className="range progress"
              type="range"
              min={0}
              max={track.duration}
              step={0.1}
              value={time}
              onChange={seek}
              style={{ "--pct": `${progress * 100}%` } as CSSProperties}
              aria-label="播放进度"
            />
            <div className="times">
              <span>{formatTime(time)}</span>
              <span>-{formatTime(track.duration - time)}</span>
            </div>

            <div className="transport-row">
              <div className="transport-side">
                <button type="button" className="icon-button" aria-label="随机播放">
                  <Shuffle size={17} />
                </button>
                <button type="button" className="icon-button" aria-label="循环">
                  <Repeat size={17} />
                </button>
              </div>

              <div className="transport-main">
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => selectTrack((index - 1 + TRACKS.length) % TRACKS.length)}
                  aria-label="上一首"
                >
                  <SkipBack size={20} fill="currentColor" />
                </button>
                <button
                  type="button"
                  className="play-button"
                  onClick={() => setPlaying((v) => !v)}
                  aria-label={playing ? "暂停" : "播放"}
                >
                  {playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
                </button>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => selectTrack((index + 1) % TRACKS.length)}
                  aria-label="下一首"
                >
                  <SkipForward size={20} fill="currentColor" />
                </button>
              </div>

              <div className="volume">
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => setVolume(volume > 0 ? 0 : 0.72)}
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
                  onChange={(e) => setVolume(Number(e.target.value))}
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
            <span>{TRACKS.length} 首</span>
          </header>

          <ul className="queue-list">
            {TRACKS.map((item, i) => (
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
            ))}
          </ul>

          <footer className="queue-foot">拖拽排序将在正式版接入</footer>
        </aside>
      </div>
    </div>
  );
}
