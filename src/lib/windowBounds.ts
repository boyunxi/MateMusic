import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { inTauri } from "./tauri";

const MINI_SIZE = new LogicalSize(440, 320);
const NORMAL_MIN = new LogicalSize(960, 640);
const NORMAL_SIZE = new LogicalSize(1200, 800);

let saved: { position: LogicalPosition; size: LogicalSize; maximized: boolean } | null = null;

export async function enterMiniWindow(): Promise<void> {
  if (!inTauri || saved) return;
  const win = getCurrentWindow();
  try {
    const maximized = await win.isMaximized();
    const scale = await win.scaleFactor();
    const position = await win.innerPosition();
    const size = await win.innerSize();
    saved = {
      position: new LogicalPosition(position.x / scale, position.y / scale),
      size: new LogicalSize(size.width / scale, size.height / scale),
      maximized,
    };
    if (maximized) await win.unmaximize();
    await win.setMinSize(new LogicalSize(1, 1));
    await win.setSize(MINI_SIZE);
    await win.setResizable(false);
  } catch {
    saved = null;
  }
}

export async function exitMiniWindow(): Promise<void> {
  if (!inTauri) return;
  const win = getCurrentWindow();
  const bounds = saved;
  saved = null;
  try {
    await win.setResizable(true);
    await win.setMinSize(NORMAL_MIN);
    if (bounds) {
      await win.setSize(bounds.size);
      await win.setPosition(bounds.position);
      if (bounds.maximized) await win.maximize();
    }
  } catch {
    /* window may be closing */
  }
}

/** Recovers a normal window after a dev reload or a partial mini transition. */
export async function ensureNormalWindow(): Promise<void> {
  if (!inTauri) return;
  if (saved) {
    await exitMiniWindow();
    return;
  }
  const win = getCurrentWindow();
  try {
    await win.setResizable(true);
    await win.setMinSize(NORMAL_MIN);
    const scale = await win.scaleFactor();
    const size = await win.innerSize();
    if (size.width / scale < 900 || size.height / scale < 600) {
      await win.setSize(NORMAL_SIZE);
      await win.center();
    }
  } catch {
    /* ignore */
  }
}
