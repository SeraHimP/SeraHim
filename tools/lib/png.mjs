/**
 * png.mjs —— 零依赖的 PNG 编解码（8 位、非隔行、RGB / RGBA）+ 两张图的像素差异统计。
 * 截图对比工具（tools/shots.mjs）用它；无头 Chromium 的截图正好是这种格式。
 */
import zlib from 'zlib';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
let _crcT = null;
function crc32(buf) {
  if (!_crcT) _crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  let c = 0xffffffff;
  for (const x of buf) c = _crcT[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 解码为 { width, height, data: Uint8Array(RGBA) }。只支持 8 位深、非隔行的 RGB(2) / RGBA(6)。 */
export function decodePNG(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('不是 PNG');
  let p = 8, width = 0, height = 0, ctype = 0, depth = 0, interlace = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), body = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]; ctype = body[9]; interlace = body[12]; }
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || (ctype !== 2 && ctype !== 6)) throw new Error(`不支持的 PNG（位深 ${depth}，颜色类型 ${ctype}，隔行 ${interlace}）`);
  const bpp = ctype === 6 ? 4 : 3, stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0, b = y > 0 ? px[dst - stride + x] : 0, c = (x >= bpp && y > 0) ? px[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      px[dst + x] = v & 255;
    }
  }
  if (bpp === 4) return { width, height, data: px };
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < px.length; i += 3, j += 4) { rgba[j] = px[i]; rgba[j + 1] = px[i + 1]; rgba[j + 2] = px[i + 2]; rgba[j + 3] = 255; }
  return { width, height, data: rgba };
}

/** 编码 RGBA → PNG（不做行滤波，够用）。 */
export function encodePNG({ width, height, data }) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tb));
    return Buffer.concat([len, tb, crc]);
  };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(width, 0); ih.writeUInt32BE(height, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([SIG, chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * 两张同尺寸图的差异。threshold：单通道差值超过它才算"这个像素变了"（0 = 任何差异都算）。
 * 返回 { changed（变了的像素数）, ratio（占比）, maxDelta（最大单通道差）, meanDelta（平均每通道差）, diff（差异可视化 RGBA）}。
 * 差异图：没变的像素是原图的暗灰版，变了的像素按差值大小涂成红色。
 */
export function diffImages(a, b, threshold = 0) {
  if (a.width !== b.width || a.height !== b.height) return { sizeMismatch: true, changed: a.width * a.height, ratio: 1, maxDelta: 255, meanDelta: 255, diff: null };
  const n = a.width * a.height, out = new Uint8Array(n * 4);
  let changed = 0, maxDelta = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const d = Math.max(Math.abs(a.data[o] - b.data[o]), Math.abs(a.data[o + 1] - b.data[o + 1]), Math.abs(a.data[o + 2] - b.data[o + 2]));
    sum += Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1]) + Math.abs(a.data[o + 2] - b.data[o + 2]);
    if (d > maxDelta) maxDelta = d;
    if (d > threshold) {
      changed++;
      const k = Math.min(1, 0.35 + d / 64);
      out[o] = 255 * k; out[o + 1] = 30; out[o + 2] = 30; out[o + 3] = 255;
    } else {
      const g = (a.data[o] * 0.3 + a.data[o + 1] * 0.59 + a.data[o + 2] * 0.11) * 0.35;
      out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = 255;
    }
  }
  return { changed, ratio: changed / n, maxDelta, meanDelta: sum / (n * 3), diff: { width: a.width, height: a.height, data: out } };
}
