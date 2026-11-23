# Operit2 上下文仪表盘 · 协同工作日志

> 2026-11-23 · 多 agent 协同执行 P3

## 任务板

| id | 任务 | 负责人 | 状态 | 写作用域 |
|---|---|---|---|---|
| task-1 | P3-2 采集层（解包 package_proxy + 里程碑事件） | collector | in_progress | `work/toolpkg/dist/`、`work/toolpkg/tools/` |
| task-2 | P3-1 偏好卡扩项 | prefs | in_progress | `work/web/src/App.tsx`、`i18n.ts`、`styles/settings.css` |
| task-3 | P3-3 里程碑带组件 | 待认领（blocked_by task-1） | pending | `work/web/src/client/components/milestoneBand.tsx`、`styles/milestoneBand.css` |

写作用域互不重叠：采集层 vs App.tsx/i18n vs 新组件文件。App.tsx 的最终接入由主控统一做，避免同文件并发写。

## 环境事实

- 工作副本：`operit2-port/work/`（toolpkg + web + assets）
- **采集层基线 = o2.19 版**（`main.js` 37427 字节，2026-10-21，已在 PC 版+手机端跑过），不是 Operit1 的 v1（30428 字节，缺 o2 适配）
- UI 基线 = v1 的 `web/src`（有源码；o2.19 的 UI 是编译产物）
- Node v24.15.0 / npm 11.12.1

## 构建链（已打通）

```powershell
# 依赖（沙箱下必须指定工作区内 cache，且跳过 postinstall）
npm install --ignore-scripts --no-audit --no-fund --cache "%TEMP%\npm-cache"

# 构建（需放行：esbuild 要 spawn 子进程，默认沙箱 EPERM）
npm run build

# 内联成单文件
node inline.mjs dist
```

产物：`work/web/dist/index.single.html` = **281,159 字节**
对照 o2.19：282,176 字节

## 已知差异（1 KB）

重建产物与 o2.19 的 CSS 差两个工具类（o2.19 有、重建无）：

- `.\\@container{container-type:inline-size}` —— 容器查询声明
- `.transform\\!` —— transform 的 important 变体

`@max-[380px]/lc-card:flex-wrap` 这类命名容器查询（donut.tsx:84、fileCard.tsx:322/385/401）在没有 `@container` 声明时会退化，**窄屏折行可能失效**。

→ 待办：真机/PC 验证时重点看 390px 宽度下 donut 与 fileCard 的折行；若失效，在对应容器补 `className="@container"` 或 CSS 里补 `container-type:inline-size`。

## 子任务产线

1. ✅ P0 基线 diff（[P0-REPORT.md](P0-REPORT.md)）
2. ✅ 工作副本 + 构建链
3. ✅ P3-1 偏好卡（prefs：4 → 9 项，App.tsx +63 行）
4. ✅ P3-2 采集层（collector：main.js +376 行，fixture 13/13，真样本 events=0）
5. ✅ P3-3 里程碑带（milestone：组件 298 行 + CSS 126 行，SSR 20/20）
6. ✅ P3-5 接线（wireup：挂载 + 样式 + 页脚版本，tsc 无新增错误）
7. ✅ 构建 + 打包 + 静态验收（队长）

## 最终产物（2026-11-23 19:30）

`work/build/context-dashboard_v2.11.0-o2.4.toolpkg` — **153,973 字节 / 6 条目**

v2.11.0-o2.4 相对 o2.19 的改动：
- 设置卡 4 → 8 项（新增主题、自适应缩放、窗口上限、事件默认筛选；压缩阈值按用户要求删除）
- 里程碑带（15 种事件旗子 + 计数徽章 + 空态提示，可关闭并持久化）
- 采集层解包 `package_proxy` 真实工具名 + 里程碑事件落盘（`events_<key>.json`）
- 「上下文趋势」改名「上下文时间线」
- 桥层新增 `milestones` 方法
- **PC 宽屏自适应**：`.lc-root` 1200 居中（CSS 控制，不再硬编码 600）；三行 `.lc-cols` 结构，767px 两列 / 1134px 三列 / 390px 单列

## 状态：o2.13 已恢复可用（P0 根因定位，2026-11-23 22:20）

**P0 事故复盘**：装插件后聊天消息列表整体空白（PC + 手机都中）。

