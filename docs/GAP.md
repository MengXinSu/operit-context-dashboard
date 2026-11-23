# GAP.md · Operit2 上下文仪表盘 ↔ dsh-context v0.87.1 差距盘点（P4-0）

> 只读盘点 · 2026-11-23 · 基线：`upstream/`（v0.87.1，200 个 TS 文件） vs `work/web/src/`（o2.4 实装）
> 结论前置：**当前实现是「单会话仪表盘」，上游已是「单会话 + 跨会话洞察页 + 入口矩阵」的产品。**
> 差距主因不在数据缺失（绝大多数要的东西 raw/chatmsg 里都有），而在**没有跨会话聚合层**、**时间线缺两个纯前端件**、**命令维度整块空白**。

---

## 0. 一句话结论

| 维度 | 判定 | 依据 |
|---|---|---|
| 数据可行性 | **好于预期** | 7 天双柱、热力图、会话卡片、命令 runs/failed、时长曲线全部可做（见附表） |
| 最大硬缺口 | **没有耗时/事件流** | 无 per-call 时间戳（`main.js:619`）→ 命令耗时、slowest、background、step 耗时一概不可得 |
| 最大软缺口 | **没有跨会话层** | 14 个 bridge 方法（`bridge.ts:92-261`）全是「当前会话」语义，只有 todayMessages/sessionUsage 越界 |
| 工作量分布 | **23 项 S/M、3 项 L、2 项不排期** | 上游大头（fold/backfill/overviewCorpus ≈ 3000 行服务端）在 Operit 侧不需要复刻 |

**已排除、不列入下表**（按约束）：Fleet/Agent 网络、DNA 条、8 语言 i18n、纯宿主事件流项（step 耗时/技能加载事件）。

---

## 1. 功能差距表（28 项）

> 批次：B1 第1批 / B2 第2批 / B3 第3批；「已做」= 现状已对齐，留作回归基准。

### A. 上下文洞察页（跨会话）

| # | 项 | 上游实现（文件:行号） | 我们现状 | 数据可行性 | 工作量 | 批次 |
|---|---|---|---|---|---|---|
| F1 | 跨会话 KPI 六格（会话数/Token/成本/命中率/工具调用/总时长） | `overviewPanel.tsx:312-344` | 无；只有本会话 4 格 + 5 格（`App.tsx:912-928`） | ✅ chatmsg 按 chatId 聚合 + `index.json` 会话清单；成本用现价表（`App.tsx:30-53`） | M | B2 |
| F2 | 7 天 Token/成本双柱图 | `overviewUsage.tsx:16-24`（窗口）、`:42-47`（高度）、`:66-109`（绘图） | 无 | ✅ chatmsg 按 `sentAt` 日聚合，三行代码出日桶 | S | B2 |
| F3 | 活动热力图（默认 8 周 × 7 天，sessions/tokens 双指标） | `heatmap.tsx:24-43`（网格）、`:45-52`（分级）、`:79-126`（渲染+图例） | 无 | ⚠️ tokens 只有 14 天（`main.js:116` RETAIN_LOG_DAYS=14）；**sessions 指标可用 `index.json` 的 capturedAtMs（最多 100 会话）撑满 8 周** → 建议默认 metric=sessions | M | B2 |
| F4 | 会话卡片（标题/相对时间/圆环构成/mini 统计/末条用户消息） | `overviewCard.tsx:8-26`（字段）、`:52-108`（卡片） | 无 | ⚠️ 无真标题：用 `index.json` 的 `preview`（末条 USER 前 40 字，`main.js:53-62`）；圆环需按卡懒读该会话 `raw_<key>.json`（单卡 ≈ 一份 payload） | M | B2 |
| F5 | 会话列表工具条（搜索/覆盖范围/排序/分组 chips/分页） | `overviewPanel.tsx:419`（搜索）、`:427`（coverage）、`:437`（排序）、`:450-466`（分组）、`:488-506`（分页） | 无 | ✅ 搜索/排序/分页可做；**分组维度缺 cwd**（raw 只有 chatId/isSubTask）→ 只能按「会话」分组或不做 | M | B3 |
| F6 | 跨会话 工具/命令/技能 tally（次数 + 会话数 + 占比条） | `overviewTally.tsx:33-73`（TallyRow 条）、`:121-167`（卡）；`overviewSkills.tsx:1-230` | 只有本会话「工具使用」一行 chips（`App.tsx:1280-1297`） | ⚠️ 需扫全部 `raw_<key>.json`（≤100 份，每份 400 字符折行）→ 必须做内存缓存 + 懒加载，否则首屏秒级卡顿 | L | B3 |
| F7 | 洞察页入口（主页面 slot + 侧栏图标） | `insightPage.ts:12-33`；`index.ts:131-138` | 无（单 UI 路由，`main.js:1180-1194`） | ✅ Operit2 `registerUiRoute` + `registerNavigationEntry`（`v2_toolpkg.d.ts:2713-2746, 2788-2827`）；页面本体建议先在单页内加 Tab（S） | S | B2 |
| F8 | 数据覆盖/回填状态提示（fold 进度、失败会话） | `overviewPanel.tsx:163-188`、`:271-285`；`overviewSource.ts:434-447` | 无 | ✅ 可算「索引 N 会话 / chatmsg M 天」的覆盖率条，不需要 backfill 机器 | M | B3 |

