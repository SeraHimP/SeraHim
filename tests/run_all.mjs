// 一键回归：顺序跑全部仿真验收，任一失败即退出非零。
// 用法：项目根目录 `npm test` 或 `node tests/run_all.mjs`
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
const dir = path.dirname(fileURLToPath(import.meta.url));
const suites = ['sim_boot.mjs', 'sim_runtime.mjs', 'sim_accept.mjs', 'sim_batch3.mjs', 'sim_batch4.mjs', 'sim_passthrough.mjs', 'sim_full.mjs', 'sim_abyss.mjs', 'sim_avoid.mjs', 'sim_formation.mjs', 'sim_wall.mjs', 'sim_terrain.mjs', 'sim_ruin.mjs', 'sim_ops.mjs', 'sim_schema.mjs', 'sim_world.mjs', 'sim_entropy.mjs', 'sim_skilldesc.mjs', 'sim_balance_q2.mjs', 'sim_matrix.mjs', 'sim_tplio.mjs', 'sim_crystal.mjs', 'sim_weather.mjs', 'sim_v24.mjs', 'sim_v33.mjs', 'sim_v34.mjs', 'sim_v35.mjs', 'sim_v36.mjs', 'sim_v37.mjs', 'sim_v39.mjs', 'sim_v40.mjs'];
let failed = 0;
for (const s of suites) {
  console.log(`\n===== ${s} =====`);
  const r = spawnSync('node', [path.join(dir, s)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n❌ ${failed} 套失败` : '\n✅ 全部通过');
process.exit(failed ? 1 : 0);
