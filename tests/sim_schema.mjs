// P1 Schema 注册表验收。
//
// 这套测试是 Schema 存在的理由本身：把「编辑器写 A、运行时读 B」这类事故
// 从"靠人发现"变成"红灯拦截"。本项目已经因为它出过三次事故
// （分层塔被动 / 分层塔武器 / 出兵规则），三次都是两边各写各的取值代码。
//
// 四条不变量：
//   ① 往返一致：write(x) 之后 read 必须拿回 x —— 这直接杜绝"写进去读不出来"；
//   ② 覆写层干净：把值改回基准值，覆写层里不许留残渣（否则覆写会越积越多）；
//   ③ 阵营隔离：改蓝方不许影响红方；
//   ④ 越界钳制：超出 min/max 的输入必须被就地钳住，而不是写进配置。
globalThis.window = { gameTime: 0, waveNumber: 0, _uid: 0 };
const { CONFIG } = await import('../src/data/Config.js');
const { SCHEMA, listGroups, readField, writeField, readGroup } =
  await import('../src/data/schema/index.js');
let pass = 0, fail = 0; const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };

const groups = listGroups();
console.log(`注册分组 ${groups.length} 个，字段合计 ${groups.reduce((s, g) => s + g.fields.length, 0)} 个`);

T('注册表非空且每组都有字段', groups.length > 0 && groups.every(g => g.fields.length > 0));
T('每组都声明了运行时消费点（可追溯）', groups.every(g => typeof g.runtime === 'string' && g.runtime));
T('每个数值字段都有 min/max/step', groups.every(g =>
  g.fields.every(f => f.type !== 'number' || (Number.isFinite(f.min) && Number.isFinite(f.max) && f.step > 0))));

// ---- ① 往返一致（对每个分组的每个字段逐一验证）----
let rtBad = [];
for (const g of groups) {
  for (const f of g.fields) {
    const ctx = { faction: 'shared' };
    const before = readField(g.id, f.key, ctx);
    // 取一个落在区间内、且与当前值不同的探测值
    const probe = Math.min(f.max, Math.max(f.min, (Number(before) || 0) + f.step * 3)) ;
    const target = probe === before ? Math.min(f.max, Math.max(f.min, probe + f.step)) : probe;
    writeField(g.id, f.key, target, ctx);
    const after = readField(g.id, f.key, ctx);
    if (Math.abs(after - target) > 1e-9) rtBad.push(`${g.id}.${f.key}: 写入 ${target} 读回 ${after}`);
    writeField(g.id, f.key, before, ctx);   // 还原
  }
}
if (rtBad.length) rtBad.slice(0, 5).forEach(s => console.log('  ' + s));
T(`往返一致：写入什么就能读回什么（${rtBad.length} 处不符）`, rtBad.length === 0);

// ---- ② 覆写层干净：改回基准值后不留残渣 ----
CONFIG.towerTierOverrides.outer = {};
const baseAD = readField('tower.outer', 'attackDamage', { faction: 'shared' });
writeField('tower.outer', 'attackDamage', baseAD + 50, { faction: 'shared' });
T('改动后覆写层记录该字段', 'attackDamage' in CONFIG.towerTierOverrides.outer);
writeField('tower.outer', 'attackDamage', baseAD, { faction: 'shared' });
T('改回基准值后覆写层自动清除（不留残渣）', !('attackDamage' in CONFIG.towerTierOverrides.outer));

// ---- ③ 阵营隔离 ----
CONFIG.factionOverrides.blue = {}; CONFIG.factionOverrides.red = {};
const shared0 = readField('tower.inner', 'maxHP', { faction: 'shared' });
writeField('tower.inner', 'maxHP', shared0 + 500, { faction: 'blue' });
const blueV = readField('tower.inner', 'maxHP', { faction: 'blue' });
const redV = readField('tower.inner', 'maxHP', { faction: 'red' });
T(`阵营隔离：蓝方 ${blueV} 已改，红方 ${redV} 不受影响`,
  blueV === shared0 + 500 && redV === shared0);
CONFIG.factionOverrides.blue = {}; CONFIG.factionOverrides.red = {};

// ---- ④ 越界钳制 ----
const f = SCHEMA['minion.melee'].fields.find(x => x.key === 'maxHP');
writeField('minion.melee', 'maxHP', f.max + 99999, { faction: 'shared' });
const clampedHi = readField('minion.melee', 'maxHP', { faction: 'shared' });
writeField('minion.melee', 'maxHP', f.min - 99999, { faction: 'shared' });
const clampedLo = readField('minion.melee', 'maxHP', { faction: 'shared' });
T(`越界钳制：上限 ${clampedHi} ≤ ${f.max}，下限 ${clampedLo} ≥ ${f.min}`,
  clampedHi <= f.max && clampedLo >= f.min);
T('非法输入（NaN）被拒绝', writeField('minion.melee', 'maxHP', 'abc', { faction: 'shared' }) === false);
writeField('minion.melee', 'maxHP', 500, { faction: 'shared' });   // 还原模板默认

// ---- ⑤ Schema 与运行时同源：塔的解析顺序必须和 createBuilding 一致 ----
import fs from 'fs';
// v43 P1-4: 4 个实体工厂搬去了 src/core/factories.js。下面这些断言钉的是
// 【组合根】的装配逻辑，不是「main.js 这个文件」，所以读的是两份源码的拼接。
// 只读 main.js 的话，`!src.includes(X)` 这类否定断言会因为「搬走了」而假通过 ——
// 本仓库栽过太多次的空断言，正是这个形状。
const mainSrc = ['../src/main.js','../src/core/factories.js']
  .map(f => fs.readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
T('createBuilding 的叠加顺序仍是 地图 → towerTierOverrides → factionOverrides',
  /towerTierOverrides\?\.\[tier\][\s\S]{0,120}factionOverrides\?\.\[faction\]\?\.\['tower_' \+ tier\]/.test(mainSrc));
T('成长表读取点仍是 CONFIG.battleGrowth（Schema 的 growth.* 与之同源）',
  mainSrc.includes('CONFIG.battleGrowth'));

// ---- ⑥ readGroup 一次性读取 ----
const grp = readGroup('tower.outer', { faction: 'shared' });
T('readGroup 返回该组全部字段', grp && Object.keys(grp).length === SCHEMA['tower.outer'].fields.length);

console.log(`Schema 验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