### B. 时间线（Timeline）

| # | 项 | 上游实现（文件:行号） | 我们现状 | 数据可行性 | 工作量 | 批次 |
|---|---|---|---|---|---|---|
| F9 | bar 虚拟窗口化（BAR_W/overscan/hysteresis/pads） | `timelineWindow.ts:1-39`；`timelineChart.tsx:388-430`（计算窗口）、`:672-697`（两侧 pad） | **全量渲染**（`trendChart.tsx:608-716`，无窗口） | ✅ 纯函数移植，不碰数据 | S | B1 |
| F10 | 时长曲线（多段 polyline + 点）+ 右侧时长轴 | `timelineChart.tsx:179`（开关）、`:699-706`（绘制）、`:751-759`（右轴）；`timelineDurationCurve.tsx:10-27` | 无 | ✅ chatmsg 每条消息带 `waitMs/outMs`（`main.js:1152-1153`）→ 按轮求和即「该轮活跃 ms」 | S | B1 |
| F11 | 里程碑旗标带（kind 图标 + 计数 + 优先级 + 图内顶部） | `timelineMilestoneBand.tsx:1-76`；`timelineMilestones.ts:1-276`；`milestoneIcons.tsx:4-121` | **已有** `milestoneBand.tsx`(303) + `milestoneBand.css`(187)，含 11 种 kind 配色 | ✅ 已对齐（种类受采集限制：无 todo/goal 工具时那些 kind 天然为 0，`main.js:621`） | — | 已做 |
| F12 | 请求详情卡（构成条 + brief + 与上一步对比 + 会话预览 + 定位） | `requestDetail.tsx:1-203` | 内联块（`App.tsx:1170-1202`）+ `BriefSection`（`App.tsx:398-455`） | ✅ 缺「prev 对比」与「会话预览」两块，其余已有 | M | B3 |
| F13 | fit 总览带（ribbon 分类色带 + 四分位旗 + 里程碑点选） | `timelineOverview.tsx:59-134`（几何）、`:165-450`（渲染） | 无；只有 adaptive 轴缩放（`trendChart.tsx:293-363`） | ✅ requests 现成；难点是几何，不是数据 | M | B3 |

### C. 命令 / 事件

| # | 项 | 上游实现（文件:行号） | 我们现状 | 数据可行性 | 工作量 | 批次 |
|---|---|---|---|---|---|---|
| F14 | `/context` 命令（输入 `/` 触发，打开弹窗） | `command.ts:9-41`（trigger source）；`contextModal.tsx:131-176`（portal + backdrop + 卡） | 无 | ⚠️ **弹窗不可复刻**：`registerCoreCommand` 只能返回 `{stdout,stderr,json}`（`v2_toolpkg.d.ts:1464-1482, 3801-3830`）→ 只能做**文本版 /context**；要「弹窗」得靠导航入口打开 UI 路由 | M | B2 |
| F15 | 消息级「看本轮上下文」跳转按钮 | `contextJump.tsx:38-71` | 无 | ✅ `registerChatMessageMenuItem`（`v2_toolpkg.d.ts:4602`）+ `chat_message_after` 导航面 | S | B2 |
| F16 | 命令统计 rail（runs / failed / 总耗时 / background + attention 四条） | `commandPanel.tsx:284-302`（KPI）；`:304-325`（attention）；`commands.ts:102-113`（tally）、`:148-186`（attention） | 无 | ⚠️ runs/failed/程序/repeats ✅（`super_admin:bash` 调用 + `status="error"`，解析已在 `dashboard/index.ui.js:1119-1126`）；**总耗时/slowest/background/killed ❌**（无起止时间、无 bg 标记） | M | B2 |
| F17 | 命令列表（all/failed/slow/bg 过滤、latest/slowest 排序、程序侧栏、语法高亮、结果预览、渐进回填） | `commandPanel.tsx:58,155-175,260-281`；`useCommandLog.ts:81-119` | 无 | ⚠️ 过滤/搜索/程序/结果预览 ✅；slow/slowest ❌；语法高亮⚠️（需引 bash/pwsh 高亮器，可延后） | L | B3 |
| F18 | 事件卡（单选过滤 + inject/prune/skill/agent 种类 + 相对时间 + 点击跳转） | `events.tsx:15-19`（种类）、`:74-129`（文案） | 3 类**多选**（`App.tsx:208`、`:1230-1237`） | ⚠️ UI 可立刻改成单选取代；新增 kind 需采集层补（现 `apiEvents` 只产 compaction/model/warn） | S | B1 |

