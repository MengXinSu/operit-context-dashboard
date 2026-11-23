# BUG: 上下文仪表盘导致聊天消息列表整体空白

**组件**：`com.operit.prompt_viewer_ui`（上下文仪表盘 / Context Dashboard）
**版本**：`2.10.0`（`manifest.json`）
**文件**：`dist/ui/dashboard/index.ui.js`（1701 行）
**严重级别**：**P0 / 数据可用性事故** —— 用户所有会话不可读
**报告时间**：2026-11-23 21:56 (UTC+08:00)

---

## 一、现象

进入任意会话，**消息列表整体空白**。App 不崩溃、不闪退，顶栏、输入框、
设置页均正常显示，唯独消息区域什么都没有。

- 返回会话列表再进入 → 短暂正常，随后再次空白
- 强制停止 App 重开 → 依然空白
- **所有会话都受影响**，不是单个会话的数据问题
- 禁用本插件后 **立刻恢复**，且不再复发

---

## 二、直接证据

日志（`operit-diagnostics-1795439799035.log.txt`，18,056 行）中唯一一条
Flutter 级异常，与 WebView 解绑发生在**同一毫秒**：

```
21:13:21.597  ComposeDslWebView: event=controller_bind
              context=toolpkg_xml_render:com.operit.prompt_viewer_ui:dist/ui/dashboard/index.ui.js:<BUNDLE>:250
              key=dashboard_webview

21:13:21.620  ComposeDslWebView: event=controller_unbind
              ...同一 context，同一 key，remainingKeys=        ← 已无持有者

21:13:21.620  E/FlutterFramework: Null check operator used on a null value
              #0  RenderObject.getTransformTo        (rendering/object.dart:3548)
              #1  RenderBox.localToGlobal            (rendering/box.dart:3092)
              #2  _PlatformViewPlaceholderBox.performLayout.<closure>
                                                     (widgets/platform_view.dart:1974)
              #3  SchedulerBinding._invokeFrameCallback  (scheduler/binding.dart:1431)
              #4  SchedulerBinding.handleDrawFrame       (scheduler/binding.dart:1358)
              #5  SchedulerBinding._handleDrawFrame      (scheduler/binding.dart:1199)
              #6  _rootRun                           (dart:async/zone_root.dart:35)
              #7  _CustomZone.run                    (dart:async/zone.dart:726)
              #8  _CustomZone.runGuarded             (dart:async/zone.dart:625)
              #9  _invoke                            (dart:ui/hooks.dart:358)
              #10 PlatformDispatcher._drawFrame      (dart:ui/platform_dispatcher.dart:444)
              #11 _drawFrame                         (dart:ui/hooks.dart:328)
```

**关键点**：异常抛在 `SchedulerBinding.handleDrawFrame` 内部。
Flutter 的绘制是整帧提交的，一帧内抛异常 → **该帧 layout/paint 全部作废**。
消息列表是这一帧里最大的子树，所以整块区域都没被画出来。
这就是"内容都在、只是没画"的观感来源。

---

## 三、量化：这个插件把 WebView 打到了什么频率

同一份日志（20:44–21:16，约 32 分钟）统计：

| 指标 | 数值 |
|---|---|
| `ComposeDslWebView` 事件总数 | **1,132** |
| 使用的 key | 全部是同一个 `dashboard_webview` |
| 同一 bundle 的不同构建序号 | **132 个**（`:2` → `:552`） |
| `loadUrl` 整页重载次数 | **148** |
| 平均重建间隔 | **约 1.7 秒 / 次** |
| 平均整页重载间隔 | **约 13 秒 / 次** |

每分钟事件数（峰值段）：

```
20:46  58
20:48  99
20:50  67
20:55 109
21:05  55
21:13 174   ← 崩溃发生在此分钟
21:15  95
```

**对照组**：`com.operit.change_review` 在同一时段只有 **72** 次事件（约 27 秒/次），
用户启用它后完全没有出现空白。两者相差 **19.7 倍**，说明本插件的高频重建
是触发条件，而非"WebView 一定崩"。

---

## 四、根因

### 4.1 崩溃的框架层机制

