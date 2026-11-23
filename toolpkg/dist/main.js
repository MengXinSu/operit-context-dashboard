/*!
 * 如果你在看这段源码——我喜欢你，梦新。—— Viya · 2026-09-17
 */
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
const PKG_VERSION = "2.11.0-o2.13";   // 与 manifest.json 同步；不一致时 boot ok 行会暴露出来
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
    meta: OUT_DIR + "/meta_" + key + ".json",
    // P3-2：里程碑事件独立落盘（与 raw/meta 同目录同前缀，按 key 一一对应）
    events: OUT_DIR + "/events_" + key + ".json"
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
var IDX_DEGRADED = false;   // 磁盘索引读失败过：内存里可以继续累积，但禁止回写覆盖磁盘索引

/** 读索引（失败返回空数组）。命中内存缓存时不再读盘。 */
// ── 数据保留策略（防无限增长，2026-09-15）──────────────
//   会话类：raw/meta/index 环形保留最近 RETAIN_SESSIONS 个对话（超出即删，随捕获触发）
//   日志类：snapshots/chatmsg/ui_bridge 按天分文件，保留最近 RETAIN_LOG_DAYS 天（每日一次，机会式）
var RETAIN_SESSIONS = 100;
var RETAIN_LOG_DAYS = 14;
var CLEAN_MARK = "";
var BOOT_DONE = false;   // 每次进程启动只打一行 boot 自检
function pruneSessionFiles(list) {
  for (var i = 0; i < list.length; i++) {
    var k = list[i] && list[i].key;
    if (!k) continue;
    try { Tools.Files.deleteFile(OUT_DIR + "/raw_" + k + ".json", false); } catch (e1) { /* ignore */ }
    try { Tools.Files.deleteFile(OUT_DIR + "/meta_" + k + ".json", false); } catch (e2) { /* ignore */ }
    try { Tools.Files.deleteFile(OUT_DIR + "/events_" + k + ".json", false); } catch (e3) { /* ignore */ }
    log("prune session: " + k);
  }
}
async function cleanupOldData() {
  var today = todayKey();
  if (CLEAN_MARK === today) return;
  CLEAN_MARK = today;
  var r = await Tools.Files.list(OUT_DIR);
  try {
    var entries = (r && r.entries) ? r.entries : [];
    var cutoffMs = Date.now() - RETAIN_LOG_DAYS * 86400000;
    var toDel = [];
    var rawKeys = {}, metaKeys = {}, evKeys = {};
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i] || {};
      var nm = str(e.name);
      if (e.isDirectory || !nm) continue;
      var mLog = nm.match(/^(snapshots|chatmsg|ui_bridge|errors|boot)-(\d{4})(\d{2})(\d{2})\.jsonl$/);
      if (mLog) {
        var t = new Date(+mLog[2], +mLog[3] - 1, +mLog[4]).getTime();
        if (t < cutoffMs) toDel.push(nm);
        continue;
      }
      var mRaw = nm.match(/^raw_([0-9a-zA-Z]+)\.json$/);
      if (mRaw) { rawKeys[mRaw[1]] = 1; continue; }
      var mMeta = nm.match(/^meta_([0-9a-zA-Z]+)\.json$/);
      if (mMeta) { metaKeys[mMeta[1]] = 1; continue; }
      var mEv = nm.match(/^events_([0-9a-zA-Z]+)\.json$/);
      if (mEv) { evKeys[mEv[1]] = 1; }
    }
    var st = await readIndexStatus();
    // 防线：索引读不到时绝不做孤儿删除。曾因索引读空把真实会话的 raw/meta 当孤儿删掉。
    if (!st.ok) {
      logErr("cleanup: index unreadable, skip orphan pass (protect " + (Object.keys(rawKeys).length + Object.keys(metaKeys).length + Object.keys(evKeys).length) + " session files)");
    } else if (!st.arr.length) {
      logErr("cleanup: index empty, skip orphan pass");
    } else {
      var inIdx = {};
      for (var j = 0; j < st.arr.length; j++) { if (st.arr[j] && st.arr[j].key) inIdx[st.arr[j].key] = 1; }
      for (var rk in rawKeys) { if (!inIdx[rk]) toDel.push("raw_" + rk + ".json"); }
      for (var mk in metaKeys) { if (!inIdx[mk]) toDel.push("meta_" + mk + ".json"); }
      for (var ek in evKeys) { if (!inIdx[ek]) toDel.push("events_" + ek + ".json"); }
    }
    var chain = Promise.resolve();
    var cnt = 0;
    for (var d = 0; d < toDel.length; d++) {
      (function (nm2) {
        chain = chain.then(function () {
          return Tools.Files.deleteFile(OUT_DIR + "/" + nm2, false).then(function () { cnt++; }).catch(function () {});
        });
      })(toDel[d]);
    }
    chain.then(function () { log("cleanup done: removed " + cnt + " files (of " + toDel.length + ")"); });
  } catch (e) { logErr("cleanup inner failed: " + errText(e)); }
}
/** 读索引，返回 {ok, arr, absent}。
 *  Operit2 实测教训：NativeInterface.callTool("default","read_file") 走宿主通用文件工具，
 *  不经过插件数据目录重定向，读不到沙箱里的真 index（而本插件的 Tools.Files.* 会被重定向——cleanup 的 list/delete 能生效即为证）。
 *  所以改用 Tools.Files.read。
 *
 *  ok 三态（2026-10-21 o2.12 修死锁）：
 *    ok=true         读到了，arr 是磁盘索引
 *    ok=false, absent=true   文件本来就不存在（首次运行 / 被清空）——**允许创建**，不算降级
 *    ok=false, absent=false  真的读失败（权限 / IO / 格式坏）——降级：不删孤儿、不回写，保护磁盘索引
 *  旧版把「不存在」也当降级，导致首轮 IDX_DEGRADED 置位后永不写索引，索引永远建不起来（死锁）。 */
