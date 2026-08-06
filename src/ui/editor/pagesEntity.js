/**
 * pagesEntity.js —— AttributeEditor 的一块（v43 P1-4 从 src/ui/AttributeEditor.js 拆出）
 *
 * 实体面板各页渲染：属性 / 武器 / 技能 / 状态 / 运维操作 / 龙魂
 *
 * 拆分性质：**纯位移**。整个 AttributeEditor 本来就是一个对象字面量，
 * 任意一段连续的顶层条目本身就是合法的对象字面量体，所以这里的方法体
 * 逐字未动、缩进未动。AttributeEditor.js 用 Object.assign 把各块合成同一个对象，
 * 因此所有 `this.xxx` 的跨块调用与拆分前完全一致 —— 它们本来就在同一个对象上。
 */
import { CONFIG } from '../../data/Config.js';
import { SkillLibrary, renderSkillDescription } from '../../core/SkillLibrary.js';
import { towerTierSource } from '../../data/schema/index.js';
import { FIELD_META, fieldLabel } from './fields.js';

export const EDITOR_PAGES_ENTITY = {
  // ==================== 渲染方法 ====================
  // ============================================================
  //  SECTION 1: Live Entity Editor ? attributes, weapons, passives, effects
  // ============================================================

  // srcCtx（可选，仅分层塔用）：{ tier }。给每个字段标出"这个数是从叠加链的哪一层来的"。
  // 塔的数值要穿过 模板 → 地图 tierStats → 共享覆写 → 阵营覆写 四层，面板过去只显示最终值，
  // 于是"我改了怎么没变"（被更靠后的层压住）和"我没改它怎么是这个数"（地图带了 tierStats）
  // 两类问题都无法自查 —— 这是模板编辑器最费解的一处。
  _renderAttrContent(target, isTemplate = false, srcCtx = null) {
    // 实体编辑：currentHP 存在 entity 上而非 baseStats，需合并进显示数据源，
    // 否则"当前生命"会显示 0（此前的 bug）。
    const data = isTemplate ? { ...target } : { ...target.baseStats, currentHP: target.currentHP };
    // v33（Q13）：塔实体可编辑【模型大小】（渲染半径，仅显示与血条位置，不影响攻击范围/碰撞）。
    // 留空 = 沿用该档建筑的全局尺寸（CONFIG.buildingSizes）。
    const modelSizeRow = (!isTemplate && target.type === 'tower') ? `
      <div class="editor-field" style="display:flex;align-items:center;gap:8px;margin:2px 0 8px;">
        <label style="width:130px;">📐 模型大小(px)</label>
        <input type="number" id="editorModelSize" min="8" max="80" step="1"
          value="${target._modelSize ?? ''}" placeholder="${(CONFIG.buildingSizes || {})[target._mapTier] ?? (CONFIG.buildingSizes || {}).default ?? 28}（默认）"
          style="width:110px;">
        <span style="font-size:10px;color:#8b949e;">留空=用该档建筑的全局尺寸</span>
      </div>` : '';
    const allKeys = Object.keys(data).filter(k => typeof data[k] === 'number');

    const coreKeys = ['maxHP', 'currentHP', 'healthRegen', 'baseHealthRegenMod'];
    const attackKeys = ['attackDamage', 'baseAttackSpeed', 'bonusAttackSpeedPct', 'attackSpeedRatio', 'attackRange', 'attackType', 'bulletSpeed'];
    const defenseKeys = ['armor', 'magicResist', 'damageReduction', 'damageBlock', 'shieldFixedMax', 'shieldRegenRate', 'tempShieldDecayPct'];
    const penKeys = ['armorPenFlat', 'armorPenPercent', 'magicPenFlat', 'magicPenPercent'];
    const effectKeys = ['onHitDamage', 'onHitPercentDamage', 'damageConvertPct', 'lifeStealPct', 'healShieldPowerPct', 'allStatsPct'];
    const allDefinedKeys = [...coreKeys, ...attackKeys, ...defenseKeys, ...penKeys, ...effectKeys];

    const groups = {
      '核心': coreKeys,
      '攻击': attackKeys,
      '防御': defenseKeys,
      '穿透': penKeys,
      '特效': effectKeys,
      '其他': allKeys.filter(k => !allDefinedKeys.includes(k))
    };

    let html = `<div class="editor-tabs">`;
    let firstGroup = true;
    for (const g of Object.keys(groups)) {
      if (groups[g].length) {
        html += `<div class="editor-tab${firstGroup ? ' active' : ''}" data-group="${g}">${g}</div>`;
        firstGroup = false;
      }
    }
    html += `</div><div class="editor-body">`;
    for (const [g, keys] of Object.entries(groups)) {
      if (!keys.length) continue;
      html += `<div class="editor-group" data-group="${g}" style="display:${g === '核心' ? '' : 'none'};">`;
      for (const key of keys) {
        const value = data[key] ?? 0;
        const label = fieldLabel(key);
        if (key === 'attackType') {
          html += `<div class="slider-row"><label title="${key}">${label}</label><select data-key="${key}" data-orig="${value}" class="editor-select">`;
          for (const opt of [['physical','物理'],['magic','魔法'],['true','真实']]) {
            html += `<option value="${opt[0]}" ${value === opt[0] ? 'selected' : ''}>${opt[1]}</option>`;
          }
          html += `</select></div>`;
        } else {
          const meta = FIELD_META[key] || { min: 0, max: Math.max(100, value * 2), step: (key === 'currentHP' ? 1 : 0.1) };
          html += `<div class="slider-row">
            <label title="${key}">${label}${this._srcBadge(srcCtx, key)}</label>
            <div class="slider-wrap">
              <input type="range" class="editor-slider" data-key="${key}" min="${meta.min}" max="${meta.max}" step="${meta.step}" value="${Math.min(meta.max, Math.max(meta.min, value))}">
              <input type="number" class="editor-number" data-key="${key}" data-orig="${value}" step="${meta.step}" value="${value}">
            </div>
          </div>`;
        }
      }
      html += `</div>`;
    }
    html += `</div>`;
    return modelSizeRow + html;
  },

  // 取值来源角标。只在分层塔的模板页显示；只有一层时不显示（没有信息量，纯噪音）。
  _SRC_COLOR: { '模板': '#8b949e', '地图': '#d29922', '共享覆写': '#58a6ff', '蓝方覆写': '#58a6ff', '红方覆写': '#f85149' },
  _srcBadge(srcCtx, key) {
    if (!srcCtx?.tier) return '';
    let r;
    try { r = towerTierSource(srcCtx.tier, key, this._factionScope); } catch (e) { return ''; }
    if (!r.chain.length || r.chain.length === 1) return '';
    // 被压住的层按顺序列进 title，用户一眼能看出"我改的那层排在第几、被谁盖了"
    const overridden = r.chain.slice(0, -1).map(c => `${c.layer} ${c.value}`).join(' → ');
    const color = this._SRC_COLOR[r.source] || '#8b949e';
    return `<span style="margin-left:4px;font-size:9px;color:${color};border:1px solid ${color};
      border-radius:3px;padding:0 3px;vertical-align:middle;"
      title="生效层：${r.source}（${r.value}）&#10;被覆盖：${overridden}">${r.source}</span>`;
  },

  _renderWeaponContent(entity) {
    const current = entity._skillInstances?.find(s => s.skillId.startsWith('weapon_'))?.skillId || 'weapon_piercing'; // v33
    const weaponMeta = {
      weapon_piercing: { label: '穿透型', icon: '🔷' },
      weapon_lightning: { label: '闪电杖', icon: '⚡' },
      weapon_explosive: { label: '爆炸型', icon: '💥' },
      weapon_corrosion: { label: '腐蚀型', icon: '🌿' },
    };
    const weaponIds = this._SKILLS_BY_TYPE.tower.weapons;
    const weapons = [{ id: 'none', label: '无武器', icon: '🚫' }, ...weaponIds.map(id => ({ id, ...weaponMeta[id] }))];
    let html = `<div class="pick-grid">`;
    for (const w of weapons) {
      const isSelected = (w.id === 'none' && (!current || current === 'none')) || w.id === current;
      html += `<div class="pick-card ${isSelected ? 'selected' : ''}" data-weapon="${w.id}">
        <div class="pick-icon">${w.icon}</div>
        <div class="pick-label">${w.label}</div>
      </div>`;
    }
    html += `</div>`;
    const currentDef = SkillLibrary[current];
    html += `<div class="pick-desc-box" id="weaponDescBox">${current === 'none' ? '无武器：塔不会攻击。' : (currentDef?.description || currentDef?.descTemplate || '')}</div>`;
    return html;
  },

  // 统一的"每类型可用技能"清单——实体编辑器与模板编辑器共用同一份，
  // 避免此前两处列表各写一份、又漏掉新增类型/新增技能的问题（Q3）。
  _SKILLS_BY_TYPE: {
    tower: {
      weapons: ['weapon_piercing', 'weapon_lightning', 'weapon_explosive', 'weapon_corrosion'],
      // 沙盒通用被动 + 对战实战塔被动。此前这里只有前 7 个沙盒被动，对战里塔真正装的那批
      // （加固城防/成长/过载/钢铁防线/镀层/烈阳护盾/水晶再生/基地光环）一个都没列 —— 这正是
      // 用户反馈"技能清单已经过时"的根因。现按 main.js 的实际装配逐条补齐。
      passives: [
        'passive_heavy_defense', 'passive_thorns', 'passive_frost_plating', 'passive_armor_plating',
        'passive_overheat', 'passive_vampire', 'passive_phase',
        'passive_overload', 'passive_iron_line',
        'passive_outer_fortify', 'passive_inner_fortify', 'passive_base_fortify', 'passive_hq_fortify',
        'passive_growth_outer', 'passive_growth_inner', 'passive_growth_base', 'passive_growth_hq',
        'passive_inner_bulwark', 'passive_base_bulwark',
        'passive_nexus_regen', 'passive_home_aura',
      ],
    },
    // 近战/远程此前是空列表，但它们默认就带屠戮被动（main.js defaultPassiveMap）—— 补上。
    melee:  { weapons: [], passives: ['passive_melee_rend'] },
    ranged: { weapons: [], passives: ['passive_ranged_rend'] },
    siege: { weapons: [], passives: ['passive_artillery_commander', 'passive_siege_shield', 'passive_siege_rend'] },
    super: { weapons: [], passives: ['passive_super_commander'] },
    totem: { weapons: [], passives: ['passive_totem_guardian', 'passive_totem_awaken', 'passive_totem_nourish', 'passive_totem_aura', 'passive_totem_sacrifice'] },
    warlock: { weapons: [], passives: ['passive_warlock_aura'] },
    corrupt: { weapons: [], passives: ['passive_corrupt_strike'] },
    ram:     { weapons: [], passives: ['passive_siege_weapon'] },
  },

  // 分层塔的技能清单：★ = main.js 里该层级的【默认装配】，其余为该层级可选。
  // 与 main.js createBuilding 的装配分支逐条对应，改那边就要同步这里。
  _SKILLS_BY_TIER: {
    outer:      ['passive_outer_fortify', 'passive_growth_outer', 'passive_iron_line', 'passive_overload',
                 'passive_armor_plating', 'passive_inner_bulwark', 'passive_thorns', 'passive_frost_plating'],
    inner:      ['passive_inner_fortify', 'passive_growth_inner', 'passive_inner_bulwark', 'passive_overload',
                 'passive_armor_plating', 'passive_iron_line', 'passive_thorns', 'passive_frost_plating'],
    base:       ['passive_base_fortify', 'passive_growth_base', 'passive_armor_plating', 'passive_overload',
                 'passive_base_bulwark', 'passive_iron_line', 'passive_heavy_defense', 'passive_thorns'],
    hq_tower:   ['passive_hq_fortify', 'passive_growth_hq', 'passive_overload',
                 'passive_armor_plating', 'passive_iron_line', 'passive_heavy_defense'],
    nexus_lane: ['passive_nexus_regen', 'passive_base_bulwark', 'passive_heavy_defense'],
    nexus_main: ['passive_nexus_regen', 'passive_home_aura', 'passive_heavy_defense'],
  },
  // main.js 中各层级的默认装配（用于在清单里标 ★ 默认）
  _TIER_DEFAULT_SKILLS: {
    outer:      ['passive_growth_outer', 'passive_outer_fortify', 'passive_iron_line', 'passive_overload'],
    inner:      ['passive_growth_inner', 'passive_inner_fortify', 'passive_inner_bulwark', 'passive_overload'],
    base:       ['passive_growth_base', 'passive_base_fortify', 'passive_armor_plating', 'passive_overload'],
    hq_tower:   ['passive_growth_hq', 'passive_hq_fortify', 'passive_overload'],
    nexus_lane: ['passive_nexus_regen'],
    nexus_main: ['passive_nexus_regen', 'passive_home_aura'],
  },

  _renderSkillContent(entity) {
    // 按单位类型区分被动列表：不同类型有各自专属的被动技能。
    const allPassives = this._SKILLS_BY_TYPE[entity.type]?.passives || [];
    const equipped = new Set(entity._skillInstances?.filter(s => allPassives.includes(s.skillId)).map(s => s.skillId) || []);

    if (allPassives.length === 0) {
      return `<div class="pick-desc-box">该单位类型没有可装备的被动技能。</div>`;
    }

    let html = `<div class="pick-grid">`;
    for (const key of allPassives) {
      const def = SkillLibrary[key];
      if (!def) continue;
      const isEquipped = equipped.has(key);
      html += `<div class="pick-card ${isEquipped ? 'selected' : ''}" data-skill="${key}">
        <div class="pick-icon">${def.icon || '🔹'}</div>
        <div class="pick-label">${def.name || key}</div>
      </div>`;
    }
    html += `</div>`;
    html += `<div class="pick-desc-box" id="skillDescBox">点击某个被动查看说明；再次点击可切换装备/卸载。</div>`;
    return html;
  },

  // ==================== Q3：运维操作（复活 / 击杀 / 改阵营 / 改层级）====================
  // 死亡的塔现在可被选中（网格已索引废墟），这一页让它可以被真正"运维"。
  // 每个操作都有连锁副作用，全部在 _applyOps 里显式处理，不留隐式状态。
  _renderOpsContent(entity) {
    const isTower = entity.type === 'tower';
    const dead = !entity.alive;
    const fac = entity._mapFaction || entity.faction || '（无阵营）';
    const facLabel = { blue: '🔵 蓝方', red: '🔴 红方' }[fac] || fac;
    const state = dead ? (entity._respawnAt ? '💤 等待重生' : (entity._ruin ? '🪦 废墟' : '☠️ 已死亡')) : '✅ 存活';

    let html = `<div style="padding:4px 0;">`;
    html += `<div class="pick-desc-box" style="margin-bottom:10px;">
      当前状态：<b>${state}</b>　｜　阵营：<b>${facLabel}</b>${isTower && entity._mapTier ? `　｜　层级：<b>${this._tierLabel(entity._mapTier)}</b>` : ''}
      <br><span style="color:var(--text-mute);font-size:11px;">编辑器操作不计入比分，日志里会标 [编辑器]。</span>
    </div>`;

    html += `<div class="slider-row"><label>存活状态</label>
      <div style="flex:1;display:flex;gap:6px;">
        <button class="editor-tab ${!dead ? 'active' : ''}" data-op="revive" ${!dead ? 'disabled' : ''}>❤️ 复活（满血）</button>
        <button class="editor-tab ${dead ? 'active' : ''}" data-op="kill" ${dead ? 'disabled' : ''}>💀 击杀</button>
      </div></div>`;

    html += `<div class="slider-row"><label>阵营</label>
      <div style="flex:1;display:flex;gap:6px;">
        <button class="editor-tab ${fac === 'blue' ? 'active' : ''}" data-op="fac" data-v="blue">🔵 蓝方</button>
        <button class="editor-tab ${fac === 'red' ? 'active' : ''}" data-op="fac" data-v="red">🔴 红方</button>
      </div></div>`;

    if (isTower) {
      html += `<div class="slider-row" style="align-items:flex-start;"><label style="padding-top:5px;">层级</label>
        <div style="flex:1;display:flex;gap:4px;flex-wrap:wrap;">
          ${this._TPL_TOWER_TIERS.map(t => `<button class="editor-tab ${t.key === entity._mapTier ? 'active' : ''}" data-op="tier" data-v="${t.key}" style="font-size:11px;">${t.icon} ${t.label}</button>`).join('')}
        </div></div>`;
      html += `<div style="font-size:11px;color:var(--text-mute);margin-top:8px;">
        改层级会按新层级重新解析属性与默认被动/武器（地图数值 → 分层覆写 → 阵营覆写）。
      </div>`;
    }

    html += `<div style="margin-top:12px;font-size:11px;color:var(--text-mute);line-height:1.7;">
      ⚠️ 这些操作会连锁影响：<br>
      · <b>结构保护</b>按"外层建筑是否存活"判定，复活/击杀会改变【其它塔】的可选中与免伤状态；<br>
      · 召唤水晶若在<b>重生队列</b>里，手动复活会把队列项一并撤掉，不会二次重生；<br>
      · 改阵营会清空当前目标（否则它会继续攻击原队友），并刷新模型颜色。
    </div>`;
    html += `</div>`;
    return html;
  },

  _bindOpsEvents(overlay, entity, logFn) {
    const app = window.CTX?.__app || window.__app;
    const ec = overlay._entityContainer || app?.entityContainer;
    const rerender = () => {
      overlay.querySelector('#editorContent').innerHTML = this._renderOpsContent(entity);
      this._bindOpsEvents(overlay, entity, logFn);
    };
    overlay.querySelectorAll('[data-op]').forEach(btn => {
      if (btn.disabled) return;
      btn.addEventListener('click', () => {
        const op = btn.dataset.op, v = btn.dataset.v;
        this._applyOps(entity, op, v, ec, app, logFn);
        rerender();
      });
    });
  },

  /**
   * 运维操作的唯一入口。所有连锁副作用都写在这里，避免"改了标记但别处没跟上"。
   * 刻意【不走 entity:death 事件】：那条链路会计分、会入重生队列、会触发超级兵，
   * 而编辑器操作是调试手段，不该污染对局状态（用户定稿：不计分，日志标 [编辑器]）。
   */
  _applyOps(e, op, v, ec, app, logFn) {
    const tag = '[编辑器]';
    const name = e.type === 'tower' ? `塔 #${e.id}` : `${CONFIG.templates[e.type]?.label || e.type} #${e.id}`;

    if (op === 'revive') {
      const maxHP = e.baseStats?.maxHP || 1;
      e.alive = true;
      e.currentHP = maxHP;
      e.shieldFixedCurrent = e.baseStats?.shieldFixedMax || 0;
      e.tempShield = 0;
      e.attackCooldown = 0;
      e.targetId = null;
      delete e._ruin;
      // 撤销重生：队列项 + _respawnAt 标记 + ⏳「重生中」状态**三样一起清**。
      // 这里原来是编辑器自己写的一小段，只清了前两样，于是复活之后那颗
      // ⏳ 状态还挂在水晶上、描述里的秒数继续往下走 —— 用户看到的
      // "设置为存活了，倒计时依旧存在"就是它。现在统一走 MapSystem.cancelNexusRespawn，
      // 那边还会顺带刷新"这一路是否算陷落"（一路可能有多座水晶）。
      const ms = app?.mapSystem;
      if (ms?.cancelNexusRespawn) ms.cancelNexusRespawn(e.id);
      else {
        const q = ms?._respawnQueue;
        if (q) for (let i = q.length - 1; i >= 0; i--) if (q[i].corpseId === e.id) q.splice(i, 1);
      }
      delete e._respawnAt; delete e._respawnProgress; delete e._respawnRemain;
      ec?.markDirty?.();
      logFn(`${tag} ❤️ ${name} 已复活（满血 ${maxHP}）`, 'spawn');

    } else if (op === 'kill') {
      e.alive = false;
      e.currentHP = 0;
      e.targetId = null;
      // 地图建筑死亡后保留为废墟（与 MapSystem 同口径），否则会被 purgeDead 直接清掉
      if (e._mapTier) e._ruin = true;
      ec?.markDirty?.();
      // 召唤水晶要进重生倒计时。刻意不走 entity:death 是为了不计分，
      // 但"不计分"不等于"不进入游戏状态"—— 原实现连重生一起跳过了，
      // 手动打掉的召唤水晶就永远躺在那儿，既不重生也不触发超级兵。
      let extra = '';
      if (e._mapTier === 'nexus_lane' && app?.mapSystem?.beginNexusRespawn) {
        if (app.mapSystem.beginNexusRespawn(e)) {
          const t = app.mapSystem.NEXUS_RESPAWN_TIME;
          const laneDown = app.mapSystem.isNexusDestroyed(e._mapFaction, e._laneId);
          extra = `，${t}s 后重生${laneDown ? '；本路召唤水晶已全灭' : '；本路还有存活的召唤水晶，尚不算陷落'}`;
        }
      }
      logFn(`${tag} 💀 ${name} 已击杀（不计入比分）${extra}`, 'death');

    } else if (op === 'fac') {
      if (v !== 'blue' && v !== 'red') return;
      e._mapFaction = v; e.faction = v;
      e.targetId = null;          // 不清目标它会继续打原来的队友
      if (e._ramLockId) e._ramLockId = null;
      logFn(`${tag} 🎌 ${name} 阵营 → ${v === 'blue' ? '蓝方' : '红方'}`, 'spawn');

    } else if (op === 'tier') {
      if (e.type !== 'tower') return;
      e._mapTier = v;
      // 按新层级重新解析数值：地图 tierStats → 分层覆写 → 阵营覆写（与 createBuilding 同序）
      const map = app?.mapSystem?.currentMap;
      const base = (map?.tierStats && map.tierStats[v]) || {};
      const shared = CONFIG.towerTierOverrides?.[v] || {};
      const facOvr = CONFIG.factionOverrides?.[e._mapFaction]?.['tower_' + v] || {};
      const merged = { ...base, ...shared, ...facOvr };
      const frac = e.baseStats?.maxHP > 0 ? e.currentHP / e.baseStats.maxHP : 1;
      Object.assign(e.baseStats, merged);
      if (e.baseStats.maxHP > 0) e.currentHP = Math.max(1, Math.round(e.baseStats.maxHP * frac));
      logFn(`${tag} 🏯 ${name} 层级 → ${this._tierLabel(v)}（属性已按新层级重解析）`, 'spawn');
    }
  },

  _renderEffectContent(entity) {
    const effs = window.__app?.effectRegistry?.getEffects(entity.id) || [];
    let html = `<div style="margin:8px 0;max-height:300px;overflow-y:auto;">`;
    if (effs.length === 0) {
      html += `<div style="color:#8b949e;font-size:12px;padding:8px;">暂无状态效果</div>`;
    } else {
      for (const e of effs) {
        html += `<div style="display:flex;align-items:center;gap:8px;padding:4px 8px;background:#0d1013;border-radius:4px;margin-bottom:4px;">
          <span style="font-size:18px;">${e.blueprint.icon || '🔹'}</span>
          <span style="flex:1;font-size:12px;">${e.blueprint.name}</span>
          <span style="font-size:10px;color:#8b949e;">${e.stacks > 1 ? `x${e.stacks}` : ''}</span>
          <span style="font-size:10px;color:#8b949e;">${e.remainingTime === Infinity ? '永久' : e.remainingTime.toFixed(1) + 's'}</span>
          <button class="remove-effect-btn" data-effect-id="${e.id}" style="background:#b33a3a;border:none;color:#fff;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:10px;">移除</button>
        </div>`;
      }
    }
    html += `</div>`;
    html += `<div style="margin-top:8px;">
      <button id="addEffectBtn" style="background:#2a5a8a;border:none;color:#fff;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:12px;">+ 添加状态</button>
      <div id="effectPickerBox" style="display:none;margin-top:8px;padding:12px;background:#0d1013;border-radius:4px;"></div>
    </div>`;
    return html;
  },

  // ==================== 龙魂（每塔独立） ====================
  _renderSoulContent(tower) {
    const app = window.__app;
    const DRAGON_ELEMENTS = app?.DRAGON_ELEMENTS || {};
    const SkillLibrary = app?.SkillLibrary || {};
    const effReg = app?.effectRegistry;

    // 已装备的龙魂（多个，来自 _skillInstances，不再是单一 _currentSoul）
    const equippedSouls = new Set((tower._skillInstances || []).filter(s => s.skillId.startsWith('dragonsoul_')).map(s => s.skillId));

    // ---- 已生效效果（穿梭框上方）：元素增益（有层数>0的）+ 已装备的所有龙魂 ----
    const activeChips = [];
    for (const [key, el] of Object.entries(DRAGON_ELEMENTS)) {
      const sampleEff = effReg ? effReg.getEffects(tower.id).find(e => e.sourceId === `dragon_buff_${key}_0`) : null;
      if (sampleEff && sampleEff.stacks > 0) {
        activeChips.push({ kind: 'buff', key, icon: el.icon, label: `${el.label}之力（${sampleEff.stacks}层）` });
      }
    }
    for (const [key, el] of Object.entries(DRAGON_ELEMENTS)) {
      if (equippedSouls.has(el.soul)) {
        const def = SkillLibrary[el.soul];
        activeChips.push({ kind: 'soul', key, icon: def?.icon || '🐉', label: def?.name || el.soul });
      }
    }

    const activeHtml = activeChips.length
      ? activeChips.map(c => `<div class="transfer-chip" data-remove-kind="${c.kind}" data-remove-key="${c.key}">
          <span class="chip-icon">${c.icon}</span><span>${c.label}</span><span class="chip-remove">✕</span>
        </div>`).join('')
      : `<div class="transfer-active-empty">尚未生效任何巨龙增益或龙魂。点击下方池中的按钮即可生效。</div>`;

    // ---- 巨龙增益池（下方，全部8种，每次点击 +1 层，可无限叠加，非开关） ----
    const buffPoolHtml = Object.entries(DRAGON_ELEMENTS).map(([key, el]) => {
      const sampleEff = effReg ? effReg.getEffects(tower.id).find(e => e.sourceId === `dragon_buff_${key}_0`) : null;
      const stacks = sampleEff ? sampleEff.stacks : 0;
      return `<div class="pick-card ${stacks > 0 ? 'has-stacks' : ''}" data-pool-kind="buff" data-pool-key="${key}">
        <div class="pick-icon">${el.icon}</div>
        <div class="pick-label">${el.label}之力${stacks > 0 ? `（${stacks}）` : ''}</div>
      </div>`;
    }).join('');

    // ---- 龙魂池（下方，全部8种，唯一开关：装备/卸下） ----
    const soulPoolHtml = Object.entries(DRAGON_ELEMENTS).map(([key, el]) => {
      const def = SkillLibrary[el.soul];
      const active = equippedSouls.has(el.soul);
      return `<div class="pick-card ${active ? 'selected' : ''}" data-pool-kind="soul" data-pool-key="${key}">
        <div class="pick-icon">${def?.icon || el.icon}</div>
        <div class="pick-label">${def?.name || el.label}</div>
      </div>`;
    }).join('');

    return `
      <div class="transfer-box">
        <div class="transfer-active-zone">
          <div class="transfer-active-title">✨ 已生效效果（点击 -1 层 / 卸下）</div>
          <div class="transfer-active-list">${activeHtml}</div>
        </div>
        <div class="transfer-pool-section">
          <div class="transfer-pool-title">🔥 巨龙增益池（点击 +1 层，可无限叠加）</div>
          <div class="pick-grid">${buffPoolHtml}</div>
        </div>
        <div class="transfer-pool-section">
          <div class="transfer-pool-title">🐉 龙魂池（唯一开关，可同时装备多个不同龙魂）</div>
          <div class="pick-grid">${soulPoolHtml}</div>
        </div>
        <div class="pick-desc-box" id="soulDescBox">点击某项查看说明。</div>
      </div>
    `;
  },

  _bindSoulEvents(overlay, tower, logFn) {
    const app = window.__app;
    const DRAGON_ELEMENTS = app?.DRAGON_ELEMENTS || {};
    const SkillLibrary = app?.SkillLibrary || {};
    const rerender = () => {
      overlay.querySelector('#editorContent').innerHTML = this._renderSoulContent(tower);
      this._bindSoulEvents(overlay, tower, logFn);
    };

    // 减少某元素增益 1 层（层数减到 0 时彻底移除该效果）
    const decrementBuff = (key, el) => {
      let stillHasLayers = false;
      for (let i = 0; i < el.buff.length; i++) {
        const eff = app.effectRegistry.getEffects(tower.id).find(e => e.sourceId === `dragon_buff_${key}_${i}`);
        if (!eff) continue;
        if (eff.stacks > 1) { eff.stacks -= 1; app.effectRegistry._recalcEffectValues(eff); app.effectRegistry._updateDescription(eff); stillHasLayers = true; }
        else app.effectRegistry.remove(eff.id);
      }
      return stillHasLayers;
    };

    // 点击池中"巨龙增益"按钮：每次点击 +1 层（可无限叠加，不是开关）
    overlay.querySelectorAll('[data-pool-kind="buff"]').forEach(card => {
      card.addEventListener('click', () => {
        const key = card.dataset.poolKey;
        const el = DRAGON_ELEMENTS[key];
        if (!el) return;
        app.dragonSystem._applyElementBuffToTower(tower, key);
        logFn(`✨ 塔 #${tower.id} ${el.label}之力 +1 层`, 'spawn');
        rerender();
      });
      card.addEventListener('mouseenter', () => {
        const el = DRAGON_ELEMENTS[card.dataset.poolKey];
        const descBox = overlay.querySelector('#soulDescBox');
        if (descBox && el) descBox.textContent = `${el.label}之力：击杀获得的永久元素增益，点击可叠加层数（每层独立生效）。`;
      });
    });

    // 点击池中"龙魂"按钮：单层开关（装备/卸下），与增益池不同
    overlay.querySelectorAll('[data-pool-kind="soul"]').forEach(card => {
      card.addEventListener('click', () => {
        const key = card.dataset.poolKey;
        const el = DRAGON_ELEMENTS[key];
        if (!el) return;
        const equipped = app.dragonSystem._toggleSoul(tower, el.soul);
        logFn(`${equipped ? '✨' : '🚫'} 塔 #${tower.id} ${equipped ? '已装备' : '已卸下'}龙魂：${SkillLibrary[el.soul]?.name || el.soul}`, 'spawn');
        rerender();
      });
      card.addEventListener('mouseenter', () => {
        const el = DRAGON_ELEMENTS[card.dataset.poolKey];
        const def = el ? SkillLibrary[el.soul] : null;
        const descBox = overlay.querySelector('#soulDescBox');
        if (descBox) descBox.textContent = renderSkillDescription(def, entity, ctx) || def?.description || '';
      });
    });

    // 点击上方已生效 chip：增益 -1 层；龙魂直接卸下
    overlay.querySelectorAll('[data-remove-kind]').forEach(chip => {
      chip.addEventListener('click', () => {
        const kind = chip.dataset.removeKind;
        const key = chip.dataset.removeKey;
        const el = DRAGON_ELEMENTS[key];
        if (!el) return;
        if (kind === 'buff') {
          decrementBuff(key, el);
          logFn(`🔻 塔 #${tower.id} ${el.label}之力 -1 层`, 'spawn');
        } else if (kind === 'soul') {
          app.dragonSystem._toggleSoul(tower, el.soul);
          logFn(`🚫 塔 #${tower.id} 已卸下龙魂：${SkillLibrary[el.soul]?.name || el.soul}`, 'spawn');
        }
        rerender();
      });
    });
  },
};
