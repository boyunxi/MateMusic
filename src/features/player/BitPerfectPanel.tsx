import type { PlayerSnapshot } from "../../lib/player";
import { formatHz, prettifyCodec } from "../../lib/format";

type Props = {
  snapshot: PlayerSnapshot | null;
  full?: boolean;
};

const VERDICTS = {
  "bit-perfect": {
    label: "Bit-Perfect",
    tone: "good",
    hint: "独占直通，源格式与设备格式一致，未启用倍速、音量或重采样。",
  },
  unverifiable: {
    label: "无法验证",
    tone: "warn",
    hint: "共享混音参与，或独占未生效；按约定不标记 Bit-Perfect。",
  },
  "not-bit-perfect": {
    label: "未达成",
    tone: "warn",
    hint: "独占已生效，但仍有处理环节使输出不再等同于源格式。",
  },
  idle: {
    label: "待播放",
    tone: "idle",
    hint: "播放本地歌曲后显示独占、重采样与 DSP 的判定结果。",
  },
} as const;

export default function BitPerfectPanel({ snapshot, full = false }: Props) {
  const verdictKey = snapshot?.bitPerfectVerdict ?? "idle";
  const verdict = VERDICTS[verdictKey] ?? VERDICTS.idle;
  const reasons = snapshot?.bitPerfectReasons ?? [];
  const exclusive = snapshot?.outputMode.includes("独占") ?? false;
  const rateMatch =
    !!snapshot && snapshot.sampleRate > 0 && snapshot.sampleRate === snapshot.outputRate;
  const channelsMatch =
    !!snapshot && snapshot.channels > 0 && snapshot.channels === snapshot.outputChannels;
  const bitsMatch =
    !!snapshot && snapshot.bits != null && snapshot.bits === snapshot.outputBits;
  const dspFree =
    !!snapshot &&
    Math.abs((snapshot.speed || 1) - 1) < 0.001 &&
    Math.abs((snapshot.volume ?? 1) - 1) < 0.001;

  const checks = [
    { label: "独占输出", ok: exclusive },
    { label: "采样率直通", ok: rateMatch },
    { label: "声道一致", ok: channelsMatch },
    { label: "位深保持", ok: bitsMatch },
    { label: "无 DSP", ok: dspFree },
  ];

  return (
    <section className={`bitperfect ${full ? "is-full" : ""}`} aria-label="Bit-Perfect 判定">
      <header className="bp-head">
        <div>
          <p className="bp-eyebrow">Bit-Perfect 判定</p>
          <p className="bp-hint">{verdict.hint}</p>
        </div>
        <span className={`bp-badge is-${verdict.tone}`}>{verdict.label}</span>
      </header>

      {full && (
        <div className="bp-stages">
          <div>
            <span>源文件</span>
            <strong>
              {snapshot
                ? `${prettifyCodec(snapshot.codec || "未知")} · ${snapshot.bits ?? "?"} bit · ${formatHz(snapshot.sampleRate)} · ${snapshot.channels} ch`
                : "—"}
            </strong>
          </div>
          <div>
            <span>解码</span>
            <strong>PCM · 32 bit float</strong>
          </div>
          <div>
            <span>输出</span>
            <strong>
              {snapshot
                ? `${snapshot.outputMode} · ${formatHz(snapshot.outputRate)} · ${snapshot.outputBits ?? "?"} bit · ${snapshot.outputFormat}`
                : "—"}
            </strong>
          </div>
        </div>
      )}

      <div className="bp-checks">
        {checks.map((check) => (
          <span key={check.label} className={check.ok ? "is-ok" : "is-off"}>
            <i aria-hidden="true" />
            {check.label}
          </span>
        ))}
      </div>

      {reasons.length > 0 &&
        (full ? (
          <ul className="bp-reasons">
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : (
          <p className="bp-summary" title={reasons.join("；")}>
            {reasons.join(" · ")}
          </p>
        ))}
    </section>
  );
}