### D. 上下文浏览器

| # | 项 | 上游实现（文件:行号） | 我们现状 | 数据可行性 | 工作量 | 批次 |
|---|---|---|---|---|---|---|
| F19 | delta 模式（选基准步/轮，显示增/删条数与 token 差） | `browser.tsx:804-844`（基准+模式切换）、`:843-910`（delta 条） | 无 | ✅ `historyCount/historyChars` + 前后两份 raw 的 `preparedHistory` 可比 | L | B3 |
| F20 | treemap「地图」模式 | `browserTreemap.tsx:107-247`；`treemap.ts:152` | 无 | ✅ 纯布局算法，输入只要分类 token | M | B3 |
| F21 | 逐类搜索 / kind 过滤 / 行虚拟滚动 / 键盘导航 | `browser.tsx:659-698`（搜索+kind+排序）、`:912-937`（flat 列表+窗口） | 只有「工具定义」排序 + 每页 10 条 + 加载更多（`App.tsx:1089,1111`） | ✅ 数据都在，纯前端 | M | B1（搜索）/ B3（虚拟滚动） |
| F22 | 工具卡（插件来源徽章 + 命中次数 + 调用参数 + 结果卡） | `browserToolCard.tsx:282` | 预览 + 全文（`App.tsx:1099-1109`） | ⚠️ 插件来源可从工具名/`availableTools` 推断（部分可做） | M | B3 |

### E. 统计 / 设置 / 外壳

| # | 项 | 上游实现（文件:行号） | 我们现状 | 数据可行性 | 工作量 | 批次 |
|---|---|---|---|---|---|---|
| F23 | 上下文统计卡（IO ledger：文件/工具/命令 + 成本格 `?` 提示 + 跳转） | `statsContext.tsx:398-496` | 4 格（轮/步/调用/命中）+ 5 格（时长/等待/生成/回答/成本），`App.tsx:912-928` | ⚠️ 文件/工具已有；命令格依赖 F16；成本提示已有价格表，可直接搬 | M | B2 |
| F24 | Token 四桶卡（缓存读/写 + 未缓存 + 输出 + 占比） | `statsTokens.tsx:1-70` | 计费 donut：input/output/cached 三桶（`App.tsx:723-734`） | ⚠️ chatmsg **无 cacheWrite**（`main.js:1145-1147`）→ 只能三桶 + 标注「缓存写未采集」 | S | B2 |
| F25 | 插件信息卡（名称/版本/更新提示/设置入口/仓库链接） | `pluginInfo.tsx:31-63` | 页脚一行版本串（`App.tsx:1377-1379`） | ⚠️ 版本可硬编码；**更新检查无接口** → 只做版本+设置入口 | S | B1 |
| F26 | 设置卡 13 项（含 deltaBase / durationCurve / overviewRange / insightsEntry / prompt 前后缀） | `settings.ts:20-36`（字段）、`:92`（默认值）；`settingsCard.tsx:296` | 8 项（`App.tsx:1301-1375`） | ✅ deltaBase/durationCurve/overviewRange/insightsEntry 纯本地加；prompt 前后缀 ⚠️ 需 `registerSystemPromptComposeHook`（可延后） | M | B2 |
| F27 | 骨架屏 / ErrorBoundary / 懒挂载 | `skeleton.tsx:29`；`cardSkeletons.tsx:105`；`errorBoundary.tsx:36`；`useLazyMount.ts:41` | 「读取中…」纯文本；无错误边界 | ✅ 纯前端 | M | B3 |
| F28 | 余额胶囊 / 更新胶囊 | `balanceCapsule.tsx:39`；`updatePill.tsx:32` | 无 | ❌ 无宿主账户余额与版本 API → **不做余额**（版本号并入 F25） | — | 不做 |

---

## 2. UI 差距表（16 项）

