// 闪电杖 / 穿透型：塔顶水晶亮度只跟充能走，不随每次攻击闪。
// 用户："闪电杖在攻击时水晶一直在高频的闪，这是错误的。闪电杖水晶的亮度根据充能大小决定，充能越大越亮。
//        穿透型子弹的升温也同理，充能层数越多水晶越亮。"
import { setupWindow, scoreboard, srcOf } from './_harness.mjs';
setupWindow();
const { CONFIG } = await import('../src/data/Config.js');
const { SkillLibrary } = await import('../src/core/SkillLibrary.js');
const weapons = { weapon_piercing: SkillLibrary.weapon_piercing || SkillLibrary.skills?.weapon_piercing || SkillLibrary.get?.('weapon_piercing') };
const { T, done } = scoreboard('水晶亮度 = 充能');
const U = srcOf('src/presentation/UnitLayer.js');
T('①闪电杖/穿透型不吃"开火猛亮一下"（那一下就是高频闪的来源）',
  /const chargeWeapon = wid === 'weapon_lightning' \|\| wid === 'weapon_piercing';\s*if \(chargeWeapon\) en\._firePulse = 0;/.test(U));
T('②闪电杖读武器实例的充能 state.charge', /target = Math\.max\(0, Math\.min\(1, inst\?\.state\?\.charge \|\| 0\)\)/.test(U));
T('③穿透型读升温层数 / 满层（换了目标作废），不再按冷却反推',
  /st\.heatTarget === e\.targetId \? Math\.max\(0, Math\.min\(1, \(st\.heatStacks \|\| 0\) \/ maxS\)\) : 0/.test(U) && !/cd \/ period/.test(U));
T('④满层与武器定义一致', CONFIG.ui.crystal.attackGlow.heatMaxStacks === weapons.weapon_piercing.HEAT_MAX_STACKS);
// 亮度随层数单调递增，且 1 层也看得出来（曲线指数不能大到把低层压没）
{
  const m = /const CRYSTAL_CHARGE_POW = ([\d.]+);/.exec(U);
  const pow = m ? +m[1] : NaN;
  const lv = [1, 2, 3, 4].map((k) => Math.pow(k / 4, pow));
  T(`⑤亮度随层数递增、1 层已有满层的 ${((lv[0]) * 100).toFixed(0)}%（≥10%）`, lv.every((v, i) => i === 0 || v > lv[i - 1]) && lv[0] >= 0.1);
}
done();
