# 上下文仪表盘（Operit ToolPkg）· 完整设计与重建指南

> 版本：2026-09-16 · 适用于 Operit（Android）ToolPkg 插件系统
> 上游参考：bowenliang123/dsh-context（Apache-2.0，DeepSeek Harness 插件，本项目的设计蓝本）
> 本文档目标：让任何 AI 依据本文即可从零重建整个插件（采集层 + 数据层 + UI 层 + 前端页面）。

---

## 0. 项目概述

**它是什么**：一个 Operit 平台插件，把「每一轮实际发给大模型的完整提示词」逐字捕获到本地文件，并以可视化仪表盘呈现——统计、Token 构成、上下文浏览器、趋势、事件、文件活动、耗时拆分、费用估算。

**一句话架构**：

```
Operit 对话流程
   │  prompt_finalize 钩子（发模型前一刻）      chat_message 钩子（消息完成时）
   ▼                                          ▼
main.js 落盘 raw_<会话>.json / snapshots / chatmsg  （全部本地文件，不联网）
   │
   ▼
侧边栏「上下文仪表盘」→ Compose UI → WebView 加载 index.single.html（React）
   │  window.CtxProbe.api() 桥
   ▼
index.ui.js 读文件、聚合、计算 → JSON 返回 → React 渲染
```

**仓库结构**（开源发布形态）：

```
operit-context-dashboard/
├── LICENSE                    # Apache-2.0（含上游版权声明）
├── README.md                  # 功能 / 原理 / 安装 / 构建 / 致谢
├── THIRD_PARTY_NOTICES.md     # dsh-context(Apache-2.0) + DeepSeek 主题(MIT) 声明
├── toolpkg/                   # Operit 插件本体（可直接安装）
│   ├── manifest.json
│   └── dist/
│       ├── main.js            # 采集层（钩子 + 落盘）
│       └── ui/dashboard/index.ui.js   # UI 桥层（读文件 + 计算 + CtxProbe）
├── web/                       # 前端源码（React + Vite + TS）
│   └── src/ …                 # 组件、数据桥、样式
└── assets/index.single.html   # 构建产物（单文件页面，WebView 热加载用）
```

---

## 1. 运行环境与技术栈

| 层 | 运行位置 | 技术 |
|---|---|---|
| 采集层 main.js | Operit ToolPkg main 上下文（QuickJS） | ES5 风格 JS，`ToolPkg.registerPromptFinalizeHook` / `registerChatMessageHook`，`Tools.Files` 读写 |
| UI 桥层 index.ui.js | ToolPkg UI 上下文（compose_dsl runtime） | ES5 风格 JS，`WebViewController` + `addJavascriptInterface("CtxProbe")` |
| 页面 index.single.html | WebView（file:// 加载） | React 18 + Vite + TypeScript，构建后单文件内联 |
| 构建链 | 开发机（Node.js） | `vite build` → `node inline.mjs`（把 JS/CSS 内联进单个 HTML） |

**关键文件路径（设备上）**：

- 插件部署目录：`/sdcard/Android/data/com.ai.assistance.operit/files/packages/com.operit.prompt_viewer_ui.toolpkg`
- 数据目录：`/sdcard/Download/Operit/prompt_viewer/`
- 页面热更目标：`/sdcard/Download/Operit/projects/dsh-context-port/preview/index.single.html`

---

## 2. 数据层（重建的基础，最重要）

### 2.1 文件清单（均在数据目录下）

| 文件 | 写入方 | 内容 | 保留策略 |
|---|---|---|---|
| `raw_<key>.json` | prompt_finalize 钩子 | 该会话**最新一次**发给模型的完整 payload（逐字，覆盖写） | 环形保留最近 100 个会话 |
| `meta_<key>.json` | 同上 | 捕获时间 / 预览 / 行数等轻量元信息 | 同上 |
| `index.json` | 同上 | 会话索引数组，最新在前 | 同上（随会话删除同步） |
| `snapshots-YYYYMMDD.jsonl` | 同上（仅 `stage=send_to_model`） | 每轮一行轻量快照（字符构成） | 按天 14 天 |
| `chatmsg-YYYYMMDD.jsonl` | chat_message 钩子 | 每条**完成态**消息一行（usage/timing） | 按天 14 天 |
| `ui_bridge-YYYYMMDD.jsonl` | UI 桥层 | 桥调用日志（调试用） | 按天 14 天 |

`<key>` = chatId 前 8 位（例：`0449d90e`）；同会话的文件互相覆盖/追加，互不干扰。

### 2.2 核心数据结构（字段级）

**raw_<key>.json**（即 prompt_finalize 的 payload，原文结构由 Operit 决定，关键字段）：

