import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { inTauri } from "./tauri";

const MINI_SIZE = new LogicalSize(400, 280);
const NORMAL_MIN = new LogicalSize(960, 640);
const NORMAL_SIZE = new LogicalSize(1200, 800);
const STORAGE_KEY = "matemusic:mini-bounds";

interface SavedBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

function takeBounds(): SavedBounds | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(STORAGE_KEY);
    return JSON.parse(raw) as SavedBounds;
  } catch {
    return null;
  }
}

async function restoreBounds(bounds: SavedBounds | null): Promise<void> {
  const win = getCurrentWindow();
  await win.setResizable(true);
  if (bounds) {
    await win.setSize(new LogicalSize(bounds.width, bounds.height));
    await win.setPosition(new LogicalPosition(bounds.x, bounds.y));
  } else {
    const scale = await win.scaleFactor();
    const size = await win.innerSize();
    if (size.width / scale < 900 || size.height / scale < 600) {
      await win.setSize(NORMAL_SIZE);
      await win.center();
    }
  }
  await win.setMinSize(NORMAL_MIN);
  if (bounds?.maximized) await win.maximize();
}

export async function enterMiniWindow(): Promise<void> {
  if (!inTauri || sessionStorage.getItem(STORAGE_KEY)) return;
  const win = getCurrentWindow();
  try {
    // Issue all reads before yielding so the mini card's resize cannot race them.
    const [maximized, scale, position, size] = await Promise.all([
      win.isMaximized(),
      win.scaleFactor(),
      win.innerPosition(),
      win.innerSize(),
    ]);
    const bounds: SavedBounds = {
      x: position.x / scale,
      y: position.y / scale,
      width: size.width / scale,
      height: size.height / scale,
      maximized,
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(bounds));
    if (maximized) await win.unmaximize();
    await win.setMinSize(new LogicalSize(1, 1));
    await win.setSize(MINI_SIZE);
    await win.setResizable(false);
  } catch {
    sessionStorage.removeItem(STORAGE_KEY);
  }
}

export async function exitMiniWindow(): Promise<void> {
  if (!inTauri) return;
  const bounds = takeBounds();
  try {
    await restoreBounds(bounds);
  } catch {
    /* window may be closing */
  }
}

/** Recovers a normal window after a dev reload or a partial mini transition. */
export async function ensureNormalWindow(): Promise<void> {
  if (!inTauri) return;
  try {
    await restoreBounds(takeBounds());
  } catch {
    /* ignore */
  }
}

/** Snaps the frameless window to the mini card's measured size. */
export async function fitMiniWindow(width: number, height: number): Promise<void> {
  if (!inTauri) return;
  const win = getCurrentWindow();
  try {
    await win.setMinSize(new LogicalSize(1, 1));
    await win.setSize(new LogicalSize(Math.ceil(width), Math.ceil(height)));
  } catch {
    /* ignore */
  }
}