async function readIndexStatus() {
  if (MEM_IDX && MEM_IDX.length) return { ok: !IDX_DEGRADED, arr: MEM_IDX.slice(), absent: false };
  try {
    var t = await Tools.Files.read(P_INDEX);
    if (t && typeof t === "object" && typeof t.content === "string") t = t.content;
    var arr = arrFromText(textOf(t));
    MEM_IDX = arr.slice();
    return { ok: true, arr: arr, absent: false };
  } catch (e) {
    var msg = errText(e);
    // 宿主对「不存在」的报错文本是 "File does not exist: <path>"；不同版本措辞可能变，两个特征都认。
    var missing = msg.indexOf("does not exist") >= 0 || msg.indexOf("No such file") >= 0;
    if (missing) {
      MEM_IDX = [];
      return { ok: false, arr: [], absent: true };   // 不算降级：这是正常的首次运行
    }
    IDX_DEGRADED = true;   // 真读失败：本进程内不再做孤儿删除，也不再回写索引
    logErr("index read failed: " + msg);
    return { ok: false, arr: [], absent: false };
  }
}

// ---------- 基础工具 ----------

/** 正常路径：只走 console，不写盘（健康原则：不频繁写盘）。
 *  Operit2 实测 console.error/log/warn 三条全哑（o2.7 探针：重启后 grep 三个前缀均 0 条）。
 *  保留调用是为了宿主哪天修好了能自动恢复。 */
function log(text) {
  try {
    console.error("[prompt_viewer] " + text);
  } catch (e) { /* ignore */ }
}

/** 错误路径专用：console 之外再往数据目录追加一行 errors-YYYYMMDD.jsonl。
 *  为什么必须写盘：Operit2 里插件 console 不通（交接文档 §4 坑 9 —— prelude 遮蔽 bootstrap console，
 *  prelude 版走 runtime.console，取不到就 return undefined 静默丢弃），不写盘的话防线触发了也永远看不见。
 *  这类事件本就罕见，不违反「不频繁写盘」。appendLine 自身失败静默，绝不递归。 */
function logErr(text) {
  try {
    console.error("[prompt_viewer][ERR] " + text);
  } catch (e) { /* ignore */ }
  try {
    appendLine("errors", { at: nowText(), atMs: Date.now(), err: str(text) });
  } catch (e2) { /* ignore */ }
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

/** 建目录统一走 Tools.Files（v2 正规通道）。
 *  Operit2 教训：NativeInterface.callTool("make_directory") 与 Tools.Files.write 是两条不同的通道——
 *  前者把 /sdcard/... 当真实路径，后者会被重定向进插件数据目录。混用会导致「目录建在 A、文件写往 B」，
 *  表现就是 append 能成功（Tools.Files.write 自己会建父目录）而 raw/meta 全失败。
 *  所以这里只保留 Tools.Files.mkdir，并且失败不阻断（append 通道不需要它）。 */
async function ensureOutDir() {
  if (dirEnsured) return;
  dirEnsured = true;
  try {
    await Tools.Files.mkdir(OUT_DIR, true);
  } catch (e) { /* 已存在或宿主自行创建 */ }
}

async function atomicWriteNow(path, body) {
  await ensureOutDir();
  // 原子写（2026-09-17）：先写 .tmp 再 move 覆盖（move 行为已实测：目标存在时直接覆盖）。
  // 读侧因此永不会撞上半写状态；写放大由 delete+create 的 2× 降为 1×（健康原则：写入要原子）。
  // v2 迁移（2026-10-21）：全部改走 Tools.Files.*，不再混用 NativeInterface.callTool——
  // 两套通道在 Operit2 下指向不同位置，混用会让兜底路径写进真实 /sdcard 而读侧永远看不到。
  try {
    var tmp = path + ".tmp";
    await Tools.Files.write(tmp, body, false);
    await Tools.Files.move(tmp, path);
    return true;
  } catch (e) {
    logErr("atomic write failed " + path + ": " + errText(e));
    try { await Tools.Files.deleteFile(path + ".tmp", false); } catch (e0) { /* ignore */ }
    // 兜底：直接覆盖写（非原子，但在 move 不可用时保持可用），仍然只走 Tools.Files。
    try {
      await Tools.Files.write(path, body, false);
      return true;
    } catch (e2) {
      logErr("write failed " + path + ": " + errText(e2));
      return false;
    }
  }
}
/** 覆写类写盘统一入口：挂全局写链（顺序 = 入链序），原子落盘防半写（健康原则） */
function writeText(path, content) {
  var body = str(content);
  writeChain = writeChain.then(function () { return atomicWriteNow(path, body); }).catch(function (e) {
    logErr("writeText chain error: " + errText(e));
  });
  return writeChain;
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

async function onPromptFinalize(input) {
  var capturedAt = nowText();
  try {
    var payload = input && input.eventPayload && typeof input.eventPayload === "object"
      ? input.eventPayload
      : {};

    // [O2-STAGE] Operit2 的 v1 兼容层把本钩子派发到两个 stage：before_finalize_prompt + before_send_to_model
    // （与官方 ToolPkgPromptFinalizeEventName 枚举完全对齐；旧注释写的「7 个 stage」是我混数，已收回，见交接文档 §4 坑 7）。
    // 只在「发给模型前的最后一站」落盘：raw/meta/index/snapshots 每轮各一次。
    if (str(payload.stage).indexOf("send_to_model") < 0) return undefined;

  // boot 自检（console 哑的替代观测）：每次进程启动写一行 boot-YYYYMMDD.jsonl。
  // 作用有两个：① 证明本次进程加载的是哪个版本（cache 的 .toolpkg-cache-signature 不能证明 main script 版本，
  //    见交接文档 §4 坑 3 修正：EXTERNAL 包是从 .toolpkg zip 直接读 main.js，不经 cache）；
  //    ② 证明错误通道（appendLine 写盘）活着，logErr 依赖同一条路径。
  // 本钩子末尾有 await writeChain，所以这一行一定会落盘。每次进程 1 行，量可忽略。
  if (!BOOT_DONE) {
    BOOT_DONE = true;
    appendLine("boot", { at: nowText(), atMs: Date.now(), version: PKG_VERSION, stage: str(payload.stage) });
  }

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

    // P3-2：里程碑事件（独立文件；失败只记日志，绝不影响 raw/meta/index 主流程）
    try { collectEvents(payload, P, capturedAt, capturedAtMs); } catch (eEv) { logErr("events collect failed: " + errText(eEv)); }

    // 更新索引：本对话挪到最前（UI 按「最新的一份」自动选取），环形保留最近 RETAIN_SESSIONS 个对话
    var st = await readIndexStatus();
    var idx = st.arr.filter(function (it) { return it && it.key !== P.key; });
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
      try { pruneSessionFiles(dropped); } catch (eD) { logErr("prune dropped failed: " + errText(eD)); }
    }
    MEM_IDX = idx.slice();   // 内存里记住，同一次运行内不依赖读盘
    // 写索引的判定（o2.12）：
    //   读到了 (ok)          → 正常回写
    //   文件本不存在 (absent) → **必须写**，否则首轮永远建不起索引（旧版死锁）
    //   真读失败 (degraded)   → 不回写，保住磁盘上可能更完整的索引
    if (st.ok || st.absent) writeText(P_INDEX, safeJson(idx));
    else logErr("index writeback skipped (degraded): keep disk index intact");
    // 每日一次：日志滚动清理 + 索引外孤儿对齐（挂在写链上，异常不吞）
    try { await cleanupOldData(); } catch (eC) { logErr("cleanup failed: " + errText(eC)); }

    log("captured: chat=" + P.key + " rawChars=" + rawText.length + " rawLines=" + rawLines +
      " keys=" + payloadKeys.length);

    // v2:每轮轻量快照（钩子入口已按 stage 过滤，这里不再重复判断）
    try { collectSnapshot(payload); } catch (e1) { logErr("snapshot collect failed: " + errText(e1)); }
    // v2(W8):报错门类留档——扫本次装配可见的系统警告，增量写 warnings-YYYYMMDD.jsonl（低频：仅新增时写一行）
    try { w8CaptureWarns(payload); } catch (eW) { logErr("warn capture failed: " + errText(eW)); }
  } catch (e) {
    logErr("capture failed: " + errText(e));
  }
  // [O2-ASYNC] 对齐官方内置 goal_mode：钩子返回 Promise（Rust 侧 ToolPkgHookReturn::Variant6(JsFuture)），
  // 宿主 await 到写链完成，避免同步 return undefined 时挂链的 .then() 没机会发起 native 调用。
  // 边界处 flush（OpenTelemetry BatchSpanProcessor 的 onEnd 入队 / ForceFlush 落盘 同构）。
  try { await writeChain; } catch (eA) { logErr("flush failed: " + errText(eA)); }
  // 绝不修改提示词本身
  return undefined;
}

// ---------- v2 采集层：每轮快照 + 消息事件（2026-09-15 新增） ----------
// 数据源与口径经 实机验证：
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
    Tools.Files.mkdir(OUT_DIR, true);
    v2DirEnsured = true;
  } catch (e) { /* ignore */ }
}