```jsonc
{
  "preparedHistory": [            // 逐字的历史数组（核心！）
    { "kind": "SYSTEM",   "content": "……" },
    { "kind": "USER",     "content": "……" },
    { "kind": "ASSISTANT","content": "……" },
    { "kind": "TOOL_CALL","content": "……" },
    { "kind": "TOOL_RESULT","content": "……" },
    { "kind": "SUMMARY",  "content": "……" }
  ],
  "availableTools": [ … ],        // 工具定义数组（JSON.stringify 后计长度）
  "metadata": { "activePrompt": { "name": "…" } },
  "stage": "before_send_to_model"
}
```

**index.json**：`[{ "key", "chatId", "capturedAt", "capturedAtMs", "preview", "chars", "lines" }, …]`（最新在前，超 100 删尾）

**snapshots-<日期>.jsonl**（每行一个 JSON）：

```jsonc
{
  "session": "0449d90e",
  "atMs": 1789448058277,           // 捕获时间戳
  "stage": "before_send_to_model",
  "charsByKind": { "SYSTEM":13436, "USER":5542, "ASSISTANT":343257, "TOOL_CALL":…, "TOOL_RESULT":480348, "SUMMARY":… },
  "countByKind": { "USER": 5, … },
  "historyCount": 197,
  "historyChars": 653444,
  "toolsChars": 11270,
  "sys": { "wb": 0, "sk": 8813, "up": 938 }   // SYSTEM 内世界书/技能/资料字符数（新快照自带）
}
```

**chatmsg-<日期>.jsonl**（每行一条完成消息）：

```jsonc
{
  "at":"…","atMs":…,
  "session":"0449d90e","chatId":"…",
  "sender":"ai","roleName":"Viya",
  "contentLen":68528,
  "inputTokens":4566737,        // 该消息期间全部 API 往返的输入合计（非单次！见坑 §7）
  "outputTokens":21266,"cachedInputTokens":4540672,
  "provider":"…","modelName":"deepseek-flash",
  "sentAt":1789445941448,"completedAt":…,
  "waitMs":…,"outMs":…,
  "done": true
}
```

### 2.3 数据治理规则

- **机会式执行**：所有清理在「每次捕获写入时」顺手做，不用定时器。
- 会话类（raw/meta/index）：环形保留 **100** 个会话，被挤出者连同文件一起删。
- 日志类（snapshots/chatmsg/ui_bridge）：文件名含日期，写入时清理 **14 天**前的文件。
- 首次运行做一次「索引外孤儿文件」对齐清理。

---

## 3. 采集层（main.js）实现要点

### 3.1 钩子注册（入口）

```js
function registerToolPkg() {
  // 1) 注册侧边栏「上下文仪表盘」UI 路由（指向 dist/ui/dashboard/index.ui.js）
  // 2) 注册提示词定稿钩子 —— 拿「模型真正看到的东西」
  ToolPkg.registerPromptFinalizeHook({ id: "prompt_snapshot_full", function: onPromptFinalize });
  // 3) 注册消息事件钩子 —— 拿 token/timing 数据
  ToolPkg.registerChatMessageHook({ id: "pvm_chat_message", function: onChatMessage });
  return true;
}
exports.registerToolPkg = registerToolPkg;
exports.onPromptFinalize = onPromptFinalize;   // 钩子函数必须导出，否则注册被拒
exports.onChatMessage = onChatMessage;
```

### 3.2 onPromptFinalize（每轮落盘）

1. 取 `input.eventPayload` 为 payload；
2. `JSON.stringify` 后做**超长行折断**（`chunkLongLines`，把超长行按固定宽度插入真换行，防止下游单行读取超限）——**约定：UI 侧解析前必须去掉真换行**（JSON 字符串内部的换行本来就是 `\n` 两字符，去真换行不改变任何值）；
3. 写 `raw_<key>.json` + `meta_<key>.json`；
4. 更新 `index.json`：本会话挪到最前，超 100 删尾并同步删文件；
5. 仅当 `stage` 含 `send_to_model` 时，追加一行快照到 `snapshots-<日期>.jsonl`（从 payload 统计各 kind 字符数、toolsChars、historyCount、sys 拆分）；
6. 顺手执行数据治理清理；
7. **绝不修改提示词本身**（钩子返回 undefined）。

### 3.3 onChatMessage（消息完成时）

- 仅处理 `completedAt > 0`（完成态）的事件，**不做高频写盘**（流式中间态只留内存）；
- 去重键：`chatId|sentAt|contentLen|d`；
- 追加一行到 `chatmsg-<日期>.jsonl`（字段见 §2.2；usage 用 `inputTokens/outputTokens/cachedInputTokens`，timing 用 `waitDurationMs/outputDurationMs`）。