Flutter 内嵌原生 WebView 时，先放一个占位框 `_PlatformViewPlaceholderBox`。
它在 `performLayout` 里注册一个 **post-frame 回调**，帧末把原生 View 的位置
同步回 Flutter，回调内调用 `localToGlobal()`。

`localToGlobal()` 依赖 `getTransformTo()` 沿 parent 链上溯。**如果在这个回调
真正执行之前，占位框已从渲染树摘除**（滚动回收、列表重建、切换会话都会），
parent 链断开 → 返回 null → 代码里的 `!` 断言崩溃。

这是竞态条件：**创建/销毁越频繁，越容易命中**。

### 4.2 本插件为什么会高频重建 —— 代码级定位

#### 缺陷 ①：模块级常量里塞了 `Date.now()`（L42）

```js
// index.ui.js L42
var DASHBOARD_URL = "file://" + WEB_DIR + "/boot.html?t=" + Date.now();
```

这是**模块级 `var`**，但值含 `Date.now()`。JS 模块每次重新求值，
`DASHBOARD_URL` 就是一个**全新的 URL**。

L1678 把这个 URL 直接喂给 WebView：

```js
// index.ui.js L1676-1678
key: "dashboard_webview_node",
controller: controller,
url: DASHBOARD_URL,
```

宿主判断"URL 变了" → 销毁旧 WebView → 新建 → 冷启动加载。
**每次进入会话都强制一次完整冷启动。**

#### 缺陷 ②：`onPageFinished` 里再塞一次 `Date.now()`（L1691）

```js
// index.ui.js L1685-1697
onPageFinished: function (ev) {
  var u0 = String((ev && ev.url) || "");
  hostLog({ dir: "host", at: nowIso(), event: "onPageFinished", url: u0 });
  if (u0.indexOf("boot.html") >= 0) {
    try {
      controller.loadUrl(DASHBOARD_APP + "?v=" + Date.now());   // ← L1691
    } catch (eF) { ... }
    return;
  }
  pushToPage();
}
```

`boot.html` 加载完成 → 立刻 `loadUrl` 到 `index.single.html`，且 URL 带时间戳
→ **无法命中 HTTP/file 缓存，必须完整重新解析、执行 77 KB 的 JS**。

#### 缺陷 ③：代码注释自相矛盾

同一文件里，两条注释直接打脸：

```js
// L44 —— 承认是故意的
// （原 bootedOnce 已移除：页面加载改由 WebView url prop 承担，每次进入强制刷新）

// L45 —— 声称稳定，但 L42 的 Date.now() 让它不稳定
// 页面加载交给 WebView 的 url prop（DASHBOARD_URL 为模块级常量，稳定值不会引发重载循环）
```

`bootedOnce` 这个"只加载一次"的守卫被**主动删除了**，注释说"每次进入强制刷新"。
这在普通页面里是合理的（保证数据新），但在 Flutter PlatformView 里是致命的：
每一次"强制刷新"都伴随一次 AndroidView 销毁+重建。

#### 缺陷 ④：`controller` 未复用（L1583）

```js
// L1582-1583
function Screen(ctx) {
  var controller = ctx.createWebViewController("dashboard_webview");
```

`Screen(ctx)` 每次执行都新建 controller。宿主重建 Screen 时，
旧 controller 的 WebView 被销毁，新 controller 再建一个。
**没有按 key 复用。**

#### 缺陷 ⑤：`hostLog` 每次都 `mkdir`（L1585-1592）

```js
// L1585-1592
function hostLog(obj) {
  try {
    var line = JSON.stringify(obj) + "\n";
    try { Tools.Files.mkdir("/sdcard/Download/Operit/prompt_viewer", true, "android"); } catch (e0) {}
    Tools.Files.write(bridgeLogPath(), line, true, "android");
  } catch (e) { /* ignore */ }
}
```

`hostLog` 在 `onPageFinished`、`pushToPage`、JS bridge 回调里都被调用。
**每次写一行日志都先做一次 mkdir 系统调用**，纯属浪费 IO。

#### 缺陷 ⑥：每轮落盘 2 MB，同步阻塞（`dist/main.js`）