| # | 项 | 上游做法 | 我们现状 | 差异说明 | 工作量 |
|---|---|---|---|---|---|
| U1 | 卡片标题图标 | 28 处 `size={14}` 图标前缀（`IconData/IconGauge/IconSettings/IconApi/IconInspect/IconContextInjection`，见各卡 title） | 纯文字标题（`App.tsx:970-1032` 等） | 扫读时缺视觉锚点，一眼分不清卡片类型 | S |
| U2 | 统计格自适应 | `repeat(auto-fit, minmax(108px,1fr))`（`stats.css:94` 注释 + `statsContext.tsx:475`） | 硬编码 `repeat(4,1fr)` / `repeat(5,1fr)`（`App.tsx:912,920`） | 390px 手机 5 列每格 ≈70px，长标签必挤 | S |
| U3 | 页头形态 | 主 tab 无页头、卡片即内容；洞察页有 `20px` 标题页头（`overview.css:5-7`） | 一条工具栏卡（`App.tsx:896-908`）+ `max-width:1200px` 居中（`app.css:17-22`） | 需定性：工具栏是留、还是并进页头；1200 居中与上游全宽 pane 语义不同 | S/M |
| U4 | 统一 tooltip | `data-lc-tip`（10 处）+ `.lc-tip`（22 处）+ `hoverTip.tsx:140` 全局气泡 | 原生 `title` + 2 处 `.lc-tip` | 长文本、多行价格、图表点信息都靠原生 title（延迟、不可样式化） | M |
| U5 | 骨架屏 | `skeleton.tsx` / `cardSkeletons.tsx` / `.lc-skel-*`（`base.css:67-84`） | 无（8 处 `lc-skel` 在 upstream，我们 0 处） | 首次加载是「空 → 蹦出」 | M |
| U6 | 懒挂载 | `useLazyMount.ts:41`（below-fold 才挂） | 一次全渲染 | 长会话首帧成本全压在一起 | M |
| U7 | 里程碑位置 | 图内顶部旗标（`timelineChart.tsx:707-717`；`timelineChart.css:61-62`） | 图上方独立一条带（`App.tsx:1141-1148`） | 旗标与柱子不共轴，点旗子跳转的「横向对齐感」弱 | S/M |
| U8 | 命令面板双栏 | rail（KPI+attention+程序侧栏）+ 列表（`commandPanel.tsx:284-330`） | 无 | 依赖 F16，先不铺 UI | L |
| U9 | 浏览器三态 + delta 条 | `cat` 折叠 / `flat` 全量 / `map` treemap，顶部 delta bar（`browser.tsx:843-844,912-940`） | 单折叠列表 | 长历史只能「加载更多」翻 | M/L |
| U10 | 分页器 | `‹ n/m ›`（`overview.css:200-205`） | 「加载更多（已显示 3/57）」按钮（`App.tsx:1111-1113`） | 上游可跳页，我们只能往下追加 | S |
| U11 | 会话/条目 hover 反馈 | `.lc-ov-session:hover` 阴影+描边+底色（`overview.css:174-177`）；条目 hover 底色（`browser.tsx:465`） | 行 hover 基本无变化 | 可点区域不可感知 | S |
| U12 | 键盘可达性 | 31 处 `focus-visible`、24 处 `tabIndex`（含柱/行/翻页键盘操作） | 3 处 `focus-visible`、0 处 `tabIndex` | 键盘/无障碍几乎不可用 | M |
| U13 | 触控目标 | `@media (pointer:coarse)` 3 处（`base.css:45`、`overview.css:204`、`modal.css:6`，按钮最小 24px） | 0 处 | 手机点小的 `lc-gran-btn` 易误触 | S |
| U14 | 语义色板一致性 | `CAT_COLOR` / `nameColorOf` 统一取色（`categories.ts`、`nameColor.ts`） | `BROWSER_CATS` 手写 10 个色（`App.tsx:210-222`） | 同一分类在图/表/浏览器可能出现两种色 | S |
| U15 | 数字排版 | `tabular-nums` 广泛用于数值（`overview.css:185` 等 20+ 处） | 仅少数处 | 数字列对不齐，扫表困难 | S |
| U16 | 深浅主题来源 | 跟随宿主 `data-ds-dark-theme` | WebView 内自管 + 工具条/设置卡双入口（`App.tsx:906-907,1366-1372`） | 移植必需，**保留现状**，只需与 F26 主题项合并入口 | — |

---

## 3. 风格差距表（CSS 变量/类级，18 项）

> 关键结构差异：上游有 **`--lc-*` 设计 token 层**（深浅两套值，`base.css:2-18`），我们的 `base.css` **一个 `--lc-*` 变量都没有**（全量 grep 为 0），所有尺寸/描边/阴影都是字面值。

