// 一键回归：跑全部仿真验收，任一失败即退出非零。
//
// 用法：
//   node tests/run_all.mjs                    全量（约 5~8 分钟）
//   node tests/run_all.mjs --only v43         只跑名字含 "v43" 的套件
//   node tests/run_all.mjs --only v43,dragon  多个关键字，逗号分隔
//   node tests/run_all.mjs --jobs 4           并行跑（默认 1，顺序跑）
//   node tests/run_all.mjs --list             只列出套件名，不执行
//
// ⚠️ `--only` 只用于**开发中反复迭代**。交付前必须跑一次不带参数的全量 ——
// CLAUDE.md 的硬约束是"0 失败"，而只跑一部分永远证明不了那件事。
import { spawnSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const suites = [
  'sim_boot.mjs', 'sim_runtime.mjs', 'sim_accept.mjs', 'sim_batch3.mjs', 'sim_batch4.mjs',
  'sim_passthrough.mjs', 'sim_full.mjs', 'sim_abyss.mjs', 'sim_avoid.mjs', 'sim_formation.mjs',
  'sim_wall.mjs', 'sim_terrain.mjs', 'sim_ruin.mjs', 'sim_ops.mjs', 'sim_schema.mjs',
  'sim_world.mjs', 'sim_entropy.mjs', 'sim_dragonsoul.mjs', 'sim_skilldesc.mjs',
  'sim_skillparams.mjs', 'sim_custom.mjs', 'sim_support.mjs', 'sim_visual.mjs',
  'sim_tpleditor.mjs', 'sim_lightring.mjs', 'sim_lanequeue.mjs', 'sim_uiq57.mjs',
  'sim_maps.mjs', 'sim_mapvalidate.mjs', 'sim_pathcorner.mjs', 'sim_balance_q2.mjs', 'sim_matrix.mjs',
  'sim_tplio.mjs', 'sim_crystal.mjs', 'sim_weather.mjs',
  'sim_v24.mjs', 'sim_v33.mjs', 'sim_v34.mjs', 'sim_v35.mjs', 'sim_v36.mjs', 'sim_v37.mjs',
  'sim_v39.mjs', 'sim_v40.mjs', 'sim_v41.mjs', 'sim_v42.mjs', 'sim_v43.mjs',
  'sim_deadcode.mjs', 'sim_v44.mjs', 'sim_v45.mjs', 'sim_v46.mjs', 'sim_classic.mjs',
  'sim_v47.mjs', 'sim_v49.mjs', 'sim_v50.mjs', 'sim_v51.mjs',
  'sim_balance_soul_runner.mjs', 'sim_postfx.mjs', 'sim_daynight.mjs', 'sim_mapskirt.mjs',
  'sim_instancing.mjs', 'sim_navgrid.mjs', 'sim_mapeditor.mjs', 'sim_mapeditorlive.mjs', 'sim_waveaction.mjs',
  'sim_multifaction.mjs', 'sim_mapcomposition.mjs',
];

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const ONLY = argOf('only', '');
const JOBS = Math.max(1, parseInt(argOf('jobs', '1'), 10) || 1);
const LIST = args.includes('--list');

const picked = ONLY
  ? suites.filter(s => ONLY.split(',').some(k => s.includes(k.trim())))
  : suites;

if (LIST) { console.log(picked.join('\n')); process.exit(0); }
if (!picked.length) {
  console.log(`❌ --only "${ONLY}" 没有匹配到任何套件。可用：\n  ` + suites.join('\n  '));
  process.exit(1);
}
if (ONLY) console.log(`（--only "${ONLY}" → ${picked.length}/${suites.length} 套；交付前请跑一次全量）`);

let failed = 0;

if (JOBS === 1) {
  // 顺序跑：输出直接继承 stdio，与改动前完全一致（日志好读，便于定位）
  for (const s of picked) {
    console.log(`\n===== ${s} =====`);
    const r = spawnSync('node', [path.join(dir, s)], { stdio: 'inherit' });
    if (r.status !== 0) failed++;
  }
} else {
  // 并行跑：各自缓冲输出，跑完按**原顺序**一次性打印。
  // 不缓冲的话多个套件的行会交错，"哪条断言是哪套的"就看不出来了。
  const results = new Array(picked.length);
  let next = 0, running = 0;
  await new Promise((resolve) => {
    const kick = () => {
      while (running < JOBS && next < picked.length) {
        const i = next++, s = picked[i];
        running++;
        const p = spawn('node', [path.join(dir, s)]);
        let out = '';
        p.stdout.on('data', d => { out += d; });
        p.stderr.on('data', d => { out += d; });
        p.on('close', (code) => {
          results[i] = { s, out, code };
          if (code !== 0) failed++;
          running--;
          if (next >= picked.length && running === 0) resolve();
          else kick();
        });
      }
    };
    kick();
  });
  for (const r of results) {
    console.log(`\n===== ${r.s} =====`);
    process.stdout.write(r.out);
  }
}

console.log(failed ? `\n❌ ${failed} 套失败` : '\n✅ 全部通过');
process.exit(failed ? 1 : 0);