| 阶段 | 结论 |
|---|---|
| 用户给的 BUG 报告 | 定位到 Flutter `_PlatformViewPlaceholderBox` 竞态（WebView 高频重建），报告针对 v1 的 `file://` + `Date.now()` 方案 |
| 我们的核对 | 报告的 P0①（URL 时间戳）、P0②（loadUrl 时间戳）在 o2.19 换虚拟源时已消除；③守卫、④controller 复用、⑤mkdir 仍在 |
| o2.12 修复（③④⑤ + useRef + 生命周期） | **失败**：controller 跨 Screen 复用在真实宿主里破坏 WebView → 聊天 UI 直接消失 |
| **真正根因** | **`chat_message_after` 内联入口**（o2.7 加的 F15 消息级跳转）：每条聊天消息都挂一个指向仪表盘 UI 的入口，宿主为它们创建的 Screen 共用同一个 `dashboard_webview` controller key → 83 次 bind / 51 次 unbind 的争用风暴 → Flutter 竞态 → 整帧 layout 作废 |
| 修复 | `CHAT_JUMP_ENTRY = false`（禁用 chat_message_after 入口）；长按菜单项「看本轮上下文」保留（不创建 Screen）；o2.12 的 WebView 改动全部回滚 |

**教训**：
1. WebView 生命周期类"优化"（controller 复用）在真实宿主里可能比原问题更糟，没有真机验证不要上
2. 每个携带 `route` 的导航入口都可能是 Screen 创建源，`chat_message_after` 这类"每条消息挂一个"的 surface 尤其危险
3. 沙箱里做不了浏览器/真机验证时，结构断言只能证伪不能证真

## 剩余待办

| 项 | 优先级 | 说明 |
|---|---|---|
| **源码归位** | 高 | 仍只在本地 `work/`；现在 o2.13 是可用基线，适合作为首个提交 |
| 消息级跳转重做 | 低 | 若要恢复「看本轮上下文」，需用不产生 Screen 的方式（长按菜单项已有，内联入口别再启用） |
| 桌面旧包清理 | 低 | o2.2–o2.12 可删，留 o2.13 |


`work/build/context-dashboard_v2.11.0-o2.8.toolpkg` — **189,144 字节 / 6 条目**，静态验收 7/7

本轮三个成员并行：

| 项 | 成果 |
|---|---|
| **「灰」的实测诊断**（visual） | 用真实截图取像素 + OKLab/WCAG 数学核对：①②⑤ 本来就对（画布/卡片 #151517→#232324 与上游逐像素一致）；真问题是 ③零值 opacity .45 把色点压灰（→.6）、④深色 KPI 60/40 混白变粉彩（→70/30，色度 +11~17%）；另补 `color-scheme` 让原生控件跟随主题 |
| **浏览器卡色底**（browsercolor2） | 上游 browser.css:59-66 四条规则照抄，分类行加 `--lc-cat-hue` + 118° 渐变 9%/10%；色点 7→8px 对齐上游 |
| **结构收尾**（structure） | 概览行整条删除（数字各有归属、不重复）；耗时统计 3 段 + 常驻「未采集：模型思考/工具参数/工具执行」；当前上下文加大号 `≈527,586 tokens · ≈¥0.527586` + 估算口径脚注 |

## 剩余待办

| 项 | 优先级 | 说明 |
|---|---|---|
| **源码归位** | 高 | 仍只在本地 `work/` |
| 浏览器展开条目色底 | 低 | `lc-br-item-row` 留到下一轮 |
| 桌面旧包清理 | 低 | o2.2–o2.7 可删 |


`work/build/context-dashboard_v2.11.0-o2.6.toolpkg` — **170,509 字节 / 6 条目**

用户对比原版后指出「差远了」，本轮按「抄上游结构 + 数据换我们的」重做：

| 项 | 成果 |
|---|---|
| **上下文统计卡** | 照抄上游 `stats.css`（154 行）：KPI 6 格（轮次/步数/技能加载/模型回复/上下文事件×2）+ IO 账本两列 + 工具 chips + 命令 chips；`@container lc-card (max-width:559px)` 断点 |
| **donut 迁移** | 从统计卡移到「当前上下文」卡（同一份 parts 不再两处重复） |
| **命令全程序统计** | 从「只取第一条」改为整条命令行所有程序（`head 91 / cut 34 / sort 11`、PowerShell `Select-Object` 等管道 cmdlet 都能出） |
| **工具短名** | chips 显示 `bash` / `pwsh`，跳转仍用全名 |
| **runs 口径** | 标题数字 = 命令调用次数（97/113），chips = 程序执行次数（510/534），hover 注明两者 |

静态验收 6/6。真实样本数据：`<key-A>` 28 轮/127 步/111 回复、`<key-C>` 32 轮/199 步/165 回复。

## 剩余待办

