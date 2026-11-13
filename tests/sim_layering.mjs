// 分层：逻辑层不依赖渲染层；渲染层不写实体；两条独立规则不共用一个标记。
import fs from 'fs';
import path from 'path';
import { setupWindow, scoreboard } from './_harness.mjs';
setupWindow();

const { T, done } = scoreboard('逻辑/渲染分层');

{
  // ① systems / core / data / simulation.js 一律不 import presentation 或 ui。
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []);
  const root = new URL('../src/', import.meta.url).pathname;
  const files = [...walk(root + 'systems'), ...walk(root + 'core'), ...walk(root + 'data'), root + 'simulation.js'];
  const bad = files.filter((f) => /from ['"][./]*(presentation|ui)\//.test(fs.readFileSync(f, 'utf8')));
  T('①逻辑层没有 import presentation/ui' + (bad.length ? '：' + bad.map((f) => path.relative(root, f)).join(', ') : ''), bad.length === 0);
}

{
  // ② 损毁档由仿真记录：不渲染也会推进，且渲染层读取时不写实体。
  const { createSimulation } = await import('../src/simulation.js');
  const { displayTowerDamageStage } = await import('../src/core/reviveState.js');
  const sim = createSimulation();
  sim.mapSystem.loadMap('summoners_rift_v1');
  const t = sim.entityContainer.getAllTowers(true).find((e) => e._mapTier === 'outer');
  const max = t.baseStats.maxHP;
  t.currentHP = max * 0.2;
  sim.step();
  T('②headless 步进后损毁档记到了重度（以前只有画出来的帧才会推进）', t._dmgStage === 2);
  t.currentHP = max;
  sim.step();
  T('③回满血不退档（不可逆）', t._dmgStage === 2);

  const u = { currentHP: 10, baseStats: { maxHP: 100 } };
  const shown = displayTowerDamageStage(u, 0.1);
  T('④渲染层读取：按当前血量显示，但不往实体上写', shown === 2 && u._dmgStage === undefined);
  const src = fs.readFileSync(new URL('../src/presentation/UnitMeshFactory.js', import.meta.url), 'utf8');
  T('⑤UnitMeshFactory 不再写 _dmgStage', !/\._dmgStage\s*=/.test(src));
}

{
  // ⑥⑦ 不可回血与不可索敌是两个标记。
  const { applyHeal } = await import('../src/core/healing.js');
  const a = { alive: true, currentHP: 50, _untargetable: true };
  T('⑥只标了不可索敌的单位仍然能回血', applyHeal(a, 10, 1, 100) > 0 && a.currentHP === 60);
  const b = { alive: true, currentHP: 50, _noHeal: true };
  T('⑦标了 _noHeal 的单位不回血', applyHeal(b, 10, 1, 100) === 0 && b.currentHP === 50);

  const { createSimulation } = await import('../src/simulation.js');
  const sim = createSimulation();
  sim.mapSystem.loadMap('dominion_crystal_scar_v1', 'dominion');
  const nex = sim.entityContainer.getAllTowers(true).filter((e) => e._mapTier === 'nexus_main');
  T('⑧水晶之痕的两座水晶枢纽同时带两个标记', nex.length === 2 && nex.every((e) => e._untargetable && e._noHeal));
}

done();
