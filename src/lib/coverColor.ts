import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";

export type ThemeMode = "dark" | "light";

type CoverHue = {
  hue: number;
  secondary: number;
  saturation: number;
};

export type CoverPalette = {
  accent: string;
  accentStrong: string;
  accentSoft: string;
  accentGlow: string;
  ambientA: string;
  ambientB: string;
  ambientC: string;
  ambientD: string;
};

const hueCache = new Map<string, CoverHue>();

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const hsl = (hue: number, saturation: number, lightness: number) =>
  `hsl(${Math.round(hue)}, ${Math.round(saturation)}%, ${Math.round(lightness)}%)`;

const hsla = (hue: number, saturation: number, lightness: number, alpha: number) =>
  `hsla(${Math.round(hue)}, ${Math.round(saturation)}%, ${Math.round(lightness)}%, ${alpha})`;

function paletteFromHue(hue: CoverHue, theme: ThemeMode): CoverPalette {
  const saturation = clamp(hue.saturation, 44, 82);
  if (theme === "light") {
    return {
      accent: hsl(hue.hue, Math.min(76, saturation), 34),
      accentStrong: hsl(hue.hue, Math.min(80, saturation + 6), 24),
      accentSoft: hsla(hue.hue, saturation, 40, 0.14),
      accentGlow: hsla(hue.hue, saturation, 42, 0.22),
      ambientA: hsla(hue.hue, saturation * 0.8, 62, 0.34),
      ambientB: hsla(hue.secondary, saturation * 0.7, 66, 0.26),
      ambientC: hsla((hue.hue + 36) % 360, saturation * 0.58, 60, 0.2),
      ambientD: hsla(hue.secondary, saturation * 0.5, 56, 0.16),
    };
  }
  return {
    accent: hsl(hue.hue, saturation, 72),
    accentStrong: hsl(hue.hue, Math.min(92, saturation + 16), 86),
    accentSoft: hsla(hue.hue, saturation, 70, 0.16),
    accentGlow: hsla(hue.hue, saturation, 64, 0.34),
    ambientA: hsla(hue.hue, saturation, 55, 0.62),
    ambientB: hsla(hue.secondary, saturation * 0.86, 58, 0.42),
    ambientC: hsla((hue.hue + 36) % 360, saturation * 0.68, 52, 0.34),
    ambientD: hsla(hue.secondary, saturation * 0.58, 46, 0.28),
  };
}

function loadImage(src: string, crossOrigin: boolean): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (crossOrigin) image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("cover load failed"));
    image.src = src;
  });
}

function dominantHue(image: HTMLImageElement): CoverHue {
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("canvas unavailable");
  context.drawImage(image, 0, 0, size, size);
  const { data } = context.getImageData(0, 0, size, size);

  const buckets = Array.from({ length: 12 }, () => ({
    weight: 0,
    sin: 0,
    cos: 0,
    saturation: 0,
  }));
  let total = 0;

  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] < 200) continue;
    const red = data[index] / 255;
    const green = data[index + 1] / 255;
    const blue = data[index + 2] / 255;
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const lightness = (max + min) / 2;
    if (lightness < 0.08 || lightness > 0.92) continue;
    const delta = max - min;
    if (delta < 0.02) continue;
    const saturation =
      delta / (1 - Math.abs(2 * lightness - 1)) || 0;
    if (saturation < 0.18) continue;

    let hue = 0;
    if (max === red) hue = ((green - blue) / delta) % 6;
    else if (max === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
    hue = ((hue * 60) % 360 + 360) % 360;

    const bucket = buckets[Math.floor(hue / 30) % 12];
    const weight = 0.12 + saturation * saturation * 3.2;
    const radians = (hue * Math.PI) / 180;
    bucket.weight += weight;
    bucket.sin += Math.sin(radians) * weight;
    bucket.cos += Math.cos(radians) * weight;
    bucket.saturation += saturation * weight;
    total += weight;
  }

  if (total < 1.5) throw new Error("cover too monochrome");

  const ranked = buckets
    .map((bucket, index) => ({ bucket, index }))
    .filter((entry) => entry.bucket.weight > 0)
    .sort((a, b) => b.bucket.weight - a.bucket.weight);
  const primary = ranked[0];
  const primaryHue =
    ((Math.atan2(primary.bucket.sin, primary.bucket.cos) * 180) / Math.PI + 360) % 360;
  const secondary =
    ranked.find((entry) => {
      const hue =
        ((Math.atan2(entry.bucket.sin, entry.bucket.cos) * 180) / Math.PI + 360) % 360;
      return Math.abs(((hue - primaryHue + 540) % 360) - 180) > 40;
    }) ?? ranked[1 % ranked.length];
  const secondaryHue =
    ((Math.atan2(secondary.bucket.sin, secondary.bucket.cos) * 180) / Math.PI + 360) %
    360;

  return {
    hue: primaryHue,
    secondary: secondaryHue,
    saturation: (primary.bucket.saturation / primary.bucket.weight) * 100,
  };
}

export async function extractCoverHue(src: string): Promise<CoverHue> {
  const cached = hueCache.get(src);
  if (cached) return cached;

  let image: HTMLImageElement;
  try {
    image = await loadImage(src, true);
  } catch {
    image = await loadImage(src, false);
  }
  const hue = dominantHue(image);
  hueCache.set(src, hue);
  return hue;
}

export function coverPaletteStyle(palette: CoverPalette): CSSProperties {
  return {
    "--accent": palette.accent,
    "--accent-strong": palette.accentStrong,
    "--accent-soft": palette.accentSoft,
    "--accent-glow": palette.accentGlow,
    "--ambient-a": palette.ambientA,
    "--ambient-b": palette.ambientB,
    "--ambient-c": palette.ambientC,
    "--ambient-d": palette.ambientD,
  } as CSSProperties;
}

export function useCoverPalette(
  src: string | null | undefined,
  theme: ThemeMode,
): CoverPalette | null {
  const [hue, setHue] = useState<CoverHue | null>(() =>
    src ? hueCache.get(src) ?? null : null,
  );

  useEffect(() => {
    let cancelled = false;
    if (!src) {
      setHue(null);
      return;
    }
    const cached = hueCache.get(src);
    if (cached) {
      setHue(cached);
      return;
    }
    setHue(null);
    void extractCoverHue(src)
      .then((value) => {
        if (!cancelled) setHue(value);
      })
      .catch(() => {
        if (!cancelled) setHue(null);
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  return useMemo(() => (hue ? paletteFromHue(hue, theme) : null), [hue, theme]);
}