| # | 项 | 上游 | 我们 | 差异 | 工作量 |
|---|---|---|---|---|---|
| S1 | 间距变量 `--lc-gap` | 深 7px / 浅 9px（`base.css:2,8`），卡 margin 与 `lc-cols` gap 全用它 | 字面 `7px`（`base.css:62-63`） | 深浅两套节奏丢失，改一处要改多处 | S |
| S2 | 画布变量 `--lc-canvas` | 深色透明 / 浅色 `neutral-bluish-75`（`base.css:9`） | `app.css:9` 直接用 `bg-base` | 浅色下卡片与背景无层次 | S |
| S3 | 描边变量 `--lc-line-fine/strong/dashed` | `0.5px` 三档（`base.css:12-14`） | 统一 `1px solid`（`base.css:41,68`） | 描边偏粗，密集列表显脏 | S |
| S4 | 阴影变量 `--lc-shadow-card/tile/hover` | 浅色卡有阴影（`base.css:15-17,23`） | 无 | 浅色模式卡片「贴平」 | S |
| S5 | 卡片圆角/标题分隔线 | 深 10px / 浅 12px + 标题下 `0.5px` 分隔线（`base.css:22,29`） | 恒 10px、无分隔线（`base.css:41`） | 浅色观感与上游差一档 | S |
| S6 | 卡片内 padding | 深 `7px 8px` / 浅 `8px 9px`（`base.css:24,27`） | 恒 `7px 8px` | 同上 | S |
| S7 | tab 根 padding | `var(--lc-gap)` = 7~9px（`base.css:19`） | `16px 20px 32px`（`base.css:10`） | 手机上四周留白比上游大一倍 | S |
| S8 | 分段按钮 hover | 背景+文字双过渡（`base.css:40-42`） | 只过渡 `color`（`base.css:75-76`） | 点按反馈弱 | S |
| S9 | 分段轨道 | `--lc-control-track` 背景 + 0.5px 描边（`base.css:34`） | `bg-layer-2` + 1px（`base.css:68`） | 选中态对比不如上游 | S |
| S10 | 动效 token | `--animate-lc-donut-in/stacked-in/bar-in` + `motion-reduce`（`tailwind.css:73-82`） | **已完整移植**（`tailwind.css:73-86`） | 已对齐 ✅ | — |
| S11 | 里程碑旗样式 | `.lc-timeline-flag` 1px pole + 10px 标签（`timelineChart.css:61-62`） | 自建 `.lc-ms-*`（`milestoneBand.css` 187 行） | 形态不同（独立带 vs 图内），非缺失 | — |
| S12 | 图表 fit 模式样式 | `.lc-chart-fit/.lc-fit-svg/.lc-fit-cursor/.lc-fit-wash`（`timelineChart.css:68-78`） | 无 | 依赖 F13 | M |
| S13 | 洞察页整套 | `.lc-ov-*` 205 行（`overview.css:1-205`） | 无 `overview.css` | 依赖 F1-F7 | M |
| S14 | 热力图样式 | `.lc-heat-*`（`overview.css:94-124`，含容器查询折叠星期标签） | 无 | 依赖 F3 | S |
| S15 | 命令面板样式 | `.lc-cmd-*` 100 行（`commandPanel.css`） | 无 | 依赖 F16 | M |
| S16 | 浏览器样式表 | `.lc-br-*` 111 行（`browser.css`） | **零 CSS 文件**：浏览器全内联 `style`（`App.tsx:1079-1120`） | 主题化/hover/焦点全无着力点 | M |
| S17 | 弹窗样式 | `.lc-modal-*`（`modal.css:1-15`，圆角 12、mask、`min(33.333%+480px)`） | 无 | 依赖 F14 | S |
| S18 | 交互密度 | `transition:` 80 处、`focus-visible` 31 处、`@container` 33 处 | 22 / 4 / 1（仅 `settings.css:14`） | 整体「手感」差一档；容器查询基本没用起来 | M |

---

## 4. 重点分析（用户最关心的五个问题）

### 4.1 上下文洞察页 —— 能做 70%，成本分层明显

上游是**服务端聚合**：`host/overview.ts:48` 一条 `/api/dsh-context/overview` 路由，按 `parts = summary|days|page|tally|projects`（`overview.ts:68`）分块返回，背后是 `overviewCorpus`(598) + `overviewCache`(574) + `overviewAggregate`(425) + `backfill`(725) + `fold`(964) 的机器，客户端 30s 轮询（`overviewSource.ts:14`）。**这套机器我们不需要复刻**——但也要接受它的替代品只能是「有界聚合」。

