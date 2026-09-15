"use strict";
/**
 * 完整提示词查看 · ToolPkg 主入口（main 上下文）
 *
 * 职责（2026-09-11 瘦身版）：
 *   1) prompt_finalize 钩子：只把「模型真正看到的东西」的**原始 payload** 存成一份文件；
 *   2) 向侧边栏注册查看面板。
 *
 * 为什么钩子只存原始数据：
 *   派生出来的 6 个 md（索引 / SYSTEM / 工具 / 历史 / 全量 / 世界书）全部可以由
 *   raw_payload.json 重新生成。实测一天 300+ 条消息时，每轮原本写 1.1MB ≈ 每月 15GB，
 *   其中派生文件约 700KB 属于重复信息。现在每轮只写 raw_payload.json + meta.json
 *   （约 380KB），派生文件改为「用户打开面板 / 手动刷新时」由 UI 侧生成。
 *   钩子路径上只剩一次 JSON.stringify + 一次写盘，不再做任何渲染。
 *
 * 落盘原则不变：不清洗、不截断、不重排。raw_payload.json 里 payload 是什么，
 * 文件里就是什么；派生文件也一律逐字，只加标题和分隔线。
 *
 * 输出目录：/sdcard/Download/Operit/prompt_viewer/
 *   raw_payload.json  hook payload 原始 JSON（逐字，含所有字段）— 钩子写
 *   meta.json         轻量元信息（抓取时间 / 行数 / 生成标记）— 钩子写，UI 生成后会回写
 *   00_索引.md / 01_SYSTEM原文.md / 02_可用工具.md / 03_消息历史.md
 *   04_世界书.md / 99_全量原文.md                          — UI 打开面板时生成
 */

const PKG_ID = "com.operit.prompt_viewer_ui";
const UI_ID = "prompt_viewer_ui";
const UI_SCREEN_PATH = "dist/ui/index.ui.js";
const UI_ROUTE = "toolpkg:" + PKG_ID + ":ui:" + UI_ID;

const OUT_DIR = "/sdcard/Download/Operit/prompt_viewer";
const P_INDEX = OUT_DIR + "/index.json";
const RAW_LINE_MAX = 400;   // raw 单行最大字符数，超过就折断（UI 读后会把换行去掉再解析）

/** 对话文件前缀：一个对话存一份，互不覆盖 */
function pathsFor(payload) {
  var id = str(payload && payload.chatId);
  var key = id ? id.slice(0, 8) : "unknown";
  return {
    key: key,
    chatId: id,
    raw: OUT_DIR + "/raw_" + key + ".json",
    meta: OUT_DIR + "/meta_" + key + ".json"
  };
}

/** 取最后一条 USER 消息的前 40 字，作为「这是哪个对话」的识别标记 */
function previewOf(payload) {
  var h = Array.isArray(payload.preparedHistory) ? payload.preparedHistory
    : (Array.isArray(payload.chatHistory) ? payload.chatHistory : []);
  for (var i = h.length - 1; i >= 0; i--) {
    var t = h[i];
    var k = str(t && (t.kind || t.role));
    if (k === "USER") {
      var c = str(t && t.content).replace(/\s+/g, " ").trim();
      return c.slice(0, 40);
    }
  }
  return "(无用户消息)";
}

/** 从 callTool 返回里取正文。
 *  兼容：字符串 / {content} / {data:{content}} / {text} / 以及「内容是嵌套 JSON 字符串」的情况。
 *  踩坑：NativeInterface.callTool 返回的是 {data:{content:...}}，早期只认 r.content，导致读索引永远为空、
 *  索引每次都被重写成 1 条。UI 侧的 rawContent 早就修过同样的坑，这里必须对齐。 */
function textOf(r) {
  if (r === null || r === undefined) return "";
  if (typeof r === "string") {
    try {
      var o = JSON.parse(r);
      var inner = textOf(o);
      if (inner) return inner;
    } catch (e) { /* 不是 json，当纯文本用 */ }
    return r;
  }
  if (typeof r.content === "string") return r.content;
  if (r.data && typeof r.data.content === "string") return r.data.content;
  if (typeof r.text === "string") return r.text;
  if (r.data && typeof r.data === "string") return r.data;
  return "";
}

