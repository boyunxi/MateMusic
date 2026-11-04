import { mkdirSync, writeFileSync } from "node:fs";

// 生成确定性测试样本：不提交二进制，随时可重建
const FADE = 0.01;

function writeWav(path, { rate, bits, seconds, channels }) {
  const frames = Math.round(rate * seconds);
  const bytesPerSample = bits / 8;
  const blockAlign = channels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * blockAlign, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);

  const freq = [440, 554.365];
  const amp = bits === 16 ? 0.42 : 0.28;

  for (let i = 0; i < frames; i++) {
    const t = i / rate;
    const edge = Math.min(1, t / FADE, (seconds - t) / FADE);
    for (let c = 0; c < channels; c++) {
      const v = Math.sin(2 * Math.PI * freq[c % freq.length] * t) * amp * Math.max(0, edge);
      const off = 44 + i * blockAlign + c * bytesPerSample;
      if (bits === 16) {
        const s = Math.round(v * 32767);
        buf.writeInt16LE(s, off);
      } else if (bits === 24) {
        const s = Math.round(v * 8388607);
        buf.writeIntLE(s, off, 3);
      } else if (bits === 32) {
        buf.writeInt32LE(Math.round(v * 2147483647), off);
      }
    }
  }

  writeFileSync(path, buf);
  console.log(`${path}  ${rate} Hz / ${bits} bit / ${channels} ch / ${seconds}s`);
}

mkdirSync("tests/samples", { recursive: true });
writeWav("tests/samples/tone-44100-16.wav", { rate: 44100, bits: 16, seconds: 2, channels: 2 });
writeWav("tests/samples/tone-96000-24.wav", { rate: 96000, bits: 24, seconds: 1.5, channels: 2 });
