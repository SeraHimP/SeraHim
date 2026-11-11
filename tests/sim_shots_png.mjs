// 截图对比工具（tools/shots.mjs）的 PNG 编解码与像素差异统计（tools/lib/png.mjs）。
// 这个工具用来证明"性能优化没有改动画面"，比对逻辑本身错了就什么也证明不了，所以单独钉住。
import { scoreboard } from './_harness.mjs';
const { decodePNG, encodePNG, diffImages } = await import('../tools/lib/png.mjs');
const { T, done } = scoreboard('截图对比：PNG 编解码 + 像素差异');

const W = 7, H = 5;
const img = { width: W, height: H, data: new Uint8Array(W * H * 4) };
for (let i = 0; i < W * H; i++) { img.data[i * 4] = (i * 37) & 255; img.data[i * 4 + 1] = (i * 91) & 255; img.data[i * 4 + 2] = (i * 13) & 255; img.data[i * 4 + 3] = 255; }
const back = decodePNG(encodePNG(img));
T('码①-编码再解码逐字节一致（尺寸与像素都对）', back.width === W && back.height === H && back.data.every((v, i) => v === img.data[i]));

const same = diffImages(img, back, 0);
T('差①-同一张图：0 个像素变化，最大差 0', same.changed === 0 && same.maxDelta === 0 && same.ratio === 0);

const b2 = { width: W, height: H, data: img.data.slice() };
b2.data[(2 * W + 3) * 4 + 1] = (b2.data[(2 * W + 3) * 4 + 1] + 5) & 255;
const one = diffImages(img, b2, 0);
T('差②-改一个像素的一个通道：恰好 1 个像素变化，最大差就是改动量', one.changed === 1 && one.maxDelta === 5);
T('差③-阈值以内的差异不算变化（阈值 5 时这一处不算）', diffImages(img, b2, 5).changed === 0);
T('差④-差异图里变了的那个像素是红的，其余是暗灰', (() => {
  const d = one.diff.data, k = (2 * W + 3) * 4;
  return d[k] > 80 && d[k + 1] === 30 && d[k + 2] === 30 && d[0] === d[1] && d[1] === d[2];
})());
T('差⑤-尺寸不同直接判成全变（不会因为越界读成"一致"）', diffImages(img, { width: W + 1, height: H, data: new Uint8Array((W + 1) * H * 4) }).ratio === 1);

done();