### 3.4 输出纪律

- 不清洗、不截断、不重排；raw 里 payload 是什么，文件里就是什么。

---

## 4. UI 桥层（dist/ui/dashboard/index.ui.js）实现要点

### 4.1 职责

1. 用 `WebViewController` 创建 WebView，加载 `preview/index.single.html`；
2. 注入 JS 接口：

```js
controller.addJavascriptInterface("CtxProbe", {
  report: async (payload) => { /* 写 ui_bridge 日志 */ },
  ping:   () => JSON.stringify({ from:"host", … }),
  api:    async (payloadJson) => {
    // 单参数协议（Android 桥接多参数会被合并）：{"m":"summary","section":…}
    const req = JSON.parse(payloadJson);
    const out = await dispatch(req);       // 见 4.2
    return JSON.stringify(out);
  }
});
```

3. 页面侧调用（前端 `data/bridge.ts`）：

```ts
const r = await (window as any).CtxProbe.api(JSON.stringify({ m: 'summary', ...extra }));
return JSON.parse(r);
```

### 4.2 桥方法（dispatch 分支）

| method | 作用 | 返回 |
|---|---|---|
| `summary` | 当前会话概览 + 当前上下文构成 | `{ok, session, cardName, current:{system,tools,user,inject,skill,profile,summary,assistant,tool,img?,total}, counts, toolsCount, worldbook, imgAttachments:{count,tokens}, historyCount}` |
| `timeline` | 逐轮上下文构成（趋势图数据） | `{ok, items:[{seq,turn,step,t,system,tools,user,inject,skill,summary,assistant,tool,total,historyCount}]}` |
| `messages` | 当前会话消息级 usage 列表 | `{ok, items:[{t,sentAt,input,output,cached,waitMs,outMs,roleName,model}]}` |
| `events` | 上下文事件（压缩点/模型切换） | `{ok, items:[…]}` |
| `fileActivity` | 文件活动聚合（v2：op 级 + 按路径聚合 + 锚点） | `{ok, total, entries:[{path,form,reads,writes,searches,added,removed,errs,ops:[{seq,kind,tool,path,added,removed,err,callIdx,resultIdx,read?,hits?,detail?,pattern?}],pattern?}], totals:{read/write/search/image:{files,ops},added,removed}, stats, items(legacy)}` |
| `toolUsage` | 工具调用统计 | `{ok, items:[…]}` |
| `rawSection` / `rawItem` | 上下文浏览器：分类列表 / 条目全文；`rawSection` 第 5 参 `focusIdx`=定位锚点（见 §4.3-⑩） | `{ok, kind, items/content, offset?, focusIdx?, focusMiss?, …}` |
| `todayMessages` | 跨会话「今天」的分组数据（今日花费） | `{ok, groups:[{session, base:{input,output,cached}, items:[…]}]}` |

### 4.3 关键算法（全部在前端或桥层实现）

**① estTok（估算，中文保守档）**：`tokens ≈ chars × 0.5`（即 ceil(chars/2)）。历史教训：早期用 /4 导致中文场景低估约 3 倍。

**② 上限保护**：任何构成总量估算值 > 960,000 时，按比例压缩到 960,000（`anchorTo`，1M 安全线）。

**③ 峰谷判定（DeepSeek 定价规则）**：

```js
cfg = { peaks: [{start:'09:00',end:'12:00'},{start:'14:00',end:'18:00'}], weekdaysOnly: true }
isOffpeakAt(cfg, d):
  if (weekdaysOnly && 周末) return true      // 周末全天谷时
  return !peaks.some(p => 时间在 p 内)        // 工作日：非峰即谷
// 支持跨零点窗口（st>en 时判断 cur>=st || cur<en）
```

**④ 会话费用（delta 算法）**：遍历消息（升序），逐条取增量并计费：

```js
dIn  = cur.input  >= last.input  ? cur.input  - last.input  : cur.input   // 处理重置
dOut = cur.output >= last.output ? cur.output - last.output : cur.output
dCached = cur.cached >= last.cached ? cur.cached - last.cached : cur.cached
tier = isOffpeakAt(cfg, new Date(cur.sentAt)) ? price.offpeak : price.peak   // 按消息发生时刻选峰/谷
cachePart = Math.min(dCached, dIn)
cost += ((dIn - cachePart) * tier.pin + cachePart * tier.pcache + dOut * tier.pout) / 1e6
```

