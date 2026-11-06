const NATIVE_SUPPORTED = new Set([
  "flac",
  "wav",
  "mp3",
  "m4a",
  "mp4",
  "aac",
  "ogg",
  "opus",
  "aiff",
  "aif",
  "alac",
]);

/** Formats the bundled Rust engine (Symphonia, no FFmpeg) can decode. */
export function isNativeDecodable(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return NATIVE_SUPPORTED.has(ext);
}