| 上游块 | 我们的数据 | 判断 | 成本 |
|---|---|---|---|
| KPI 六格 | chatmsg(14d) + `index.json`(≤100 会话) | ✅ | 一次遍历 ≈ 万行级，毫秒~百毫秒 |
| 7 天双柱 | chatmsg `sentAt/inputTokens/cachedInputTokens/outputTokens/modelName` | ✅ | 同上，共用一次遍历 |
| 热力图 | tokens 只 14 天；**sessions 用 index `capturedAtMs`** | ⚠️ 双指标不同窗口，需在 UI 注明 | 索引已在磁盘，读一次 |
| 会话卡片 | 索引给 key/preview/chars/时间；**构成圆环需读该会话 raw** | ⚠️ 必须按卡懒加载（一屏 12 张 = 12 份 raw） | 每卡 ~几十 ms，可缓存 |
| 工具/命令 tally | 需扫全部 100 份 raw | ⚠️ 唯一「贵」的块 | 首屏不做，进页面后异步回填 |
| 项目维度 | 无 cwd | ❌ 不做（用「会话」维度替） | — |

**聚合成本结论**：`summary/days` 一个纯函数 + 一次 `Tools.Files.list` 就能出，**S/M 级**；`page`（会话卡）**M 级**；`tally/projects` 是唯一的 **L 级**，因为它要读全部 raw，且 raw 是 400 字符折行的文本，解析成本远高于 chatmsg。**建议 v1 只做前三块，tally 放第 3 批。**

### 4.2 Timeline 完整形态 —— 缺的都是「前端件」，数据够

| 上游件 | 判定 | 说明 |
|---|---|---|
| 时长曲线 `timelineDurationCurve.tsx:10-27` + 右轴 `timelineChart.tsx:751-759` | ✅ 可做 | 上游取「每请求活跃 ms」；我们用该轮所有消息的 `waitMs+outMs` 求和，口径一致（`main.js:1152-1153`） |
| 窗口化 `timelineWindow.ts:1-39` | ✅ 可做 | 纯常量+纯函数，搬过来即可；**我们最该先补的一块**（`trendChart.tsx:608-716` 目前全量渲染） |
| 里程碑带 | ✅ 已有 | `milestoneBand.tsx` + 11 种 kind 配色，功能不低于上游 |
| fit 总览带 `timelineOverview.tsx:59-134` | ✅ 可做但偏贵 | ribbon 几何 + 四分位旗 + 点选，M 级；收益是「长会话全局感」 |
| 起势动画上限 `RISE_CAP=200`（`timelineChart.tsx:21,364`） | ✅ 可做 | 长会话逐柱入场会卡；一行常量 |
| DNA 条 | ❌ 不做 | 无 assemble 组装树（已排除） |
| step 精确耗时 | ❌ 不做 | 无 per-call 时间戳（`main.js:619`） |

### 4.3 `/context` 命令 —— 文本版可复刻，弹窗不可

- 上游：`command.ts:9-41` 注册 `/` 触发源，选中后 `modalStoreOf(sessionId).set(true)` 打开 overlay（`index.ts:120-129`），弹窗体是 `CurrentComposition + ContextBrowser`（`contextModal.tsx:145-168`）。
- Operit2：`CoreCommandRegistration`（`v2_toolpkg.d.ts:3801-3830`）的回调只能返回 `CoreCommandResult{stdout,stderr,json}`（`:1464-1482`）——**没有任何打开 UI 的能力**。
- 结论：`/context` 能做成 **「打印一份文本/Markdown 上下文构成报告」**（九段 token、占比、可用窗口、压缩预留、里程碑摘要），M 级且真有用；**弹窗形态必须走导航入口**（`chat_sidebar_tabs` / `chat_input_menu`，`:2788`）另开 UI 路由。别承诺「/context 弹窗」。

### 4.4 命令执行统计 —— 能从 bash 调用解析出「次数/失败/程序」，解析不出「耗时」

- 数据：`preparedHistory` 里 `TOOL_CALL` 是 `<tool name="pkg:tool" call_id><param …>`，`package_proxy` 真名在 `tool_name`（`main.js:610-618`）；`TOOL_RESULT` 带 `status="success|error"`（`main.js:617`），**且失败判定已经有现成实现**（`dashboard/index.ui.js:1119-1126`：`status==='error'` 或 `<error>` 内容）。
- 可得：runs、failed/failedByProgram、命令文本、程序名（首 token）、repeats、按程序搜索与过滤、点击定位到工具结果条目。
- 不可得：**耗时/总耗时/slowest/slow 过滤**（无起止时间）、**background**（无 `run_in_background` 标记，只能从 `&`/`nohup` 猜，不建议）、killed（无状态流）。
- 结论：**v1 做「runs/failed/程序/repeats + 定位」，删掉 rail 里的总耗时格与 slow 过滤**，工作量 M；不要为了对齐上游去造假的时长。