**⑤ 今日花费（跨会话）**：读最近 3 个 chatmsg 文件 → 按会话分组 → 组内按 sentAt 升序 → `base`=今天 0 点前最后一条的累计值 → 今天的 items（按 sentAt 去重）→ 前端按组跑同样的 delta 求和。

**⑥ 图片 Token 估算（DeepSeek 官方「图片 Token 计算器」忠实移植）**，常量：`PATCH=14, DOWNSAMPLE=3, MAX=384, PAD=4, MIN_PIXELS=147456, MAX_WH_RATIO=8`；关键函数：
- `imgGridTokens(rows, cols)`：`rows*(cols+1)+2 (+cols+1 if rows odd) (+2 条件项)`；
- `imgSolveResize(h,w,budget)`：按网格求解最大可容纳缩放（含高图/宽图两个退化分支）；
- `safeResize`→ `calcResizeInner`（先按 MIN_PIXELS 放大/MAX_WH_RATIO 限宽，再 padding 到 14 网格、超预算逐 1 降 budget 迭代）→ `estimateImageTokens(w,h)` 迭代收敛；
- 官方验证样本（必须全过）：`2048×1365→313, 800×600→341, 2048×2048→349, 512×512→201, 100×100→117, 1920×1080→369, 400×900→249`；
- **读图片尺寸**：`Tools.Files.readBinary(path)` → 取 `contentBase64` 前 200000 字符 → 手写 base64→bytes → JPEG 扫 SOF0/1/2/3 段（`FF C0..C3`），PNG 读 IHDR（字节 16-24，大端）；结果缓存；读不到（文件已清理）按 350 估。
- **附件发现**：在消息 `content` 里正则找 `<attachment … type="image/…" …>`，取 `id="…"` 为文件路径。

**⑦ 世界书/技能/资料提取（从 SYSTEM 文本）**：
- 世界书：`<worldbook>…</worldbook>` 块 + `<entry name="…">` 名单；
- 技能段：从「包系统」标题行到 `<worldbook>` / `<user_profile>` / 下一个 `#` 标题之前；
- 用户资料：`<user_profile>` 块。

**⑧ raw 解析三件套**（重要坑）：文件内容是「折断过的 JSON」——解析顺序：① `text.replace(/\n/g,'')`（去真换行）② `JSON.parse(text, strict:false)`（容错非法控制字符/转义）③ 失败再尝试逐行容错。

**⑨ 快照 sys 回填（历史数据兼容）**：旧快照没有 `sys` 字段时——当全会话 SYSTEM 字符数恒定、且与当前 raw 中 SYSTEM 长度接近（±200）时，从 raw 提取 wb/sk/up 三个拆分值补齐。
**⑩ 定位锚点（W3，2026-09-16）**：`apiRawSection(key, section, offset, limit, focusIdx)`——`focusIdx` 为 preparedHistory 下标；命中 → 返回**含锚点的页**（回传 `offset`=页起点、`focusIdx`）；未命中 → `{items:[], focusMiss:true}`。页计算由纯函数 `fa2FocusPage(revIdxs, focusIdx, lim)` 完成（定义在 FILE_ACTIVITY_V2 段内，桥与 `tools/focus_check.js` 共用同一实现），倒序列表（最新在前）中 `offset = floor(pos/lim)*lim`。普通分页路径也回传 `offset`，前端「加载更多」以 `data.offset + items.length` 为基准（focus 页替换后分页不断链）。前端 `locateOp`：已加载直滚（零网络）→ `focusIdx` 一页直达 → result/call 双锚点回退 → `notice` 提示；`pendingFocus` 在 useEffect 消费（commit 后展开 + scrollIntoView）。锚点：`op.resultIdx`=配对上的 TOOL_RESULT 下标，`op.callIdx`=TOOL_CALL 下标。

---

## 5. 前端（React 页面）实现要点

### 5.1 技术栈与构建

- React 18 + TypeScript + Vite；无 UI 框架，全部手写样式（`lc-*` class 体系）。
- 构建：`npm run build`（产出 `dist/app.js + style.css + index.html`）→ `node inline.mjs dist`（把 JS/CSS 内联进 `index.single.html` 单文件）。
- 部署热更：把 `index.single.html` 复制到 `preview/` 目标路径即可（WebView 下次加载生效；页面内「刷新」按钮已接 `location.reload()` 整页重载）。

### 5.2 组件清单（web/src/client/components/）