/** 从文本里抽出第一个 JSON 数组（自动剥「行号 | 」前缀） */
function arrFromText(s) {
  if (!s) return [];
  var lines = String(s).split("\n");
  var out = [];
  for (var i = 0; i < lines.length; i++) out.push(lines[i].replace(/^\s*\d+\|\s?/, ""));
  var t = out.join("\n");
  var a = t.indexOf("[");
  var b = t.lastIndexOf("]");
  if (a < 0 || b <= a) return [];
  try {
    var arr = JSON.parse(t.slice(a, b + 1));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

/** 同一次 App 运行内的索引缓存：读文件失败了也能继续累积多对话 */
var MEM_IDX = null;

/** 读索引（失败返回空数组）。命中内存缓存时不再读盘。 */
// ── 数据保留策略（防无限增长，2026-09-15）──────────────
//   会话类：raw/meta/index 环形保留最近 RETAIN_SESSIONS 个对话（超出即删，随捕获触发）
//   日志类：snapshots/chatmsg/ui_bridge 按天分文件，保留最近 RETAIN_LOG_DAYS 天（每日一次，机会式）
var RETAIN_SESSIONS = 100;
var RETAIN_LOG_DAYS = 14;
var CLEAN_MARK = "";
function pruneSessionFiles(list) {
  for (var i = 0; i < list.length; i++) {
    var k = list[i] && list[i].key;
    if (!k) continue;
    try { Tools.Files.deleteFile(OUT_DIR + "/raw_" + k + ".json", false, "android"); } catch (e1) { /* ignore */ }
    try { Tools.Files.deleteFile(OUT_DIR + "/meta_" + k + ".json", false, "android"); } catch (e2) { /* ignore */ }
    log("prune session: " + k);
  }
}
function cleanupOldData() {
  var today = todayKey();
  if (CLEAN_MARK === today) return;
  CLEAN_MARK = today;
  Tools.Files.list(OUT_DIR, "android").then(function (r) {
    try {
      var entries = (r && r.entries) ? r.entries : [];
      var cutoffMs = Date.now() - RETAIN_LOG_DAYS * 86400000;
      var toDel = [];
      var rawKeys = {}, metaKeys = {};
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i] || {};
        var nm = str(e.name);
        if (e.isDirectory || !nm) continue;
        var mLog = nm.match(/^(snapshots|chatmsg|ui_bridge)-(\d{4})(\d{2})(\d{2})\.jsonl$/);
        if (mLog) {
          var t = new Date(+mLog[2], +mLog[3] - 1, +mLog[4]).getTime();
          if (t < cutoffMs) toDel.push(nm);
          continue;
        }
        var mRaw = nm.match(/^raw_([0-9a-zA-Z]+)\.json$/);
        if (mRaw) { rawKeys[mRaw[1]] = 1; continue; }
        var mMeta = nm.match(/^meta_([0-9a-zA-Z]+)\.json$/);
        if (mMeta) { metaKeys[mMeta[1]] = 1; }
      }
      var idx = readIndex();
      if (!idx.length) {
        log("cleanup: index empty, skip orphan pass");
      } else {
        var inIdx = {};
        for (var j = 0; j < idx.length; j++) { if (idx[j] && idx[j].key) inIdx[idx[j].key] = 1; }
        for (var rk in rawKeys) { if (!inIdx[rk]) toDel.push("raw_" + rk + ".json"); }
        for (var mk in metaKeys) { if (!inIdx[mk]) toDel.push("meta_" + mk + ".json"); }
      }
      var chain = Promise.resolve();
      var cnt = 0;
      for (var d = 0; d < toDel.length; d++) {
        (function (nm2) {
          chain = chain.then(function () {
            return Tools.Files.deleteFile(OUT_DIR + "/" + nm2, false, "android").then(function () { cnt++; }).catch(function () {});
          });
        })(toDel[d]);
      }
      chain.then(function () { log("cleanup done: removed " + cnt + " files (of " + toDel.length + ")"); });
    } catch (e) { log("cleanup inner failed: " + errText(e)); }
  }).catch(function (e) { log("cleanup list failed: " + errText(e)); });
}
function readIndex() {
  if (MEM_IDX && MEM_IDX.length) return MEM_IDX.slice();
  var n = nativeApi();
  if (!n) return [];
  try {
    var r = n.callTool("default", "read_file", JSON.stringify({ path: P_INDEX, environment: "android" }));
    var arr = arrFromText(textOf(r));
    if (arr.length) MEM_IDX = arr.slice();
    return arr;
  } catch (e) {
    return [];
  }
}