### 4.5 上下文浏览器 —— 我们差在「模式 + 检索」，不在「展开」

现状：10 个分类折叠 + 单条展开全文 + 工具定义三向排序 + 每页 10 条加载更多 + 定位联动（`App.tsx:1064-1125`）。
上游多的：`delta` 模式（基准步/轮 + 增删计数 + token 差，`browser.tsx:804-910`）、`flat`/`map` 三态（`:912-940`、`browserTreemap.tsx`）、逐类搜索 + kind 过滤（`:659-698`）、行虚拟滚动（`:912-937`）、工具插件来源徽章（`browserToolCard.tsx`）。
可按性价比拆：**逐类搜索 + kind 过滤**（S/M，B1）→ **treemap**（M，B3）→ **delta 模式**（L，B3，需要双快照对比与基准选择器）。

---

## 5. 分批建议

### 第 1 批 · 当天可交付、低风险（5 项）
1. **F9 时间线 bar 虚拟窗口化**（`timelineWindow.ts` 移植）——长会话不再一次性渲染千根柱。
2. **F10 时长曲线 + 右轴**——每轮活跃时长的「慢点」可视化，数据现成。
3. **F18 事件卡改造**（单选取代多选 + 计数 + 采集补 inject/prune/skill/agent kind）。
4. **S1-S9 风格 token 层 + U13/U12 触控与焦点**（`--lc-*` 变量、`pointer:coarse`、`focus-visible`、浅色圆角/阴影）。
5. **U1/U2/U14/F25 UI 打磨三连**（卡标题图标、统计格 `auto-fit`、色板统一、插件信息卡）。

### 第 2 批 · 中期（5 项）
1. **F1-F4 + F7 洞察页 v1**：今日/7 天，KPI + 双柱 + 热力图（默认 sessions）+ 会话卡前 12 张（懒加载圆环）。
2. **F16 + F23 命令执行统计 v1**：runs/failed/程序/repeats + 定位，删掉耗时类格子；顺带补上下文统计卡的「命令格」。
3. **F14 + F15 入口矩阵**：文本版 `/context` + `chat_input_menu`/`chat_sidebar_tabs` 入口 + 消息级跳转按钮。
4. **F24 Token 三桶卡 + 成本提示**（缓存写未采集需显式标注）。
5. **F26 设置卡补齐 4 项**（deltaBase / durationCurve / overviewRange / insightsEntry）。

### 第 3 批 · 大件（5 项）
1. **F6 + F5 + F8 洞察页 v2**：跨会话 tally（全量扫 raw + 缓存）、搜索/排序/分页、数据覆盖状态。
2. **F19 浏览器 delta 模式**（基准步/轮 + 增删/token 差）——与时间线「选轮」联动。
3. **F20 + F21 浏览器 treemap + 逐类检索/虚拟滚动**。
4. **F17 命令面板 v2**（过滤/搜索/结果预览/渐进回填）+ **U8 双栏 rail**。
5. **F13 + F12 + F27**：fit 总览带、请求详情组件化、骨架屏/懒挂载/错误边界。

---

## 6. 三条「最值得先做」的判断

**① 先修时间线（F9 窗口化 + F10 时长曲线）——决定「能不能长期开着看」**
用户视角：仪表盘的价值是「回看长会话找问题」。现在（`trendChart.tsx:608-716` 全量渲染）会话一长，面板滚动/交互就开始卡；而「哪一轮慢」正是最常问的问题，数据（`waitMs/outMs`）一条不缺、零采集成本。这两项加起来 **S+S**，是整份清单里性价比最高的组合。

**② 再做洞察页 v1（F1-F4+F7）——这是「跟上上游」最显眼的空位，且数据 100% 现成**
用户视角：现在这个仪表盘只能看「当前这一轮对话」，一换会话就全丢；上游最有存在感的能力恰恰是「昨天/这周花了多少、哪几个会话在烧上下文」。`chatmsg` 14 天 + `index.json` 100 会话足以支撑今日/7 天视图，**S/M 级**；唯一要守的纪律是**有界聚合**（分层：summary/days 同步算，tally 异步回填），否则会把首屏拖死。