| 组件 | 用途 | 关键点 |
|---|---|---|
| `stackedBar` | 构成条（当前上下文/浏览器 DNA） | 支持 `max`（窗口基准，如 1,000,000）、`free` 剩余空槽、`reserve` 压缩预留斜纹（0.8 处）、hover 联动、最小带宽 |
| `donut` | 环形图（构成/耗时） | 段→弧换算、中心大字 + 小字、hover 高亮（`hoverKey/onHoverKey`） |
| `trendChart` | 逐轮堆叠柱趋势 | 自适应 y 轴、轮次聚合（「步骤/轮次」切换保留：轮次=快照聚合，步骤=宿主从 raw 事后重建——快照每轮 1 条，无独立步骤数据，见坑 13）、全量/增量模式、选中/悬停联动、图片段（第十段，`img > 0` 时，见坑 16） |
| `legend` | 图例行 | 色点 + 名称 + 值，与条/环共享 hoverKey |
| `fileCard` | 文件活动卡（2026-09-16） | 上游形态：chips 筛选（五类+计数）、路径搜索、排序（次数/最新/路径）、meta 条（文件数 + 总 delta + 气泡说明）、文件行（form 图标/完整路径/徽章/delta/错误点）、点行展开操作日志（树轨）；窄屏折行走容器查询；操作行点击→定位联动（W3，2026-09-16）；时间显示留待后续窗口 |
| `viewkit` | 工具包（t/fmt/catLabel 等注入） | 所有组件通过 make*(kit) 工厂创建 |

### 5.3 页面卡片与顺序（最终验收版）

```
会话头（角色名 · chatId | 刷新 | 浅色）
设置（折叠，默认收起）：趋势图默认粒度/展示方式 · 文件活动默认排序 · 工具定义默认排序（W4）
统计行 1：轮次 | 步骤 | 工具调用 | 缓存命中%
统计行 2：活跃时长 | 模型等待 | 模型生成 | 回答数 | [峰/谷徽章] 估算花费（点击展开价格面板）
（展开）价格面板：今日花费 | 峰时时段输入 | 每模型峰/谷双价（自动保存）| 恢复默认价
上下文统计：Donut（总量中各类占比）+ 图例
当前上下文：≈X / 1.0M · Y%已用 + 1M 窗口条 + 明细九类 + 图片附件行（N 张 ≈X tokens）
上下文浏览器：10 个可展开分类（系统提示词/技能注入/世界书/用户资料/对话总结/工具定义/用户消息/助手消息/工具结果/全部历史）
耗时统计：Donut（模型等待/模型生成/工具与开销）+ 图例（时长 + 百分比）
趋势：堆叠柱（轮次聚合 + 全量/增量切换 + 图片段）；点柱详情 = 该轮占用条（StackedBar 铺满）+ 2 列颜色图例（各区块颜色区分，含图片段）
世界书 · 本轮注入 / 上下文事件 / 文件活动（chips + 路径搜索 + 排序 + 展开操作日志）/ 工具使用
```

### 5.4 数据加载与状态

- `hasBridge()` 检测 `window.CtxProbe`；无宿主（浏览器预览）时回退 demo 数据。
- 页面加载时 `Promise.all` 并发拉取：summary / timeline / messages / events / fileActivity / toolUsage / todayMessages。
- 展开价格面板时不重新拉数据（todayMessages 已随首屏加载）。
- 展开设置：`selected/hovered/hoverCat/hoverTiming/granularity/mode/browser.expanded`。

### 5.5 localStorage 键

| 键 | 内容 | 说明 |
|---|---|---|
| `dsh-prices-v2` | 价格配置 `{peaks:[], weekdaysOnly, models:{name:{peak:{pin,pcache,pout},offpeak:{…}}}}` | 改价自动保存 |
| `dsh-prefs-v1` | 用户偏好 `{granularity:'step'|'turn', mode:'total'|'delta', fileSort:'count'|'latest'|'path', toolSort:'size'|'count'|'name'}` | 各卡默认偏好（W4 设置卡；设置卡与卡内切换同源写回。granularity/mode=趋势，fileSort=文件卡已联动，toolSort 消费点见 W5） |

### 5.6 交互细节

- 花费格：点击 → 展开/收起价格面板；徽章实时显示当前时段（谷=绿 / 峰=橙）。
- 工具/消息条目：点击展开 → 再点收起（toggle）。
- 上下文浏览器条目：点击看全文（`rawItem`），分类头点击展开列表（`rawSection`）。
- 文件卡操作行：点击 → 定位联动（W3）——自动滚到浏览器卡、打开「工具结果」、直达并展开对应条目；未命中在列表上方提示（结果已被压缩裁剪）。
- - 趋势柱点击：详情卡显示该轮占用条（StackedBar 铺满）+ 2 列颜色图例（名称 ≈值 %），与「当前上下文」卡图例跨卡 hover 联动。
- 设置卡（W4）：头部卡后折叠条（默认收起）；展开四行偏好 chips（趋势粒度/展示方式、文件活动排序、工具定义排序）；改动即时生效 + localStorage 持久化；设置卡与各卡内切换按钮同源（同改同存）。
- 深浅色：`data-ds-dark-theme` 属性切换 + `dsh_dark` 记忆。

