import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { LyricDoc, LyricLine, LyricWord } from "../../lib/lyrics";

type Props = {
  doc: LyricDoc | null;
  loading: boolean;
  error: string | null;
  position: number;
  offsetMs: number;
  onOffsetChange: (value: number) => void;
  onSeek: (seconds: number) => void;
  compact?: boolean;
  fill?: boolean;
};

const COMPACT_HEIGHT = 168;
const COMPACT_LINE = 38;
const FULL_HEIGHT = 430;
const FULL_LINE = 54;

function activeLineIndex(doc: LyricDoc, effectiveMs: number) {
  let active = -1;
  for (let index = 0; index < doc.lines.length; index += 1) {
    const line = doc.lines[index];
    if (line.start == null) continue;
    if (line.start * 1000 <= effectiveMs) active = index;
    else break;
  }
  return active;
}

function Words({
  line,
  effectiveMs,
}: {
  line: LyricLine;
  effectiveMs: number;
}) {
  if (line.words.length === 0) {
    return <>{line.text}</>;
  }
  return (
    <>
      {line.words.map((word: LyricWord, index) => {
        const startMs = word.start * 1000;
        const endMs = word.end * 1000;
        const sung = effectiveMs >= startMs;
        const current = effectiveMs >= startMs && effectiveMs < endMs;
        const progress = current
          ? Math.min(Math.max((effectiveMs - startMs) / Math.max(endMs - startMs, 1), 0), 1)
          : sung
            ? 1
            : 0;
        return (
          <span
            key={`${word.start}-${index}`}
            className={`lp-word ${sung ? "is-sung" : ""} ${current ? "is-current" : ""}`}
            style={{ "--word-progress": `${progress * 100}%` } as CSSProperties}
          >
            {word.text}
          </span>
        );
      })}
    </>
  );
}

export default function LyricsPanel({
  doc,
  loading,
  error,
  position,
  offsetMs,
  onOffsetChange,
  onSeek,
  compact = false,
  fill = false,
}: Props) {
  const [measuredHeight, setMeasuredHeight] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!fill) return;
    const element = viewportRef.current;
    if (!element) return;
    const update = () => setMeasuredHeight(element.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [fill, loading, doc]);

  const totalOffset = (doc?.offsetMs ?? 0) + offsetMs;
  const effectiveMs = position * 1000 + totalOffset;
  const lineHeight = compact ? COMPACT_LINE : FULL_LINE;
  const viewportHeight = fill
    ? Math.max(measuredHeight, 160)
    : compact
      ? COMPACT_HEIGHT
      : FULL_HEIGHT;

  const active = useMemo(
    () => (doc && doc.synced ? activeLineIndex(doc, effectiveMs) : -1),
    [doc, effectiveMs],
  );

  const offsetY =
    active >= 0
      ? Math.max(0, active * lineHeight - viewportHeight / 2 + lineHeight / 2)
      : 0;

  if (loading) {
    return <div className={`lp-state ${compact ? "is-compact" : ""}`}>正在读取歌词…</div>;
  }

  if (error) {
    return (
      <div className={`lp-state ${compact ? "is-compact" : ""}`}>
        <p>歌词读取失败</p>
        <p>{error}</p>
      </div>
    );
  }

  if (!doc || doc.lines.length === 0) {
    return (
      <div className={`lp-state ${compact ? "is-compact" : ""}`}>
        <p>未找到歌词</p>
        {!compact && (
          <p>将同名 .lrc / .srt 放在音频旁，或写入内嵌歌词；当前支持 UTF-8 / UTF-16 / GB18030。</p>
        )}
      </div>
    );
  }

  const offsetLabel = `${totalOffset > 0 ? "+" : ""}${totalOffset} ms`;

  if (!doc.synced) {
    return (
      <div className={`lp-plain ${compact ? "is-compact" : ""}`}>
        {!compact && (
          <div className="lp-source">
            <span>{doc.source}</span>
            <span>{doc.encoding}</span>
            <span>无时间轴</span>
          </div>
        )}
        <div className="lp-plain-scroll">
          {doc.lines.map((line, index) => (
            <p key={`${line.text}-${index}`}>{line.text}</p>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={`lp ${compact ? "is-compact" : ""}`}>
      {!compact && (
        <div className="lp-toolbar">
          <div className="lp-source">
            <span>{doc.source}</span>
            <span>{doc.encoding}</span>
          </div>
          <div className="lp-offset">
            <span>偏移 {offsetLabel}</span>
            <button type="button" onClick={() => onOffsetChange(offsetMs - 100)}>
              -0.1s
            </button>
            <button type="button" onClick={() => onOffsetChange(offsetMs + 100)}>
              +0.1s
            </button>
            <button type="button" onClick={() => onOffsetChange(0)}>
              归零
            </button>
          </div>
        </div>
      )}

      <div
        ref={viewportRef}
        className="lp-viewport"
        style={fill ? { flex: 1, minHeight: 0 } : { height: viewportHeight }}
        aria-label="歌词"
      >
        <div
          className="lp-track"
          style={{
            transform: `translateY(${-offsetY}px)`,
            transitionDuration: "420ms",
          }}
        >
          {doc.lines.map((line, index) => {
            const isActive = index === active;
            return (
              <button
                key={`${line.start ?? 0}-${index}`}
                type="button"
                className={`lp-line ${isActive ? "is-active" : ""}`}
                style={{ height: lineHeight }}
                onClick={() => {
                  if (line.start != null) {
                    onSeek(line.start + totalOffset / 1000);
                  }
                }}
              >
                <span className="lp-text">
                  {isActive ? (
                    <Words line={line} effectiveMs={effectiveMs} />
                  ) : (
                    line.text
                  )}
                </span>
                {line.translation && (
                  <span className="lp-translation">{line.translation}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
