// 仿真唯一装配点：游戏与平衡工具跑的是同一套系统、同一个步进顺序。
// 以前平衡工具各自手抄更新顺序并且抄漏了（没有法力/天气/巨龙/哀兵/地面痕迹，
// balance_matrix 对统治战场图甚至没有 DominionSystem），平衡结论量的是另一个游戏。
import fs from 'fs';
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();

const { createSimulation, SIM_DT } = await import('../src/simulation.js');
const { T, done } = scoreboard('仿真唯一装配点');

const SYSTEMS = ['effectRegistry', 'buffSystem', 'dragonSystem', 'combatSystem', 'manaSystem',
  'weatherSystem', 'worldState', 'mapSystem', 'laneWaveSystem', 'dominionSystem',
  'laneMovementSystem', 'collisionSystem', 'facingSystem', 'laneAvengerSystem',
  'groundTraceSystem', 'projectileSystem'];

{
  const sim = createSimulation();
  T('①每个系统都在（含以前工具里漏掉的法力/天气/巨龙/哀兵/地面痕迹/统治战场）',
    SYSTEMS.every((k) => sim[k] && typeof sim[k].update === 'function'));
  const calls = [];
  for (const k of SYSTEMS) {
    const orig = sim[k].update.bind(sim[k]);
    sim[k].update = (...a) => { calls.push(k); return orig(...a); };
  }
  sim.mapSystem.loadMap('summoners_rift_v1');
  const t0 = window.gameTime;
  sim.step(SIM_DT);
  T('②一步里每个系统恰好更新一次', SYSTEMS.every((k) => calls.filter((c) => c === k).length === 1));
  T('③顺序：移动/碰撞在朝向之前，弹道最后', calls.indexOf('laneMovementSystem') < calls.indexOf('facingSystem')
    && calls.indexOf('collisionSystem') < calls.indexOf('facingSystem') && calls[calls.length - 1] === 'projectileSystem');
  T('④step 推进游戏时钟', Math.abs(window.gameTime - t0 - SIM_DT) < 1e-9);

  for (let i = 0; i < 30 * 40; i++) sim.step(SIM_DT);
  T('⑤跑 40 秒后第一波兵已经出来（出兵回调与游戏同一套接线）', sim.entityContainer.getAllMinions(true).length > 0);
}

{
  const sim = createSimulation();
  sim.mapSystem.loadMap('dominion_crystal_scar_v1', 'dominion');
  T('⑥换到统治战场图时据点系统随 map:loaded 自动初始化', sim.dominionSystem.active === true);
}

{
  // 守门：游戏入口和平衡工具都不许再手抄系统更新。
  const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
  const users = ['src/main.js', 'tools/balance_matrix.mjs', 'tools/balance_dominion.mjs', 'tools/balance_tower.mjs'];
  const bad = users.filter((f) => {
    const src = read(f);
    return !/createSimulation\(/.test(src) || /\b(combat|combatSystem|move|coll|facing|proj|buffs|waves|mapSys)\.update\(/.test(src);
  });
  T('⑦main.js 与三个平衡工具都用 createSimulation，没有手写的系统 update 调用' + (bad.length ? '：' + bad.join(', ') : ''), bad.length === 0);
}

done();