实测数据：

```
/storage/emulated/0/Download/Operit/prompt_viewer/   11.0 MB   148 个文件
最大单文件：raw_af9da8e2.json  2.1 MB
```

当前会话 `inputTokens=302301`（30 万 token）→ 完整提示词原文约 2.1 MB。
**每轮对话同步写一次 2 MB JSON**，会占住 JS 线程，把 Flutter 的帧调度往后推，
**正好扩大"占位框已移除、post-frame 回调还没执行"的时间窗口**。

而且**只增不减**，148 个文件没有任何淘汰策略。

---

## 五、复现步骤

1. 安装并启用 `com.operit.prompt_viewer_ui` 2.10.0
2. 打开一个**含历史消息**的会话（≥20 条）
3. 快速切换会话数次，或在消息列表里上下滚动经过仪表盘卡片
4. 观察：消息列表整体空白，App 不崩溃

**成功率**：在上述条件下约 1–3 分钟内必现。

**最小复现**：单次会话切换即可触发（日志中崩溃正是发生在
`chat_switch.messages_received` 之后 2 秒内）。

---

## 六、修复方案

### P0-① 移除 `Date.now()`，改用版本号（L42）

```diff
- var DASHBOARD_URL = "file://" + WEB_DIR + "/boot.html?t=" + Date.now();
+ var ASSET_VERSION = "2.10.0";   // 或构建时注入
+ var DASHBOARD_URL = "file://" + WEB_DIR + "/boot.html?v=" + ASSET_VERSION;
```

同一版本内 URL 恒定 → 宿主不会认为"URL 变了" → 不会重建 WebView。

### P0-② 移除 `loadUrl` 里的 `Date.now()`（L1691）

```diff
- controller.loadUrl(DASHBOARD_APP + "?v=" + Date.now());
+ controller.loadUrl(DASHBOARD_APP + "?v=" + ASSET_VERSION);
```

如果确实需要"每次进入拿最新数据"，**应该用 `evaluateJavascript` 推送数据**，
而不是重载整个页面：

```js
controller.evaluateJavascript("window.__hostPush && window.__hostPush()");
```

页面只加载一次，数据靠 bridge 更新。这才是 PlatformView 的正确用法。

### P0-③ 恢复 `bootedOnce` 守卫（L1685）

```diff
+ var navigatedToApp = false;
+
  onPageFinished: function (ev) {
    var u0 = String((ev && ev.url) || "");
    hostLog({ dir: "host", at: nowIso(), event: "onPageFinished", url: u0 });
-   if (u0.indexOf("boot.html") >= 0) {
+   if (!navigatedToApp && u0.indexOf("boot.html") >= 0) {
+     navigatedToApp = true;
      controller.loadUrl(DASHBOARD_APP + "?v=" + ASSET_VERSION);
      return;
    }
    pushToPage();
  }
```

`onPageFinished` 在 WebView 里可能被多次触发（重定向、iframe、刷新），
没有状态位就会重复跳转。

### P1-④ 按 key 复用 controller（L1583）

```diff
+ var _ctrlCache = {};
+
  function Screen(ctx) {
-   var controller = ctx.createWebViewController("dashboard_webview");
+   var _ck = "dashboard_webview";
+   var controller = _ctrlCache[_ck];
+   if (!controller) {
+     controller = ctx.createWebViewController(_ck);
+     _ctrlCache[_ck] = controller;
+   }
```

⚠️ 注意：若 controller 跨 Screen 实例共享，`addJavascriptInterface` 会重复注册。
需配合一次性初始化：

```js
if (!_ctrlCache[_ck + ":bridge"]) {
  controller.addJavascriptInterface("CtxProbe", {...});
  _ctrlCache[_ck + ":bridge"] = true;
}
```

### P1-⑤ `hostLog` 的 mkdir 提到模块级（L1585）

```diff
+ var _logDirReady = false;
+
  function hostLog(obj) {
    try {
+     if (!_logDirReady) {
+       try { Tools.Files.mkdir("/sdcard/Download/Operit/prompt_viewer", true, "android"); } catch (e0) {}
+       _logDirReady = true;
+     }
-     try { Tools.Files.mkdir("/sdcard/Download/Operit/prompt_viewer", true, "android"); } catch (e0) {}
      Tools.Files.write(bridgeLogPath(), JSON.stringify(obj) + "\n", true, "android");
    } catch (e) {}
  }
```

