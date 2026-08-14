#!/usr/bin/env node
/**
 * 生成 DSH Desktop 应用图标(build/icon.png + build/icon.ico)
 * 纯 Node 实现:绘制 256x256 圆角渐变方块 + 白色 ">" 提示符,编码为 PNG,
 * 并打包为 ICO(Windows 支持 ICO 内嵌 PNG)。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const buildDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "build");
const SIZE = 256;
const RADIUS = 52;

// ---------- 像素绘制 ----------
const px = new Uint8Array(SIZE * SIZE * 4); // RGBA

function setPx(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  px[i] = r;
  px[i + 1] = g;
  px[i + 2] = b;
  px[i + 3] = a;
}

function insideRoundRect(x, y, r) {
  const x0 = r, y0 = r, x1 = SIZE - 1 - r, y1 = SIZE - 1 - r;
  if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return true;
  // 四角圆弧
  const cx = x < x0 ? x0 : x > x1 ? x1 : x;
  const cy = y < y0 ? y0 : y > y1 ? y1 : y;
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// 垂直渐变(深空蓝 -> 亮蓝)
const cTop = [16, 22, 44]; // #10162c
const cBottom = [45, 96, 255]; // #2d60ff

// 提示符 ">" :由两条线段组成的三角形(粗描边)
function inChevron(x, y) {
  // 参数化:中心 (cx, cy),半宽 hw,半高 hh,厚度 t
  const cx = 128, cy = 132, hw = 66, hh = 92, t = 26;
  // 上臂:从 (cx-hw, cy-hh) 到 (cx+hw, cy)
  const d1 = distToSegment(x, y, cx - hw, cy - hh, cx + hw * 0.55, cy);
  // 下臂:从 (cx+hw*0.55, cy) 到 (cx-hw, cy+hh)
  const d2 = distToSegment(x, y, cx + hw * 0.55, cy, cx - hw, cy + hh);
  return Math.min(d1, d2) <= t / 2;
}

function distToSegment(px_, py_, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px_ - x1) * dx + (py_ - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const nx = x1 + t * dx, ny = y1 + t * dy;
  return Math.hypot(px_ - nx, py_ - ny);
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (!insideRoundRect(x, y, RADIUS)) {
      // 边缘抗锯齿:1px 过渡
      const v = insideRoundRect(x, y, RADIUS - 1) ? 255 : 0;
      setPx(x, y, 0, 0, 0, Math.round(v * 0.9));
      continue;
    }
    const f = y / (SIZE - 1);
    const r = Math.round(cTop[0] + (cBottom[0] - cTop[0]) * f);
    const g = Math.round(cTop[1] + (cBottom[1] - cTop[1]) * f);
    const b = Math.round(cTop[2] + (cBottom[2] - cTop[2]) * f);
    if (inChevron(x, y)) {
      setPx(x, y, 255, 255, 255);
    } else {
      setPx(x, y, r, g, b);
    }
  }
}

// ---------- PNG 编码 ----------
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      // 缩放到 size
      const sx = Math.floor((x / size) * SIZE);
      const sy = Math.floor((y / size) * SIZE);
      const si = (sy * SIZE + sx) * 4;
      raw[o] = px[si];
      raw[o + 1] = px[si + 1];
      raw[o + 2] = px[si + 2];
      raw[o + 3] = px[si + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- ICO 编码(内嵌 256x256 PNG) ----------
function encodeICO(pngBuf) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry[0] = 0; // width 256
  entry[1] = 0; // height 256
  entry[2] = 0; // colors
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(22, 12); // offset
  return Buffer.concat([header, entry, pngBuf]);
}

fs.mkdirSync(buildDir, { recursive: true });
const png256 = encodePNG(256);
fs.writeFileSync(path.join(buildDir, "icon.png"), png256);
fs.writeFileSync(path.join(buildDir, "icon.ico"), encodeICO(png256));
console.log("图标已生成:");
console.log(`  ${path.join(buildDir, "icon.png")} (${png256.length} bytes)`);
console.log(`  ${path.join(buildDir, "icon.ico")} (${encodeICO(png256).length} bytes)`);