// ---------- 基础工具 ----------

function log(text) {
  try {
    console.error("[prompt_viewer] " + text);
  } catch (e) { /* ignore */ }
}

function errText(e) {
  return e && e.message ? e.message : String(e);
}

function str(v) {
  return v === null || v === undefined ? "" : String(v);
}

function pad2(n) {
  return (n < 10 ? "0" : "") + n;
}

function nowText() {
  var d = new Date();
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
    " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

function nativeApi() {
  try {
    return typeof NativeInterface !== "undefined" ? NativeInterface : null;
  } catch (e) {
    return null;
  }
}

var dirEnsured = false;

function writeText(path, content) {
  var n = nativeApi();
  if (!n) return false;
  if (!dirEnsured) {
    try {
      n.callTool("default", "make_directory", JSON.stringify({ path: OUT_DIR, create_parents: true }));
    } catch (e) { /* 已存在 */ }
    dirEnsured = true;
  }
  var body = str(content);
  try {
    try {
      n.callTool("default", "delete_file", JSON.stringify({ path: path }));
    } catch (e) { /* 不存在 */ }
    n.callTool("default", "create_file", JSON.stringify({ path: path, new: body }));
    return true;
  } catch (e) {
    log("write failed " + path + ": " + errText(e));
    return false;
  }
}

/** 安全 JSON：遇到循环引用/怪值不炸，逐字段降级 */
function safeJson(value, indent) {
  var space = indent === undefined ? 2 : indent;
  try {
    return JSON.stringify(value, null, space);
  } catch (e) {
    if (value && typeof value === "object") {
      var out = {};
      var keys = Object.keys(value);
      for (var i = 0; i < keys.length; i++) {
        try {
          JSON.stringify(value[keys[i]]);
          out[keys[i]] = value[keys[i]];
        } catch (e2) {
          out[keys[i]] = "[unserializable: " + errText(e2) + "]";
        }
      }
      try {
        return JSON.stringify(out, null, space);
      } catch (e3) {
        return "{\"__error\": \"json stringify failed\"}";
      }
    }
    return "\"" + errText(e) + "\"";
  }
}

/** 把超长行按固定宽度折断（纯格式处理，内容逐字不变）。
 *  raw 里个别行可能有几万字符（实测最长 65239），而 read_file_part 单次返回有大小上限，
 *  那种行无论怎么分块都读不出来。折断后 UI 侧会把所有换行去掉再解析 ——
 *  JSON 字符串内部的换行本来就转义成 \n 两个字符，所以去掉真换行不会改变任何值。 */
function chunkLongLines(text, maxLen) {
  var lines = String(text).split("\n");
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    while (l.length > maxLen) {
      out.push(l.slice(0, maxLen));
      l = l.slice(maxLen);
    }
    out.push(l);
  }
  return out.join("\n");
}

// ---------- prompt_finalize 钩子（只存原始数据，不渲染） ----------