---

## 6. 价格与费用系统

### 6.1 默认价格（DeepSeek 官方，2026-09 核实，单位：元/百万 token）

| 模型 | 时段 | 缓存命中 | 输入(未命中) | 输出 |
|---|---|---|---|---|
| deepseek-flash | 峰 | 0.04 | 2 | 8 |
| deepseek-flash | 谷 | 0.02 | 1 | 4 |
| deepseek-v4-pro | 峰 | 0.30 | 9 | 27 |
| deepseek-v4-pro | 谷 | 0.15 | 4.5 | 13.5 |

### 6.2 峰谷规则（官方 2026-09）

- 峰时 = **北京时间工作日 09:00-12:00 与 14:00-18:00**（两个窗口）；
- 其余时间（含周末全天）为谷时（谷价 = 峰价一半）。

### 6.3 计费口径

- token 来源 = chatmsg 的官方 usage（`inputTokens` 含缓存命中部分，`cachedInputTokens` 为其中命中数）；
- 费用 = **会话累计**（delta 算法，§4.3-④）与**今日合计**（跨会话，§4.3-⑤）两个口径；
- 重要语义：**这是估算费用**（token × 价目表），对账以官方账单为准。

---

## 7. 已知坑与对策（复现时务必注意）

1. **`inputTokens` 是"消息级聚合"**：一条 AI 消息的 inputTokens = 该消息期间**全部 API 往返（含多轮工具调用）的输入合计**，不是"单次发送的上下文大小"。**不可**直接用它锚定"当前上下文"（曾产生 1.8M 超限的 bug）。它只适合做计费口径（delta 算法）与"单次量级"的旁证。
2. **WebView 静态加载**：页面文件是加载那一刻读取的；改版后需整页重载（「刷新」已接 `location.reload()`）。
3. **临时附件会被清理**：用户消息里的图片路径在 `cleanOnExit/` 下，历史附件文件可能已不存在——图片尺寸读不到时按 350 tokens 估；已实现（2026-09-15）：采集存 `imgPaths`、桥层按官方公式估算——见坑 16。
4. **raw 文件非法转义/控制字符**：`JSON.parse(strict:false)` + **先去真换行**（长行折断是写入时故意做的）。
5. **快照与消息的对齐**：快照（每轮）与 chatmsg（每条完成消息）数量≈1:1 但不保证严格对应；跨天/压缩后需容错。
6. **`sys` 拆分字段**：老快照没有 `wb/sk/up` 字段，需要从 raw 回填（见 §4.3-⑨）。
7. **host 侧 key 别名**：桥方法里的分类 key 与宿主键名可能不一致（例：世界书请求键 `inject`，宿主侧曾叫 `worldbook`——需要别名映射，否则返回空列表）。
8. **工具定义点击错绑**：浏览器里"工具定义"条目必须用 `tool:<index>` 前缀标记索引，从 availableTools 数组取数（否则会错拿到消息历史）。
9. **展开/收起 toggle**：展开后再点必须能收起（早期版本只开不收）。
10. **效率提醒**：部分 Operit 工具（如 `debug_install_toolpkg`）每次调用会返回全量包列表（单次 ~46k 字符 ≈ 23k tokens）——批量合并调用、减少次数，可显著节省上下文。
11. **时区**：所有"今天/峰谷"判定使用设备本地时区（北京），时间戳存毫秒 epoch。
12. **数据规模**：会话数据环形保留 100 个、日志 14 天，长期稳定在 ~10-50MB。
13. **快照粒度 = 每条用户消息 1 条**：`prompt_finalize`（含 send 阶段）只在用户消息触发的完整装配流程里触发；assistant 的工具往返请求**不触发**（实测：raw/快照文件在工具往返期间不更新）——快照里没有「每步」数据，「步骤」与「轮次」在数据上等价。**「轮次/步骤」切换器保留**：轮次=快照聚合视图；步骤=宿主从 raw 事后重建（2026-09-15 晚修正：此前文档写「已移除」，实际代码保留且正常使用）。若未来 Operit 提供逐请求级钩子，可恢复切换。
14. **轮号跨压缩续编**（2026-09-15）：快照的 `countByKind.USER` 是「当前留存窗口」内的用户消息数，上下文压缩后窗口重排、该计数骤降（实测一段序列 …16→2）。宿主 `apiTimeline` 不再直接用它当轮号，改为增量续编 `turnCounter`：增长按差值累加；压缩骤降视为新一轮 +1；同值视为同轮不同步骤。真实会话数据（69 条快照、含 3 次压缩）复算：旧算法 3 次回跳 → 新算法 0 次。**残留**：个别轮次采集端未写 send 阶段快照（原因见坑 15：系统警告类「虚拟轮」）；显示层已按「+1 吞变 + 红标」消化。
15. **轮号续编语义修订**（2026-09-15 晚）：增长从「按差值累加」改为「一律 +1」——系统警告类「虚拟轮」（app 崩溃残留、工具输出截断等，不写快照）不再让轮号跳格；被吞掉的个数记入该轮快照行的 `skip` 字段，趋势图在该柱标红「!N」（title 带说明）。全量数据离线复算：9 处旧跳变 → 0 跳变。老数据（警告原文已被上下文压缩清掉）无法再细分类型；有 raw 证据的窗口可细分（暂未实现）
16. **趋势图「图片段」数据链路**（2026-09-15 晚）：快照只记文本字符构成，图片 token 进不了趋势图（原待办②）。已实现方案：采集层 `collectSnapshot` 增 `imgPaths` 字段（扫 `preparedHistory` 里 `<attachment ... type="image...>` 的 id，去重，**只存路径、钩子零 IO**）；桥层 `apiTimeline` 用 `imgTokensOfPath`（含 `IMG_TOKEN_CACHE`）逐路径估算（复用 `imageSizeOf`/`estimateImageTokens`，文件读不到按 350/张），rec 补 `img`/`imgCount` 并计入 `total` 与 96 万上限保护（`anchorTo` keys 加 `"img"`）；前端趋势图按「第十段」渲染（stacked / delta 双向 arms / adaptive 缩放全链路，色 `IMG_COLOR`），详情卡加「图片」项，CSS 补 `data-catdim='img'` re-light 行。口径与「当前上下文」卡完全一致。**限制**：旧快照无 `imgPaths` → 旧轮无图片段（只能从部署后积累）；采集侧只记「留存窗口内」的附件（压缩后自动收缩）。。
17. **宿主 AI 的 edit_file 是「AI 式模糊匹配」**（2026-09-16）：old 块起止边界模糊时会**吞掉中间行或残留尾巴**（bridge.ts 实测被吞 2 处、残留 2 行）。大块精确改动用 `python str.replace`（先 `count==1` 断言）+ 脚本化写入，或整文件重写；每次编辑后必须跑语法/构建校验（esbuild / node --check / fa_check）。
18. **`<error>` 判定必须锚定结构位置**（2026-09-16）：桥 v2 旧实现「全文扫 `<error>` 字样」判错——读自身文档（正文含 `<error>` 示例文本）时误标错误红点。已改：`status="error"` 或结果**开头** `\s*<content>\s*<error>` 锚定正则（宿主桥 2.2.1）。全库 46 份 raw 复算：err 条目 24→21，减掉的全是误报、余下全为真错。**教训：内容里会包含标记语法的文本（文档/代码/日志），标签判定只认结构锚点。**
19. **定位联动的焦点页与分页基准**（2026-09-16，W3）：①「已加载直滚」快路径必须先查 `browser.data.items`（resultIdx、callIdx 两查）再决定是否重取；② focus 替换页后，旧「加载更多」按 `items.length` 算 offset 会**错位**——统一改 `data.offset + items.length`（普通路径桥也回传 offset）；③ `pendingFocus` 消费必须在 React commit 之后（useEffect 里、DOM ref 已挂载）再 `scrollIntoView`，在点击处理函数里直接滚会滚空；④ 迟到响应防串台用 `locateSeq` 序号（同 openSection / expandItem 守卫模式）。验证：`node tools/focus_check.js` 全库 47 份 raw / 1514 个锚点全部直达命中（含 miss 反例），`tools/w3_verify.cjs` mock 三场景 Pass。
20. **设置卡（W4，2026-09-16）**：四项偏好 granularity/mode/fileSort/toolSort。设计决策：① 形态=顶部（头部卡后）折叠条、默认收起——上游在设置页底部（桌面宿主），手机端改前置便于触达；② 选择交互用页面统一 chips（`.lc-gran-btn`）而非上游下拉菜单（无浮层组件问题、与外层控件同语言）；③ **写回语义=卡内切换也持久化**（与上游「卡内 mount-local 不回写」不同）——单机手机场景「上次选择保持」优于「每次回默认」，且设置卡与卡内按钮同源（一个 state）；④ fileSort 对文件卡**受控**（`FileCardProps.sort/onSortChange` 必传，App 持 state），设置改动即时联动；gran/mode 与趋势卡同理；⑤ **toolSort 消费点归 W5**（浏览器工具定义分类排序按钮），W4 只做持久化。验证：`tools/w4_verify.cjs`（Playwright+mock）14 检查全过，覆盖默认值/联动/刷新持久化。顺手修：fileCard `makeFileCard` 返回注解 `ReactElement→ReactNode`（memo 调用签名返回 ReactNode，tsc 的既有报错；vite build 不查类型所以一直未暴露）。**tsc 已知残余**：shared/types.ts 5 条上游类型引用报错（`../host/*`、`@deepseek-ai/*`，构建链不涉及，不修）。