| 项 | 优先级 | 说明 |
|---|---|---|
| **源码归位** | 高 | 仍只在本地 `work/` |
| 概览行收敛 | 中 | 顶部 KPI 与统计卡重复，收敛成只放时长/费用 |
| 密度对齐 | 中 | 耗时统计补 6 段、当前上下文大号数字 |
| 洞察页 | 中 | 跨会话 KPI + 7 天图 + 热力图 |
| 桌面旧包清理 | 低 | o2.2–o2.5 可删 |


`work/build/context-dashboard_v2.11.0-o2.5.toolpkg` — **161,974 字节 / 6 条目**

第 1 批（4 个成员并行）交付：

| 项 | 成果 |
|---|---|
| **时间线窗口化**（timeline） | 1000 柱 → 145 柱（-85.5%），DOM -82.2%，SSR 44.8ms→10.8ms；41 个滚动位置 pad 校验全过 |
| **时长曲线**（timeline + bridge + wireup2） | `waitMs/outMs` 折线 + 右轴；turn 按轮求和、step 按「轮:步」对齐，无测量断线不画假 0 |
| **事件卡**（bridge + wireup2） | 3 类多选 → 7 类单选（压缩/剪枝/注入/模型/技能/代理/报错）+ 筛选空态 |
| **风格 token**（styles） | 新建 `lc-tokens.css` 20 个 `--lc-*`（深浅两套），25 条深色数值断言不变；触控 24px、focus-visible、tabular-nums |
| **UI 打磨**（wireup2） | 10 张卡标题图标、统计格 auto-fit、插件信息卡（含「本地采集，零外传」） |

静态验收 9/9 通过。

## 剩余待办

| 项 | 优先级 | 说明 |
|---|---|---|
| **源码归位** | 高 | 仍只在本地 `work/`，GitHub 是旧版 |
| 第 2 批 | 中 | 洞察页 v1、命令执行统计 v1、`/context` 文本版、Token 三桶、设置补 4 项（见 GAP.md） |
| 浅色模式目视 | 中 | token 层深色不变已断言，浅色（卡片阴影/0.5px 线/9px 节奏）尚未目视 |
| 桌面旧包清理 | 低 | o2.2 / o2.3 / o2.4 可删 |


用户在 PC 版安装 o2.4 后确认：
- ✅ 宽屏自适应生效（三行 `.lc-cols` 结构，1200 居中）
- ✅ 发一条消息后 hook 正常触发、`raw_<key>.json` 落盘、面板出数据

**运行时铁律（已两次踩坑）**：装/更新插件后必须**完全退出 Operit2 再重开**，否则 hook 不注册；且只有**重启后新发的 AI 请求**才会被记录。

## 剩余待办

| 项 | 优先级 | 说明 |
|---|---|---|
| **源码归位** | 高 | o2.4 的源码（main.js + web/src）只在本地 `work/`，GitHub 只有 v1 旧仓库。不归位，下次 Operit2 破坏性更新就没法维护 |
| 空态文案 | 中 | 「数据异常 raw 解析失败」→「当前会话还没有上下文记录 · 发一条消息后再打开」 |
| Timeline 主图窗口化 | 中 | 长会话（588 条 history）渲染性能未优化 |
| 洞察页 | 低（下一轮） | 跨会话 KPI/热力图，需新聚合层 |
| 桌面旧包清理 | 低 | o2.2 / o2.3 可删，避免误装 |

## 打包踩坑记录（重要）


1. **ZIP 条目前缀**：`tar -C dir .` 会生成 `./dist/main.js`，Operit2 按 `dist/ui/dashboard/index.ui.js` 精确匹配 → `registerUiRoute screen not found`。必须逐文件打包（o2.3 修复）。
2. **测试脚本混进包**：`work/toolpkg/tools/` 被全量打包（+10 KB）。已改为只打 manifest/dist/resources。
3. **版本号错位**：前端页脚与 manifest 各写各的（o2.1/o2.2/o2.3 各错一次）。现在打包前同步页脚。

## 已确认的运行时事实（PC 版）

- 采集层（main.js hook）**只在进程启动时注册**：装/更新插件后必须**完全退出 Operit2 再重开**，否则没有 `boot-<date>.jsonl`、没有 raw。
- 仪表盘只显示**当前选中会话**的数据，且只记录**插件运行后**发生的 AI 请求；安装前的历史会话没有 raw（产品决策 A：不做近似重建）。
- 11-17/18 有 6 个会话的 raw 样本（<key-A> 等），可用于验证读取链路。



## 待用户决策（产品）

1. 里程碑空态：隐藏 / 淡提示一次
2. 「上下文趋势」是否改名「上下文时间线」
3. 洞察页何时做（本轮已收干净，建议下一轮）