function onPromptFinalize(input) {
  var capturedAt = nowText();
  try {
    var payload = input && input.eventPayload && typeof input.eventPayload === "object"
      ? input.eventPayload
      : {};

    var P = pathsFor(payload);   // 每个对话一份文件，互不覆盖
    var rawText = safeJson(payload);
    // 超长行折断（见 chunkLongLines 说明）：UI 读完后会把换行去掉再解析
    rawText = chunkLongLines(rawText, RAW_LINE_MAX);

    var payloadKeys = [];
    try {
      payloadKeys = Object.keys(payload);
    } catch (e) { /* ignore */ }

    var rawLines = rawText.split("\n").length;
    var capturedAtMs = Date.now();

    writeText(P.raw, rawText);

    var meta = {
      ok: true,
      capturedAt: capturedAt,
      capturedAtMs: capturedAtMs,
      // 这份数据属于哪个对话
      chatId: P.chatId,
      key: P.key,
      // 最后一条 USER 消息的前 40 字：UI 靠它显示「这份是哪个对话的」
      preview: previewOf(payload),
      rawChars: rawText.length,
      rawLines: rawLines,
      chunked: RAW_LINE_MAX,
      payloadKeys: payloadKeys,
      // 派生文件尚未生成；UI 打开面板生成完会回写 true + generatedFor
      generated: false
    };
    writeText(P.meta, safeJson(meta));

    // 更新索引：本对话挪到最前（UI 按「最新的一份」自动选取），环形保留最近 RETAIN_SESSIONS 个对话
    var idx = readIndex().filter(function (it) { return it && it.key !== P.key; });
    idx.unshift({
      key: P.key,
      chatId: P.chatId,
      capturedAt: capturedAt,
      capturedAtMs: capturedAtMs,
      preview: previewOf(payload),
      chars: rawText.length,
      lines: rawLines
    });
    if (idx.length > RETAIN_SESSIONS) {
      var dropped = idx.slice(RETAIN_SESSIONS);
      idx = idx.slice(0, RETAIN_SESSIONS);
      try { pruneSessionFiles(dropped); } catch (eD) { log("prune dropped failed: " + errText(eD)); }
    }
    MEM_IDX = idx.slice();   // 内存里记住，同一次运行内不依赖读盘
    writeText(P_INDEX, safeJson(idx));
    // 每日一次：日志滚动清理 + 索引外孤儿对齐（机会式，不阻塞主流程）
    try { cleanupOldData(); } catch (eC) { log("cleanup failed: " + errText(eC)); }

    log("captured: chat=" + P.key + " rawChars=" + rawText.length + " rawLines=" + rawLines +
      " keys=" + payloadKeys.length);

    // v2:每轮轻量快照——只在 send_to_model 阶段记一行（健康原则：避免每轮双行写盘）
    var stageStr = str(payload.stage);
    if (stageStr.indexOf("send_to_model") >= 0) {
      try { collectSnapshot(payload); } catch (e1) { log("snapshot collect failed: " + errText(e1)); }
    }
  } catch (e) {
    log("capture failed: " + errText(e));
  }
  // 绝不修改提示词本身
  return undefined;
}

// ---------- v2 采集层：每轮快照 + 消息事件（2026-09-15 新增） ----------
// 数据源与口径经 开发期探针（ctx_probe）实机验证：
//   快照：preparedHistory 按 kind 拆字符（SYSTEM 在历史里；systemPrompt 字段恒为 null）+ availableTools 体量
//   消息：流式多条 + 完成态带真实 usage；全量记录、带 done 标记，去重规则留给统计层
// 追加写串行化（写队列）、按天分文件；不碰现有 raw/meta 落盘路径

function todayKey() {
  var d = new Date();
  return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
}

var writeChain = Promise.resolve();
var v2DirEnsured = false;

function ensureV2Dir() {
  if (v2DirEnsured) return;
  try {
    Tools.Files.mkdir(OUT_DIR, true, "android");
    v2DirEnsured = true;
  } catch (e) { /* ignore */ }
}

/** 串行追加一行 JSONL（写队列防并发交错；失败静默不干扰业务） */
function appendLine(baseName, obj) {
  writeChain = writeChain.then(function () {
    try {
      ensureV2Dir();
      var path = OUT_DIR + "/" + baseName + "-" + todayKey() + ".jsonl";
      return Tools.Files.write(path, JSON.stringify(obj) + "\n", true, "android");
    } catch (e) { /* ignore */ }
  }).catch(function () { /* keep chain alive */ });
  return writeChain;
}

function num(v) {
  return typeof v === "number" ? v : null;
}