---

## 8. 开发与部署流程（Operit 环境）

### 8.1 本地开发目录

```
/sdcard/Download/Operit/
├── dev_package/com.operit.prompt_viewer_ui_v2/   # ToolPkg 开发目录（改这里）
│   ├── manifest.json
│   └── dist/{main.js, ui/dashboard/index.ui.js}
└── projects/dsh-context-port/                    # 项目工作区
    ├── preview/index.single.html                 # 页面热更目标
    ├── github-repo/                              # 开源仓库本地副本
    └── DESIGN.md                                 # 本文档
```

### 8.2 两类部署

| 改动 | 部署方式 | 生效方式 |
|---|---|---|
| 采集层 / 桥层（main.js、index.ui.js） | `operit_editor:debug_install_toolpkg`（指向 dev_package 目录） | 重进插件 |
| 页面（index.single.html） | 复制到 `preview/` 目标 | 页面点「刷新」（整页重载） |

### 8.3 发布到 GitHub

- 仓库副本在 `projects/dsh-context-port/github-repo/`（git 或 GitHub API 上传皆可）；
- 同步文件：`assets/index.single.html`、`web/src/**`、`toolpkg/dist/**`；
- 凭证：GitHub token 存于 Operit 的 MCP 配置（`mcp-github-com-missionsquad-mcp-github` 的 `env.GITHUB_PERSONAL_ACCESS_TOKEN`），权限收紧到仅 `repo`。

