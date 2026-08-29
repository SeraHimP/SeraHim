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

  // 兵种总开关仍然凌驾于两者之上
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
  // v45：第三个参数从 `CONFIG.gameRules` 换成了 `rules` —— 地图可以覆写 spawnEnabled
  //（经典模式只出 近战/远程/炮兵/超级兵）。没有覆写时 rules 就是 CONFIG.gameRules 本身。
  // 这条断言要守的是**faction 有没有传下去**（编排是按阵营解析的），
  // 不是"第三个参数长什么样"，所以只钉 faction 那一位。
  T('LaneWaveSystem 把 faction 传进 buildWaveOrder',
    /buildWaveOrder\(this\.waveNumber, nexusDown, \w+, faction/.test(src));
  T('地图可以覆写 spawnEnabled（没覆写时逐位退回 CONFIG.gameRules）',
    /currentMap\?\.spawnEnabled/.test(src) && /: CONFIG\.gameRules;/.test(src));
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
  // 无 _mapTier / _mapFaction 的塔（正常游戏里不会出现，防御性场景）：正是原来会被清掉的那种
  const bareTower = mk('tower');
  const battleTower = mk('tower', { _mapTier: 'outer', _mapFaction: 'blue' });
  const minion = mk('melee', { _mapFaction: 'red' });

  bareTower.alive = false; battleTower.alive = false; minion.alive = false;
  ents.purgeDead();

  T('无字段的塔死后留成废墟（原来会被直接清掉，根本选不中）',
    !!ents.get(bareTower.id) && ents.get(bareTower.id)._ruin === true);
  T('对战塔死后同样留成废墟', !!ents.get(battleTower.id) && ents.get(battleTower.id)._ruin === true);
  T('小兵死后照常清除（只有塔留废墟）', !ents.get(minion.id));

  // 废墟要能被 aliveOnly=false 的查询命中 —— 点选就是走这条路
  const hit = ents.findInRadius(0, 0, 50, null, false).map(e => e.id);
  T('废墟能被 findInRadius(aliveOnly=false) 命中（点选依赖这条）',
    hit.includes(bareTower.id) && hit.includes(battleTower.id));
  T('废墟不会被 aliveOnly=true 命中（不该被索敌/计入存活）',
    !ents.findInRadius(0, 0, 50, null, true).some(e => e.id === bareTower.id));

  // 反复 purge 不应重复处理或复活
  ents.purgeDead(); ents.purgeDead();
  T('重复 purge 幂等', !!ents.get(bareTower.id) && !ents.get(minion.id));

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

// ==================== 四、v51.6：拖拽平移与方位角的旋转方向必须一致 ====================
// 用户："右下角工具栏在我改变方位后，视角的拖拽乱了，就是不是按照当前的视角进行
//        拖拽计算的，还是按照原先的视角。"
// 根因：CanvasController 的拖拽平移公式与 ThreeRenderer.syncCameraFrom 的相机站位
// 公式各自实现了一份"方位角怎么转"，两处的旋转方向没对上——旧公式在方位角非 0 时
// 会把拖拽方向转反。这里不重新实例化真实的 CanvasController/ThreeRenderer（需要
// DOM/WebGL），改成用同样的公式在纯数学层面验证两者自洽：屏幕拖拽应当让"鼠标当前
// 指着的那个世界点"始终跟着鼠标走，在四个整角（0°/90°/180°/270°）上手工可核验。
{
  const W = 800, H = 600, zoom = 1;
  // 复刻 syncCameraFrom 的相机站位几何：camera 相对 target 的水平站位 ∝ (sin(az), cos(az))，
  // 由此推出屏幕右方向＝(cos(az), -sin(az))、屏幕下方向＝(sin(az), cos(az))（世界 x,z）。
  const screenRight = (azDeg) => { const a = azDeg * Math.PI / 180; return [Math.cos(a), -Math.sin(a)]; };
  const screenDown = (azDeg) => { const a = azDeg * Math.PI / 180; return [Math.sin(a), Math.cos(a)]; };
  // 复刻本次修好之后的拖拽公式（CanvasController pointermove 那两行）。
  const panOffset = (azDeg, mdx, mdy) => {
    const a = azDeg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    return { dOffsetX: mdx * ca + mdy * sa, dOffsetY: mdy * ca - mdx * sa };
  };
  // offsetX/offsetY → 世界 target(tx,tz) 是线性反比：tx=(W/2-offsetX)/zoom，
  // 所以 offset 的变化量换算成 target 的变化量要取负、除以 zoom。
  const targetDelta = (dOffsetX, dOffsetY) => [-dOffsetX / zoom, -dOffsetY / zoom];

  for (const az of [0, 90, 180, 270]) {
    const { dOffsetX, dOffsetY } = panOffset(az, 100, 0); // 只沿屏幕横向拖 100px
    const [dtx, dtz] = targetDelta(dOffsetX, dOffsetY);
    const [rx, rz] = screenRight(az);
    // 目标应当精确沿着"屏幕右方向的反方向"移动（抓地拖拽：鼠标右移，画面内容跟着
    // 鼠标右移 = 目标点往屏幕右方向的反方向挪），且横向拖拽不应带出屏幕下方向的分量。
    const [dx2, dz2] = screenDown(az);
    const alongRight = dtx * rx + dtz * rz;   // 投影到屏幕右方向：应为 -100（負号=反向）
    const alongDown = dtx * dx2 + dtz * dz2;  // 投影到屏幕下方向：应为 0（纯横向拖拽不应有此分量）
    T(`拖①-方位${az}°时，横向拖拽的目标位移精确落在"屏幕右方向"的反方向上（不掺屏幕下方向分量）`,
      Math.abs(alongRight - (-100)) < 1e-9 && Math.abs(alongDown) < 1e-9);
  }
  T('拖②-方位0°时（未偏航）退化为原始逐像素拖拽，不受本次修复影响',
    JSON.stringify(panOffset(0, 37, -19)) === JSON.stringify({ dOffsetX: 37, dOffsetY: -19 }));
}

// ==================== 五、v51.6：俯仰角范围 0-90、重置视角自适应窗口、左上角巨龙HUD ====================
{
  const tr = fs.readFileSync('src/presentation/ThreeRenderer.js', 'utf8');
  T('俯①-俯仰角下限从1改成0（用户定稿"俯仰角调节改为0-90"）',
    /this\.elevationDeg = Math\.max\(0, Math\.min\(90, Number\(deg\) \|\| 0\)\)/.test(tr));

  const cc = fs.readFileSync('src/ui/CanvasController.js', 'utf8');
  T('重①-重置视角前先 resize() 拿当前真实画布尺寸（不是用可能过时的旧尺寸）',
    /this\.renderer\?\.resize\?\.\(\);\s*\n\s*const w = this\.renderer\?\.width/.test(cc));
  T('缩①-缩放行新增滑杆并双向同步（拖滑杆改zoom、zoom变了滑杆跟着动）',
    /zoomSl\.addEventListener\('input'/.test(cc) && /zoomSl\.value = String\(this\.zoom\)/.test(cc));
  T('缩②-#zoomLabel（百分比读数）已删除，不再往这个不存在的元素写字', !/getElementById\('zoomLabel'\)/.test(cc));

  const html = fs.readFileSync('index.html', 'utf8');
  T('缩③-三行控件统一形状：缩放/俯仰/方位都有 −/+ 步进按钮',
    /id="zoomOutBtn"/.test(html) && /id="zoomInBtn"/.test(html)
    && /id="elevDownBtn"/.test(html) && /id="elevUpBtn"/.test(html)
    && /id="azimDownBtn"/.test(html) && /id="azimUpBtn"/.test(html));
  T('缩④-俯仰角滑杆的 min 属性同步改成 0', /id="elevSlider"[^>]*min="0"/.test(html));
  T('缩⑤-缩放行的读数位换成重置视角按钮（同一个 ctl-row 里）',
    /<input id="zoomSlider"[^>]*>\s*\n\s*<button class="icon-btn" id="zoomInBtn"[^>]*>\+<\/button>\s*\n\s*<button class="icon-btn" id="resetViewBtn"/.test(html));

  T('龙①-左上角新增巨龙信息格（次要于原有推塔数格，默认隐藏）',
    /id="dragonStatBoard"[^>]*style="display:none;"/.test(html)
    && /id="dragonNextTimer"/.test(html) && /id="dragonPowerBlue"/.test(html) && /id="dragonPowerRed"/.test(html));

  const um = fs.readFileSync('src/ui/UIManager.js', 'utf8');
  T('龙②-按地图是否有龙（mapAllowsDragon）切换两块面板的显隐，不是常驻显示',
    /const hasDragonMap = !!\(ds && ds\.mapAllowsDragon\(\)\)/.test(um));
  T('龙③-已成魂的一方改显示龙魂本身（图标+名字），未成魂显示巨龙之力层数',
    /soulIds\.map\(id => `\$\{SkillLibrary\[id\]\?\.icon/.test(um)
    && /Object\.values\(ds\.factionKills\?\.\[fac\] \|\| \{\}\)\.reduce/.test(um));
}

console.log(`视觉/编排验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
