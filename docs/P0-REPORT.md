# P0 基线 diff 报告

> 日期：2026-11-23
> 基线：`bowenliang123/dsh-context` **v0.87.1**（tag，源码已解压到 `operit2-port/upstream/`）
> 对照：`MengXinSu/operit-context-dashboard` 2.10.0（`operit2-port/src-v1/`）
> 结论：**上游代码不能直接复用，必须按设计重实现。原估 P3 需要上调。**

---

## 一、量级差距

| 指标 | 上游 dsh-context 0.87.1 | operit 移植版 2.10.0 |
|---|---|---|
| `src/` 下 TS/TSX/CSS 文件 | **约 200 个** | **26 个** |
| 客户端组件 | 60+ 个（`client/components/`） | 4 个（donut / stackedBar / trendChart / fileCard） |
| 宿主逻辑 | 60+ 个（`host/`：fold、overview、fleet…） | 0（全塞在 `bridge.ts` 7.6 KB） |
| 主入口 | 按模块拆分 | `App.tsx` 单文件 **72.6 KB** |
| i18n | 8 语言拆文件（ja/ru 各 40–58 KB） | 单文件 28 KB |

两个月里上游从「6 个组件的小插件」长成了「200 文件的多面板产品」。**这不是一个可 merge 的岔路，是两个不同规模的代码库。**

---

## 二、Timeline 卡依赖闭包（核心证据）

上游 `client/components/timelineChart.tsx`（31.3 KB / 763 行）直接依赖 12 个模块：

| 依赖 | 体积 | 性质 | operit 侧有无对应 |
|---|---|---|---|
| `dna.ts` | 7.6 KB | DNA 条数据（依赖 `shared/assemble` 上下文组装树） | ❌ 无 `assemble` / `SurfaceNode` 模型 |
| `timelineDnaBars.tsx` | 6.9 KB | DNA 条渲染 | ❌ |
| `timelineMilestoneBand.tsx` | 3.2 KB | 里程碑旗标带 | ⚠️ 需新建 |
| `timelineMilestones.ts` | 9.7 KB | 里程碑聚合 + 优先级 | ⚠️ 需移植（依赖 `shared/milestones`） |
| `timelineMilestoneText.ts` | 5.2 KB | 里程碑文案/tooltip | ⚠️ 需移植（依赖 ViewKit + i18n key） |
| `milestoneIcons.tsx` | 3.4 KB | 15 种 kind 的颜色 + 图标 | ✅ 可直接抄（纯视觉） |
| `timelineModel.ts` | 4.9 KB | 预处理 / maxima / tooltip 行 | ⚠️ 需移植 |
| `timelineWindow.ts` | 1.5 KB | 虚拟窗口常量（BAR_W/BAR_GAP/overscan/hysteresis） | ⚠️ 需移植（**长会话性能关键**） |
| `timelineDurationCurve.tsx` | 0.8 KB | 时长曲线 | ⚠️ |
| `timelineReserved.tsx` | 0.9 KB | 压缩预留斜纹 | ⚠️ |
| `boundedCache.ts` | 6.0 KB | LRU 缓存 | ✅ 通用 |
| `revealScroll.ts` / `tip.ts` / `useElementMetrics.ts` | 2.5+2.6+3.3 KB | 滚动/提示/尺寸 | ✅ 通用工具 |

**结论**：Timeline 卡本体 + 依赖 ≈ **55 KB 上游代码**，其中一半以上依赖 dsh 专属模型（`assemble`、`ViewKit`、`RequestRecord.net`）。operit 版对应物是单个 `trendChart.tsx`（37 KB / 721 行），数据模型是自己那套（`total`/`prompt`/`brief`/`pIdx`/`skip`），**没有 DNA 所需的组装树**。

---

## 三、三栏清单

### ✅ 可直接复用（纯视觉/纯函数，不依赖 dsh 模型）