---

## 9. 从零重建 Checklist（给重建方 AI）

**Stage 1 · 环境就绪**
- [ ] Operit 安装，确认 ToolPkg 开发能力（SandboxPackage_DEV types 可读）
- [ ] Node.js 环境（构建 React 页面用）

**Stage 2 · 采集层**
- [ ] 创建 ToolPkg（manifest + main.js），注册两个钩子（prompt_finalize / chat_message）
- [ ] 实现落盘：raw/meta/index + snapshots + chatmsg（字段见 §2.2），含超长行折断
- [ ] 实现数据治理：环形 100 会话 + 日志 14 天 + 孤儿清理
- [ ] 部署验证：对话几轮后检查数据目录文件生成

**Stage 3 · UI 桥层**
- [ ] index.ui.js：WebView + CtxProbe 注入 + dispatch（§4.2 全部方法）
- [ ] 实现全部算法：estTok / 上限保护 / 峰谷 / 费用 delta /今日花费 / 图片公式与读尺寸 / 世界书提取 / raw 解析
- [ ] 部署验证：桥方法逐个返回正确 JSON

**Stage 4 · 前端页面**
- [ ] Vite + React + TS 工程；实现组件（stackedBar/donut/trendChart/legend/fileCard）
- [ ] 实现卡片页（§5.3 顺序）与交互（§5.6）
- [ ] localStorage：价格配置 + 偏好持久化（granularity / mode / fileSort / toolSort —— W4 设置卡）
- [ ] 构建单文件并部署到 preview/，真机验收

**Stage 5 · 打磨与发布**
- [ ] 回归检查：工具点击/收起、世界书显示、费用单位（¥）、峰谷徽章、图片附件行、趋势图片段、1M 窗口条、耗时环、文件卡操作行定位联动（W3）
- [ ] 自检脚本：图片公式七个官方样本全过
- [ ] 开源合规：LICENSE（Apache-2.0）+ THIRD_PARTY_NOTICES + README 致谢上游（bowenliang123/dsh-context）与 DeepSeek 主题（MIT）
- [ ] 隐私检查：无个人路径/密钥/用户名残留

---

## 10. 上游致谢与许可

- 设计蓝本：**bowenliang123/dsh-context**（Apache-2.0）—— 环形图/堆叠条/趋势图组件、分类与 i18n 框架、`anchoredParts` 思想、图片 Token 公式等；
- 主题血统：DeepSeek Harness 客户端主题（MIT）；
- 本项目以 Apache-2.0 发布，衍生文件均带来源标注。

---

*文档完 · 由薇娅根据 2026-09-14 ~ 16 的完整开发过程整理*