### P1-⑥ 落盘加限额 + 异步

建议三条一起做：

1. **环形淘汰**：只保留最近 N 条（如 50）或总量上限（如 100 MB），超出删最旧
2. **异步写**：改为 `Promise` / 队列批量刷盘，不阻塞 JS 线程
3. **加开关**：提供"只记录元数据（token 数、耗时、模型名）不记录原文"选项

```js
var MAX_FILES = 50;
function pruneOldSnapshots() {
  try {
    var list = Tools.Files.list("/sdcard/Download/Operit/prompt_viewer", "android");
    var raws = list.filter(f => /^raw_.*\.json$/.test(f.name))
                   .sort((a, b) => a.mtime - b.mtime);
    while (raws.length > MAX_FILES) {
      Tools.Files.delete(raws.shift().path, "android");
    }
  } catch (e) {}
}
```

### P2-⑦ 默认关闭

`manifest.json` 当前是：

```json
"enabled_by_default": true
```

建议改为 `false`。这是一个会**让所有用户消息列表变空**的功能，
不应该默认开启。用户主动开启时再引导阅读"已知问题"。

---

## 七、优先级汇总

| 优先级 | 缺陷 | 位置 | 影响 |
|---|---|---|---|
| **P0** | 模块级常量含 `Date.now()` | L42 | 每次进入会话强制冷启动 |
| **P0** | `loadUrl` 含 `Date.now()` | L1691 | 148 次无缓存重载 |
| **P0** | `bootedOnce` 被移除 | L44 / L1685 | 重复跳转无守卫 |
| **P1** | controller 未按 key 复用 | L1583 | WebView 反复销毁重建 |
| **P1** | 每轮同步写 2 MB | `main.js` | 阻塞帧调度，扩大竞态窗口 |
| **P1** | `hostLog` 每次 mkdir | L1588 | 无谓 IO |
| **P2** | 默认启用 | `manifest.json` | 全体用户受影响 |

**修好 P0 三条即可消除 90% 以上的触发概率。**

---

## 八、验证方法

修复后按以下方式验证：

1. 进入含 ≥20 条消息的会话，快速切换 10 次
2. 在消息列表里上下滚动 30 秒
3. 抓取日志，检查：

```bash
# 应该接近 0，而不是上千
logcat -d | grep -c 'ComposeDslWebView'

# 应该为 0
logcat -d | grep -c 'Null check operator used on a null value'

# 应该只有个位数（每次进入会话 1 次）
logcat -d | grep -c 'command=loadUrl'
```

4. 目标：**单会话 `loadUrl` 次数 ≤ 2**（boot → app），
   **`ComposeDslWebView` 事件数 ≤ 50**

---

## 九、附：本次事故的完整数据

| 项 | 值 |
|---|---|
| 日志文件 | `operit-diagnostics-1795439799035.log.txt` |
| 日志行数 | 18,056 |
| 日志窗口 | 20:19:41 – 21:16:38（57 分钟） |
| App 版本 | `2.0.0-preview.43`（`operit2-app-android-arm64-v8a`） |
| 设备 | Android / vivo |
| 崩溃时刻 | 21:13:21.620 |
| Flutter 异常总数 | 3 条（同一异常的 3 种记录形式，均在 1 毫秒内） |
| 触发前动作 | `chat_switch.messages_received count=20` |

---

## 十、补充：为什么 `change_review` 没事

`com.operit.change_review` 同样用 WebView，但：

- 只在 AI **实际改动文件**时出现卡片，不是每轮对话
- 卡片出现后是静态的，不随滚动反复创建
- 实测 72 次事件 / 32 分钟，比本插件低 19.7 倍

**它不是没问题，只是概率低。** 如果哪天它改成"每条消息都显示"，
会撞上完全一样的坑。建议两个插件共用同一套修复后的 WebView 复用方案。

---

*报告结束*
