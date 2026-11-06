export interface ParsedMeta {
  title?: string;
  artist?: string;
  album?: string;
  picture?: Blob;
  lyrics?: string;
  sampleRate?: number;
  bitsPerSample?: number;
}

function decodeText(bytes: Uint8Array, enc: number): string {
  try {
    let label = "latin1";
    if (enc === 1) label = "utf-16";
    else if (enc === 2) label = "utf-16be";
    else if (enc === 3) label = "utf-8";
    return new TextDecoder(label).decode(bytes).replace(/\u0000+$/g, "").replace(/\u0000/g, " / ").trim();
  } catch {
    return "";
  }
}

function findTerminator(b: Uint8Array, start: number, enc: number): number {
  if (enc === 1 || enc === 2) {
    for (let i = start; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i;
    return b.length;
  }
  for (let i = start; i < b.length; i++) if (b[i] === 0) return i;
  return b.length;
}

const syncsafe = (b: Uint8Array, o: number) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];

async function parseId3(file: File): Promise<ParsedMeta> {
  const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return {};
  const version = head[3];
  const size = syncsafe(head, 6);
  const buf = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
  const meta: ParsedMeta = {};
  let p = 0;
  if (head[5] & 0x40) {
    // extended header
    const ext = version === 4 ? syncsafe(buf, 0) : ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) + 4;
    p += ext;
  }
  const idLen = version === 2 ? 3 : 4;
  const hdrLen = version === 2 ? 6 : 10;
  while (p + hdrLen < buf.length) {
    const id = String.fromCharCode(...buf.slice(p, p + idLen));
    if (!/^[A-Z0-9]+$/.test(id)) break;
    let fsize: number;
    if (version === 2) fsize = (buf[p + 3] << 16) | (buf[p + 4] << 8) | buf[p + 5];
    else if (version === 4) fsize = syncsafe(buf, p + 4);
    else fsize = (buf[p + 4] << 24) | (buf[p + 5] << 16) | (buf[p + 6] << 8) | buf[p + 7];
    const body = buf.slice(p + hdrLen, p + hdrLen + fsize);
    p += hdrLen + fsize;
    if (!body.length) continue;
    const enc = body[0];
    switch (id) {
      case "TIT2":
      case "TT2":
        meta.title = decodeText(body.slice(1), enc);
        break;
      case "TPE1":
      case "TP1":
        meta.artist = decodeText(body.slice(1), enc);
        break;
      case "TALB":
      case "TAL":
        meta.album = decodeText(body.slice(1), enc);
        break;
      case "USLT":
      case "ULT": {
        const descEnd = findTerminator(body, 4, enc);
        const start = descEnd + (enc === 1 || enc === 2 ? 2 : 1);
        meta.lyrics = decodeText(body.slice(start), enc);
        break;
      }
      case "APIC": {
        const mimeEnd = findTerminator(body, 1, 0);
        const mime = decodeText(body.slice(1, mimeEnd), 0) || "image/jpeg";
        const descStart = mimeEnd + 2; // skip picture type
        const descEnd = findTerminator(body, descStart, enc);
        const dataStart = descEnd + (enc === 1 || enc === 2 ? 2 : 1);
        if (!meta.picture) meta.picture = new Blob([body.slice(dataStart)], { type: mime.includes("/") ? mime : `image/${mime.toLowerCase()}` });
        break;
      }
      case "PIC": {
        const fmt = decodeText(body.slice(1, 4), 0).toLowerCase();
        const descEnd = findTerminator(body, 5, enc);
        const dataStart = descEnd + (enc === 1 || enc === 2 ? 2 : 1);
        if (!meta.picture) meta.picture = new Blob([body.slice(dataStart)], { type: fmt === "png" ? "image/png" : "image/jpeg" });
        break;
      }
    }
  }
  return meta;
}

async function parseFlac(file: File): Promise<ParsedMeta> {
  const buf = new Uint8Array(await file.slice(0, Math.min(file.size, 8 * 1024 * 1024)).arrayBuffer());
  if (String.fromCharCode(...buf.slice(0, 4)) !== "fLaC") return {};
  const meta: ParsedMeta = {};
  const dv = new DataView(buf.buffer);
  let p = 4;
  let last = false;
  while (!last && p + 4 <= buf.length) {
    const h = buf[p];
    last = (h & 0x80) !== 0;
    const type = h & 0x7f;
    const len = (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3];
    const s = p + 4;
    if (s + len > buf.length) break;
    if (type === 0) {
      meta.sampleRate = (buf[s + 10] << 12) | (buf[s + 11] << 4) | (buf[s + 12] >> 4);
      meta.bitsPerSample = (((buf[s + 12] & 0x01) << 4) | (buf[s + 13] >> 4)) + 1;
    } else if (type === 4) {
      let q = s;
      const vlen = dv.getUint32(q, true);
      q += 4 + vlen;
      const count = dv.getUint32(q, true);
      q += 4;
      const dec = new TextDecoder("utf-8");
      for (let i = 0; i < count && q < s + len; i++) {
        const l = dv.getUint32(q, true);
        q += 4;
        const kv = dec.decode(buf.slice(q, q + l));
        q += l;
        const eq = kv.indexOf("=");
        const k = kv.slice(0, eq).toUpperCase();
        const v = kv.slice(eq + 1);
        if (k === "TITLE") meta.title = v;
        else if (k === "ARTIST") meta.artist = meta.artist ? `${meta.artist} / ${v}` : v;
        else if (k === "ALBUM") meta.album = v;
        else if (k === "LYRICS" || k === "UNSYNCEDLYRICS") meta.lyrics = v;
      }
    } else if (type === 6 && !meta.picture) {
      let q = s + 4;
      const mlen = dv.getUint32(q);
      q += 4;
      const mime = new TextDecoder().decode(buf.slice(q, q + mlen));
      q += mlen;
      const dlen = dv.getUint32(q);
      q += 4 + dlen + 16;
      const plen = dv.getUint32(q);
      q += 4;
      meta.picture = new Blob([buf.slice(q, q + plen)], { type: mime || "image/jpeg" });
    }
    p = s + len;
  }
  return meta;
}

async function parseWav(file: File): Promise<ParsedMeta> {
  const buf = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  if (String.fromCharCode(...buf.slice(0, 4)) !== "RIFF") return {};
  const dv = new DataView(buf.buffer);
  return { sampleRate: dv.getUint32(24, true), bitsPerSample: dv.getUint16(34, true) };
}

export async function parseMetadata(file: File): Promise<ParsedMeta> {
  const ext = file.name.split(".").pop()?.toLowerCase();
  try {
    if (ext === "flac") return await parseFlac(file);
    if (ext === "wav") return await parseWav(file);
    return await parseId3(file);
  } catch {
    return {};
  }
}

export function probeDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    const a = document.createElement("audio");
    a.preload = "metadata";
    const done = (v: number) => {
      a.removeAttribute("src");
      a.load();
      resolve(v);
    };
    const timer = window.setTimeout(() => done(0), 8000);
    a.onloadedmetadata = () => {
      window.clearTimeout(timer);
      done(isFinite(a.duration) ? a.duration : 0);
    };
    a.onerror = () => {
      window.clearTimeout(timer);
      done(0);
    };
    a.src = url;
  });
}

/** "Artist - Title.mp3" → { artist, title } */
export function parseFileName(name: string): { title: string; artist?: string } {
  const base = name.replace(/\.[^.]+$/, "").replace(/_/g, " ").trim();
  const m = base.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { title: base };
}
