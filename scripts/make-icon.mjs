import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";

const SIZE = 1024;
const [cx, cy] = [SIZE / 2, SIZE / 2];

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
const out = Buffer.alloc(SIZE * SIZE * 4);

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const dx = (x - cx) / cx;
    const dy = (y - cy) / cy;
    const r = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);

    // 深色底 + 左上柔光
    let [red, green, blue] = [10, 14, 28];
    const glow = Math.max(0, 1 - Math.hypot(dx + 0.55, dy + 0.6) * 1.4);
    red += glow * 18;
    green += glow * 42;
    blue += glow * 40;

    // 黑胶盘体
    if (r < 0.78) {
      const shade = 0.5 + 0.5 * Math.cos(r * 70);
      const body = 10 + shade * 7;
      red = body + 4;
      green = body + 7;
      blue = body + 12;

      // 细密沟槽
      const groove = Math.sin(r * 190) * 0.5 + 0.5;
      const grooveAmt = groove * 6;
      red += grooveAmt;
      green += grooveAmt;
      blue += grooveAmt;

      // 左上一道高光
      const spec = Math.max(0, Math.cos(angle - 2.4)) * Math.max(0, 1 - Math.abs(r - 0.5) * 6);
      red += spec * 60;
      green += spec * 90;
      blue += spec * 86;
    }

    // 中心标签
    if (r < 0.2) {
      const t = r / 0.2;
      red = 34 + (127 - 34) * (1 - t);
      green = 70 + (209 - 70) * (1 - t);
      blue = 78 + (196 - 78) * (1 - t);
    }
    if (r < 0.022) {
      red = 10;
      green = 14;
      blue = 22;
    }

    // 圆角方形遮罩
    const ex = Math.max(Math.abs(dx), Math.abs(dy));
    const corner = 0.84;
    let alpha = 255;
    if (ex > corner) {
      const k = (ex - corner) / (1 - corner);
      alpha = Math.max(0, 1 - k * k) * 255;
    }

    const i = (y * SIZE + x) * 4;
    out[i] = Math.min(255, red);
    out[i + 1] = Math.min(255, green);
    out[i + 2] = Math.min(255, blue);
    out[i + 3] = alpha;
  }
}

for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  out.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync("src-tauri", { recursive: true });
writeFileSync("app-icon.png", png);
console.log(`app-icon.png ${SIZE}x${SIZE} written`);