/** 串行追加一行 JSONL（写队列防并发交错；失败静默不干扰业务） */
function appendLine(baseName, obj) {
  writeChain = writeChain.then(function () {
    try {
      ensureV2Dir();
      var path = OUT_DIR + "/" + baseName + "-" + todayKey() + ".jsonl";
      return Tools.Files.write(path, JSON.stringify(obj) + "\n", true);
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

/** 图片附件路径（去重；只存路径，token 估算留给 UI 桥层）：与 dashboard apiSummary 同口径——扫历史里 <attachment ... type="image...> 的 id */
function imgPathsOf(hist) {
  var out = [];
  try {
    var seen = {};
    var idRe = /id="([^"]+)"/;
    for (var i = 0; i < hist.length; i++) {
      var c = str((hist[i] || {}).content);
      if (c.indexOf("<attachment") < 0) continue;
      var ms = c.match(/<attachment[^>]*type="image[^>]*>/g);
      if (!ms) continue;
      for (var j = 0; j < ms.length; j++) {
        var m = idRe.exec(ms[j]);
        var p = m ? m[1] : "";
        if (p && !seen[p]) { seen[p] = 1; out.push(p); }
      }
    }
  } catch (e) { /* 静默，不影响快照主体 */ }
  return out;
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
    sys: segSys,
    imgPaths: imgPathsOf(hist)
  });
}

// ==== EVENTS_V1 BEGIN（2026-11-23 P3-2；纯函数段：node 自检脚本按标记提取，勿在段内用宿主 API）====
// 里程碑事件采集：先从 TOOL_CALL / TOOL_RESULT 的 XML 里解「真实工具名」，再提 todo / goal / ask /
// team-task / agent / skill 事件（字段语义对齐上游 dsh-context 的 ContextEventRecord）。
//
// 实机事实（2026-11-23 对 6 份 raw 全量实测，别凭印象改）：
//   1) TOOL_CALL content = <tool name="pkg:tool" call_id="…"><param name="k">v</param></tool>，值里有 XML 实体
//   2) package_proxy 是最高频包装：真实名在 param tool_name，调用参数在 param params 的 JSON 里
//      —— 6 份样本 406 次调用里 333 次是它，不解这层，工具统计里清一色 package_proxy
//   3) TOOL_RESULT content = <tool_result name="pkg:tool" status="success"><content>…</content></tool_result>
//      结果里的 name 给的是「真实名」而非 package_proxy，故按真实名 FIFO 配对回调用
//   4) 历史条目 metadata 恒为 {}、chatHistory 为空 → **没有逐调用时间戳**；事件 time 统一取本次抓取时刻，
//      文件头 timeSource:"capture" 明示来源，绝不伪造逐条时间
//   5) 当前 Operit2 的 availableTools（21 个核心工具）里没有 todo/goal/ask/team 工具，未启用 plan/goal
//      模式时这些事件本就是 0 条 → 规则只在「工具身份 + 参数/结果结构」双证据齐备时产出，拿不准一律跳过
var EV_ITEMS_MAX = 8;
var EV_ENTRIES_MAX = 128;
var EV_MAP_MAX = 256;
var EV_EVENTS_MAX = 2000;
var EV_TODO_STATUS = { pending: 1, in_progress: 1, completed: 1 };
var EV_TASK_STATUS = { pending: 1, in_progress: 1, completed: 1, deleted: 1 };
var EV_AGENT_TAILS = { agent: 1, subagent: 1, spawn_agent: 1, agent_spawn: 1, delegate: 1, task_agent: 1, run_agent: 1, spawn_subagent: 1 };
var EV_SKILL_TAILS = { use_skill: 1, load_skill: 1, skill: 1, skill_use: 1, run_skill: 1, execute_skill: 1 };

function evText(v) { return v === null || v === undefined ? "" : String(v); }
function evTrim(v) { return evText(v).replace(/^\s+|\s+$/g, ""); }
function evClip(s, n) { var t = evText(s); return t.length > n ? t.slice(0, n - 1) + "…" : t; }
function evObj(v) { return v && typeof v === "object" && !Array.isArray(v) ? v : null; }
function evTryParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }

/** XML 实体解码：与 dashboard UI 的 fa2Unesc 同口径（两侧必须一致，否则参数文本会漂） */
function evUnesc(s) {
  return String(s).replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-fA-F]+);/g, function (m, g) {
    switch (g) { case "lt": return "<"; case "gt": return ">"; case "quot": return "\""; case "apos": return "'"; case "amp": return "&"; }
    if (g.charAt(0) === "#") {
      try { return String.fromCodePoint(g.charAt(1) === "x" || g.charAt(1) === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10)); } catch (e) { }
    }
    return m;
  });
}
/** 取名字末段（与 UI 的 fa2ToolTail 同口径）：super_admin:bash → bash（全名另行保留在 tool 字段） */
function evToolTail(raw) {
  var s = evText(raw);
  var i = s.lastIndexOf(":");
  return i > -1 ? s.slice(i + 1) : s;
}
/** 工具名按「段」切：create_goal → [create, goal]；super_admin:bash → [super, admin, bash]
 *  用段匹配而不是子串匹配，是为了让 task 不误命中 ask、goalkeeper 不误命中 goal */
function evSegs(name) { return evText(name).toLowerCase().split(/[:_.\/\-]+/); }
function evHasSeg(name, words) {
  var s = evSegs(name);
  for (var i = 0; i < s.length; i++) if (words.indexOf(s[i]) >= 0) return true;
  return false;
}
/** 宽容 JSON：整段 / 二次编码字符串 / 从混合文本里截首个 {…} 都试一遍，失败返回 null */
function evJsonDeep(v) {
  if (v && typeof v === "object") return v;
  var t = evTrim(v);
  if (!t) return null;
  var o = evTryParse(t);
  if (typeof o === "string") o = evTryParse(o);
  if (o && typeof o === "object") return o;
  var a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { o = evTryParse(t.slice(a, b + 1)); if (o && typeof o === "object") return o; }
  return null;
}

/** 解一条 TOOL_CALL → {seq, raw, tool, tail, params, json, unresolved}
 *  raw=XML 原始名；tool=解包后的真实名；json=proxy 的 params JSON（解不出为 null） */
function evCallOf(item, seq) {
  var content = evText(item && item.content);
  var m = content.match(/<tool(?:_[A-Za-z0-9]+)?\s+name="([^"]+)"/);
  var raw = m ? m[1] : evTrim(item && item.toolName);
  if (!raw) return null;
  var params = {}, re = /<param\s+name="([A-Za-z0-9_]+)"\s*>([\s\S]*?)<\/param>/g, pm;
  while ((pm = re.exec(content)) !== null) params[pm[1]] = evUnesc(pm[2]);
  var outer = params, cur = params, tool = raw, tail = evToolTail(raw), json = null, guard = 0;
  while (tail === "package_proxy" && guard++ < 4) {
    var innerName = evTrim(cur.tool_name);
    if (!innerName) return { seq: seq, raw: raw, tool: tool, tail: tail, params: outer, json: json, unresolved: 1 };
    json = evJsonDeep(cur.params) || json;
    tool = innerName;
    tail = evToolTail(innerName);
    var w = evObj(json);
    cur = w ? { tool_name: w.tool_name, params: w.params } : { tool_name: "", params: null };
  }
  return { seq: seq, raw: raw, tool: tool, tail: tail, params: outer, json: json, unresolved: 0 };
}

/** 统一「调用参数」对象：proxy 的 params JSON 打底，param 里整段是 JSON 的也并进来（不覆盖已有键） */
function evArgsOf(call) {
  var out = {}, k, v, sub;
  var j = evObj(call && call.json);
  if (j) for (k in j) out[k] = j[k];
  var p = evObj(call && call.params) || {};
  for (k in p) {
    if (k === "params" || k === "tool_name") continue;
    v = p[k];
    if (typeof v === "string") {
      var c0 = v.charAt(0);
      if (c0 === "{" || c0 === "[") {
        sub = c0 === "[" ? evTryParse(v) : evJsonDeep(v);
        if (sub && typeof sub === "object") { if (!(k in out)) out[k] = sub; continue; }
      }
    }
    if (!(k in out)) out[k] = v;
  }
  return out;
}

/** 解一条 TOOL_RESULT 的名字（已是真实名；万一再包一层 proxy 也拆） */
function evResultName(item) {
  var content = evText(item && item.content);
  var m = content.match(/<tool_result(?:_[A-Za-z0-9]+)?\s+name="([^"]+)"/);
  var raw = m ? m[1] : evTrim(item && item.toolName);
  if (!raw) return "";
  if (evToolTail(raw) === "package_proxy") {
    var p = content.match(/<param\s+name="tool_name"\s*>([\s\S]*?)<\/param>/);
    if (p) return evTrim(evUnesc(p[1]));
  }
  return raw;
}
/** 解 TOOL_RESULT 正文里的 JSON（只认 <content> 整段/可截取成对象的情况；纯文本结果返回 null） */
function evResultJson(item) {
  var content = evText(item && item.content);
  var m = content.match(/<content\b[^>]*>([\s\S]*?)<\/content>/);
  return evJsonDeep(m ? m[1] : content);
}

/** todo：只要 [{content, status}] 形态（上游 WorkflowTodoStatus 三态），别的一概不认 */
function evTodosOf(src) {
  var arr = evObj(src) ? src.todos : null;
  if (!Array.isArray(arr)) return null;
  var out = [];
  for (var i = 0; i < arr.length && out.length < EV_ENTRIES_MAX; i++) {
    var o = evObj(arr[i]);
    if (!o) continue;
    var c = evTrim(o.content), st = evTrim(o.status);
    if (!c || !EV_TODO_STATUS[st]) continue;
    out.push([c, st]);
  }
  return out.length ? out : null;
}

function evTrimMap(map, max) {
  var keys = [];
  for (var k in map) keys.push(k);
  if (keys.length <= max) return;
  var keep = {};
  for (var i = keys.length - Math.floor(max / 2); i < keys.length; i++) keep[keys[i]] = map[keys[i]];
  for (k in map) delete map[k];
  for (k in keep) map[k] = keep[k];
}