| 项 | 说明 |
|---|---|
| `milestoneIcons.tsx` | 15 种 kind 的颜色映射 + SVG 图形 |
| `styles/timelineMilestone.css`（3.8 KB） | flag 12×12、计数徽章、虚线 pole、菱形 foot、颜色混合公式 |
| `styles/timelineChart.css` 中的坐标/网格部分 | 需按 operit 的容器尺寸微调 |
| `timelineWindow.ts` 常量 | 窗口化渲染参数 |
| `boundedCache` / `revealScroll` / `tip` / `useElementMetrics` | 通用工具，改名即可 |

### ⚠️ 需改写后移植

| 项 | 改写原因 |
|---|---|
| 里程碑聚合（`timelineMilestones.ts` + `timelineMilestoneText.ts`） | 依赖上游 `ContextEventRecord` 的 13 种 kind；operit 侧只有 **5 种**（compaction/prune/inject/model/mode），缺 `todo-add`/`todo-done`/`ask`/`goal-*`/`team-task-*`/`agent` |
| Timeline 主图（`timelineChart.tsx`） | props 契约不同（上游有 `dna`/`dnaAt`/`deltaMaxima`/`onPickBand`/`hoverLock`/`selectedSeq`；operit 传 `markers` 数组） |
| 偏好卡（`settingsCard.tsx` + `settings.ts`） | 上游用 `@deepseek-ai/dsh-client-ui-primitives` 的 `Menu`；operit 不能依赖 dsh 的 UI 包，要用自己的 chips + localStorage。设置项从 4 项扩到 ~10 项 |
| 洞察页（`overviewPanel.tsx` 27 KB + `overviewSource.ts` 18.8 KB + 相关） | 依赖宿主侧 `host/overview*.ts` 的聚合缓存；operit 侧只能从 raw 文件重算，需要新的宿主聚合层 |

### ❌ 不适用（做不了或不该做）

| 项 | 原因 |
|---|---|
| **DNA 条** | 需要 `shared/assemble`（上下文组装树：`ContextHeaders` / `SurfaceNode`），operit 的 raw payload 是纯文本分段，没有这个模型。硬做只能假数据 |
| **Fleet / Agent 网络** | 依赖 dsh 的 agent 父子事件流（`host/fleet.ts` 27.6 KB）；Operit 插件拿不到 |
| **时长曲线** | 需要 host 侧 step 耗时事件，operit 只有请求级时间戳 |
| 多语言 8 套 | operit 版是中文单语，不扩 |
| `host/` 整个目录 | 这是 dsh 宿主适配层（fold 43 KB、overview 22.5 KB…），与 Operit 的 hook 模型完全不同 |

---

## 四、关键发现（影响计划）

1. **里程碑数据源缺口**
   上游徽章能显示 15 种事件，operit 侧目前只有 5 种。要做出徽章内容，必须在采集层（`main.js` hook）里**补解析工具调用**：从 `preparedHistory` 的 TOOL_CALL/TOOL_RESULT 中提取 todo / goal / ask 记录，转成 `ContextEventRecord`。
   → 这是原计划 P2 的实质内容，工作量约 **1 天**。

2. **Timeline 不只是"改名"**
   上游 Timeline = 柱图 + DNA 条 + 里程碑带 + 时长曲线 + 窗口化。若能接受砍掉 DNA 与时长曲线，最小版 = 柱图 + 里程碑带，仍是可观改动。

3. **窗口化渲染值得单独拿**
   上游为长会话做了虚拟窗口（`timelineWindow` + `useRowWindow` 22.9 KB）。operit 版 trendChart 是否已有类似保护需要确认 —— 手机端长会话（>200 步）首屏卡顿的根因很可能在这里。

4. **偏好卡是最便宜的一块**
   纯前端改动，不依赖数据模型，0.5 天可上。

---

## 五、修正后的 P3 排期

原估「P3 2–3 天」偏乐观，修正为：

