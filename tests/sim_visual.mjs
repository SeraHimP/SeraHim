// 阵营级出兵编排 + 死亡塔可选中 + 射程圈按需显示 验收。
//
// 挑测什么：这三条都是【逻辑可测】的。塔灯光池与 HDR 输出是纯渲染层，
// headless 下测不出有意义的东西（没有 GPU、没有 HDR 显示器），
// 那两项靠浏览器冒烟 + 实拍截图核对，不在这里凑断言充数。
globalThis.window = { gameTime: 0, waveNumber: 1, _uid: 0, CTX: {} };
import fs from 'fs';
const { CONFIG } = await import('../src/data/Config.js');
const { buildWaveOrder, compositionFor, hasFactionComposition } = await import('../src/data/waveComposition.js');
const { EntityContainer } = await import('../src/core/EntityContainer.js');
const { EventBus } = await import('../src/utils/EventBus.js');
let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };

// ==================== 一、出兵编排可以只对某一方生效 ====================
{
  const gr = CONFIG.gameRules;
  const base = gr.laneWaveComposition;
  CONFIG.factionOverrides = CONFIG.factionOverrides || { blue: {}, red: {} };
  delete CONFIG.factionOverrides.blue.laneWaveComposition;
  delete CONFIG.factionOverrides.red.laneWaveComposition;
  gr.spawnEnabled = { melee: true, ranged: true, siege: true, super: true,
                      totem: true, warlock: true, corrupt: true, ram: true };
  gr.laneWaveComposition = [{ type: 'melee', count: 3 }];

  T('无阵营覆写时两方都用共享基准',
    buildWaveOrder(1, false, gr, 'blue').join() === 'melee,melee,melee'
    && buildWaveOrder(1, false, gr, 'red').join() === 'melee,melee,melee');
  T('不传 faction 时仍是共享基准（向后兼容）',
    buildWaveOrder(1, false, gr).join() === 'melee,melee,melee');
  T('未配覆写时 hasFactionComposition 为 false',
    !hasFactionComposition('blue') && !hasFactionComposition('red'));

  // 只给红方配独立编排
  CONFIG.factionOverrides.red.laneWaveComposition = [{ type: 'ranged', count: 2 }];
  T('红方用自己的编排', buildWaveOrder(1, false, gr, 'red').join() === 'ranged,ranged');
  T('蓝方【不受影响】，仍是共享基准（这条就是需求本身）',
    buildWaveOrder(1, false, gr, 'blue').join() === 'melee,melee,melee');
  T('hasFactionComposition 只对红方为真',
    hasFactionComposition('red') && !hasFactionComposition('blue'));

  // 整体替换而不是逐条合并 —— 编排的顺序就是语义，掺在一起会得到谁都没要过的顺序
  T('阵营编排是整体替换，不与共享基准合并',
    !buildWaveOrder(1, false, gr, 'red').includes('melee'));
  T('compositionFor 是解析顺序的唯一实现',
    compositionFor('red', gr)[0].type === 'ranged' && compositionFor(null, gr)[0].type === 'melee');

  // 兵种总开关仍然凌驾于两者之上（它是"沙盒+对战通用"的总闸）
  gr.spawnEnabled.ranged = false;
  T('兵种总开关对阵营编排同样生效', buildWaveOrder(1, false, gr, 'red').length === 0);
  gr.spawnEnabled.ranged = true;

  // 空数组视为"没配"，回退共享 —— 否则用户把编排删空会得到"这一方完全不出兵"，
  // 而那几乎肯定是误操作而不是本意
  CONFIG.factionOverrides.red.laneWaveComposition = [];
  T('空的阵营编排回退共享基准（删空≈没配，不是"这方不出兵"）',
    buildWaveOrder(1, false, gr, 'red').join() === 'melee,melee,melee');

  // 出兵系统真的按阵营取
  const src = fs.readFileSync('src/systems/LaneWaveSystem.js', 'utf8');
  // 调用现在是多行的（第 5 个参数是条件判定用的世界快照），不能再用 [^)]* 匹配
  T('LaneWaveSystem 把 faction 传进 buildWaveOrder',
    /buildWaveOrder\(this\.waveNumber, nexusDown, CONFIG\.gameRules, faction/.test(src));
  // v43 P1-4：编辑器已拆成 src/ui/editor/* 七块，断言要读整片 ——
  // 只读 AttributeEditor.js 会让否定断言因为「搬到隔壁文件」而假通过。
  const ui = ['.' + '/src/ui/AttributeEditor.js',
    ...fs.readdirSync('.' + '/src/ui/editor').sort()
      .filter(f => f.endsWith('.js')).map(f => '.' + '/src/ui/editor/' + f)]
    .map(f => fs.readFileSync(f, 'utf8')).join('\n');
  // 预览调用现在是多行的（第 5 个参数是条件判定用的世界快照）
  T('编辑器预览也按阵营算（否则预览骗人）', /buildWaveOrder\(w, nd, gr, _pf, \{/.test(ui));
  T('编辑器读写走同一个 _woList 入口', /_woList\(true\)/.test(ui) && /_woList\(false\)/.test(ui));

  delete CONFIG.factionOverrides.red.laneWaveComposition;
  gr.laneWaveComposition = base;
}

// ==================== 二、死亡的塔留成废墟（可被选中）====================
{
  const bus = new EventBus();
  const ents = new EntityContainer(bus);
  const mk = (type, extra = {}) => {
    const e = { id: ++window._uid, type, alive: true, pos: { x: 0, y: 0 },
                baseStats: {}, currentHP: 1, ...extra };
    ents.add(e);
    return e;
  };
  // 沙盒手建塔：没有 _mapTier / _mapFaction —— 正是原来会被清掉的那种
  const sandboxTower = mk('tower');
  const battleTower = mk('tower', { _mapTier: 'outer', _mapFaction: 'blue' });
  const minion = mk('melee', { _mapFaction: 'red' });

  sandboxTower.alive = false; battleTower.alive = false; minion.alive = false;
  ents.purgeDead();

  T('沙盒手建塔死后留成废墟（原来会被直接清掉，根本选不中）',
    !!ents.get(sandboxTower.id) && ents.get(sandboxTower.id)._ruin === true);
  T('对战塔死后同样留成废墟', !!ents.get(battleTower.id) && ents.get(battleTower.id)._ruin === true);
  T('小兵死后照常清除（只有塔留废墟）', !ents.get(minion.id));

  // 废墟要能被 aliveOnly=false 的查询命中 —— 点选就是走这条路
  const hit = ents.findInRadius(0, 0, 50, null, false).map(e => e.id);
  T('废墟能被 findInRadius(aliveOnly=false) 命中（点选依赖这条）',
    hit.includes(sandboxTower.id) && hit.includes(battleTower.id));
  T('废墟不会被 aliveOnly=true 命中（不该被索敌/计入存活）',
    !ents.findInRadius(0, 0, 50, null, true).some(e => e.id === sandboxTower.id));

  // 反复 purge 不应重复处理或复活
  ents.purgeDead(); ents.purgeDead();
  T('重复 purge 幂等', !!ents.get(sandboxTower.id) && !ents.get(minion.id));

  // 点选命中检测确实放行废墟
  const cc = fs.readFileSync('src/ui/CanvasController.js', 'utf8');
  T('点选命中检测放行废墟与待重生实体', /e\.alive \|\| e\._ruin \|\| e\._respawnAt/.test(cc));
}

// ==================== 三、射程圈按需显示 ====================
// 注：射程圈与塔灯的细节断言已经**整体搬到 tests/sim_lightring.mjs**。
// 那一轮把布尔开关改成了按距离渐显（射程+50 起渐显、射程+10 全显），
// 滞回随之取消、rangeMult 换成 rangeExtra，所以这里原来那几条钉的是已经不存在的
// 实现细节。留在这里会变成"两套断言各钉一半"，改一处就得改两边。
// 这里只保留最粗的一条：配置存在且默认按需显示（真正的逐档验证在 sim_lightring）。
{
  const ul = fs.readFileSync('src/presentation/UnitLayer.js', 'utf8');
  T('射程圈配置软编码且默认按需显示',
    CONFIG.ui?.rangeRing?.mode === 'auto'
    && typeof CONFIG.ui.rangeRing.probeInterval === 'number');
  T('探测有节流（不是每帧给几十座塔查网格）', /probeInterval/.test(ul));
  T('探测状态记在渲染层 entry 上，不往实体写字段',
    /en\.ringHot/.test(ul) && !/e\._ringHot/.test(ul));
  T('always 模式保留（可退回旧行为）', /'always'/.test(ul));

  T('塔灯配置软编码', typeof CONFIG.ui?.towerLight?.poolSize === 'number');
  T('HDR 配置软编码且默认走自动探测', CONFIG.ui?.hdr?.auto === true);
  const tr = fs.readFileSync('src/presentation/ThreeRenderer.js', 'utf8');
  T('塔灯是【固定大小的池】（数量变化会导致全材质重编译）',
    /towerLights/.test(tr) && /poolSize/.test(tr));
  T('HDR 只在显示器真是 HDR 时自动开启（SDR 屏不会被搞灰）',
    /dynamic-range: high/.test(tr));
  T('HDR 任何一步不支持都静默降级', /hdrSupported\(\)/.test(tr) && /降级/.test(tr));
}

console.log(`视觉/编排验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
