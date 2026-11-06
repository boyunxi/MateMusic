import type { LyricLine } from "../types";

export function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function formatDurationLong(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h} 小时 ${m} 分钟` : `${m} 分钟`;
}

export function formatBytes(n: number): string {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`;
}

/** Parse LRC text, supports multiple timestamps per line and [offset:] tag. */
export function parseLrc(text?: string): LyricLine[] {
  if (!text) return [];
  const out: LyricLine[] = [];
  let offset = 0;
  const offsetMatch = text.match(/\[offset:\s*(-?\d+)\s*\]/i);
  if (offsetMatch) offset = parseInt(offsetMatch[1], 10) / 1000;
  const re = /\[(\d{1,2}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
  for (const raw of text.split(/\r?\n/)) {
    const stamps: number[] = [];
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    let lastIndex = 0;
    while ((m = re.exec(raw))) {
      stamps.push(parseInt(m[1], 10) * 60 + parseFloat(m[2].replace(":", ".")));
      lastIndex = re.lastIndex;
    }
    if (!stamps.length) continue;
    const content = raw.slice(lastIndex).trim();
    for (const t of stamps) out.push({ time: Math.max(0, t - offset), text: content || "♪" });
  }
  return out.sort((a, b) => a.time - b.time);
}

export function findLyricIndex(lines: LyricLine[], t: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= t + 0.15) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const hsl = (h: number, s: number, l: number) => `hsl(${Math.round(h)} ${s}% ${l}%)`;

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}

export function paletteFromSeed(seed: string): [string, string, string] {
  const h = hashString(seed) % 360;
  return [hslToHex(h, 78, 58), hslToHex((h + 48) % 360, 70, 45), hslToHex((h + 200) % 360, 45, 12)];
}

/** Deterministic generated SVG cover for tracks without embedded artwork. */
export function generatedCover(seed: string, title: string): string {
  const h = hashString(seed) % 360;
  const h2 = (h + 55) % 360;
  const h3 = (h + 190) % 360;
  const letter = (title.trim()[0] || "♪").toUpperCase().replace(/[<>&"]/g, "♪");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
<defs>
<radialGradient id="a" cx="25%" cy="20%" r="90%"><stop offset="0" stop-color="${hsl(h, 85, 62)}"/><stop offset="1" stop-color="${hsl(h3, 55, 12)}"/></radialGradient>
<radialGradient id="b" cx="85%" cy="90%" r="70%"><stop offset="0" stop-color="${hsl(h2, 90, 55)}" stop-opacity=".85"/><stop offset="1" stop-color="${hsl(h2, 90, 55)}" stop-opacity="0"/></radialGradient>
</defs>
<rect width="400" height="400" fill="url(#a)"/><rect width="400" height="400" fill="url(#b)"/>
<g fill="none" stroke="white" stroke-opacity=".14"><circle cx="200" cy="200" r="150"/><circle cx="200" cy="200" r="110"/><circle cx="200" cy="200" r="70"/></g>
<text x="200" y="236" font-family="Segoe UI, PingFang SC, sans-serif" font-size="120" font-weight="700" fill="white" fill-opacity=".9" text-anchor="middle">${letter}</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Extracts 3 representative colors from an image URL (same-origin / blob / data). */
export async function extractPalette(url: string): Promise<[string, string, string] | null> {
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = c.height = 32;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, 32, 32);
    const data = ctx.getImageData(0, 0, 32, 32).data;
    const buckets = new Map<number, { r: number; g: number; b: number; n: number; sat: number }>();
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const sat = max === 0 ? 0 : (max - min) / max;
      const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
      const e = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0, sat: 0 };
      e.r += r; e.g += g; e.b += b; e.n++; e.sat += sat;
      buckets.set(key, e);
    }
    const arr = [...buckets.values()].map((e) => ({
      r: e.r / e.n, g: e.g / e.n, b: e.b / e.n, n: e.n, sat: e.sat / e.n,
    }));
    const hex = (o: { r: number; g: number; b: number }) =>
      "#" + [o.r, o.g, o.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
    const vivid = [...arr].sort((a, b) => b.n * (0.3 + b.sat) - a.n * (0.3 + a.sat));
    const dark = [...arr].sort((a, b) => a.r + a.g + a.b - (b.r + b.g + b.b))[0];
    const first = vivid[0];
    const second = vivid.find((c) => Math.abs(c.r - first.r) + Math.abs(c.g - first.g) + Math.abs(c.b - first.b) > 90) || vivid[1] || first;
    return [hex(first), hex(second), hex({ r: dark.r * 0.6, g: dark.g * 0.6, b: dark.b * 0.6 })];
  } catch {
    return null;
  }
}

export function uid(prefix = "id"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
