// Q5 统一页脚 + Q7 建塔模型选择 验收。
globalThis.window = { gameTime: 0, waveNumber: 1, _uid: 0, CTX: {} };
import fs from 'fs';
const TM = await import('../src/data/towerModels.js');
let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : (fail++, console.log('✗', n)); };
const rd = (p) => fs.readFileSync(p, 'utf8');

// ==================== Q7：建塔可选模型 ====================
{
  T('模型清单是唯一来源，且放在 data/（不带 three 依赖）',
    Array.isArray(TM.TOWER_MODEL_ROLES) && TM.TOWER_MODEL_ROLES.length === 3
    && !/from '.*three/.test(rd('src/data/towerModels.js')));
  T('三种建筑外观都在', TM.TOWER_MODEL_ROLES.map(r => r.key).join() === 'tower,lane_crystal,nexus');
  T('防御塔没有对应档位（外/内/水晶/枢纽塔共用一个模型）', TM.towerModelTier('tower') === null);
  T('两类水晶各有档位', TM.towerModelTier('lane_crystal') === 'nexus_lane'
    && TM.towerModelTier('nexus') === 'nexus_main');
  T('脏值被挡住', !TM.isTowerModelRole('../evil') && !TM.isTowerModelRole(undefined)
    && TM.isTowerModelRole('nexus'));
  T('程序化回退的形状也来自同一张表',
    TM.towerModelKind('lane_crystal') === 'orb' && TM.towerModelKind('nexus') === 'gem');

  // v44：GLB 模型库（ModelLibrary.js + assets/models/*.glb）整条删除，
  // 全部造型改为程序化生成（用户定稿"全部程序化，删 GLB"）。
  // 原来这三条断言钉的是 ModelLibrary 的接口，对象没了就该改成钉**接替它的那条路**。
  const ul = rd('src/presentation/UnitLayer.js');
  T('GLB 那条路已删干净（不再有 ModelLibrary / isModel 分支）',
    !/ModelLibrary/.test(ul) && !/vis\.isModel/.test(ul));
  T('渲染层把实体上的 _modelRole 传下去（外观选择仍然生效，只是落到程序化几何上）',
    /towerModelKind\(e\._modelRole\)/.test(ul) && /towerModelTier\(e\._modelRole\)/.test(ul));
  T('tier 与 faction 进了几何缓存 key（不进的话四个档次会共用第一个被缓存的几何）',
    /\$\{vTier\}\|\$\{vFac\}/.test(ul));
  // GLB 没加载完 / headless 时走程序化回退。不认 _modelRole 的话，
  // "我选了召唤水晶外观"在加载完成前完全没反应，用户会以为设置没生效。
  T('程序化回退也认 _modelRole', /const roleKind = towerModelKind\(e\._modelRole\)/.test(ul));
  T('回退的 kind 优先用角色，其次才按 tier 推', /const kind = roleKind \|\| \(isLaneCrystal/.test(ul));

  const ua = rd('src/ui/UnitAddDialog.js');
  T('建塔面板有模型选择器', /_renderTowerModelSelector\(\)/.test(ua) && /data-uadmodel/.test(ua));
  T('选项由清单生成（UI 里没有第二份）', /TOWER_MODEL_ROLES\.map\(btn\)/.test(ua));
  T('默认只换外观（说明文字写明了）', /只换外观/.test(ua));
  T('有"套用该档位数值"勾选框', /uadModelStats/.test(ua));
  T('防御塔外观时勾选框禁用（它没有对应档位）', /meta\.tier \? '' : 'disabled'/.test(ua));
  T('切回防御塔时把勾选清掉（不留一个勾住却不可选的框）',
    /if \(!towerModelTier\(this\._state\.towerModel\)\) this\._state\.towerModelStats = false;/.test(ua));

  const mj = rd('src/main.js');
  T('建塔流程带上模型参数', /model: opts\?\.model \|\| 'tower', modelStats: !!opts\?\.modelStats/.test(mj));
  T('只换外观时只写 _modelRole（玩法不受影响）', /tower\._modelRole = model;/.test(mj));
  T('套用档位数值走与 createBuilding 同一条解析链（不添第五份抄写）',
    /map\?\.tierStats && map\.tierStats\[meta\.tier\]/.test(mj)
    && /towerTierOverrides\?\.\[meta\.tier\]/.test(mj)
    && /\['tower_' \+ meta\.tier\]/.test(mj));
  T('套用数值时层级也一并设上（否则统计里仍算沙盒塔，面板与实际不符）',
    /tower\._mapTier = meta\.tier;/.test(mj));
}

// ==================== Q5：统一页脚 ====================
{
  const df = rd('src/ui/dialogFooter.js');
  T('页脚三按钮：应用/确定/取消',
    /dlgApplyBtn/.test(df) && /dlgOkBtn/.test(df) && /dlgCancelBtn/.test(df));
  T('应用后窗口不关', /提交改动，窗口保持打开/.test(df));
  T('取消靠快照回滚（否则那个按钮就是个谎）', /restore\(base\)/.test(df));
  T('应用后基线前移（否则"应用→改坏→取消"会吞掉已确认的那批）',
    /base = o\.snapshot\(\);/.test(df) && /基线前移/.test(df));
  T('有按路径自动快照的工具（省得每个窗口手写取值/赋值）', /makeSnapshotter/.test(df));
  T('文件顶部写明了哪些窗口刻意不套三按钮及判据',
    /有没有"改了但还没生效"的中间态/.test(df));

  // 快照/回滚的真实行为
  const { makeSnapshotter } = await import('../src/ui/dialogFooter.js');
  const roots = { CONFIG: { a: { b: 1, deep: { x: 1 } } }, window: { flag: true } };
  const s = makeSnapshotter(roots, ['CONFIG.a.b', 'CONFIG.a.deep', 'window.flag']);
  const snap = s.snapshot();
  roots.CONFIG.a.b = 99; roots.CONFIG.a.deep.x = 99; roots.window.flag = false;
  s.restore(snap);
  T('回滚还原标量', roots.CONFIG.a.b === 1 && roots.window.flag === true);
  T('回滚还原嵌套对象（深拷，不是共享引用）', roots.CONFIG.a.deep.x === 1);
  const snap2 = s.snapshot();
  roots.CONFIG.a.deep.x = 7;
  T('快照是拍下来的那一刻，不随后续修改漂移', snap2['CONFIG.a.deep'].x === 1);
  T('缺失路径不炸', (() => {
    const s2 = makeSnapshotter({ CONFIG: {} }, ['CONFIG.nope.deep.x']);
    try { s2.restore(s2.snapshot()); return true; } catch { return false; }
  })());

  const sd = rd('src/ui/SettingsDialog.js');
  T('设置窗套上了统一页脚', /mountDialogFooter\('modalActions'/.test(sd));
  T('设置窗的快照覆盖 world/ui/gameRules 与 window.__* 开关',
    /CONFIG\.world\.couplings/.test(sd) && /CONFIG\.ui\.towerLight\.enabled/.test(sd)
    && /window\.__towerRules/.test(sd) && /window\.__gameSpeed/.test(sd));
  T('回滚后把渲染器侧开关重新推一次（配置对了画面不对是最难查的）',
    /applyRendererFlags\(\)/.test(sd)
    && /restore: \(b\) => \{ snap\.restore\(b\); applyRendererFlags\(\); \}/.test(sd));
  T('回滚后重绘界面（否则界面还显示旧值）', /rerender: render/.test(sd));
  T('旧的单"关闭"按钮已移除', !/settingsCloseBtn/.test(sd));

  const md = rd('src/ui/ModeDialog.js');
  T('模式窗给的是确定/取消（切地图是立刻发生的重动作，没有中间态）',
    /modeOkBtn/.test(md) && /取消<\/button>/.test(md));
  T('模式窗注释说明了为什么不给"应用"', /没有"改了还没生效"的中间态/.test(md));

  const doc = rd('docs/ui-standard.md');
  T('设计规范成文（含待改造清单）', /左树 \+ 右表单/.test(doc) && /待改造清单/.test(doc));
  T('规范里写了"控件不许撒谎"这条及真实反例',
    /控件摆在那儿却不起作用/.test(doc) && /建筑体积/.test(doc));
  T('规范里写了哪些窗口不套三按钮', /什么窗口\*\*不该\*\*套三按钮/.test(doc));
}

console.log(`页脚/建塔模型 验收: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