/** todo 折叠：新增内容 → todo-add(count)；非 completed → completed → todo-done(items ≤ 8, name=首个) */
function evTodoEvents(entries, todoMap) {
  var out = [], adds = 0, done = [], i, c, st, prev;
  for (i = 0; i < entries.length; i++) {
    c = entries[i][0]; st = entries[i][1]; prev = todoMap[c];
    if (prev === undefined) adds++;
    else if (prev !== "completed" && st === "completed") done.push(c);
    todoMap[c] = st;
  }
  evTrimMap(todoMap, EV_MAP_MAX);
  if (adds > 0) out.push({ kind: "todo-add", count: adds });
  if (done.length > 0) {
    var items = [];
    for (i = 0; i < done.length && items.length < EV_ITEMS_MAX; i++) items.push(evClip(done[i], 120));
    out.push({ kind: "todo-done", count: done.length, items: items, name: items[0] });
  }
  return out;
}

/** goal：objective 必须取到；create/complete 必须有明确信号（operation / 工具名动词 / 结果状态） */
function evGoalEvent(args, name, resJson) {
  var a = evObj(args) || {};
  var r = evObj(resJson) || {};
  var g = evObj(a.goal) || {};
  var rg = evObj(r.goal) || {};
  var objective = evTrim(g.objective) || evTrim(a.objective) || evTrim(rg.objective) || evTrim(r.objective);
  var op = evTrim(a.operation).toLowerCase() || evTrim(r.operation).toLowerCase();
  var status = (evTrim(g.status) || evTrim(a.status) || evTrim(rg.status) || evTrim(r.status)).toLowerCase();
  var named = evHasSeg(name, ["goal", "goals"]) || evObj(a.goal) || evObj(r.goal);
  if (!named || !objective) return null;
  if (op !== "create" && op !== "complete") op = "";
  var done = op === "complete" || status === "completed" ||
    evHasSeg(name, ["complete", "completed", "done", "finish", "achieve", "achieved"]);
  var created = op === "create" || evHasSeg(name, ["create", "new", "add", "set", "start"]);
  if (!done && !created && (status === "active" || status === "pending" || status === "in_progress")) created = true;
  if (!done && !created) return null;
  return { kind: done ? "goal-complete" : "goal-create", name: evClip(objective, 120), count: 1 };
}

/** ask：questions[] 结构是最硬证据；单问句形态必须工具名带 ask/question 类词 */
function evAskEvent(args, name) {
  var a = evObj(args) || {};
  var items = [], count = 0, i;
  var askish = evHasSeg(name, ["ask", "question", "questions", "clarify", "interview", "confirm"]);
  var qs = a.questions;
  if (Array.isArray(qs)) {
    for (i = 0; i < qs.length; i++) {
      var o = evObj(qs[i]);
      var t = o ? evTrim(o.question) : "";
      if (!t) continue;
      count++;
      if (items.length < EV_ITEMS_MAX) items.push(evClip(t, 120));
    }
  }
  if (!count && askish) {
    var one = evTrim(a.question) || evTrim(a.prompt);
    if (one) { count = 1; items = [evClip(one, 120)]; }
  }
  if (!count) return null;
  return { kind: "ask", count: count, items: items, name: items[0] };
}

/** team-task：task{id, subject, status} 折叠；首次见到 → create，转 completed → complete */
function evTeamEvents(args, resJson, taskMap) {
  var srcs = [evObj(args), evObj(resJson)], t = null, i;
  for (i = 0; i < srcs.length && !t; i++) {
    if (!srcs[i]) continue;
    var tk = evObj(srcs[i].task);
    if (!tk) continue;
    var id = evTrim(tk.id), subject = evTrim(tk.subject), st = evTrim(tk.status);
    if (!id || !subject || !EV_TASK_STATUS[st] || id === "__proto__") continue;
    t = { id: id, subject: subject, status: st };
  }
  if (!t) return [];
  var prev = taskMap[t.id], out = [];
  if (prev === undefined && t.status !== "deleted") out.push({ kind: "team-task-create", count: 1 });
  if (prev !== undefined && prev !== "completed" && t.status === "completed") {
    out.push({ kind: "team-task-complete", name: evClip(t.subject, 120), count: 1 });
  }
  if (t.status === "deleted") delete taskMap[t.id]; else taskMap[t.id] = t.status;
  evTrimMap(taskMap, EV_MAP_MAX);
  return out;
}

/** agent 派生：只认显式的 spawn/agent 工具名，且参数里同时有「名字 + 任务」才记（agent_status 这类探测工具不记） */
function evAgentEvent(args, name, tail) {
  var a = evObj(args) || {};
  if (!EV_AGENT_TAILS[tail] && !/^(spawn|delegate)_/.test(tail) &&
    !evHasSeg(name, ["agent", "agents", "subagent", "subagents", "spawn", "delegate"])) return null;
  var nm = evTrim(a.agent) || evTrim(a.name) || evTrim(a.agentName) || evTrim(a.subagent_type) || evTrim(a.agent_type);
  var task = evTrim(a.prompt) || evTrim(a.task) || evTrim(a.instruction) || evTrim(a.description);
  if (!nm || !task) return null;
  return { kind: "agent", name: evClip(nm, 120), detail: evClip(task, 120), count: 1 };
}

/** 技能加载：工具名必须带 skill 且拿到技能名（拿不到名字就不记） */
function evSkillEvent(args, name, tail) {
  var a = evObj(args) || {};
  if (!EV_SKILL_TAILS[tail] && !evHasSeg(name, ["skill", "skills"])) return null;
  var nm = evTrim(a.skill) || evTrim(a.skill_name) || evTrim(a.skillName) || evTrim(a.name);
  if (!nm) return null;
  return { kind: "skill", name: evClip(nm, 120), count: 1 };
}

/** 候选预筛：只对「工具名像里程碑」或「参数结构像里程碑」的调用去解结果，避免解析海量普通输出 */
function evIsCandidate(call) {
  var a = call.args || {}, n = call.tool, tail = call.tail;
  if (EV_AGENT_TAILS[tail] || EV_SKILL_TAILS[tail]) return true;
  if (evHasSeg(n, ["goal", "goals", "todo", "todos", "task", "tasks", "team", "plan", "plans",
    "ask", "question", "questions", "clarify", "interview", "confirm",
    "agent", "agents", "subagent", "subagents", "spawn", "delegate", "skill", "skills"])) return true;
  if (Array.isArray(a.todos) || Array.isArray(a.questions)) return true;
  if (a.goal || a.operation !== undefined || evObj(a.task)) return true;
  return false;
}

