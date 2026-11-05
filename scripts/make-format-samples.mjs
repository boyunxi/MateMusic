import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 用 ffmpeg 生成格式矩阵样本；样本不提交，需要本机 ffmpeg 或 FFMPEG 环境变量
const OUT_DIR = fileURLToPath(new URL("../tests/samples/formats/", import.meta.url));
const SOURCE = fileURLToPath(new URL("../tests/samples/tone-44100-16.wav", import.meta.url));
const FFMPEG = process.env.FFMPEG || "ffmpeg";

mkdirSync(OUT_DIR, { recursive: true });

const jobs = [
  ["tone.flac", ["-c:a", "flac"]],
  ["tone.mp3", ["-c:a", "libmp3lame", "-b:a", "192k"]],
  ["tone-aac.m4a", ["-c:a", "aac", "-b:a", "192k"]],
  ["tone-alac.m4a", ["-c:a", "alac"]],
  ["tone.ogg", ["-c:a", "libvorbis", "-q:a", "5"]],
  ["tone.opus", ["-c:a", "libopus", "-b:a", "128k"]],
  ["tone.wma", ["-c:a", "wmav2", "-b:a", "192k"]],
];

for (const [name, args] of jobs) {
  execFileSync(
    FFMPEG,
    ["-y", "-hide_banner", "-loglevel", "error", "-i", SOURCE, ...args, `${OUT_DIR}${name}`],
    { stdio: "inherit" },
  );
  console.log(`${name} written`);
}

// 仅用于验证「缺少解码器」提示，模板文件是占位内容
writeFileSync(`${OUT_DIR}tone.ape`, "not a real APE file\n");
writeFileSync(`${OUT_DIR}tone.dsf`, "not a real DSF file\n");
console.log("tone.ape / tone.dsf placeholder written");
