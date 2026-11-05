const CODEC_NAMES: Record<string, string> = {
  pcm_s16le: "PCM 16",
  pcm_s24le: "PCM 24",
  pcm_s32le: "PCM 32",
  pcm_f32le: "PCM F32",
};

export function formatTime(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function formatHz(rate: number) {
  if (!rate) return "未知";
  return rate % 1000 === 0 ? `${rate / 1000} kHz` : `${(rate / 1000).toFixed(1)} kHz`;
}

export function prettifyCodec(codec: string) {
  return CODEC_NAMES[codec] ?? codec.toUpperCase();
}

export function formatTrackFormat(
  codec?: string | null,
  bits?: number | null,
  rate?: number | null,
) {
  return [codec ? prettifyCodec(codec) : null, bits ? `${bits} bit` : null, rate ? formatHz(rate) : null]
    .filter(Boolean)
    .join(" · ");
}
