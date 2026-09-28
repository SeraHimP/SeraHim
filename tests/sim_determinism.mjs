// 逻辑层随机数可复现：同一个种子 → 同一场战斗逐位相同的结果。
// 以前暴击/闪避/出兵抖动直接调 Math.random，测试从不播种，全栈用例会"偶发变红"。
import { setupWindow, scoreboard, makeWorld, mkEntity } from './_harness.mjs';
setupWindow();

const { seedRandom, random } = await import('../src/core/rng.js');
const { T, done } = scoreboard('逻辑随机数可复现');

// 一场两个近战互砍的小战斗：暴击率、闪避率都是 50%，结果对随机序列极其敏感。
async function fight(seed) {
  seedRandom(seed);
  window._uid = 0; window.gameTime = 0;
  const { ents, combat, CONFIG } = await makeWorld();
  const a = mkEntity(ents, 'melee', { faction: 'blue', pos: { x: 100, y: 100 }, stats: { critChance: 50, evasionPct: 50, maxHP: 5000 } }, CONFIG);
  const b = mkEntity(ents, 'melee', { faction: 'red', pos: { x: 120, y: 100 }, stats: { critChance: 50, evasionPct: 50, maxHP: 5000 } }, CONFIG);
  a.targetId = b.id; b.targetId = a.id;
  for (let i = 0; i < 40; i++) {
    window.gameTime += 1;
    combat.performAttack(a, b);
    combat.performAttack(b, a);
    combat.update(1 / 30);   // 结算在途弹道/效果
    if (!a.alive || !b.alive) break;
  }
  return [a.currentHP, b.currentHP];
}

{
  seedRandom(7); const s1 = [random(), random(), random()];
  seedRandom(7); const s2 = [random(), random(), random()];
  T('①同一个种子 → 同一串随机数', s1.every((v, i) => v === s2[i]));
  T('②随机数落在 [0,1)', s1.every((v) => v >= 0 && v < 1));
}
{
  const r1 = await fight(42);
  const r2 = await fight(42);
  T('③同一个种子打两遍，双方剩余血量逐位相同', r1[0] === r2[0] && r1[1] === r2[1]);
  T('④战斗确实发生了（不是两边都没掉血的空测试）', r1[0] < 5000 && r1[1] < 5000);
  const outs = [];
  for (const s of [1, 2, 3, 4, 5]) outs.push((await fight(s)).join(','));
  T('⑤换种子会换结果（暴击/闪避真的走这个随机源）', new Set(outs).size > 1);
}

{
  // 守门：逻辑层不许再直接调 Math.random（渲染层的纯装饰随机不受限）。
  const fs = await import('fs'), path = await import('path');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []);
  const root = new URL('../src/', import.meta.url).pathname;
  const offenders = [...walk(root + 'systems'), ...walk(root + 'core')].filter((f) =>
    fs.readFileSync(f, 'utf8').split('\n').some((l) => !/^\s*(\/\/|\*)/.test(l) && /Math\.random\(/.test(l)));
  T('⑥src/systems 与 src/core 里没有直接调用 Math.random' + (offenders.length ? '：' + offenders.join(', ') : ''), offenders.length === 0);
}

done();