| 子项 | 内容 | 估时 |
|---|---|---|
| P3-1 | 偏好卡扩项（4 → 10 项，沿用 chips 风格） | 0.5 天 |
| P3-2 | 里程碑采集（hook 解析 todo/goal/ask → event record） | 1 天 |
| P3-3 | 里程碑带 UI（照抄 CSS/图标 + 聚合逻辑改写） | 1 天 |
| P3-4 | Timeline 主图改名 + 计数徽章 + 窗口化 | 1–1.5 天 |
| **小计** | B 方案（不含洞察页） | **3.5–4 天** |
| P3-5 | 洞察页（跨会话聚合，需新宿主层） | +2–3 天 |

**修正后 B 方案总量：P0 0.5 + P1 0.5 + P3 3.5–4 + P4 1 + P5 1 ≈ 6.5–7 天**（原估 2–3 天，低估了「重实现」成本）。

---

## 六、下一步（P1 数据映射要回答的问题）

1. operit 的 raw payload 里，工具调用结果是否完整保留了 todo/goal/ask 的原始内容？
2. 长会话（>200 步）当前 trendChart 的实际渲染耗时是多少？是否已有窗口化？
3. 洞察页需要的跨会话聚合，从 raw 文件全量扫一遍要多久（手机端）？
4. operit 的 `ContextEventRecord` 能否原地扩展 kind 枚举，而不破坏页面渲染？

这 4 个问题答完，才能定 P3 的最终实现方式。

---

## 七、P1 初步数据探查（用本机 6 个真实会话完成一半）

样本：`%OPERIT_RUNTIME%\...\extensions\device\plugins\data\prompt_viewer\` 下 6 个 `raw_*.json`（34 KB – 881 KB，最长 588 条 history）。

### 已验证

| 项 | 结果 |
|---|---|
| payload 顶层字段 | `preparedHistory / chatHistory / availableTools / modelParameters / metadata / chatId / stage / functionType / rawInput / processedInput / promptFunctionType` —— 与 v2 `PromptHookEventPayload` 完全对得上 ✅ |
| history kind | TOOL_CALL / TOOL_RESULT / ASSISTANT / USER / SYSTEM（样本无 SUMMARY） |
| 工具调用格式 | XML 文本：`<tool name="..." call_id="..."><param name="x">...</param></tool>`，**可解析** |
| 工具结果格式 | `<tool_result name="..." status="success"><content>...</content></tool_result>`，**可解析** |
| `metadata` | 含 `chatId / executionContext / isSubTask / promptPreparationId / workspacePath` |

### 关键发现 1：真实工具名藏在参数里

样本里 `package_proxy` 出现 333 次（最高频）。真实工具名在：

```xml
<tool name="package_proxy"><param name="params">{...}</param><param name="tool_name">super_admin:bash</param></tool>
```

→ **工具使用统计/里程碑采集必须先解一层 `tool_name`**，否则统计结果全是 `package_proxy`，毫无意义。现有 v1 的「工具使用」卡是否已处理这一点，需要核对 `bridge.ts`。

### 关键发现 2：里程碑事件在样本中为 0

6 个会话里没有任何 `todo_add` / `create_goal` / `ask` 类工具调用（`plan_mode` / `goal_mode` 未启用或未使用）。含义：

- **采集路径是通的**（只要工具被调用就能从 XML 里解析出来）
- 但**没有真实样本可验证**，P3-3 做徽章时需要用户配合跑一次带 todo 的会话

### 关键发现 3：没有 `systemPrompt` 字段

payload 顶层没有 `systemPrompt` / `toolPrompt`（v1 类型里有）。样本里的系统提示词是以 `kind: "SYSTEM"` 的 turn 形式出现在 history 中（内容是角色卡设定）。

→ 上下文构成里的「系统提示词」段实际取自 SYSTEM turn，不是独立字段。做洞察页/构成时按这个口径。

### 待做（需要跑起来）

- 长会话（588 / 396 条 history）下 trendChart 的实际渲染耗时 —— 需在 PC 版打开面板实测
- 跨会话聚合耗时（6 个文件 2.2 MB，本地毫秒级；手机端待测）
- `ContextEventRecord.kind` 扩展是否影响页面渲染（TypeScript 层面无运行时校验，理论可扩）