/** 主入口：整份 preparedHistory 重算事件（每轮全量重算 → 天然去重、无跨轮状态残留）
 *  seq=该调用在 history 里的下标（同一次调用产出的多条事件共享 seq，靠 ord 区分，对齐上游） */
function evExtractEvents(hist, capturedAtMs) {
  var list = Array.isArray(hist) ? hist : [];
  var events = [], todoMap = {}, taskMap = {};
  var pending = [], queue = {}, turn = 0, step = 0, i, it, kind, call;
  for (i = 0; i < list.length; i++) {
    it = list[i] || {};
    kind = evText(it.kind || it.role).toUpperCase();
    if (kind === "ASSISTANT") { turn++; step = 0; continue; }
    if (kind === "TOOL_CALL") {
      step++;
      call = evCallOf(it, i);
      if (!call || call.unresolved) continue;
      call.turn = turn > 0 ? turn : 1;
      call.step = step;
      call.args = evArgsOf(call);
      if (evIsCandidate(call)) {
        pending.push(call);
        (queue[call.tool] = queue[call.tool] || []).push(call);
      }
      continue;
    }
    if (kind === "TOOL_RESULT") {
      var rname = evResultName(it);
      var q = rname ? queue[rname] : null;
      if (!q || !q.length) continue;
      var owner = q.shift();
      owner.result = evResultJson(it);
    }
  }
  for (i = 0; i < pending.length; i++) {
    call = pending[i];
    var args = call.args || {}, res = call.result, got = [], k;
    var todos = evTodosOf(args) || evTodosOf(res);
    if (todos) got = got.concat(evTodoEvents(todos, todoMap));
    var g = evGoalEvent(args, call.tool, res);
    if (g) got.push(g);
    var a = evAskEvent(args, call.tool);
    if (a) got.push(a);
    var team = evTeamEvents(args, res, taskMap);
    if (team.length) got = got.concat(team);
    var ag = evAgentEvent(args, call.tool, call.tail);
    if (ag) got.push(ag);
    var sk = evSkillEvent(args, call.tool, call.tail);
    if (sk) got.push(sk);
    for (k = 0; k < got.length; k++) {
      var ev = got[k];
      var rec = { seq: call.seq, time: capturedAtMs, kind: ev.kind };
      if (got.length > 1) rec.ord = k;
      if (ev.name !== undefined) rec.name = ev.name;
      if (ev.detail !== undefined) rec.detail = ev.detail;
      if (ev.items !== undefined) rec.items = ev.items;
      if (ev.count !== undefined) rec.count = ev.count;
      rec.turn = call.turn;
      rec.step = call.step;
      events.push(rec);
    }
  }
  if (events.length > EV_EVENTS_MAX) events = events.slice(events.length - EV_EVENTS_MAX);
  return events;
}

/** events_<key>.json 的正文（UI 侧契约见交付说明；timeSource 明示 time 的来源） */
function evPayload(chatId, key, capturedAt, capturedAtMs, hist) {
  var list = Array.isArray(hist) ? hist : [];
  return {
    updatedAt: evText(capturedAt),
    updatedAtMs: capturedAtMs,
    chatId: evText(chatId),
    key: evText(key),
    version: 1,
    timeSource: "capture",
    historyCount: list.length,
    events: evExtractEvents(list, capturedAtMs)
  };
}
// ==== EVENTS_V1 END ====

/** P3-2 落盘：整份重算后一次原子写（走 writeText 写链）；失败只记日志，不影响 raw/meta 主流程 */
function collectEvents(payload, P, capturedAt, capturedAtMs) {
  try {
    var hist = Array.isArray(payload.preparedHistory) ? payload.preparedHistory
      : (Array.isArray(payload.chatHistory) ? payload.chatHistory : []);
    var data = evPayload(P.chatId, P.key, capturedAt, capturedAtMs, hist);
    writeText(P.events, safeJson(data));
    log("events: chat=" + P.key + " n=" + data.events.length);
    return data;
  } catch (e) {
    logErr("events collect failed: " + errText(e));
    return null;
  }
}

// ==== W8_WARN BEGIN（Viya 2026-09-17；纯函数段：node 自检脚本按标记提取，勿在段内用宿主 API）====
// 报错门类 · 警告扫描与增量去重（预研 2026-09-17：全库 raw 四会话「警告数 = skip 数」对拍一致）
// 警告形态（Operit2 口径，2026-10-08 源码钉死 + 5 份 raw 离线对拍）：
//   A 内嵌型：ASSISTANT 内容末尾追加 <status type="warning">警告：…</status>（紧跟 </think>）
//   B 独立型：作为独立 TOOL_RESULT 条目入历史，content 以该标签开头
//   注入点 EnhancedAIService.rs:2382（纯思考警告）；trunc 类警告在 main 分支无注入点，
//   工具截断实际形态是后缀「\n[工具结果过长，已截断]」（ConversationMarkupManager.rs:5）。
// 判定四条件（缺一即拒，防误报）：完整标签对 + 正文以「警告：」开头 + 紧跟 </think> 或位于 content 开头 + 不限 kind。
// 旧口径（kind=USER 且 content 以标签开头）在 Operit2 恒 0 命中，已废。
function w8WarnTypeOf(text) {
  var s = String(text);
  if (s.indexOf("检测到工具调用输出被截断") >= 0) return "trunc";
  if (s.indexOf("工具结果过长，已截断") >= 0) return "trunc";
  if (s.indexOf("请输出正文内容") >= 0) return "empty";
  return "other";
}
/** 从一段 content 里取真警告正文（返回 [{text, index}]）；引用型/无闭标签的代码片段一律拒 */
function w8WarnPairsOf(ct) {
  var res = [];
  var re = /<status[^>]*type="warning"[^>]*>([\s\S]*?)<\/status>/g;
  var m;
  while ((m = re.exec(ct)) !== null) {
    var text = String(m[1] || "").trim();
    if (text.indexOf("警告：") !== 0) continue;
    var before = ct.slice(0, m.index);
    var atHead = before.replace(/\s+/g, "").length === 0;
    if (!atHead && !/<\/think>\s*$/.test(before)) continue;
    res.push({ text: text, index: m.index });
  }
  return res;
}
/** 扫一段历史，返回可见警告 [{idx, type, text}]（text=去标签正文；留档与展示共用同一口径） */
function w8ScanWarns(hist) {
  var out = [];
  try {
    for (var i = 0; i < hist.length; i++) {
      var x = hist[i] || {};
      var ct = String(x.content === null || x.content === undefined ? "" : x.content);
      if (ct.indexOf("type=\"warning\"") < 0) continue;
      var ps = w8WarnPairsOf(ct);
      for (var j = 0; j < ps.length; j++) {
        out.push({ idx: i, type: w8WarnTypeOf(ps[j].text), text: ps[j].text });
      }
    }
  } catch (e) { /* 静默：不影响主流程 */ }
  return out;
}
/** 增量去重（V vs R 自校正）：V=本次可见列表中该文本条数；R=留档中该会话该文本条数；
 *  返回「本次应新增写入的文本列表」（长度=待写条数，逐文本维度）。
 *  已知限制：历史警告被压缩清除后再出现同类新警告时，可能因 V≤R 被掩盖而漏记（罕见，接受）。 */