/** 以下三段与 dashboard UI 侧解析保持同口径（世界书 / 包系统技能段 / 用户资料段）；改动需两侧同步 */
function segWorldbook(text) {
  var OPEN = "<worldbook>", CLOSE = "</worldbook>";
  var chars = 0, pos = 0;
  while (true) {
    var a = text.indexOf(OPEN, pos);
    if (a < 0) break;
    var b = text.indexOf(CLOSE, a);
    if (b < 0) { chars += text.length - a; break; }
    b += CLOSE.length;
    chars += text.slice(a, b).length;
    pos = b;
  }
  return chars;
}
function segSkillPack(sysText) {
  var lines = String(sysText).split("\n");
  var start = -1, end = lines.length;
  for (var i = 0; i < lines.length; i++) {
    var t = lines[i].trim();
    if (start < 0) { if (/^包系统/.test(t)) start = i; continue; }
    if (t.indexOf("<worldbook>") === 0 || t.indexOf("<user_profile") === 0 || /^#/.test(t)) { end = i; break; }
  }
  if (start < 0) return 0;
  return lines.slice(start, end).join("\n").length;
}
function segUserProfile(sysText) {
  var lines = String(sysText).split("\n");
  var start = -1, end = lines.length;
  for (var i = 0; i < lines.length; i++) {
    var t = lines[i].trim();
    if (start < 0) { if (t.indexOf("<user_profile") === 0) start = i; continue; }
    if (t.indexOf("</user_profile>") === 0) { end = i + 1; break; }
  }
  if (start < 0) return 0;
  return lines.slice(start, end).join("\n").length;
}

/** 每轮轻量快照（挂在 onPromptFinalize 内，独立 try/catch） */
function collectSnapshot(payload) {
  var hist = Array.isArray(payload.preparedHistory) ? payload.preparedHistory
    : (Array.isArray(payload.chatHistory) ? payload.chatHistory : []);
  var charsByKind = {};
  var countByKind = {};
  var totalChars = 0;
  for (var i = 0; i < hist.length; i++) {
    var t = hist[i] || {};
    var k = str(t.kind || t.role || "OTHER").toUpperCase();
    var c = str(t.content).length;
    charsByKind[k] = (charsByKind[k] || 0) + c;
    countByKind[k] = (countByKind[k] || 0) + 1;
    totalChars += c;
  }
  var tools = Array.isArray(payload.availableTools) ? payload.availableTools : [];
  var toolsChars = 0;
  try { toolsChars = JSON.stringify(tools).length; } catch (e0) {}
  // SYSTEM 内三段拆分（世界书/技能/资料）：供时间线「组成」分栏（旧快照无此字段时，UI 侧按「全会话 SYSTEM 恒定」规则用 raw 回填）
  var segSys = { wb: 0, sk: 0, up: 0 };
  try {
    var sysText = "";
    for (var sx = 0; sx < hist.length; sx++) {
      var hx = hist[sx] || {};
      if (str(hx.kind || hx.role || "").toUpperCase() === "SYSTEM") { sysText = str(hx.content); break; }
    }
    if (sysText) {
      segSys.wb = segWorldbook(sysText);
      segSys.sk = segSkillPack(sysText);
      segSys.up = segUserProfile(sysText);
    }
  } catch (eSeg) { /* 静默，不影响快照主体 */ }
  appendLine("snapshots", {
    at: nowText(),
    atMs: Date.now(),
    stage: str(payload.stage),
    session: str(payload.chatId).slice(0, 8),
    chatId: str(payload.chatId),
    toolsCount: tools.length,
    toolsChars: toolsChars,
    historyCount: hist.length,
    historyChars: totalChars,
    charsByKind: charsByKind,
    countByKind: countByKind,
    rawInputChars: str(payload.rawInput).length,
    modelParams: Array.isArray(payload.modelParameters) ? payload.modelParameters.length : -1,
    sys: segSys
  });
}

/** 消息事件（流式快照 + 完成态 usage）。完全相同的事件去重（同 chatId/sentAt/长度/done）。 */
var lastChatKey = null;

function onChatMessage(input) {
  try {
    var p = input && input.eventPayload && typeof input.eventPayload === "object"
      ? input.eventPayload
      : (input || {});
    var done = num(p.completedAt) > 0;
    // 健康原则：不做高频写盘——流式中间态只留在内存不落盘，仅消息完成时写一行
    if (!done) return undefined;
    var key = str(p.chatId) + "|" + num(p.sentAt) + "|" + str(p.content).length + "|d";
    if (key === lastChatKey) return undefined;
    lastChatKey = key;
    appendLine("chatmsg", {
      at: nowText(),
      atMs: Date.now(),
      session: str(p.chatId).slice(0, 8),
      chatId: str(p.chatId),
      sender: str(p.sender),
      roleName: str(p.roleName),
      contentLen: str(p.content).length,
      inputTokens: num(p.inputTokens),
      outputTokens: num(p.outputTokens),
      cachedInputTokens: num(p.cachedInputTokens),
      provider: str(p.provider),
      modelName: str(p.modelName),
      sentAt: num(p.sentAt),
      completedAt: num(p.completedAt),
      waitMs: num(p.waitDurationMs),
      outMs: num(p.outputDurationMs),
      done: done,
      displayMode: str(p.displayMode)
    });
  } catch (e) {
    log("chatmsg collect failed: " + errText(e));
  }
  return undefined;
}

// ---------- 注册 ----------

function registerToolPkg() {
// 旧入口「完整提示词」于 2026-09-15 退役（由「上下文仪表盘」取代）。
  // 旧 UI 源码保留在 dist/ui/index.ui.js；如需恢复，恢复下方注册逻辑即可。
  // var title = { zh: "完整提示词", en: "Full Prompt" };
  // var screenRef = null;
  // try { var mod = require("./ui/index.ui.js"); screenRef = mod && (mod.default || mod); } catch (e) { log("ui require failed: " + errText(e)); }
  // try {
  //   ToolPkg.registerUiRoute({ id: UI_ID, runtime: "compose_dsl", screen: screenRef || UI_SCREEN_PATH, title: title });
  //   ToolPkg.registerNavigationEntry({ id: "prompt_viewer_sidebar", route: UI_ROUTE, surface: "main_sidebar_plugins", title: title, icon: "description", order: 70 });
  // } catch (e) { log("ui register failed: " + errText(e)); }

  // Phase4:上下文仪表盘 UI（自探针搬迁，2026-09-15）
  try {
    var dashMod = require("./ui/dashboard/index.ui.js");
    var dashScreen = dashMod && (dashMod.default || dashMod);
    ToolPkg.registerUiRoute({
      id: "prompt_viewer_dashboard",
      route: "toolpkg:" + PKG_ID + ":ui:prompt_viewer_dashboard",
      runtime: "compose_dsl",
      screen: dashScreen || "dist/ui/dashboard/index.ui.js",
      title: { zh: "上下文仪表盘", en: "Context Dashboard" }
    });
    ToolPkg.registerNavigationEntry({
      id: "prompt_viewer_dashboard_sidebar",
      route: "toolpkg:" + PKG_ID + ":ui:prompt_viewer_dashboard",
      surface: "main_sidebar_plugins",
      title: { zh: "上下文仪表盘", en: "Context Dashboard" },
      icon: "dashboard",
      order: 71
    });
    log("dashboard ui registered");
  } catch (e2) {
    log("dashboard register failed: " + errText(e2));
  }
  ToolPkg.registerPromptFinalizeHook({
    id: "prompt_snapshot_full",
    function: onPromptFinalize
  });

  // v2:消息事件钩子（token/timing 数据源）
  try {
    ToolPkg.registerChatMessageHook({
      id: "pvm_chat_message",
      function: onChatMessage
    });
  } catch (e2) {
    log("chat hook register failed: " + errText(e2));
  }

  try {
    Tools.Files.mkdir(OUT_DIR, true);
  } catch (e) { /* ignore */ }

  log("registered (raw + metrics mode)");
  return true;
}

exports.registerToolPkg = registerToolPkg;
// 钩子函数必须从本 toolpkg module 导出，否则 registerXxxHook 会拒绝注册
// （报错：registerPromptFinalizeHook function must be exported from a toolpkg module）
exports.onPromptFinalize = onPromptFinalize;
exports.onChatMessage = onChatMessage;