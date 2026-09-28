// 导入存档的安全边界：存档是可以互传的文件，不能借它污染原型链或往界面里塞脚本。
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();

const { CONFIG } = await import('../src/data/Config.js');
const { importTemplates, exportTemplates, deepMerge } = await import('../src/data/templateIO.js');
const { T, done } = scoreboard('导入存档安全');

{
  // JSON.parse 会把 "__proto__" 解析成自有键，这正是真实攻击文件的样子。
  const evil = JSON.parse('{"_seraHimTemplates":1,"world":{"__proto__":{"pwnA":1},"constructor":{"prototype":{"pwnB":1}}},'
    + '"customMinions":{"x":{"__proto__":{"pwnC":1}}}}');
  const r = importTemplates(CONFIG, evil);
  T('①导入本身照常成功（不是靠报错挡住）', r.ok === true);
  T('②__proto__ 不会污染 Object.prototype', ({}).pwnA === undefined && ({}).pwnC === undefined);
  T('③constructor.prototype 也不会', ({}).pwnB === undefined);
  const d = {}; deepMerge(d, JSON.parse('{"__proto__":{"pwnD":1}}'));
  T('④deepMerge 单独调用同样安全', ({}).pwnD === undefined);
}

{
  const r = importTemplates(CONFIG, { _seraHimTemplates: 1, customMinions: {
    evil_unit: { name: '<img src=x onerror=alert(1)>坏兵', tags: ['<b>a</b>'], '<k>': 1 } } });
  const u = CONFIG.customMinions.evil_unit;
  T('⑤自制内容字符串里的尖括号被去掉', r.ok && !/[<>]/.test(u.name) && u.name.endsWith('坏兵'));
  T('⑥数组里的字符串也处理了', !/[<>]/.test(u.tags[0]));
  T('⑦键名里的尖括号也处理了', !Object.keys(u).some((k) => /[<>]/.test(k)));
  delete CONFIG.customMinions.evil_unit;
}

{
  // 守门：内置配置导出再导入必须逐位不变——去尖括号只允许打到恶意内容上。
  const a = JSON.stringify(exportTemplates(CONFIG), (k, v) => (k === '_exportedAt' ? undefined : v));
  importTemplates(CONFIG, JSON.parse(a));
  const b = JSON.stringify(exportTemplates(CONFIG), (k, v) => (k === '_exportedAt' ? undefined : v));
  T('⑧内置配置往返逐位不变（内置字符串里没有尖括号）', a === b && !/[<>]/.test(a));
}

done();
