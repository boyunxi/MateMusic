import { createWriteStream, existsSync, mkdirSync, readdirSync, copyFileSync, rmSync, statSync } from "node:fs";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetDir = path.join(root, "src-tauri", "resources", "ffmpeg");
const ffmpegExe = path.join(targetDir, "ffmpeg.exe");
const ffprobeExe = path.join(targetDir, "ffprobe.exe");
const url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip";

if (process.platform !== "win32") {
  console.log("[ffmpeg] 当前项目仅内置 Windows FFmpeg 二进制，跳过下载。");
  process.exit(0);
}

const ready = () =>
  existsSync(ffmpegExe) && existsSync(ffprobeExe) && statSync(ffmpegExe).size > 1_000_000 && statSync(ffprobeExe).size > 1_000_000;

if (ready()) {
  process.exit(0);
}

mkdirSync(targetDir, { recursive: true });
const tempRoot = path.join(os.tmpdir(), `matemusic-ffmpeg-${process.pid}`);
const zipPath = path.join(tempRoot, "ffmpeg.zip");
mkdirSync(tempRoot, { recursive: true });

console.log("[ffmpeg] 下载 LGPL 构建（约 168MB，仅首次需要）…");
const response = await fetch(url, { redirect: "follow" });
if (!response.ok || !response.body) {
  throw new Error(`下载 FFmpeg 失败：HTTP ${response.status}`);
}
const total = Number(response.headers.get("content-length") || 0);
let received = 0;
const stream = Readable.fromWeb(response.body);
stream.on("data", (chunk) => {
  received += chunk.length;
  if (total && received % (16 * 1024 * 1024) < chunk.length) {
    const pct = Math.round((received / total) * 100);
    console.log(`[ffmpeg] ${pct}% (${(received / 1024 / 1024).toFixed(0)}MB)`);
  }
});
const out = createWriteStream(zipPath);
stream.pipe(out);
await once(out, "finish");

console.log("[ffmpeg] 解压…");
const unpack = path.join(tempRoot, "unpacked");
execFileSync(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${unpack}' -Force`],
  { stdio: "inherit" },
);

function find(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = find(full, name);
      if (hit) return hit;
    } else if (entry.name.toLowerCase() === name.toLowerCase()) {
      return full;
    }
  }
  return null;
}

const foundFfmpeg = find(unpack, "ffmpeg.exe");
const foundFfprobe = find(unpack, "ffprobe.exe");
if (!foundFfmpeg || !foundFfprobe) {
  throw new Error("FFmpeg 压缩包中未找到 ffmpeg.exe / ffprobe.exe");
}
copyFileSync(foundFfmpeg, ffmpegExe);
copyFileSync(foundFfprobe, ffprobeExe);
rmSync(tempRoot, { recursive: true, force: true });
console.log(`[ffmpeg] 就绪：${targetDir}`);