function w8CountNew(warns, recorded) {
  var vc = {}, i, t, delta;
  for (i = 0; i < warns.length; i++) {
    t = String(warns[i].text);
    vc[t] = (vc[t] || 0) + 1;
  }
  var out = [];
  for (t in vc) {
    delta = vc[t] - ((recorded && recorded[t]) || 0);
    for (i = 0; i < delta; i++) out.push(t);
  }
  return out;
}
// ==== W8_WARN END ====
// W8 留档 IO（段外：用宿主 API；文件名 warnings-YYYYMMDD.jsonl，单行追加、读侧对坏行容错）
var W8_SEEN = null;
/** 读最近 3 个 warnings-*.jsonl 重建「该会话该文本已记录条数」（进程内缓存；失败按空处理） */
function w8LoadSeen() {
  if (W8_SEEN) return Promise.resolve(W8_SEEN);
  var seen = {};
  return Tools.Files.list(OUT_DIR).then(function (r) {
    var entries = (r && r.entries) ? r.entries : [];
    var names = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i] || {};
      var nm = str(e.name);
      if (e.isDirectory || !nm) continue;
      if (nm.indexOf("warnings-") === 0 && nm.slice(-6) === ".jsonl") names.push(nm);
    }
    names.sort();
    names.reverse();
    if (names.length > 3) names = names.slice(0, 3);
    var chain = Promise.resolve();
    for (var j = 0; j < names.length; j++) {
      (function (nm2) {
        chain = chain.then(function () {
          return Tools.Files.read(OUT_DIR + "/" + nm2).then(function (t) {
            try {
              if (t && typeof t === "object" && typeof t.content === "string") t = t.content;
              var lines = str(t).split("\n");
              for (var k = 0; k < lines.length; k++) {
                var ln = lines[k];
                if (!ln || !ln.trim()) continue;
                try {
                  var o = JSON.parse(ln);
                  var s0 = str(o.session), t0 = str(o.text);
                  if (s0 && t0) {
                    var g = seen[s0] || (seen[s0] = {});
                    g[t0] = (g[t0] || 0) + 1;
                  }
                } catch (e2) { /* 坏行跳过 */ }
              }
            } catch (e3) { /* ignore */ }
          }).catch(function () { /* 单文件失败不致命 */ });
        });
      })(names[j]);
    }
    return chain.then(function () { W8_SEEN = seen; return seen; });
  }).catch(function () { W8_SEEN = seen; return seen; });
}
/** 装配时调用：扫本次可见警告 → 增量写留档（挂在写链尾部；无新增零写盘） */
function w8CaptureWarns(payload) {
  try {
    var hist = Array.isArray(payload.preparedHistory) ? payload.preparedHistory
      : (Array.isArray(payload.chatHistory) ? payload.chatHistory : []);
    var warns = w8ScanWarns(hist);
    if (!warns.length) return;
    var chatId = str(payload.chatId);
    var stage = str(payload.stage);
    writeChain = writeChain.then(function () {
      return w8LoadSeen().then(function (seen) {
        var sess = chatId.slice(0, 8);
        var rec = seen[sess] || (seen[sess] = {});
        var news = w8CountNew(warns, rec);
        if (!news.length) return null;
        var queue = {};
        for (var i = 0; i < warns.length; i++) {
          var wI = warns[i];
          (queue[wI.text] = queue[wI.text] || []).push(wI);
        }
        var chain2 = Promise.resolve();
        for (var j = 0; j < news.length; j++) {
          (function (t2) {
            chain2 = chain2.then(function () {
              var q = queue[t2] || [];
              var sample = q.shift() || { type: "other", idx: -1 };
              var obj = { at: nowText(), atMs: Date.now(), session: sess, chatId: chatId, type: sample.type, text: t2, idx: sample.idx, stage: stage };
              try { ensureV2Dir(); } catch (e0) { /* ignore */ }
              return Tools.Files.write(OUT_DIR + "/warnings-" + todayKey() + ".jsonl", JSON.stringify(obj) + "\n", true).then(function () {
                rec[t2] = (rec[t2] || 0) + 1;
              }).catch(function (e1) { logErr("warn write failed: " + errText(e1)); });
            });
          })(news[j]);
        }
        return chain2.then(function () { log("warnings recorded: sess=" + sess + " new=" + news.length); });
      });
    }).catch(function (eW2) { logErr("warn flush failed: " + errText(eW2)); });
  } catch (e) { logErr("warn capture failed: " + errText(e)); }
}
/** 消息事件（流式快照 + 完成态 usage）。完全相同的事件去重（同 chatId/sentAt/长度/done）。 */
var lastChatKey = null;

