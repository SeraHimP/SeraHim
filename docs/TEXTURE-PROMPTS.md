# 地图贴图提示词（给 ChatGPT / 绘图模型）

用户："地图的贴图目前只有召唤师峡谷的，嚎哭深渊和扭曲丛林都没有贴图……
并且目前的贴图太简单了，我想要高地/路径/野区等都用不同贴图看起来好看一些。"

---

## 一、先说清楚这些图在引擎里怎么被用

**这一节比提示词本身重要**——图的画法必须迁就用法，否则再好看的图贴上去也是花的。

1. **图是平铺的（tile）**，一张覆盖 384×384 世界单位。四条边**必须无缝**：
   上边接下边、左边接右边。有接缝的话地面上会出现规则的网格线，一眼就看出来。
2. 引擎会把图**归一化到中灰**再以 `overlay` 混进地形底图（见 `TerrainMaterial.js`
   的 `normalize()`）。这意味着：
   - 图的**平均亮度会被抹掉**，只有"起伏"被保留 → 别在图里画大面积明暗过渡，
     那部分会被吃掉；要的是**均匀分布的细节**。
   - 图的**色相会保留**并成为该区域的主色 → 每一区的色相要一眼可分。
3. 分辨率 **2048×2048 PNG**。再大没有意义（一张覆盖 384 世界单位，小兵才 10~24 单位）。
4. **不要画任何有方向的大结构**（路的走向、河的走向、建筑）。走向由引擎的分区遮罩
   决定，图只负责"这一片是什么材质"。图里出现一条路，平铺后会变成一堆路。
5. **不要画光影**。场景有实时昼夜光照，图里自带的阴影会和实时阴影打架。
   要的是 **albedo（固有色）**，平光、无高光、无投影。

## 二、命名与放置

```
assets/textures/<主题>/ground.png     # 通用地面（缺其他图时的兜底）
assets/textures/<主题>/plateau.png    # 高地顶面
assets/textures/<主题>/lane.png       # 路径（兵线走的那条）
assets/textures/<主题>/jungle.png     # 野区
assets/textures/<主题>/river.png      # 河道
assets/textures/<主题>/base.png       # 基地圈
assets/textures/<主题>/cliff.png      # 崖壁（侧面，非俯视）
```

`<主题>` 取地图 id 去掉 `_quick` 与版本后缀：
`summoners_rift` / `howling_abyss` / `twisted_treeline`。

**每一张都是可选的。** 缺哪张，引擎就用程序化占位图顶上（`placeholderTexture()`），
不会白屏也不会报错。所以可以一张一张地替换，不必一次交齐。

---

## 三、提示词

下面每条都可以直接粘给绘图模型。**每条末尾那句"seamless tileable"不要删**。

### 通用后缀（每条都加）

> flat top-down orthographic albedo texture, seamless tileable in all four
> directions, no lighting, no shadows, no highlights, no vignette, uniform
> overall brightness, fine even detail, no large-scale structures, no paths,
> no buildings, no text, 2048x2048, stylized low-poly game art

---

### 1. 召唤师峡谷 `summoners_rift`

**ground** — 温带林地的泥土地表
> packed damp earth with scattered small pebbles and thin dry grass tufts,
> muted olive-brown, subtle moss patches

**lane** — 被踩实的行军路
> hard-packed dirt road surface, fine gravel, faint wheel ruts and footprint
> scuffs, warm tan-brown, slightly lighter than surrounding soil

**jungle** — 茂密野区
> dense forest floor, overlapping fallen leaves, thick moss, small ferns,
> rich saturated green with dark undergrowth gaps

**plateau** — 高地岩台
> weathered flat rock shelf, angular stone plates with thin grass in the
> cracks, cool grey-green

**river** — 浅河床
> shallow riverbed seen from above, smooth rounded stones under clear
> water, cyan-teal tint, gentle caustic speckle

**base** — 基地地面
> carved stone plaza floor, tight-fitting hexagonal flagstones, faint arcane
> etching, cool blue-grey

**cliff** — 崖壁（**这张是侧面，不是俯视**）
> vertical layered rock cliff face, horizontal strata lines, cracks and
> loose scree, cool grey-brown

---

### 2. 嚎哭深渊 `howling_abyss`

**ground**
> wind-scoured frozen ground, compacted snow over dark stone, pale
> blue-white with grey stone showing through

**lane**
> packed snow trail, boot-compressed icy surface, faint blue shadow in the
> compressions, brighter than surrounding snow

**jungle**
> deep untouched powder snow with wind ripples and scattered frozen rock,
> soft pale blue-white

**plateau**
> ancient carved ice shelf, glassy blue ice with internal fracture lines and
> frost bloom

**river**
> frozen river ice, thick translucent blue ice sheet with trapped bubbles
> and hairline cracks

**base**
> frost-covered stone bridge decking, worn pale stone slabs rimed with ice

**cliff**（侧面）
> vertical glacial ice wall, deep blue crevasse texture, icicle fringe

---

### 3. 扭曲丛林 `twisted_treeline`

> ⚠️ 这张图野区占比最大，夜里最黑（也正是用户说"晚上看起来很怪"的那张）。
> 所以它的 jungle 与 ground **不要画太暗**——底图的布局明暗会再压一次。

**ground**
> dark swampy soil with damp patches and scattered twisted roots,
> desaturated purple-brown

**lane**
> muddy trodden path through swamp, wet compacted earth with shallow
> puddles, mid-tone brown, clearly lighter than surrounding ground

**jungle**
> tangled overgrowth, thick gnarled roots, dark broad leaves and pale
> fungus clusters, deep desaturated green with violet undertone

**plateau**
> mossy overgrown ruin stone, cracked slabs swallowed by creeping vines,
> grey-green

**river**
> stagnant swamp water surface, murky green-brown, floating algae mats and
> lily pads

**base**
> overgrown ceremonial stone floor, broken tiles with moss in every seam,
> faint carved spiral motifs

**cliff**（侧面）
> vertical mossy rock face draped with hanging vines and exposed roots

---

## 四、拿到图之后

丢进对应目录、按上面的名字命名即可，**不需要改任何代码**。
分区遮罩、平铺、归一化、overlay 合成都已经在管线里了。

验一眼有没有接缝：把图在图像编辑器里横竖各平铺 2×2，看四条内缝有没有明显的线。
有的话让模型重出，或者用 offset 滤镜（偏移半张）自己修一遍中缝。
