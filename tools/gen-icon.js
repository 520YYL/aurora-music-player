'use strict';
/**
 * 生成应用图标（纯 Node，无第三方依赖）
 * 输出： assets/icon.png (256x256) 与 assets/icon.ico (含 16/32/48/64/128/256 的 PNG 压缩 ICO)
 * 图形：圆角方形渐变底 + 白色音符/声波。
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/* ---------------- PNG 编码 ---------------- */
function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------------- 绘制 ---------------- */
function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const R = size * 0.5;
  const corner = size * 0.235;

  const set = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const sa = a / 255;
    const da = buf[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    buf[i] = Math.round((r * sa + buf[i] * da * (1 - sa)) / oa);
    buf[i + 1] = Math.round((g * sa + buf[i + 1] * da * (1 - sa)) / oa);
    buf[i + 2] = Math.round((b * sa + buf[i + 2] * da * (1 - sa)) / oa);
    buf[i + 3] = Math.round(oa * 255);
  };

  // 圆角方形渐变背景（紫 -> 青）
  const inset = size * 0.045;
  const x0 = inset; const y0 = inset;
  const x1 = size - inset; const y1 = size - inset;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5; const py = y + 0.5;
      const ax = Math.min(Math.max(px - (x0 + corner), 0), Math.max(x1 - corner - (x0 + corner), 0));
      const ay = Math.min(Math.max(py - (y0 + corner), 0), Math.max(y1 - corner - (y0 + corner), 0));
      const dx = px - (x0 + corner + ax);
      const dy = py - (y0 + corner + ay);
      const dist = Math.sqrt(dx * dx + dy * dy);
      const inside = px >= x0 && px <= x1 && py >= y0 && py <= y1 && dist <= corner;
      if (!inside) continue;
      const edge = Math.min(1, corner - dist + 1.6);
      const t = (px + py) / (size * 2);
      const r = Math.round(124 + (34 - 124) * t);
      const g = Math.round(92 + (211 - 92) * t);
      const b = Math.round(255 + (238 - 255) * t);
      set(x, y, r, g, b, Math.round(255 * Math.max(0, Math.min(1, edge))));
    }
  }

  // 圆形唱片轮廓
  const discR = size * 0.315;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d < discR && d > discR - Math.max(1.6, size * 0.013)) {
        set(x, y, 255, 255, 255, 205);
      }
    }
  }

  // 三个音柱（垂直居中）
  const bars = [
    { x: cx - size * 0.155, h: 0.26, w: 0.062 },
    { x: cx, h: 0.44, w: 0.062 },
    { x: cx + size * 0.155, h: 0.32, w: 0.062 }
  ];
  for (const bar of bars) {
    const bw = size * bar.w;
    const bh = size * bar.h;
    const bx0 = Math.round(bar.x - bw / 2);
    const by0 = Math.round(cy - bh / 2);
    const by1 = Math.round(cy + bh / 2);
    const rad = bw / 2;
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx0 + bw; x++) {
        const dx = x - (bx0 + rad);
        const dyTop = y - (by0 + rad);
        const dyBot = y - (by1 - rad);
        if (y < by0 + rad && Math.sqrt(dx * dx + dyTop * dyTop) > rad) continue;
        if (y > by1 - rad && Math.sqrt(dx * dx + dyBot * dyBot) > rad) continue;
        set(x, y, 255, 255, 255, 248);
      }
    }
  }
  return buf;
}

/* ---------------- ICO 打包 ---------------- */
function buildIco(pngs) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  const entries = [];
  let offset = 6 + count * 16;
  for (const p of pngs) {
    const e = Buffer.alloc(16);
    e[0] = p.size >= 256 ? 0 : p.size;
    e[1] = p.size >= 256 ? 0 : p.size;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(p.data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += p.data.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
const sizes = [16, 32, 48, 64, 128, 256];
const pngs = sizes.map((s) => ({ size: s, data: encodePng(s, s, drawIcon(s)) }));
fs.writeFileSync(path.join(outDir, 'icon.png'), pngs[pngs.length - 1].data);
fs.writeFileSync(path.join(outDir, 'icon.ico'), buildIco(pngs));
fs.writeFileSync(path.join(outDir, 'icon-256.png'), pngs[pngs.length - 1].data);
console.log('icons written:', sizes.join(', '));