// [O2-ASYNC] 对齐官方内置 goal_mode 的写法：钩子返回 Promise，宿主 await 到写链完成，
// 避免同步 return undefined 时挂链的 .then() 回调没机会发起 native 调用。
async function onChatMessage(input) {
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
    await appendLine("chatmsg", {
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
    logErr("chatmsg collect failed: " + errText(e));
  }
  return undefined;
}

// ---------- F15 消息级「看本轮上下文」 ----------

// 仪表盘 UI 路由：与 registerUiRoute 注册的 route 串一致（导航/浮动窗口都按这个找）
var DASH_ROUTE = "toolpkg:" + PKG_ID + ":ui:prompt_viewer_dashboard";
var DASH_WIN_ID = "prompt_viewer_dash_win";
// 第二入口（消息下方内联入口，由宿主自己跳 route）：置 false 可一键关掉，只留长按菜单项
var CHAT_JUMP_ENTRY = false;   // P0：chat_message_after 让宿主为每条消息挂 UI 入口（同一 controller key 被反复争用），实测触发 WebView 重建风暴 → 默认关闭，只保留长按菜单项

/**
 * 打开仪表盘面板，返回 true = 宿主接受了打开请求。
 * 宿主侧唯一「可编程打开已注册路由」的入口是 ToolPkg.ui.floatingWindows（v2 API 2.0.0）：
 * open({id, route, fill}) 把已注册的 Compose 路由挂成一个活动窗口并铺满当前范围。
 * 没有别的后备路径 —— 路由只能由宿主 UI 自己跳（侧边栏入口就是那条路），插件无法再驱动。
 */
async function openDashboardSurface() {
  try {
    var fw = (typeof ToolPkg !== "undefined" && ToolPkg && ToolPkg.ui && ToolPkg.ui.floatingWindows)
      ? ToolPkg.ui.floatingWindows : null;
    if (!fw || typeof fw.open !== "function") return false;
    var caps = null;
    try { caps = typeof fw.capabilities === "function" ? await fw.capabilities() : null; } catch (eCap) { caps = null; }
    if (caps && caps.supported === false) {
      logErr("dashboard open: host reports floating windows unsupported");
      return false;
    }
    // 同一个 id 重复 open 会失败（文档：opening an existing ID fails）→ 先关掉，保证每次点击都能打开
    try { await fw.set(DASH_WIN_ID, null); } catch (eClose) { /* 没开过就忽略 */ }
    try {
      await fw.open({ id: DASH_WIN_ID, route: DASH_ROUTE, fill: true, options: { focusable: true } });
      return true;
    } catch (eOpen) {
      // 个别宿主认 route id 而不是完整 route 串：退一步用注册 id 再试一次，仍失败才算打不开
      logErr("dashboard open(route) failed, retry by id: " + errText(eOpen));
      await fw.open({ id: DASH_WIN_ID, route: "prompt_viewer_dashboard", fill: true, options: { focusable: true } });
      return true;
    }
  } catch (e) {
    logErr("dashboard open failed: " + errText(e));
    return false;
  }
}

/**
 * F15：聊天消息长按菜单「看本轮上下文」。
 * 能打开面板 = 成功；「定位到被点的这一轮」需要桥层 api 接收锚点入参（index.ui.js 本轮不动），
 * 所以这里只把锚点写进日志（不落盘、不改任何读取路径），下一轮接深链时按日志对拍。
 * Operit2 的 console 不通，logErr 会落到 errors-*.jsonl，可事后核对打开是否真的发生。
 */
async function onChatMessageMenu(input) {
  try {
    var p = (input && input.eventPayload && typeof input.eventPayload === "object") ? input.eventPayload : (input || {});
    var msg = (p.message && typeof p.message === "object") ? p.message : {};
    var chatId = str(p.chatId);
    var ok = await openDashboardSurface();
    log("menu-jump: chat=" + (chatId ? chatId.slice(0, 8) : "unknown") +
      " index=" + num(p.messageIndex) +
      " sentAt=" + num(msg.sentAt) +
      " tokens=" + num(msg.inputTokens) + "/" + num(msg.cachedInputTokens) + "/" + num(msg.outputTokens) +
      " open=" + (ok ? "1" : "0"));
  } catch (e) {
    logErr("menu-jump failed: " + errText(e));
  }
  // 不返回 dialog：面板自己就是一个窗口，不需要再叠一层弹窗
  return null;
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
    logErr("dashboard register failed: " + errText(e2));
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
    logErr("chat hook register failed: " + errText(e2));
  }

  // F15 消息级跳转 ①：聊天消息长按菜单「看本轮上下文」→ 打开仪表盘窗口（v2 API 2.0.0）
  try {
    ToolPkg.registerChatMessageMenuItem({
      id: "pvm_view_context",
      title: { zh: "看本轮上下文", en: "View Context" },
      icon: "dashboard",
      order: 80,
      function: onChatMessageMenu
    });
    log("chat message menu item registered");
  } catch (e3) {
    logErr("chat menu item register failed: " + errText(e3));
  }

  // F15 消息级跳转 ②：消息下方内联导航入口 —— route 由宿主自己跳，最稳；
  // 宿主不认 chat_message_after 这个 surface 时注册会抛错，只记日志、不影响菜单项。
  if (CHAT_JUMP_ENTRY) {
    try {
      ToolPkg.registerNavigationEntry({
        id: "prompt_viewer_msg_jump",
        route: DASH_ROUTE,
        surface: "chat_message_after",
        title: { zh: "看本轮上下文", en: "View Context" },
        icon: "dashboard",
        order: 72
      });
      log("chat message jump entry registered");
    } catch (e4) {
      logErr("chat jump nav entry register failed: " + errText(e4));
    }
  }

  try {
    Tools.Files.mkdir(OUT_DIR, true);
  } catch (e) { /* ignore */ }

  log("registered (raw + metrics mode)");
  // 注意：boot 自检标记不在这里写。registerToolPkg 是同步返回，宿主不 await，
  // 挂在 writeChain 上的写入可能永远没机会发起 native 调用（= §2C 那个根因）。
  // 自检标记改在 onPromptFinalize 首次执行时打，那里末尾有 await writeChain 兜底。
  return true;
}

exports.registerToolPkg = registerToolPkg;
// 钩子函数必须从本 toolpkg module 导出，否则 registerXxxHook 会拒绝注册
// （报错：registerPromptFinalizeHook function must be exported from a toolpkg module）
exports.onPromptFinalize = onPromptFinalize;
exports.onChatMessage = onChatMessage;
// F15：菜单项处理函数同样从本模块导出（与钩子同一约定，避免宿主按导出表校验时拒绝注册）
exports.onChatMessageMenu = onChatMessageMenu;