**③ 第三条：命令执行统计 v1（F16 精简版）——补结构性空缺，且几乎不用新采集**
用户视角：现在工具调用只能在「上下文浏览器」里当文本看，没有任何「这个命令跑了几次、哪个程序老失败」的视角；而这正是排查「Agent 在反复试同一条命令」的直接证据。解析基建已就绪（`main.js:610-618` 解 proxy、`dashboard/index.ui.js:1119-1126` 判 error），**M 级**即可上线；代价是必须诚实地**不做耗时**——这比做一条假曲线强。

---

## 附：数据源事实卡（判定依据，可直接复核）

| 事实 | 出处 |
|---|---|
| 输出目录、raw/meta/events 按 `chatId.slice(0,8)` 命名 | `work/toolpkg/dist/main.js:35,40-51` |
| 会话环形保留 100 个；日志类按天保留 14 天 | `main.js:115-116` |
| `index.json` 每条 = `{key, chatId, capturedAt, capturedAtMs, preview, chars, lines}`；unshift 到最前 | `main.js:419-427` |
| `preview` = 末条 USER 消息前 40 字（**没有会话标题**） | `main.js:53-62` |
| chatmsg 行字段：session(8)/chatId/roleName/inputTokens/outputTokens/cachedInputTokens/**waitMs/outMs**/sentAt/completedAt/modelName/provider/done | `main.js:1137-1156` |
| snapshots 行字段：historyCount/historyChars/charsByKind/countByKind/**sys{wb,sk,up}**/imgPaths | `main.js:590-605` |
| **无 per-call 时间戳**，事件 time 取抓取时刻（`timeSource:"capture"`） | `main.js:619-620` |
| 当前 availableTools 21 个核心工具，无 todo/goal/ask/team → 相关里程碑天然 0 条 | `main.js:621` |
| 里程碑 kind 实产：todo-add/todo-done/ask/team-task-create/team-task-complete/agent/skill | `main.js:772-863` |
| `package_proxy` 解包（真名在 `tool_name`）、`TOOL_RESULT` 带 `status` 属性 | `main.js:610-618`；`main.js:677-695` |
| 失败判定现成实现（`status==='error'` 或 `<error>`） | `work/toolpkg/dist/ui/dashboard/index.ui.js:1119-1126` |
| 跨会话扫描已有先例（`todayMessages` 读全部现存 chatmsg 文件） | `dashboard/index.ui.js:323-339` |
| bridge 方法全集（全部「当前会话」语义，仅 todayMessages/sessionUsage 越界） | `work/web/src/data/bridge.ts:92-261` |
| 当前只注册 1 个 UI 路由 + 1 个 `main_sidebar_plugins` 入口 | `main.js:1177-1198` |
| WebView 走 boot.html → index.single.html（虚拟源 + 拦截） | `dashboard/index.ui.js:39-40,1881-1891,1946-2013` |
| `registerCoreCommand` 只能返回 `{stdout,stderr,json}` | `refs/v2_toolpkg.d.ts:1464-1482, 3801-3830` |
| `registerChatComposerSlot` 只有 `above_input` 一个槽位 | `v2_toolpkg.d.ts:2757-2783` |
| `registerNavigationEntry` 可用面含 `chat_sidebar_tabs`/`chat_input_menu`/`chat_message_after`/`main_sidebar_plugins` | `v2_toolpkg.d.ts:2788-2827` |
| `registerUiRoute`/`registerToolboxUiModule`/`registerChatMessageMenuItem` 存在 | `v2_toolpkg.d.ts:2713-2746, 2683-2708, 4602` |
| 上游洞察页是 host 路由 + 5 个 part + 30s 轮询 | `upstream/src/host/overview.ts:48,68`；`client/overviewSource.ts:14` |
| 上游 bridge 侧无、我们有的能力 | 世界书注入段/用户资料段拆分、价格峰谷与节假日、brief 按需拉取、skip 警告对拍（`App.tsx:377-455,1215-1222`） |

---

### 行数统计

- 功能差距表：**28 行**（A 洞察页 8 / B 时间线 5 / C 命令事件 5 / D 浏览器 4 / E 统计设置 6）
  - 可行性分布：**✅ 16 · ⚠️ 11 · ❌ 1**（F28 余额，明确不做）
  - 工作量分布：**S 8 · M 15 · L 3 · — 2**（— = 已对齐 F11 / 不适用 F28）
- UI 差距表：**16 行**
- 风格差距表：**18 行**（含 S10「已对齐」、S11/U16「保留现状」）
- 分批：**第1批 5 项 / 第2批 5 项 / 第3批 5 项**（共 15 项排期 + 已对齐 1 项 + 不做 1 项）
