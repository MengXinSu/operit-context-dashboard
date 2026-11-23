"use strict";
/**
 * 上下文探针 · Compose DSL 薄壳
 *
 * 验证两件事：
 *   1) WebView 能否在 ToolPkg UI 里正常渲染（loadHtml 内联页面）；
 *   2) 双向桥：
 *      页面→宿主  window.CtxProbe.report() / ping()
 *      宿主→页面  controller.evaluateJavascript() → window.__hostPush()
 *
 * 页面与宿主之间所有日志都追加到 /sdcard/Download/Operit/prompt_viewer/ui_bridge-YYYYMMDD.jsonl（按天分文件）
 */

Object.defineProperty(exports, "__esModule", { value: true });
exports.default = Screen;

// 桥日志按天分文件（ui_bridge-YYYYMMDD.jsonl），避免单文件无限增长
function bridgeLogPath() {
  var d = new Date();
  var mm = ("0" + (d.getMonth() + 1)).slice(-2);
  var dd = ("0" + d.getDate()).slice(-2);
  return "/sdcard/Download/Operit/prompt_viewer/ui_bridge-" + d.getFullYear() + mm + dd + ".jsonl";
}
// 页面地址：模块级常量。禁止放进 Screen 函数体——时间戳每次重组都会变，
// WebView 检测到 url 变化就重载 → 无限重载循环（实测表现为页面持续闪烁）。
//
// v2 改造（2026-10-21 o2.14）：Operit2 的 UI WebView 走宿主内部代理，file:// 会被翻译成
// https://p-<hash>... 虚拟域名；代理拿不到本地文件就返回 ERR_INVALID_RESPONSE（真机实测）。
// 所以不再依赖 file:// 直读物理文件，改用官方 dino_runner 的模式：
//   ① 用 ToolPkg.readResource 把包内资源导出成可读路径（页面文件仍然落盘，便于排查）
//   ② WebView 加载固定虚拟地址 https://ctxdash.local/...
//   ③ onInterceptRequest 拦截这些地址，直接把资源内容塞回 response
var RES_KEY_BOOT = "dashboard_boot";
var RES_KEY_APP = "dashboard_app";
// 资源导出的落盘目录（readResource 的 outputFileName 落在这里；仅用于排查，WebView 不直接读它）
var WEB_DIR = "/sdcard/Download/Operit/context_dashboard";
// WebView 使用的固定虚拟源。不能带时间戳：url 变就重载。
var DASHBOARD_ORIGIN = "https://ctxdash.local";
var DASHBOARD_URL = DASHBOARD_ORIGIN + "/boot.html";
var DASHBOARD_APP = DASHBOARD_ORIGIN + "/index.single.html";
function _readStr(r) {
  if (r === null || r === undefined) return "";
  if (typeof r === "string") return r;
  if (typeof r === "object") {
    if (typeof r.content === "string") return r.content;
    if (typeof r.text === "string") return r.text;
    if (typeof r.data === "string") return r.data;
  }
  return String(r);
}
// （v2：DASHBOARD_URL / DASHBOARD_APP 已在文件头部定义，指向 ctxdash.local 虚拟源。
//  这里曾是 file:// 覆盖——Operit1 老做法，在 Operit2 会触发 ERR_INVALID_RESPONSE，已删。）

function nowIso() {
  return new Date().toISOString();
}

var PROBE_HTML = [
  "<!doctype html>",
  "<html><head><meta charset='utf-8'>",
  "<meta name='viewport' content='width=device-width,initial-scale=1'>",
  "<style>",
  "body{font-family:sans-serif;margin:16px;background:#111;color:#eee}",
  "button{display:block;width:100%;padding:12px;margin:8px 0;font-size:15px;border-radius:8px;border:1px solid #555;background:#222;color:#eee}",
  "#log{white-space:pre-wrap;font-size:12px;background:#000;padding:10px;border-radius:8px;max-height:60vh;overflow:auto}",
  "</style></head><body>",
  "<h3>Context Probe</h3>",
  "<button id='btnHost'>1) 调宿主 report()</button>",
  "<button id='btnVer'>2) 调宿主 ping()</button>",
  "<div id='log'></div>",
  "<script>",
  "var logEl=document.getElementById('log');",
  "function log(s){logEl.textContent+=(s+'\\n');}",
  "function report(name,data){try{var r=window.CtxProbe&&window.CtxProbe.report(JSON.stringify({ev:name,data:data,at:Date.now()}));Promise.resolve(r).then(function(x){log('host ack: '+x);}).catch(function(e){log('host ack err: '+e);});}catch(e){log('bridge err: '+e);}}",
  "log('page loaded, bridge='+(!!window.CtxProbe));",
  "report('page_load',{ua:navigator.userAgent});",
  "document.getElementById('btnHost').onclick=function(){report('btn_host_click',{t:Date.now()});};",
  "document.getElementById('btnVer').onclick=function(){try{var r=window.CtxProbe.ping();Promise.resolve(r).then(function(x){log('ping result: '+x);}).catch(function(e){log('ping err: '+e);});}catch(e){log('ping err: '+e);}};",
  "window.__hostPush=function(msg){log('HOST PUSH: '+msg);report('got_host_push',{msg:msg});};",
  "</script></body></html>"
].join("");

// ===== 数据层：读取 prompt_viewer（summary / timeline / messages） =====
// 逻辑先在 node 原型跑通验证，再移植到这里。
var PV_DIR = "/sdcard/Download/Operit/prompt_viewer";
var rawCache = { key: "", at: 0, data: null };
// P4-1：loadRaw 最近一次失败的原因。no-file = raw 还没有（正常空态）｜parse-error = 读到了但解析失败（真异常）
var rawLastReason = "no-file";
var UI_CTX = null;      // Screen(ctx) 时注入：ctx.callTool 工具通道
var LAST_KEY = "";      // 最近一次解析的会话 key（切会话时清缓存）

function estTok(chars) { return Math.ceil((chars || 0) / 2); }
// ── 图片 token 估算（DeepSeek 官方「图片 Token 计算器」移植）──
var IMG_PATCH = 14, IMG_DOWN = 3, IMG_MAX_TOKENS = 384, IMG_PAD = 4, IMG_MIN_PIXELS = 147456, IMG_MAX_RATIO = 8;
function imgGridTokens(rows, cols) {
  var n = rows * (cols + 1) + 2;
  if (rows % 2 === 1) n += cols + 1;
  n += (Math.ceil(rows / 2) * (cols + 1) % 2) * 2;
  return n;
}
function imgSolveResize(height, width, budget) {
  var ratio = height / width;
  var gridW = Math.sqrt((budget - 2) / ratio + 0.25) - 0.5;
  var gridH = gridW * ratio;
  var unit = IMG_PATCH * IMG_DOWN;
  var bestHeight, bestWidth;
  if (gridW < 1) {
    var rows0 = Math.floor((budget - 2) / 2);
    if (rows0 % 2 === 1) rows0 -= 1;
    bestWidth = unit; bestHeight = rows0 * unit;
  } else if (gridH < 2) {
    var cols0 = Math.floor((budget - 2) / 2) - 1;
    bestHeight = 2 * unit; bestWidth = cols0 * unit;
  } else {
    var cols = Math.trunc(gridW);
    var rows = Math.trunc(gridH);
    if (rows % 2 === 1) rows -= 1;
    var scale = Math.min(cols * unit / width, rows * unit / height);
    bestWidth = Math.trunc(width * scale / IMG_PATCH) * IMG_PATCH;
    bestHeight = Math.trunc(height * scale / IMG_PATCH) * IMG_PATCH;
  }
  var nH = Math.ceil(Math.floor(bestHeight / IMG_PATCH) / IMG_DOWN);
  var nW = Math.ceil(Math.floor(bestWidth / IMG_PATCH) / IMG_DOWN);
  return { nLlmH: nH, nLlmW: nW, bestHeight: bestHeight, bestWidth: bestWidth, numTokens: imgGridTokens(nH, nW) };
}
function imgSafeResize(height, width, paddedHeight, paddedWidth) {
  var nH = Math.ceil(Math.floor(paddedHeight / IMG_PATCH) / IMG_DOWN);
  var nW = Math.ceil(Math.floor(paddedWidth / IMG_PATCH) / IMG_DOWN);
  var pad = IMG_PAD - 1;
  var budget = IMG_MAX_TOKENS - pad;
  var result = { nLlmH: nH, nLlmW: nW, bestHeight: paddedHeight, bestWidth: paddedWidth, numTokens: imgGridTokens(nH, nW) };
  if (result.numTokens > budget) {
    result = imgSolveResize(height, width, budget);
    var nextBudget = budget;
    while (result.numTokens > budget) {
      nextBudget -= 1;
      result = imgSolveResize(height, width, nextBudget);
    }
  }
  result.numTokens += pad;
  return result;
}
function imgCalcResizeInner(width, height) {
  var w = width, h = height;
  if (w > h * IMG_MAX_RATIO) w = h * IMG_MAX_RATIO;
  var pixels = w * h;
  if (pixels < IMG_MIN_PIXELS && pixels > 0) {
    var scale = Math.sqrt(IMG_MIN_PIXELS / pixels);
    w = Math.trunc(w * scale); h = Math.trunc(h * scale);
  }
  var paddedWidth = Math.ceil(w / IMG_PATCH) * IMG_PATCH;
  var paddedHeight = Math.ceil(h / IMG_PATCH) * IMG_PATCH;
  return imgSafeResize(h, w, paddedHeight, paddedWidth);
}
function estimateImageTokens(width, height) {
  if (!isFinite(width) || !isFinite(height) || width <= 0 || height <= 0) return null;
  try {
    var result = imgCalcResizeInner(width, height);
    for (var i = 1; i < 10; i++) {
      var next = imgCalcResizeInner(result.bestWidth, result.bestHeight);
      if (next.nLlmH === result.nLlmH && next.nLlmW === result.nLlmW && next.bestHeight === result.bestHeight && next.bestWidth === result.bestWidth && next.numTokens === result.numTokens) return result.numTokens;
      result = next;
    }
    return null;
  } catch (e0) { return null; }
}
var IMG_B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var IMG_B64_MAP = null;
function imgBase64ToBytes(b64) {
  if (!IMG_B64_MAP) {
    IMG_B64_MAP = {};
    for (var c = 0; c < 64; c++) IMG_B64_MAP[IMG_B64_CHARS.charAt(c)] = c;
  }
  var out = [];
  var buf = 0, bits = 0;
  for (var i = 0; i < b64.length; i++) {
    var ch = b64.charAt(i);
    if (ch === "=") break;
    var v = IMG_B64_MAP[ch];
    if (v === undefined) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xFF); }
  }
  return out;
}
/** 读图片宽高（JPEG SOF / PNG IHDR）；文件不在或解析失败返回 null（含缓存） */
var IMG_SIZE_CACHE = {};
async function imageSizeOf(path) {
  if (IMG_SIZE_CACHE[path] !== undefined) return IMG_SIZE_CACHE[path];
  var result = null;
  try {
    var r = await Tools.Files.readBinary(path);
    var b64 = r && r.contentBase64 ? String(r.contentBase64).slice(0, 200000) : "";
    if (b64) {
      var bytes = imgBase64ToBytes(b64);
      if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
        var wP = ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0;
        var hP = ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0;
        result = { w: wP, h: hP };
      } else {
        var i2 = 2;
        while (i2 + 9 < bytes.length) {
          if (bytes[i2] !== 0xFF) { i2 += 1; continue; }
          var m2 = bytes[i2 + 1];
          if (m2 >= 0xC0 && m2 <= 0xC3) {
            result = { w: (bytes[i2 + 7] << 8) + bytes[i2 + 8], h: (bytes[i2 + 5] << 8) + bytes[i2 + 6] };
            break;
          }
          i2 += 2 + ((bytes[i2 + 2] << 8) + bytes[i2 + 3]);
        }
      }
    }
  } catch (e) { result = null; }
  IMG_SIZE_CACHE[path] = result;
  return result;
}
/**图片路径 → token 估算（含缓存；文件不在或解析失败按 350 估）：供趋势图每轮图片段，与 apiSummary 同口径 */
var IMG_TOKEN_CACHE = {};
function imgTokensOfPath(path) {
  if (IMG_TOKEN_CACHE[path] !== undefined) return IMG_TOKEN_CACHE[path];
  var p = (async function () {
    var tk = 350;
    try {
      var dim = await imageSizeOf(path);
      if (dim) {
        var t = estimateImageTokens(dim.w, dim.h);
        if (t !== null) tk = t;
      }
    } catch (e) { /*读不到按 350 估 */ }
    return tk;
  })();
  IMG_TOKEN_CACHE[path] = p;
  return p;
}

/** 会话的官方 usage 轮次（chatmsg 去重、按时间升序；每轮 inputDelta = 该轮真实输入总量的增量） */
async function usageRounds(key) {
  var msgs = await readJsonl("chatmsg-", 3);
  var arr = [];
  var seen = {};
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    if (!m || !m.done || String(m.session) !== String(key)) continue;
    var sk = String(m.sentAt);
    if (seen[sk]) continue;
    seen[sk] = 1;
    arr.push(m);
  }
  arr.sort(function (a, b) { return (a.sentAt || 0) - (b.sentAt || 0); });
  var out = [];
  var lastIn = 0;
  for (var j = 0; j < arr.length; j++) {
    var inT = arr[j].inputTokens || 0;
    var dIn = inT >= lastIn ? inT - lastIn : inT;
    out.push({ sentAt: arr[j].sentAt || 0, inputDelta: dIn });
    lastIn = inT;
  }
  return out;
}
/** 按比例缩放到 target（锚定：估算只决定切分，总量用官方真值 —— 照上游 anchoredParts 思路） */
function anchorTo(vals, keys, target) {
  var total = 0;
  for (var i = 0; i < keys.length; i++) total += vals[keys[i]] || 0;
  if (!(target > 0) || !(total > 0)) return false;
  var scale = target / total;
  for (var j = 0; j < keys.length; j++) vals[keys[j]] = Math.round((vals[keys[j]] || 0) * scale);
  return true;
}

async function readText(path) {
  try {
    var r = await Tools.Files.read(path);
    if (r === null || r === undefined) return null;
    if (typeof r === "string") return r;
    if (typeof r.content === "string") return r.content;
    if (r.data && typeof r.data.content === "string") return r.data.content;
    return null;
  } catch (e) { return null; }
}

async function listPv() {
  try {
    var r = await Tools.Files.list(PV_DIR);
    return (r && r.entries) ? r.entries : [];
  } catch (e) { return []; }
}

async function readJsonl(prefix, maxFiles) {
  var entries = await listPv();
  var names = [];
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (e && !e.isDirectory && e.name && e.name.indexOf(prefix) === 0 && e.name.slice(-6) === ".jsonl") names.push(e.name);
  }
  names.sort();
  names.reverse();
  if (names.length > (maxFiles || 3)) names = names.slice(0, maxFiles || 3);
  var out = [];
  for (var j = 0; j < names.length; j++) {
    var t = await readText(PV_DIR + "/" + names[j]);
    if (!t) continue;
    var lines = t.split("\n");
    for (var k = 0; k < lines.length; k++) {
      var ln = lines[k];
      if (!ln || !ln.trim()) continue;
      try { out.push(JSON.parse(ln)); } catch (e2) { /* skip bad line */ }
    }
  }
  return out;
}

async function listChatmsgFiles(maxFiles) {
  var entries = await listPv();
  var names = [];
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (e && !e.isDirectory && e.name && e.name.indexOf("chatmsg-") === 0 && e.name.slice(-6) === ".jsonl") names.push(e.name);
  }
  names.sort();
  names.reverse();
  return names.slice(0, maxFiles || 3);
}
/** 读最近 N 个 chatmsg 文件为「行对象数组」（每个文件顺序读一次，不排序、不去重，调用方自行处理）。
 *  时间线时长聚合用；返回顺序 = 文件从新到旧的物理顺序，与时间顺序无关。 */
async function readChatmsgs(maxFiles) {
  var files = await listChatmsgFiles(maxFiles || 3);
  var out = [];
  for (var f = 0; f < files.length; f++) {
    var t = await readText(PV_DIR + "/" + files[f]);
    if (!t) continue;
    var lines = t.split("\n");
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (!ln || !ln.trim()) continue;
      try { out.push(JSON.parse(ln)); } catch (e2) { /* skip bad line */ }
    }
  }
  return out;
}
/** 今日花费数据：最近3个 chatmsg 文件里「今天」的完成态消息，按会话分组；base = 该会话今天之前最后一行的累计值 */
async function apiTodayMessages() {
  try {
    var files = await listChatmsgFiles(99); // base 要尽量早：读全部现存 chatmsg 文件（保留期由日志策略管控），避免「≥3 天未用的会话再启用」时当日首条把历史累计误算进今日
    var all = [];
    for (var f = 0; f < files.length; f++) {
      var t = await readText(PV_DIR + "/" + files[f]);
      if (!t) continue;
      var lines = t.split("\n");
      for (var i = 0; i < lines.length; i++) {
        var ln = lines[i];
        if (!ln || !ln.trim()) continue;
        try {
          var m = JSON.parse(ln);
          if (m && m.done && m.session) all.push(m);
        } catch (e2) { /* skip bad line */ }
      }
    }
    var now = new Date();
    var y = now.getFullYear(), mo = now.getMonth(), day = now.getDate();
    var isToday = function (ms) {
      var d = new Date(ms);
      return d.getFullYear() === y && d.getMonth() === mo && d.getDate() === day;
    };
    var bySess = {};
    for (var j = 0; j < all.length; j++) {
      var sm = String(all[j].session);
      if (!bySess[sm]) bySess[sm] = [];
      bySess[sm].push(all[j]);
    }
    var groups = [];
    var keys = Object.keys(bySess);
    for (var k = 0; k < keys.length; k++) {
      var arr = bySess[keys[k]];
      arr.sort(function (a, b) { return (a.sentAt || 0) - (b.sentAt || 0); });
      var base = { input: 0, output: 0, cached: 0 };
      var items = [];
      var seen = {};
      for (var q = 0; q < arr.length; q++) {
        var row = arr[q];
        if (isToday(row.sentAt)) {
          var sk = String(row.sentAt);
          if (seen[sk]) continue;
          seen[sk] = 1;
          items.push({
            t: row.completedAt || row.atMs || 0,
            sentAt: row.sentAt,
            input: row.inputTokens || 0,
            output: row.outputTokens || 0,
            cached: row.cachedInputTokens || 0,
            waitMs: row.waitMs || 0,
            outMs: row.outMs || 0,
            roleName: row.roleName || "",
            model: row.modelName || ""
          });
        } else {
          base = { input: row.inputTokens || 0, output: row.outputTokens || 0, cached: row.cachedInputTokens || 0 };
        }
      }
      if (items.length > 0) groups.push({ session: keys[k], base: base, items: items });
    }
    return { ok: true, groups: groups };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}
function stripNl(t) { return String(t).replace(/\n/g, ""); }

function extractWorldbook(text) {
  var OPEN = "<worldbook>";
  var CLOSE = "</worldbook>";
  var blocks = [];
  var pos = 0;
  while (true) {
    var a = text.indexOf(OPEN, pos);
    if (a < 0) break;
    var b = text.indexOf(CLOSE, a);
    if (b < 0) { blocks.push(text.slice(a)); break; }
    b += CLOSE.length;
    blocks.push(text.slice(a, b));
    pos = b;
  }
  var chars = 0;
  for (var i = 0; i < blocks.length; i++) chars += blocks[i].length;
  var names = [];
  var parts = text.split('<entry name="');
  for (var j = 1; j < parts.length; j++) {
    var q = parts[j].indexOf('"');
    names.push(q < 0 ? parts[j].slice(0, 40) : parts[j].slice(0, q));
  }
  return { blocks: blocks.length, blockTexts: blocks, chars: chars, entries: names.length, names: names };
}

/** 提取 SYSTEM 里的「包系统 / 技能目录」段：从「包系统」标题行 → 到 <worldbook> / <user_profile> / # 标题之前。
 *  （适配 Operit v1.12.x 的 SYSTEM 结构；结构变化时更新此规则） */
function extractSkillPack(sysText) {
  var lines = String(sysText).split("\n");
  var start = -1;
  var end = lines.length;
  for (var i = 0; i < lines.length; i++) {
    var t = lines[i].trim();
    if (start < 0) {
      if (/^包系统/.test(t)) start = i;
      continue;
    }
    if (t.indexOf("<worldbook>") === 0 || t.indexOf("<user_profile") === 0 || /^#/.test(t)) { end = i; break; }
  }
  if (start < 0) return { chars: 0, text: "", found: false };
  var seg = lines.slice(start, end).join("\n");
  return { chars: seg.length, text: seg, found: true };
}

/** 提取 SYSTEM 里的用户资料段（用户资料注入）。
 *  两种形态都要认（o2.4，2026-10-21）：
 *    ① Operit1：<user_profile> ... </user_profile>
 *    ② Operit2：`USER.md:` 前缀 + markdown（实测长这样）
 *         USER.md:
 *         # About me
 *         ## Basic information
 *         - name: 梦新
 *         ...
 *       结束于下一个一级标题、下一个 `XXX.md:` 前缀，或文本末尾。
 */
function extractUserProfile(sysText) {
  var text = String(sysText);

  // ① 优先认 XML 标签（Operit1 形态，向后兼容）
  var open = text.indexOf("<user_profile");
  if (open >= 0) {
    var close = text.indexOf("</user_profile>", open);
    var seg1 = close < 0 ? text.slice(open) : text.slice(open, close + "</user_profile>".length);
    return { chars: seg1.length, text: seg1, found: true, form: "xml" };
  }

  // ② Operit2 形态：`USER.md:` 前缀
  var lines = text.split("\n");
  var start = -1;
  for (var i = 0; i < lines.length; i++) {
    if (/^\s*USER\.md:\s*$/.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return { chars: 0, text: "", found: false, form: "none" };

  var end = lines.length;
  for (var j = start + 1; j < lines.length; j++) {
    var t = lines[j];
    // 遇到别的 .md 前缀（如 SYSTEM.md: / MEMORY.md:）就停
    if (/^\s*[A-Za-z0-9_\-]+\.md:\s*$/.test(t)) { end = j; break; }
    // 遇到一级标题以外的新段落标题也停（避免吞掉后面的系统内容）
    // 这里保守：只在遇到「已知的系统段标题」时停
    if (/^#\s+(工具|技能|包系统|记忆|工程纪律)\b/.test(t)) { end = j; break; }
  }
  var seg = lines.slice(start, end).join("\n");
  return { chars: seg.length, text: seg, found: true, form: "usermd" };
}

/** 当前所在会话 key（前 8 位）：① getChatId() 直取；② list_chats 的 is_current（兼容解析照抄 prompt_viewer v1） */
function currentSessionKey() {
  try {
    if (typeof getChatId === "function") {
      var g = String(getChatId() || "");
      if (g) return g.slice(0, 8);
    }
  } catch (e) { /* ignore */ }
  return "";
}

async function currentSessionKeyAsync() {
  var direct = currentSessionKey();
  if (direct) return direct;
  try {
    if (!UI_CTX) return "";
    var r = await UI_CTX.callTool("list_chats", {});
    var o = r;
    if (typeof r === "string") { try { o = JSON.parse(r); } catch (e1) { o = null; } }
    var d = (o && o.data) ? o.data : o;
    var arr = d && (d.chats || d.items || d.list || d);
    if (arr && !Array.isArray(arr) && typeof arr === "object") {
      try { arr = Object.values(arr); } catch (e2) { arr = null; }
    }
    if (Array.isArray(arr)) {
      for (var i = 0; i < arr.length; i++) {
        var c = arr[i];
        if (c && (c.is_current === true || c.current === true || c.isCurrent === true)) {
          var id = c.id || c.chat_id || c.chatId || c.uuid;
          if (id) return String(id).slice(0, 8);
        }
      }
    }
  } catch (e3) { /* fallback to latest */ }
  return "";
}

async function latestKey() {
  var cur = await currentSessionKeyAsync();
  if (cur) return cur;
  var t = await readText(PV_DIR + "/index.json");
  if (!t) return null;
  try {
    var arr = JSON.parse(stripNl(t));
    if (arr && arr.length && arr[0].key) return arr[0].key;
  } catch (e) { /* ignore */ }
  return null;
}

/** P4-1：loadRaw 失败时统一带错误码——no-raw = 当前会话还没有记录（正常空态）；parse-error = raw 存在但解析失败（真异常）。 */
function rawFail(key) {
  if (rawLastReason === "parse-error") {
    return { ok: false, code: "parse-error", error: "raw 解析失败: " + key };
  }
  return { ok: false, code: "no-raw", error: "当前会话还没有上下文记录" };
}

async function loadRaw(key) {
  if (rawCache.key === key && rawCache.data && (Date.now() - rawCache.at) < 60000) {
    rawLastReason = "";
    return rawCache.data;
  }
  // 防「读到半写文件」：raw 每轮被钩子覆盖写，读取可能撞上半写状态 → 解析失败时等待重试
  rawLastReason = "no-file";
  for (var attempt = 0; attempt < 3; attempt++) {
    var t = await readText(PV_DIR + "/raw_" + key + ".json");
    if (t) {
      // 读到了内容 → 之后即使三次解析都失败，也是「文件存在但内容坏了」，不再是空态
      rawLastReason = "parse-error";
      try {
        var parsed = JSON.parse(stripNl(t));
        rawCache = { key: key, at: Date.now(), data: parsed };
        rawLastReason = "";
        return parsed;
      } catch (e) { /* 半写状态，重试 */ }
    }
    await new Promise(function (r) { setTimeout(r, 250); });
  }
  return null;
}

async function apiSummary(keyIn) {
  var key = keyIn || await latestKey();
  if (!key) return { ok: false, code: "no-raw", error: "当前会话还没有上下文记录" };
  var payload = await loadRaw(key);
  if (!payload) return rawFail(key);
  var hist = Array.isArray(payload.preparedHistory) ? payload.preparedHistory : [];
  var charsByKind = {};
  var counts = {};
  var systemText = "";
  var totalChars = 0;
  for (var i = 0; i < hist.length; i++) {
    var t = hist[i] || {};
    var k = String(t.kind || "OTHER").toUpperCase();
    var c = String(t.content || "").length;
    charsByKind[k] = (charsByKind[k] || 0) + c;
    counts[k] = (counts[k] || 0) + 1;
    if (k === "SYSTEM" && !systemText) systemText = String(t.content || "");
    totalChars += c;
  }
  var toolsChars = 0;
  try { toolsChars = JSON.stringify(payload.availableTools || []).length; } catch (e0) {}
  var wb = extractWorldbook(systemText);
  var sk = extractSkillPack(systemText);
  var up = extractUserProfile(systemText);
  var systemRest = (charsByKind.SYSTEM || 0) - wb.chars - sk.chars - up.chars;
  var cardName = "";
  try { var md = payload.metadata || {}; if (md.activePrompt && md.activePrompt.name) cardName = String(md.activePrompt.name); } catch (eM) {}
  // 图片附件：扫消息里的 image 附件标签，按官方公式估算 token（读不到尺寸按典型截图 350 估）
  var imgCount = 0, imgTokens = 0;
  try {
    var attRe = /<attachment[^>]*type="image[^>]*>/g;
    var idRe = /id="([^"]+)"/;
    for (var hi = 0; hi < hist.length; hi++) {
      var hContent = String((hist[hi] || {}).content || "");
      if (hContent.indexOf("<attachment") < 0) continue;
      var attMatches = hContent.match(attRe);
      if (!attMatches) continue;
      for (var mi = 0; mi < attMatches.length; mi++) {
        imgCount++;
        var idm = idRe.exec(attMatches[mi]);
        var dim = idm ? await imageSizeOf(idm[1]) : null;
        if (dim) {
          var tk = estimateImageTokens(dim.w, dim.h);
          imgTokens += tk !== null ? tk : 350;
        } else {
          imgTokens += 350;
        }
      }
    }
  } catch (eI) { /* 图片统计失败不影响主流程 */ }
  var current = {
    system: estTok(systemRest),
    tools: estTok(toolsChars),
    user: estTok(charsByKind.USER),
    inject: estTok(wb.chars),
    skill: estTok(sk.chars),
    profile: estTok(up.chars),
    summary: estTok(charsByKind.SUMMARY),
    assistant: estTok(charsByKind.ASSISTANT),
    tool: estTok((charsByKind.TOOL_CALL || 0) + (charsByKind.TOOL_RESULT || 0))
  };
  if (imgTokens > 0) current.img = imgTokens;
  current.total = current.system + current.tools + current.user + current.inject + current.skill + current.profile + current.summary + current.assistant + current.tool + (current.img || 0);
  // 上限保护：估算总量超过 96 万（1M 安全线）时按比例压缩
  try {
    if (current.total > 960000) {
      anchorTo(current, ["system", "tools", "user", "inject", "skill", "profile", "summary", "assistant", "tool", "img"], 960000);
      current.total = current.system + current.tools + current.user + current.inject + current.skill + current.profile + current.summary + current.assistant + current.tool;
    }
  } catch (eA) { /* 忽略 */ }
  return {
    ok: true,
    session: key,
    cardName: cardName,
    current: current,
    counts: counts,
    toolsCount: (payload.availableTools || []).length,
    worldbook: wb,
    imgAttachments: { count: imgCount, tokens: imgTokens },
    historyCount: hist.length,
    totalChars: totalChars + toolsChars
  };
}

// ==== P4_2C BEGIN（2026-11-23；纯函数段：node 自检脚本按标记提取，勿在段内用宿主 API）====
// ① 时间线时长（F10 配套）：chatmsg 每条完成消息带 waitMs/outMs（采集层 main.js onChatMessage），
//    按「请求快照时刻」切片把消息归到 timeline 的每条 request 上，同一请求多条消息求和。
//    实测（2026-11-23 prompt_viewer 真样本，<key-A> / <key-B> 共 4 个可配对点）：
//    快照 atMs 恒比对应消息 sentAt 晚 218~322ms（钩子晚于消息对象创建），故 GUARD 取 3s 吸收钟差，
//    又远小于请求间隔（最短实测 29s），不会把消息错配到下一条请求。
// ② 事件推导（F18 配套）：从快照序列推 prune / inject；skill / agent 映射采集层 events_ 投影。
//    所有判定只用数据里已有的字段，缺字段一律跳过（宁可 0 条，绝不编事件）。
var TL_GUARD_MS = 3000;
var EV3_TOK_DIV = 2;
/** 字符 → token 估算（与 apiSummary 的 estTok 同口径；段内自持，供自检脚本独立复跑） */
function ev3Tok(chars) { return Math.ceil(Math.abs(+chars || 0) / EV3_TOK_DIV); }

/** chatmsg 行 → 时长行 [{t, w, o}]（按 t 升序，只取本会话）
 *  时间锚：sentAt>0 用 sentAt（=该次请求发出时刻）；缺失退 completedAt（回答完成时刻），再退 atMs（落盘时刻）。
 *  去重：同一条消息可能被钩子重放，按 sentAt|completedAt|contentLen 判同一行，只留一条。
 *  已知限制：采集层只对完成态助手消息写 chatmsg（main.js onChatMessage），工具往返的中间请求没有行
 *  → 这些 request 时长保持 0；只有 sentAt 缺失的行才可能因期间又发新请求而晚归一条（实测这类行 wait/out 也是 0）。 */
function tlRowsOf(msgs, key) {
  var list = Array.isArray(msgs) ? msgs : [];
  var rows = [], seen = {};
  for (var i = 0; i < list.length; i++) {
    var m = list[i];
    if (!m) continue;
    if (key && String(m.session) !== String(key)) continue;
    var sent = +m.sentAt || 0, comp = +m.completedAt || 0, at = +m.atMs || 0;
    var t = sent > 0 ? sent : (comp > 0 ? comp : at);
    if (!(t > 0)) continue;
    var dk = String(sent) + "|" + String(comp) + "|" + String(m.contentLen || 0);
    if (seen[dk]) continue;
    seen[dk] = 1;
    rows.push({ t: t, w: Math.max(0, +m.waitMs || 0), o: Math.max(0, +m.outMs || 0) });
  }
  rows.sort(function (a, b) { return a.t - b.t; });
  return rows;
}

/** 把时长行单遍归位到 timeline 每条 request（items 按 t 升序、rows 按 t 升序）：
 *  每条消息归「t <= 消息锚点 + GUARD 的最后一条请求」= 按请求时刻切片，落在两请求之间的消息归前一请求；
 *  同一请求的多条消息 waitMs/outMs 累加；锚点早于首条请求（旧快照已被滚动清理）→ 跳过，不给假值。
 *  返回归位条数（自检用）；items 上的 waitMs/outMs/msgCount 由调用方先初始化为 0。 */
function tlApplyDurations(items, rows) {
  var list = Array.isArray(items) ? items : [];
  var rs = Array.isArray(rows) ? rows : [];
  var i = -1, matched = 0;
  for (var r = 0; r < rs.length; r++) {
    var row = rs[r] || {};
    var t = +row.t || 0;
    while (i + 1 < list.length && (+((list[i + 1] || {}).t) || 0) <= t + TL_GUARD_MS) i++;
    if (i < 0) continue;
    var rec = list[i];
    rec.waitMs = (+rec.waitMs || 0) + (+row.w || 0);
    rec.outMs = (+rec.outMs || 0) + (+row.o || 0);
    rec.msgCount = (+rec.msgCount || 0) + 1;
    matched++;
  }
  return matched;
}

/** 快照序列（apiEvents 里已按时间升序、10s 内合并过的 merged）→ prune / inject 事件。
 *  prune 触发（对齐上游 compaction/prune 的「工具输出被清/剪」语义）：
 *    - 相邻两快照 historyChars 下降：saved/c0 ≥ 5% 且 saved ≥ 1000 字符（挡掉消息进出造成的小抖动）
 *    - 且 historyCount 未腰斩（h1 < h0/2 归 compaction，由 apiEvents 既有规则记，这里不重复记）
 *    - toolChars = TOOL_CALL+TOOL_RESULT 段减少量（有 charsByKind 才算，算不出留 0）
 *  inject 触发（上游 inject = 注入段变化）：
 *    - 相邻两快照都带 sys{wb,sk,up}（旧版快照无 sys → 跳过，不猜）
 *    - 任一段字符数有变化即记一条（name=段名，与上下文浏览器分类同名；deltaChars 带符号）
 *  时间：取「变化后那条快照」的捕获时刻，与 compaction 同口径（数据里没有逐事件时间戳）。 */
function ev3SegEvents(merged) {
  var list = Array.isArray(merged) ? merged : [];
  var out = [];
  var SEG_NAME = { wb: "世界书", sk: "技能注入", up: "用户资料" };
  for (var k = 1; k < list.length; k++) {
    var p0 = list[k - 1] || {}, p1 = list[k] || {};
    var c0 = +p0.historyChars || 0, c1 = +p1.historyChars || 0;
    var h0 = +p0.historyCount || 0, h1 = +p1.historyCount || 0;
    var saved = c0 - c1;
    if (saved > 0 && c0 > 0 && saved >= 1000 && saved / c0 >= 0.05 && !(h1 > 0 && h1 < h0 / 2)) {
      var cb0 = p0.charsByKind || {}, cb1 = p1.charsByKind || {};
      var tk0 = (+cb0.TOOL_CALL || 0) + (+cb0.TOOL_RESULT || 0);
      var tk1 = (+cb1.TOOL_CALL || 0) + (+cb1.TOOL_RESULT || 0);
      out.push({
        kind: "prune", at: String(p1.at || ""), atMs: +p1.atMs || 0,
        count: Math.max(0, h0 - h1), from: h0, to: h1,
        savedChars: saved, tokens: ev3Tok(saved), toolChars: Math.max(0, tk0 - tk1)
      });
    }
    var s0 = p0.sys, s1 = p1.sys;
    if (!s0 || !s1) continue;
    var segs = ["wb", "sk", "up"];
    for (var si = 0; si < segs.length; si++) {
      var g = segs[si];
      var a = +s0[g] || 0, b = +s1[g] || 0, d = b - a;
      if (!d) continue;
      out.push({
        kind: "inject", at: String(p1.at || ""), atMs: +p1.atMs || 0,
        name: SEG_NAME[g], tokens: ev3Tok(d), deltaChars: d, count: 1,
        detail: (d > 0 ? "+" : "-") + Math.abs(d) + " 字符"
      });
    }
  }
  return out;
}

/** 采集层 events_<key>.json → 事件卡 skill / agent 条目（只映射这两种；todo/goal/ask/team 归里程碑带 apiMilestones）。
 *  为什么复用采集层而不在桥层扫 raw：skill/agent 要「工具名 + 参数结构」双证据（main.js EVENTS_V1 的
 *  evAgentEvent/evSkillEvent），桥层重复实现等于维护两份口径；events_ 是采集层每轮装配重算的事件投影，
 *  已带 seq/turn/step。已知限制：该投影与 raw 同窗口，历史被压缩/剪枝后这类事件同样会消失（与 warn 不同，
 *  warn 另有 warnings-*.jsonl 增量留档）；要做到跨压缩持久，采集层得加同样的增量留档，属后续采集层任务。
 *  events 文件缺失（旧采集版本）→ 返回空，不猜。 */
function ev3SkillAgentOf(evData) {
  var out = [];
  if (!evData || typeof evData !== "object") return out;
  var list = Array.isArray(evData.events) ? evData.events : [];
  var upd = String(evData.updatedAt || "");
  var updMs = +evData.updatedAtMs || 0;
  for (var i = 0; i < list.length; i++) {
    var e = list[i] || {};
    var k = String(e.kind || "");
    if (k !== "skill" && k !== "agent") continue;
    var tm = +e.time || 0;
    out.push({
      kind: k, at: String(e.at || upd), atMs: tm > 0 ? tm : updMs,
      seq: +e.seq || 0, turn: +e.turn || 0, step: +e.step || 0,
      name: String(e.name || ""), detail: String(e.detail || ""),
      count: +e.count || 1
    });
  }
  return out;
}
// ==== P4_2C END ====

async function apiTimeline(keyIn) {
  var key = keyIn || await latestKey();
  var snaps = await readJsonl("snapshots-", 3);
  var filtered = [];
  for (var i = 0; i < snaps.length; i++) {
    if (!key || snaps[i].session === key) filtered.push(snaps[i]);
  }
  filtered.sort(function (a, b) { return (a.atMs || 0) - (b.atMs || 0); });
  var merged = [];
  for (var j = 0; j < filtered.length; j++) {
    var s = filtered[j];
    var last = merged.length ? merged[merged.length - 1] : null;
    if (last && Math.abs((s.atMs || 0) - last.atMs) < 10000) merged[merged.length - 1] = s;
    else merged.push(s);
  }
  // 段落拆分补全（世界书/技能/资料）：新快照自带 sys 字段；旧快照按「全会话 SYSTEM 恒定 + 与当前 raw 同长」用 raw 回填
  var liveSeg = null;
  if (merged.length > 0) {
    var firstSys = (merged[0].charsByKind || {}).SYSTEM || 0;
    var constSys = firstSys > 0;
    for (var ci = 1; ci < merged.length; ci++) {
      if (((merged[ci].charsByKind || {}).SYSTEM || 0) !== firstSys) { constSys = false; break; }
    }
    if (constSys) {
      try {
        var lr = await loadRaw(key);
        var lh = lr && Array.isArray(lr.preparedHistory) ? lr.preparedHistory : [];
        var lsys = "";
        for (var li = 0; li < lh.length; li++) {
          if (String(lh[li].kind || "").toUpperCase() === "SYSTEM") { lsys = String(lh[li].content || ""); break; }
        }
        if (lsys && Math.abs(lsys.length - firstSys) <= 200) {
          var lw = extractWorldbook(lsys), lsk = extractSkillPack(lsys), lu = extractUserProfile(lsys);
          liveSeg = { wb: lw.chars, sk: lsk.chars, up: lu.chars };
        }
      } catch (eL) { /* 回填失败保持 0，不影响主流程 */ }
    }
  }
  var out = [];
  //轮号跨压缩续编（2026-09-15）：countByKind.USER 是「当前留存窗口」内的用户消息数，
  //压缩后窗口重排、该计数骤降（实测 …16→2），直接当轮号会让趋势图回跳/分段。
  //改为增量映射：压缩骤降视为新一轮只 +1；同值视为同轮不同步骤。
  //晚 20:20 修订：增长一律只 +1——系统警告类「虚拟轮」不写快照，按差值累加会跳格；
  //吞掉的个数记入 skip，前端在该柱标红（表示此处截断/警告）。
  var turnCounter = 0;
  var curStep = 0;
  var lastUserCount = -1;
  var skipN = 0;
  for (var k = 0; k < merged.length; k++) {
    var r = merged[k];
    var cb = r.charsByKind || {};
    var uc = (r.countByKind && r.countByKind.USER) || 0;
    skipN = 0;
    if (lastUserCount < 0) { turnCounter = uc > 0 ? uc : 1; curStep = 1; }
    else if (uc > lastUserCount) { skipN = uc - lastUserCount - 1; if (skipN < 0) skipN = 0; turnCounter += 1; curStep = 1; }
    else if (uc < lastUserCount) { if (uc > 0) turnCounter += 1; curStep = 1; }
    else { curStep++; }
    if (uc > 0) lastUserCount = uc;
    var seg = r.sys || liveSeg || null;
    var wb0 = seg ? (seg.wb || 0) : 0;
    var sk0 = seg ? (seg.sk || 0) : 0;
    var up0 = seg ? (seg.up || 0) : 0;
    //图片附件段（2026-09-15）：快照行 imgPaths → 逐路径估算（含缓存）；旧快照无此字段（= 0）
    var imgTok0 = 0;
    if (Array.isArray(r.imgPaths) && r.imgPaths.length > 0) {
      for (var ip2 = 0; ip2 < r.imgPaths.length; ip2++) {
        imgTok0 += await imgTokensOfPath(r.imgPaths[ip2]);
      }
    }
    var imgCount0 = Array.isArray(r.imgPaths) ? r.imgPaths.length : 0;
    var rec = {
      seq: k + 1,
      turn: turnCounter,
      step: curStep,
      t: r.atMs,
      stage: r.stage, skip: skipN,
      system: estTok(Math.max(0, (cb.SYSTEM || 0) - wb0 - sk0 - up0)),
      tools: estTok(r.toolsChars),
      user: estTok(cb.USER),
      inject: estTok(wb0),
      skill: estTok(sk0),
      summary: estTok(cb.SUMMARY),
      assistant: estTok(cb.ASSISTANT),
      tool: estTok((cb.TOOL_CALL || 0) + (cb.TOOL_RESULT || 0)),
      historyCount: r.historyCount || 0,
      historyChars: r.historyChars || 0,
      img: imgTok0,
      imgCount: imgCount0,
      msgCount: 0,
      waitMs: 0,
      outMs: 0
    };
    rec.total = rec.system + rec.tools + rec.user + rec.inject + rec.skill + rec.summary + rec.assistant + rec.tool + (rec.img || 0);
    // 上限保护：单轮估算超过 96 万时按比例压缩
    if (rec.total > 960000) {
      anchorTo(rec, ["system", "tools", "user", "inject", "skill", "summary", "assistant", "tool", "img"], 960000);
      rec.total = rec.system + rec.tools + rec.user + rec.inject + rec.skill + rec.summary + rec.assistant + rec.tool + (rec.img || 0);
    }
    out.push(rec);
  }
  // P4-2C 时长字段（F10 配套）：读最近 3 个 chatmsg 文件一次，单遍把完成消息的 waitMs/outMs 归到对应 request；
  // 归位口径见 P4_2C 纯函数段 tlRowsOf / tlApplyDurations（匹配不上保持 0，前端曲线按缺数据断点处理）。
  // key 缺失时时间线本身是「全会话混排」的退化态，时长不参与，避免跨会话错配。
  try {
    if (key) tlApplyDurations(out, tlRowsOf(await readChatmsgs(3), key));
  } catch (eD) { /* chatmsg 缺失/损坏不影响时间线主流程 */ }
  // W8 跳过明细：留档警告（含已压缩历史）附挂到「捕获它的快照行」（±10s 最近邻；捕获时刻=该次装配）
  try {
    var wrAll = await readJsonl("warnings-", 3);
    var wl = [];
    for (var wA = 0; wA < wrAll.length; wA++) {
      var wR = wrAll[wA] || {};
      if (key && wR.session !== key) continue;
      var wAt = +wR.atMs || 0;
      if (wAt) wl.push({ wtype: String(wR.type || "other"), text: String(wR.text || ""), at: String(wR.at || ""), atMs: wAt, idx: +wR.idx || 0 });
    }
    for (var wB = 0; wB < wl.length; wB++) {
      var best = -1, bestD = 1e18;
      for (var wC = 0; wC < out.length; wC++) {
        var dD = Math.abs((out[wC].t || 0) - wl[wB].atMs);
        if (dD < bestD) { bestD = dD; best = wC; }
      }
      if (best >= 0 && bestD < 10000) {
        if (!out[best].skipWarns) out[best].skipWarns = [];
        out[best].skipWarns.push(wl[wB]);
      }
    }
  } catch (eW4) { /* 留档缺失不致命 */ }
  return { ok: true, items: out };
}

/** 步骤重建（2026-09-15）：从最新 raw 的 preparedHistory 事后切分每一步（请求）的上下文量。
 *  数据基础：工具往返不触发钩子，但每次工具调用/结果都会沉淀进下一轮历史；消息序列是线性的，
 *  按顺序切分即可：每轮 USER 起 = step1；一段连续 TOOL_RESULT 结束 = 下一请求点（step++）。
 *  轮号对齐：raw 最后的 USER = 最后一轮（快照续编 turn T，若本轮 send 快照未写则 +deltaU）；
 *  时间：无逐步时间戳，按轮映射快照 atMs（本轮用 raw 捕获时间兜底）。零新增写盘。
 */
async function apiSteps(keyIn) {
  var key = keyIn || await latestKey();
  if (!key) return { ok: false, error: "no key" };
  var payload = await loadRaw(key);
  if (!payload) return rawFail(key);
  var hist = Array.isArray(payload.preparedHistory) ? payload.preparedHistory : [];
  var kindOf = function (m) { return String((m && (m.kind || m.role)) || "").toUpperCase(); };
  // 工具定义体量 + SYSTEM 三段拆分（每步恒定）
  var toolsChars = 0;
  try { toolsChars = JSON.stringify(payload.availableTools || []).length; } catch (e0) {}
  var wbChars = 0, skChars = 0, upChars = 0;
  for (var si = 0; si < hist.length; si++) {
    if (kindOf(hist[si]) === "SYSTEM") {
      var st = String(hist[si].content || "");
      try {
        wbChars = extractWorldbook(st).chars; skChars = extractSkillPack(st).chars; upChars = extractUserProfile(st).chars;
      } catch (eS) { wbChars = 0; skChars = 0; upChars = 0; }
      break;
    }
  }
  // 轮号对齐：U = raw 内 USER 数；快照末轮 T 与窗口内 USER 数 ucLast → deltaU 预期 0/1
  var U = 0;
  for (var ui = 0; ui < hist.length; ui++) { if (kindOf(hist[ui]) === "USER") U++; }
  var T = U, ucLast = -1, deltaU = 0, snapTimes = [];
  try {
    var tl = await apiTimeline(key);
    if (tl && tl.ok && tl.items && tl.items.length) T = tl.items[tl.items.length - 1].turn || U;
  } catch (eT) { /* 退化：T 以 U 起编 */ }
  try {
    var snaps = await readJsonl("snapshots-", 3);
    var filtered = [];
    for (var ii = 0; ii < snaps.length; ii++) { if (snaps[ii] && snaps[ii].session === key) filtered.push(snaps[ii]); }
    filtered.sort(function (a, b) { return (a.atMs || 0) - (b.atMs || 0); });
    var merged = [];
    for (var jj = 0; jj < filtered.length; jj++) {
      var s0 = filtered[jj];
      var last0 = merged.length ? merged[merged.length - 1] : null;
      if (last0 && Math.abs((s0.atMs || 0) - last0.atMs) < 10000) merged[merged.length - 1] = s0;
      else merged.push(s0);
    }
    for (var mk = 0; mk < merged.length; mk++) { snapTimes.push(merged[mk].atMs || 0); }
    if (merged.length) {
      var mu = merged[merged.length - 1];
      ucLast = (mu.countByKind && mu.countByKind.USER) || 0;
      deltaU = U - ucLast;
      if (deltaU < 0 || deltaU > 3) deltaU = 0; // 异常差退化为按 U 起编
    }
  } catch (eSn) { /* 无快照：全部用兜底时间 */ }
  var fallbackAt = 0;
  try { fallbackAt = payload.capturedAtMs || Date.now(); } catch (eF) { fallbackAt = Date.now(); }
  // 主扫描：前缀累计 + 请求点打点
  var acc = { SYSTEM: 0, USER: 0, ASSISTANT: 0, TOOL_CALL: 0, TOOL_RESULT: 0, SUMMARY: 0 };
  var accMsgs = 0, accChars = 0, userSeen = 0, seq = 0, curTurn = 0, curStep = 0, curAt = fallbackAt;
  var out = [];
  var pushPoint = function () {
    seq += 1;
    var rec = {
      seq: seq, turn: curTurn, step: curStep, t: curAt,
      system: estTok(Math.max(0, acc.SYSTEM - wbChars - skChars - upChars)),
      tools: estTok(toolsChars),
      user: estTok(acc.USER),
      inject: estTok(wbChars),
      skill: estTok(skChars),
      summary: estTok(acc.SUMMARY),
      assistant: estTok(acc.ASSISTANT),
      tool: estTok(acc.TOOL_CALL + acc.TOOL_RESULT),
      historyCount: accMsgs,
      historyChars: accChars
    };
    rec.total = rec.system + rec.tools + rec.user + rec.inject + rec.skill + rec.summary + rec.assistant + rec.tool;
    if (rec.total > 960000) {
      anchorTo(rec, ["system", "tools", "user", "inject", "skill", "summary", "assistant", "tool"], 960000);
      rec.total = rec.system + rec.tools + rec.user + rec.inject + rec.skill + rec.summary + rec.assistant + rec.tool;
    }
    out.push(rec);
  };
  for (var x = 0; x < hist.length; x++) {
    var it = hist[x] || {};
    var k = kindOf(it);
    var len = String(it.content || "").length;
    acc[k] = (acc[k] || 0) + len;
    accMsgs += 1; accChars += len;
    if (k === "USER") {
      userSeen += 1;
      var idxFromEnd = U - userSeen; // 0 = 最后一个 USER
      curTurn = T + deltaU - idxFromEnd;
      if (curTurn < 1) curTurn = 1;
      curStep = 1;
      var snapIdx = snapTimes.length - 1 - (idxFromEnd - deltaU);
      curAt = (snapIdx >= 0 && snapIdx < snapTimes.length) ? snapTimes[snapIdx] : fallbackAt;
      pushPoint();
    } else if (k === "TOOL_RESULT") {
      var nxt = hist[x + 1];
      if (kindOf(nxt) !== "TOOL_RESULT") { curStep += 1; pushPoint(); }
    }
  }
  // 保险：截断超长（保留最近 1500 步）
  if (out.length > 1500) out = out.slice(out.length - 1500);
  // W9①：步 brief 按需化——steps 只挂锚点 pIdx（毫秒级）；三行由 apiStepBrief 单步现算。
  // 口径不变：pIdxs 尾部对齐 out；逐项一致性与旧全量 w7BriefOf 对拍（tools/w9_brief_one_check.cjs）。
  try {
    var pIdxs = w7PointIdxs(hist);
    if (pIdxs.length > out.length) pIdxs = pIdxs.slice(pIdxs.length - out.length);
    for (var bi = 0; bi < out.length && bi < pIdxs.length; bi++) out[bi].pIdx = pIdxs[bi];
  } catch (eW) { /* 锚点失败：详情卡无三行（降级） */ }
  return { ok: true, items: out };
}

/** W9①：单步 brief —— 点某一步时现算那一条（毫秒级；大会话打开秒回）。
 * key=会话；pIdx=apiSteps 回传的请求点下标。口径与旧全量版逐项一致。 */
async function apiStepBrief(keyIn, pIdxIn) {
  var key = keyIn || await latestKey();
  if (!key) return { ok: false, error: "no key" };
  var pIdx = Number(pIdxIn);
  if (!isFinite(pIdx) || pIdx < 0 || Math.floor(pIdx) !== pIdx) return { ok: false, error: "bad pIdx" };
  var payload = await loadRaw(key);
  if (!payload) return rawFail(key);
  var hist = Array.isArray(payload.preparedHistory) ? payload.preparedHistory : [];
  var pIdxs = w7PointIdxs(hist);
  var s = -1;
  for (var i = 0; i < pIdxs.length; i++) { if (pIdxs[i] === pIdx) { s = i; break; } }
  if (s < 0) return { ok: false, error: "step not found" };
  var b = w7BriefOne(hist, pIdxs, s);
  if (!b) return { ok: false, error: "step not found" };
  return { ok: true, key: key, brief: b };
}

// ==== W8_WARN_UI BEGIN（2026-09-17；纯函数段：node 自检脚本按标记提取，勿在段内用宿主 API）====
// 报错门类 · 警告扫描（与 main.js W8_WARN 段同口径；两侧一致性由离线对拍脚本校验）
// 警告形态（Operit2 口径，2026-10-08 源码钉死 + 6 份 raw 离线对拍）：
//   A 内嵌型：ASSISTANT 内容里追加 <status type="warning">警告：…</status>（紧跟 </think>）
//   B 独立型：作为独立条目入历史，content 以该标签开头
//   注入点 EnhancedAIService.rs:2382（纯思考警告）；trunc 类警告在 main 分支无注入点，
//   工具截断实际形态是后缀「\n[工具结果过长，已截断]」（ConversationMarkupManager.rs:5）。
// 判定四条件（缺一即拒，防误报）：完整标签对 + 正文以「警告：」开头 + 紧跟 </think> 或位于 content 开头 + 不限 kind。
// 旧口径（kind=USER 且 content 以标签开头）在 Operit2 恒 0 命中，已废。
function w8WarnTypeOfUi(text) {
  var s = String(text);
  if (s.indexOf("检测到工具调用输出被截断") >= 0) return "trunc";
  if (s.indexOf("工具结果过长，已截断") >= 0) return "trunc";
  if (s.indexOf("请输出正文内容") >= 0) return "empty";
  return "other";
}
/** 从一段 content 里取真警告正文（返回 [{text, index}]）；引用型/无闭标签的代码片段一律拒 */
function w8WarnPairsOfUi(ct) {
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
/** 扫一段历史，返回可见警告 [{idx, type, text}]（与 main.js w8ScanWarns 同口径） */
function w8ScanWarnsUi(hist) {
  var out = [];
  try {
    for (var i = 0; i < hist.length; i++) {
      var x = hist[i] || {};
      var ct = String(x.content === null || x.content === undefined ? "" : x.content);
      if (ct.indexOf("type=\"warning\"") < 0) continue;
      var ps = w8WarnPairsOfUi(ct);
      for (var j = 0; j < ps.length; j++) {
        out.push({ idx: i, type: w8WarnTypeOfUi(ps[j].text), text: ps[j].text });
      }
    }
  } catch (e) { /* 静默：不影响主流程 */ }
  return out;
}
// ==== W8_WARN_UI END ====
/** 上下文事件：从快照推压缩、从消息事件推模型切换（零新增写入） */
async function apiEvents(keyIn) {
  var key = keyIn || await latestKey();
  if (!key) return { ok: false, error: "no key" };
  var out = [];
  // 1) 压缩事件：快照 historyCount 骤降
  var snaps = await readJsonl("snapshots-", 3);
  var filtered = [];
  for (var i = 0; i < snaps.length; i++) { if (snaps[i].session === key) filtered.push(snaps[i]); }
  filtered.sort(function (a, b) { return (a.atMs || 0) - (b.atMs || 0); });
  var merged = [];
  for (var j = 0; j < filtered.length; j++) {
    var s = filtered[j];
    var last = merged.length ? merged[merged.length - 1] : null;
    if (last && Math.abs((s.atMs || 0) - last.atMs) < 10000) merged[merged.length - 1] = s;
    else merged.push(s);
  }
  for (var k = 1; k < merged.length; k++) {
    var p0 = merged[k - 1], p1 = merged[k];
    var h0 = p0.historyCount || 0, h1 = p1.historyCount || 0;
    if (h0 > 0 && h1 > 0 && h1 < h0 * 0.5) {
      out.push({ kind: "compaction", at: p1.at || "", atMs: p1.atMs || 0, count: Math.max(0, h0 - h1), from: h0, to: h1, savedChars: Math.max(0, (p0.historyChars || 0) - (p1.historyChars || 0)) });
    }
  }
  // 2) 模型切换：消息事件的 modelName 变化
  var msgs = await readJsonl("chatmsg-", 3);
  var prevModel = "";
  for (var m = 0; m < msgs.length; m++) {
    var r0 = msgs[m];
    if (r0.session !== key) continue;
    var mn = String(r0.modelName || "");
    if (!mn) continue;
    if (prevModel && mn !== prevModel) out.push({ kind: "model", at: r0.at || "", atMs: r0.atMs || 0, from: prevModel, to: mn });
    prevModel = mn;
  }
  // 3) W8报错门类：当前 raw 里的系统警告（截断类 / 输出异常类；结构锚点判定，带 idx 锚点供点击定位）
  try {
    var rawW = await loadRaw(key);
    var warnList = w8ScanWarnsUi(rawW && Array.isArray(rawW.preparedHistory) ? rawW.preparedHistory : []);
    if (warnList.length) {
      // 时间近似：与留档（warnings-*.jsonl，main.js 捕获实录）尾部对齐，取捕获时刻
      try {
        var wrRows = await readJsonl("warnings-", 3);
        var mine = [];
        for (var wrI = 0; wrI < wrRows.length; wrI++) {
          if (key && wrRows[wrI].session !== key) continue;
          mine.push(wrRows[wrI]);
        }
        mine.sort(function (a, b) { return (+a.atMs || 0) - (+b.atMs || 0); });
        var vi = warnList.length - 1, ri = mine.length - 1;
        while (vi >= 0 && ri >= 0) {
          if (String(mine[ri].text) === warnList[vi].text) {
            warnList[vi].at = String(mine[ri].at || "");
            warnList[vi].atMs = +mine[ri].atMs || 0;
            vi--; ri--;
          } else {
            ri--; // 留档含已压缩历史：跳过对不上的
          }
        }
      } catch (eW2) { /* 留档缺失不致命 */ }
      for (var wj = 0; wj < warnList.length; wj++) {
        out.push({ kind: "warn", wtype: warnList[wj].type, text: warnList[wj].text, idx: warnList[wj].idx, at: warnList[wj].at || "", atMs: warnList[wj].atMs || 0 });
      }
    }
  } catch (eW0) { /* raw 读取失败不影响其它事件 */ }
  // 4) 剪枝 / 注入：从快照序列推导（触发条件见 P4_2C 纯函数段 ev3SegEvents）
  try {
    var segEv = ev3SegEvents(merged);
    for (var se = 0; se < segEv.length; se++) out.push(segEv[se]);
  } catch (eP) { /* 推导失败不影响其它事件 */ }
  // 5) 技能 / 子代理：采集层 events_<key>.json 里的 skill / agent 投影（判定见 P4_2C 纯函数段 ev3SkillAgentOf）
  try {
    var evTxt = await readText(PV_DIR + "/events_" + key + ".json");
    if (evTxt) {
      var evData = null;
      try { evData = JSON.parse(stripNl(evTxt)); } catch (eJ) { evData = null; }
      var saEv = ev3SkillAgentOf(evData);
      for (var sa = 0; sa < saEv.length; sa++) out.push(saEv[sa]);
    }
  } catch (eS) { /* 旧采集版本没有 events 文件：保持空，不猜 */ }
  // 排序：有时间按时间；无时间的（留档缺失的警告）排最后，避免抢占 slice(-30) 裁剪顺位
  out.sort(function (a, b) {
    var am = +a.atMs || 0, bm = +b.atMs || 0;
    if (!am && !bm) return 0;
    if (!am) return 1;
    if (!bm) return -1;
    return am - bm;
  });
  return { ok: true, items: out.slice(-30) };
}

// ==== STATS_V1 BEGIN（P4-4B；纯函数段：node 自检脚本按标记提取，勿在段内用宿主 API）====
// 上下文统计卡聚合：raw preparedHistory → core / io / tools / commands（apiStats 只负责读盘与事件计数）。
// 口径（对齐上游 dsh-context shared/commands.ts 与本文件既有 fa2* 段；零新增写盘）：
//  - 工具名 = package_proxy 解包后的真实名（tool_name，最多 3 层）；解不开保持包名，不猜。
//    每项带 short = 尾段（super_admin:bash → bash），供前端显示；name 保留全名供跳转/统计。
//  - 命令只认 super_admin:bash|shell|powershell：按 | ; && || & 换行 把命令串切成命令段，
//    每段解析程序名（跳过 cd 导航段、前导 VAR=value 赋值、env/sudo/nohup 之类包装器及其取值、注释）；
//    引号内与 heredoc 正文里的分隔符不切段。同名程序在一次调用里出现几次就记几次。
//    整条一个都解析不出 → 归 STATS_UNKNOWN 记 1 次；只有 cd 导航的调用不进 commands。
//    runs = 这三类工具的调用次数（= commands 的「调用」口径，标题总数用它；不等于 commands 之和）。
//  - failed = 该调用按「同名 FIFO」配对到的 TOOL_RESULT 是 error（status="error" 或 <content><error>）；
//    失败是调用级的，展开记到该调用涉及的所有程序上（故各程序 failed 之和可大于失败调用数）。
//    窗口内没有结果的调用不计失败。结果里的 name 已是解包后的真实名，配对线索只有工具名，
//    同一工具的并行批次内可能错位——与 fa2Pair 的 FIFO 兜底同性质（已知限制）。
//  - 无 per-call 时间戳 → 不做耗时。
var STATS_UNKNOWN = "(未识别)";
var STATS_CMD_DIALECT = { bash: "bash", shell: "bash", powershell: "pwsh" };
var STATS_BASH_HEAD = { for: 1, if: 1, while: 1, until: 1, case: 1, do: 1, then: 1, else: 1, elif: 1, function: 1, select: 1, coproc: 1, done: 1, fi: 1, esac: 1, export: 1, local: 1, declare: 1, readonly: 1, typeset: 1 };
var STATS_PWSH_HEAD = { if: 1, elseif: 1, else: 1, for: 1, foreach: 1, while: 1, do: 1, switch: 1, function: 1, filter: 1, param: 1, begin: 1, process: 1, end: 1, try: 1, catch: 1, finally: 1, trap: 1, return: 1, throw: 1, break: 1, continue: 1, using: 1, class: 1, enum: 1 };
// 包装器里「带一个取值」的单字母选项（sudo -u root / nice -n 5 / timeout -s KILL 3 …）
var STATS_WRAP_VALUE_FLAG = { u: 1, g: 1, p: 1, C: 1, D: 1, h: 1, r: 1, t: 1, U: 1, R: 1, n: 1, s: 1, k: 1, i: 1, o: 1, e: 1, a: 1, f: 1 };

/** 程序名规范化：取 basename，去 Windows 可执行后缀（对齐上游 normalizeProgram） */
function statsProgName(word) {
  var s = String(word === null || word === undefined ? "" : word).trim();
  var cut = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  if (cut >= 0) s = s.slice(cut + 1);
  return s.replace(/\.(?:exe|cmd|bat)$/i, "").trim();
}

/** 取文本首个「词」（支持引号包裹）：{word, end, quoted} 或 null */
function statsHeadWord(text) {
  var s = String(text === null || text === undefined ? "" : text);
  var m = s.match(/^"([^"]*)"/) || s.match(/^'([^']*)'/);
  if (m) return { word: m[1], end: m[0].length, quoted: 1 };
  m = s.match(/^[^\s;&|()<>]+/);
  return m ? { word: m[0], end: m[0].length, quoted: 0 } : null;
}

/** 包装器（env/sudo/timeout…）自带的选项与取值一并跳过：-u root / -n 5 / timeout 3 / --format x */
function statsSkipWrapArgs(text, wrapper) {
  var rest = String(text === null || text === undefined ? "" : text);
  for (var guard = 0; guard < 8; guard++) {
    var m = rest.match(/^(-{1,2}[A-Za-z][A-Za-z0-9_-]*)(?:[ \t]+|$)/);
    if (m) {
      rest = rest.slice(m[0].length);
      var takesValue = m[1].charAt(1) !== "-" ? STATS_WRAP_VALUE_FLAG[m[1].charAt(1)] === 1
        : /^--(?:user|group|unset|split-string|format|adjustment|kill-after|signal|chdir|other-user|chroot)$/.test(m[1]);
      if (takesValue) rest = rest.replace(/^\S+[ \t]*/, "");
      continue;
    }
    if ((wrapper === "timeout" || wrapper === "time") && /^\d+(?:\.\d+)?[a-z]*[ \t]+/i.test(rest)) { rest = rest.replace(/^\S+[ \t]*/, ""); continue; }
    break;
  }
  return rest;
}

/** 命令串 → 第一条命令的程序名（跳过 cd 前缀 / 前导赋值 / 包装器；解析不出 → STATS_UNKNOWN） */
function statsProgramOf(cmd, dialect) {
  var rest = String(cmd === null || cmd === undefined ? "" : cmd).replace(/^\s+/, "");
  var pwsh = dialect === "pwsh";
  var heads = pwsh ? STATS_PWSH_HEAD : STATS_BASH_HEAD;
  var skipCd = pwsh
    ? /^(?:cd|Set-Location|sl)\b[^\n;]*?(?:;|&&|\n)\s*/i
    : /^cd\s+(?:"[^"]*"|'[^']*'|\S+)[^;&|\n]*(?:&&|;|\n)\s*/;
  // 前导赋值：带分隔符的整条（VAR=...; cmd）＋不带分隔符的前缀（VAR=1 cmd）
  // 值里排除 $ ( ) 与引号：`x=$(grep -o …)`、`W='/含 空格/路径'` 这类残段按「解析不出」处理，不猜
  var skipAssign = pwsh
    ? /^\$[A-Za-z_][A-Za-z0-9_:]*\s*=\s*[^;\n]*(?:;|\n|$)\s*/
    : /^(?:[A-Za-z_][A-Za-z0-9_]*\+?=\s*(?:"[^"]*"|'[^']*'|[^;&|\n$()]*)(?:&&|;|\n)|[A-Za-z_][A-Za-z0-9_]*\+?=[^\s;&|$()'"]*\s+)\s*/;
  var wrapRe = /^(env|sudo|doas|command|exec|nohup|nice|stdbuf|timeout|time)[ \t]+/;
  // pwsh 调用运算符 & / 点源 .：被调用的引号路径仍算程序名（裸字符串不算）
  var invoked = pwsh && /^[&.][ \t]/.test(rest);
  for (var guard = 0; guard < 8; guard++) {
    rest = rest.replace(/^[\s;&|]+/, "");
    if (!rest) break;
    if (rest.charAt(0) === "#") {
      var nl = rest.indexOf("\n");
      if (nl < 0) { rest = ""; break; }
      rest = rest.slice(nl + 1);
      continue;
    }
    var m = rest.match(skipCd);
    if (m) { rest = rest.slice(m[0].length); continue; }
    m = rest.match(skipAssign);
    if (m) { rest = rest.slice(m[0].length); continue; }
    // 循环体/条件体的引导词（`do echo …` / `then cat …`）：跳过后再取真正执行的程序
    if (pwsh) { m = rest.match(/^(?:do|then|else|begin|process)[ \t]+/i); }
    else { m = rest.match(/^(?:do|then|else)[ \t]+/); }
    if (m && m[0].length < rest.length) { rest = rest.slice(m[0].length); continue; }
    m = rest.match(wrapRe);
    if (m && m[0].length < rest.length) { rest = statsSkipWrapArgs(rest.slice(m[0].length), m[1]); continue; }
    break;
  }
  if (invoked) rest = rest.replace(/^[&.][ \t]+/, "");
  if (!rest) return STATS_UNKNOWN;
  // 函数定义（f() { … }）不是命令
  if (pwsh ? /^[A-Za-z_][A-Za-z0-9_-]*[ \t]*\(\s*\)/.test(rest) : /^[A-Za-z_][A-Za-z0-9_-]*\(\)/.test(rest)) return STATS_UNKNOWN;
  var hw = statsHeadWord(rest);
  if (!hw) return STATS_UNKNOWN;
  if (pwsh && hw.quoted && !invoked) return STATS_UNKNOWN; // 裸字符串不是命令（& "path" 已按调用处理）
  var w = hw.word;
  var c0 = w.charAt(0);
  // 纯变量 / 子表达式 / 数组 / 数字 / 带等号的残片：都不是程序名
  if (!w || c0 === "$" || c0 === "(" || c0 === "{" || c0 === "[" || c0 === "@" || c0 === '"' || c0 === "'" || c0 === "`" || c0 === "!" || w.indexOf("=") > -1 || /^\d+(?:\.\d+)?$/.test(w)) return STATS_UNKNOWN;
  if (heads[w.toLowerCase()] === 1) return STATS_UNKNOWN;
  var name = statsProgName(w);
  return name ? name : STATS_UNKNOWN;
}

/** 命令串 → 命令段数组：按 | ; && || & 换行切；引号内、注释里、bash heredoc 正文里的分隔符不切 */
function statsSegmentsOf(cmd, dialect) {
  var s = String(cmd === null || cmd === undefined ? "" : cmd);
  var pwsh = dialect === "pwsh";
  var out = [], start = 0, i = 0, quote = "", heredoc = "";
  while (i < s.length) {
    var c = s.charAt(i);
    if (heredoc) {
      var nl0 = s.indexOf("\n", i);
      if (nl0 < 0) { start = s.length; i = s.length; break; } // 未闭合 heredoc：余下全是正文
      var line = s.slice(i, nl0).replace(/^\t+/, "").replace(/\s+$/, "");
      i = nl0 + 1;
      if (line === heredoc) { heredoc = ""; start = i; }
      continue;
    }
    if (quote) {
      if (c === "\\" && !pwsh) { i += 2; continue; }
      if (c === "`" && pwsh) { i += 2; continue; }
      if (c === quote) quote = "";
      i++;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; i++; continue; }
    if (c === "`" && pwsh) { i += 2; continue; }
    if (c === "\\" && !pwsh) { i += 2; continue; }
    if (c === "#" && (i === 0 || /[\s;&|]/.test(s.charAt(i - 1)))) {
      out.push(s.slice(start, i));
      var nl1 = s.indexOf("\n", i);
      if (nl1 < 0) { start = s.length; i = s.length; break; }
      start = nl1 + 1;
      i = start;
      continue;
    }
    // bash heredoc：命令本体到 << 之前为止，正文整块跳过（否则 python - <<'PY' 的正文会被当成命令）
    if (!pwsh && c === "<" && s.charAt(i + 1) === "<" && s.charAt(i + 2) !== "<") {
      var at = i + 2;
      if (s.charAt(at) === "-") at++;
      while (s.charAt(at) === " " || s.charAt(at) === "\t") at++;
      var dl = statsHeadWord(s.slice(at));
      if (dl && dl.word) {
        out.push(s.slice(start, i));
        heredoc = dl.word;
        var nl2 = s.indexOf("\n", at + dl.end);
        i = nl2 < 0 ? s.length : nl2 + 1;
        start = i;
        continue;
      }
    }
    if (c === "\n") { out.push(s.slice(start, i)); i++; start = i; continue; }
    if (c === "|" || c === "&" || c === ";") {
      if ((c === "|" && s.charAt(i + 1) === "|") || (c === "&" && s.charAt(i + 1) === "&")) { out.push(s.slice(start, i)); i += 2; start = i; continue; }
      if (c === "&" && (s.charAt(i - 1) === ">" || s.charAt(i + 1) === ">")) { i++; continue; } // 2>&1 / &> 是重定向不是分隔
      if (c === "|" && s.charAt(i + 1) === "&") { out.push(s.slice(start, i)); i += 2; start = i; continue; }
      out.push(s.slice(start, i));
      i++;
      start = i;
      continue;
    }
    i++;
  }
  out.push(s.slice(start));
  return out;
}

/** 命令串 → 整条命令行涉及的程序名数组（同名多次出现记多次；cd 导航段与解析不出的段跳过）。
 *  空命令 → [STATS_UNKNOWN]（参数缺失如实归未识别）；只有导航/空段 → []（不算一次执行）。 */
function statsProgramsOf(cmd, dialect) {
  var s = String(cmd === null || cmd === undefined ? "" : cmd);
  if (!s.trim()) return [STATS_UNKNOWN];
  var segs = statsSegmentsOf(s, dialect);
  var out = [], saw = false;
  for (var i = 0; i < segs.length; i++) {
    if (!String(segs[i]).trim()) continue;
    var p = statsProgramOf(segs[i], dialect);
    if (dialect === "pwsh" ? /^(?:cd|Set-Location|sl)$/i.test(p) : p === "cd") continue; // 导航段不算执行
    saw = true;
    if (p && p !== STATS_UNKNOWN) out.push(p);
  }
  return out.length > 0 ? out : (saw ? [STATS_UNKNOWN] : []);
}

/** 一条 TOOL_CALL → {tool, params}：tool 为 package_proxy 解包后的真实名（最多 3 层），params 为解包后的调用参数 */
function statsCallOf(content) {
  var s = String(content === null || content === undefined ? "" : content);
  var h = s.match(/<tool(?:_[A-Za-z0-9]+)?\s+name="([^"]+)"/);
  if (!h) return null;
  var params = {};
  var re = /<param name="([A-Za-z0-9_]+)">([\s\S]*?)<\/param>/g, m;
  while ((m = re.exec(s)) !== null) params[m[1]] = fa2Unesc(m[2]);
  var tool = h[1];
  for (var guard = 0; guard < 3 && fa2ToolTail(tool) === "package_proxy"; guard++) {
    var inner = String(params.tool_name === null || params.tool_name === undefined ? "" : params.tool_name).trim();
    if (!inner) break;
    var rawParams = params.params;
    var sub = null;
    if (rawParams && typeof rawParams === "object") sub = rawParams;
    else if (rawParams !== null && rawParams !== undefined) { try { sub = JSON.parse(String(rawParams)); } catch (e) { sub = null; } }
    var next = {};
    if (sub && typeof sub === "object") {
      for (var k in sub) if (!(k in next)) next[k] = sub[k];
    } else if (rawParams) {
      // JSON 坏掉时的宽松兜底（同 fa2ParseCall）：抓 "key": "value" 对，解不出就不填
      var lm = String(rawParams).match(/"([A-Za-z0-9_]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g) || [];
      for (var li = 0; li < lm.length; li++) {
        var kv = lm[li].match(/"([A-Za-z0-9_]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (kv && !(kv[1] in next)) next[kv[1]] = kv[2].replace(/\\(["\\/])/g, "$1");
      }
    }
    tool = inner;
    params = next;
  }
  return { tool: tool, params: params };
}

/** raw preparedHistory → {core, io, tools, commands}（单遍扫描；文件活动复用 fa2Compute，步点位复用 w7PointIdxs） */
function statsCompute(hist) {
  var list = Array.isArray(hist) ? hist : [];
  var counts = { USER: 0, ASSISTANT: 0, TOOL_CALL: 0 };
  var tools = {};
  var cmds = {};
  var skillCalls = 0;
  var runs = 0;   // 命令行调用次数（标题右侧的总数口径；与 commands 的程序段数区分）
  var pending = {};
  for (var i = 0; i < list.length; i++) {
    var it = list[i] || {};
    var k = String(it.kind || it.role || "").toUpperCase();
    if (k === "USER") { counts.USER += 1; continue; }
    if (k === "ASSISTANT") { counts.ASSISTANT += 1; continue; }
    if (k === "TOOL_CALL") {
      counts.TOOL_CALL += 1;
      var call = statsCallOf(it.content);
      if (!call) continue;
      tools[call.tool] = (tools[call.tool] || 0) + 1;
      if (/skill/i.test(call.tool)) skillCalls += 1; // use_skill / load_skill / skill…
      var dialect = STATS_CMD_DIALECT[fa2ToolTail(call.tool)];
      if (!dialect) continue;
      runs += 1; // bash/shell/powershell 各算一次调用（含只有 cd 导航、解析不出程序的调用）
      var cmdText = call.params.command !== undefined ? call.params.command : (call.params.script !== undefined ? call.params.script : call.params.cmd);
      var progs = statsProgramsOf(cmdText, dialect);
      for (var pi = 0; pi < progs.length; pi++) {
        var slot = cmds[progs[pi]] || (cmds[progs[pi]] = { name: progs[pi], count: 0, failed: 0 });
        slot.count += 1;
      }
      // 空数组也占位：保证同名 FIFO 配对不会错位到后一条调用
      var q = pending[call.tool] || (pending[call.tool] = { list: [], head: 0 });
      q.list.push(progs);
      continue;
    }
    if (k === "TOOL_RESULT") {
      var s2 = String(it.content || "");
      var rr = s2.match(/<tool_result(?:_[A-Za-z0-9]+)?\s+name="([^"]+)"(?:\s+status="([^"]+)")?/);
      if (!rr) continue;
      var q2 = pending[rr[1]];
      if (!q2 || q2.head >= q2.list.length) continue; // 窗口里没有对应调用：不猜
      var owner = q2.list[q2.head];
      q2.head += 1;
      var err = rr[2] === "error" || /^<tool_result(?:_[A-Za-z0-9]+)?[^>]*>\s*<content>\s*<error>/.test(s2);
      // 失败是调用级的：该调用涉及的每个程序各记一次（各程序 failed 之和可大于失败调用数）
      if (err && owner) {
        for (var oi = 0; oi < owner.length; oi++) if (cmds[owner[oi]]) cmds[owner[oi]].failed += 1;
      }
      continue;
    }
  }
  var toolRows = [];
  for (var tn in tools) toolRows.push({ name: tn, short: fa2ToolTail(tn), count: tools[tn] });
  toolRows.sort(function (a, b) { return (b.count - a.count) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
  var topTools = toolRows.slice(0, 12);
  if (toolRows.length > 12) {
    var restN = 0;
    for (var ti = 12; ti < toolRows.length; ti++) restN += toolRows[ti].count;
    if (restN > 0) topTools.push({ name: "其他", short: "其他", count: restN });
  }
  var cmdRows = [];
  for (var cn in cmds) cmdRows.push(cmds[cn]);
  cmdRows.sort(function (a, b) { return (b.count - a.count) || (b.failed - a.failed) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
  var act = fa2Compute(list);
  return {
    core: {
      turns: counts.USER,
      // 步 = 一次请求（上游 countStep 口径）：复用 w7PointIdxs（USER / 连续 TOOL_RESULT 段末），
      // 与 apiSteps 的 items 数同源；实测 ≈ ASSISTANT 数（<key-A> 127 vs 111），不是工具调用数。
      steps: w7PointIdxs(list).length,
      skills: skillCalls,
      answers: counts.ASSISTANT,
      events: { inject: 0, compaction: 0, prune: 0 }
    },
    io: {
      in: { user: counts.USER, read: act.totals.read.ops, write: act.totals.write.ops, search: act.totals.search.ops },
      out: { tools: counts.TOOL_CALL }
    },
    tools: topTools,
    commands: cmdRows,
    // 命令行调用次数（标题右侧总数；commands 之和是「程序执行次数」，两者不等）
    runs: runs
  };
}
// ==== STATS_V1 END ====

/** P4-4B：上下文统计卡聚合（KPI 6 格 + IO 账本 + 工具 chips + 命令 chips）。
 *  raw 单次读（loadRaw 缓存复用）→ statsCompute；chatmsg 不读。
 *  events 三类只能从快照序列推导，复用 apiEvents 的合并口径 + ev3SegEvents 纯函数（读 snapshots-* 3 个 jsonl）。 */
async function apiStats(keyIn) {
  var key = keyIn || await latestKey();
  if (!key) return { ok: false, code: "no-raw", error: "当前会话还没有上下文记录" };
  var payload = await loadRaw(key);
  if (!payload) return rawFail(key);
  var out = statsCompute(Array.isArray(payload.preparedHistory) ? payload.preparedHistory : []);
  try {
    var snaps = await readJsonl("snapshots-", 3);
    var filtered = [];
    for (var i = 0; i < snaps.length; i++) { if (snaps[i] && snaps[i].session === key) filtered.push(snaps[i]); }
    filtered.sort(function (a, b) { return (a.atMs || 0) - (b.atMs || 0); });
    var merged = [];
    for (var j = 0; j < filtered.length; j++) {
      var s = filtered[j];
      var last = merged.length ? merged[merged.length - 1] : null;
      if (last && Math.abs((s.atMs || 0) - last.atMs) < 10000) merged[merged.length - 1] = s;
      else merged.push(s);
    }
    var ev = out.core.events;
    for (var c = 1; c < merged.length; c++) {
      var h0 = merged[c - 1].historyCount || 0, h1 = merged[c].historyCount || 0;
      if (h0 > 0 && h1 > 0 && h1 < h0 * 0.5) ev.compaction += 1; // 与 apiEvents 同判定
    }
    var seg = ev3SegEvents(merged);
    for (var q = 0; q < seg.length; q++) {
      if (seg[q].kind === "inject") ev.inject += 1;
      else if (seg[q].kind === "prune") ev.prune += 1;
    }
  } catch (eE) { /* 快照缺失/损坏：三类事件保持 0，不猜 */ }
  return { ok: true, key: key, core: out.core, io: out.io, tools: out.tools, commands: out.commands, runs: out.runs };
}

/** P3-2 里程碑事件：读采集层每轮落盘的 events_<key>.json（与 raw 同目录，整份重算、可为空）。
 *  缺失/损坏不算错误，返回空数组；kind 见采集层 EVENTS_V1 段（todo-add / goal-complete / ask …）。 */
async function apiMilestones(keyIn) {
  var key = keyIn || await latestKey();
  if (!key) return { ok: false, error: "no key" };
  var t = await readText(PV_DIR + "/events_" + key + ".json");
  if (!t) return { ok: true, key: key, updatedAt: "", items: [] };
  var data = null;
  try { data = JSON.parse(stripNl(t)); } catch (e) { return { ok: true, key: key, updatedAt: "", items: [], error: "parse failed" }; }
  var list = data && Array.isArray(data.events) ? data.events : [];
  return { ok: true, key: key, updatedAt: String((data && data.updatedAt) || ""), timeSource: String((data && data.timeSource) || ""), items: list };
}

// ==== FILE_ACTIVITY_V2 BEGIN（Viya 2026-09-16；纯函数段：node 自检脚本按标记提取，勿在段内用宿主 API）====
// 文件活动 v2：op 级解析器 + 配对 + 聚合（对齐上游 dsh-context shared/fileOps.ts 语义）
// 实测结论（2026-09-16，prompt_viewer/raw_*.json 全库 45 份）：
//  - call 参数在 TOOL_CALL 的 <param> 里（XML 实体需解码）；result 线索在 TOOL_RESULT 文本里。
//  - 结果按【完成顺序】返回（并行调用会乱序）且随机 id 与 call 无关联 → 配对靠内容线索：
//    ① 路径线索（Content of /path、Directory listing for /path、file-diff path="…" 等）
//    ② read_file_part 窗口线索（Lines a-b == call 的 start_line-end_line）
//    ③ FIFO 兜底（stats.fifo 计数；拿不准时不硬错配）
//  - delta：结果里的 file-diff（Changes: +N -M lines）优先；无则按调用参数估算（对齐上游）。
var FA2_KIND = {
  read_file: 'read', read_file_part: 'read', list_files: 'read', file_exists: 'read', file_info: 'read',
  grep_code: 'search', grep_context: 'search', find_files: 'search',
  edit_file: 'write', create_file: 'write', write_file: 'write', delete_file: 'write',
  make_directory: 'write', move_file: 'write', copy_file: 'write', zip_files: 'write', unzip_files: 'write'
};
var FA2_PATH_KEYS = { path: 1, old_path: 1, new_path: 1, source_path: 1, destination_path: 1, target_path: 1, file_path: 1, source: 1, destination: 1 };

function fa2Unesc(s) {
  return String(s).replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-fA-F]+);/g, function (m, g) {
    switch (g) { case 'lt': return '<'; case 'gt': return '>'; case 'quot': return '"'; case 'apos': return "'"; case 'amp': return '&'; }
    if (g.charAt(0) === '#') {
      try { return String.fromCodePoint(g.charAt(1) === 'x' || g.charAt(1) === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10)); } catch (e) { }
    }
    return m;
  });
}

function fa2ToolTail(raw) {
  var s = String(raw || '');
  var i = s.lastIndexOf(':');
  return i > -1 ? s.slice(i + 1) : s;
}

function fa2LinesOf(s) {
  if (typeof s !== 'string' || s === '') return 0;
  var n = 0;
  for (var i = 0; i < s.length; i++) if (s.charAt(i) === '\n') n++;
  return s.charAt(s.length - 1) === '\n' ? n : n + 1;
}

function fa2Dedupe(arr) {
  var seen = {}, out = [];
  for (var i = 0; i < arr.length; i++) { var v = arr[i]; if (v && !seen[v]) { seen[v] = 1; out.push(v); } }
  return out;
}

/** 解析一条 TOOL_CALL：返回 {idx, tool, kind, params, paths, win} 或 null（非文件工具） */
function fa2ParseCall(content, idx) {
  var s = String(content);
  var h = s.match(/<tool(?:_[A-Za-z0-9]+)?\s+name="([^"]+)"/);
  if (!h) return null;
  var toolRaw = h[1], tool = fa2ToolTail(toolRaw);
  var params = {};
  var re = /<param name="([A-Za-z_]+)">([\s\S]*?)<\/param>/g, m;
  while ((m = re.exec(s)) !== null) params[m[1]] = fa2Unesc(m[2]);
  // package_proxy 包装（如 extended_file_tools:copy_file）：真实工具名在 tool_name，参数在 params(JSON)
  if (tool === 'package_proxy' && params.tool_name) {
    toolRaw = params.tool_name; tool = fa2ToolTail(params.tool_name);
    var inner = null;
    try { inner = JSON.parse(params.params || '{}'); } catch (e) { inner = null; }
    if (inner && typeof inner === 'object') {
      for (var k in inner) if (!(k in params)) params[k] = inner[k];
    } else if (params.params) {
      var lm = params.params.match(/"([A-Za-z_]+)"\s*:\s*"([^"]+)"/g) || [];
      for (var li = 0; li < lm.length; li++) {
        var kv = lm[li].match(/"([A-Za-z_]+)"\s*:\s*"([^"]+)"/);
        if (kv && !(kv[1] in params)) params[kv[1]] = kv[2];
      }
    }
  }
  var kind = FA2_KIND[tool];
  if (!kind) return null;
  var paths = [];
  for (var pk in FA2_PATH_KEYS) if (typeof params[pk] === 'string' && params[pk]) paths.push(params[pk]);
  var win = null;
  if (tool === 'read_file_part') {
    var sl = parseInt(params.start_line, 10), el = parseInt(params.end_line, 10);
    if (isFinite(sl) && isFinite(el)) win = { start: sl, end: el };
  }
  return { idx: idx, toolRaw: toolRaw, tool: tool, kind: kind, params: params, paths: fa2Dedupe(paths), win: win, used: false, result: null };
}

/** 解析一条 TOOL_RESULT：返回 {idx, tool, kind, err, hints, win, lineRange, hits, hitFiles, searchFiles, added, removed, hasDelta} 或 null */
function fa2ParseResult(content, idx) {
  var s = String(content);
  var h = s.match(/<tool_result(?:_[A-Za-z0-9]+)?\s+name="([^"]+)"(?:\s+status="([^"]+)")?/);
  if (!h) return null;
  var toolRaw = h[1], tool = fa2ToolTail(toolRaw);
  var kind = FA2_KIND[tool];
  if (!kind) return null;
  var err = h[2] === 'error' || /^<tool_result(?:_[A-Za-z0-9]+)?[^>]*>\s*<content>\s*<error>/.test(s);
  var hints = [], win = null, lineRange = null, hits = 0, hitFiles = 0, searchFiles = null, added = 0, removed = 0, hasDelta = false;
  // read_file_part 窗口：Part x of y (Lines a-b of c)
  var w = s.match(/Part (\d+) of (\d+) \(Lines (\d+)-(\d+) of (\d+)\)/);
  if (w) win = { start: parseInt(w[3], 10), count: parseInt(w[4], 10) - parseInt(w[3], 10) + 1 };
  // file-diff（edit_file / create_file）：path + Changes: +N -M lines
  var fd = s.match(/<file-diff path="([^"]*)"/);
  if (fd) hints.push(fd[1]);
  var ch = s.match(/Changes: \+(\d+) -(\d+) lines/);
  if (ch) { added = parseInt(ch[1], 10); removed = parseInt(ch[2], 10); hasDelta = true; }
  // 路径线索：各工具结果头
  var co = s.match(/Content of ([^\n:]+?):/); if (co) hints.push(co[1]);
  var dl = s.match(/Directory listing for ([^\n:]+?):/); if (dl) hints.push(dl[1]);
  var sp = s.match(/Search Path: ([^\n]+?)(?:\s+Pattern:|$)/m); if (sp) hints.push(sp[1].replace(/\s+$/, ''));
  var de = s.match(/Successfully deleted ([^\s<]+)/); if (de) hints.push(de[1]);
  var mkd = s.match(/Successfully created directory ([^\s<]+)/); if (mkd) hints.push(mkd[1]);
  // 复制类（含包工具 JSON 结果）
  var jc = s.match(/Successfully copied file ([^\s<]+) to ([^\s<]+)/); if (jc) { hints.push(jc[1]); hints.push(jc[2]); }
  var jp = s.match(/"path"\s*:\s*"([^"]+)"/); if (jp) hints.push(jp[1]);
  // 搜索命中：Total Matches: N (in M files) / Found N files
  var tm = s.match(/Total Matches: (\d+) \(in (\d+) files\)/);
  if (tm) { hits = parseInt(tm[1], 10); hitFiles = parseInt(tm[2], 10); }
  else { var ff = s.match(/Found (\d+) files/); if (ff) hits = parseInt(ff[1], 10); }
  // 搜索逐文件清单（grep: "File: /path" 行；find_files: "- /path" 行）
  if (kind === 'search') {
    searchFiles = [];
    var fre = /(?:^|\n)\s*File: (\/[^\n]+)/g, fm;
    while ((fm = fre.exec(s)) !== null) searchFiles.push({ path: fm[1].replace(/\s+$/, ''), hits: 0 });
    if (!searchFiles.length) {
      var fle = /- (\/[^\n]+)/g, flm;
      while ((flm = fle.exec(s)) !== null) searchFiles.push({ path: flm[1].replace(/\s+$/, ''), hits: 0 });
    }
    // 截断保护：声明的文件数 > 实抓行数 → 清单不完整，弃用（退回 target 行）
    var declared = hitFiles || hits;
    if (searchFiles.length && declared && searchFiles.length < declared) searchFiles = null;
    if (searchFiles && searchFiles.length === 0) searchFiles = null;
  }
  // read_file 行号范围（结果正文的 "N| " 前缀）→ 读取窗口 [first, last]
  if (tool === 'read_file' && !err) {
    var reN = /(?:^|\n)\s*(\d+)\|/g, mn, first = null, lastN = null, guard = 0;
    while ((mn = reN.exec(s)) !== null && guard < 200000) {
      var v = parseInt(mn[1], 10);
      if (first === null) first = v;
      lastN = v; guard++;
    }
    if (first !== null) lineRange = { start: first, count: lastN - first + 1 };
  }
  // error 文本里的路径（配对辅助；保守提取，最多 6 个）
  if (err) {
    var pe = /(?:^|[\s:'"(])((?:\/[A-Za-z0-9_.\-]+)+)/g, pm, pn = 0;
    while ((pm = pe.exec(s)) !== null) { hints.push(pm[1]); pn++; if (pn >= 6) break; }
  }
  return { idx: idx, toolRaw: toolRaw, tool: tool, kind: kind, err: err, hints: fa2Dedupe(hints), win: win, lineRange: lineRange, hits: hits, hitFiles: hitFiles, searchFiles: searchFiles, added: added, removed: removed, hasDelta: hasDelta, call: null };
}

/** 配对：每个 result 找它的 call（路径线索 → 窗口线索 → FIFO 兜底） */
function fa2Pair(calls, results) {
  var stats = { calls: calls.length, results: results.length, paired: 0, unpairedResults: 0, unpairedCalls: 0, fifo: 0, hintMatched: 0, winMatched: 0 };
  var byTool = {};
  for (var i = 0; i < calls.length; i++) (byTool[calls[i].tool] || (byTool[calls[i].tool] = [])).push(calls[i]);
  for (var r = 0; r < results.length; r++) {
    var res = results[r];
    var cands = byTool[res.tool] || [];
    var pick = null, how = '';
    // 1) 路径线索（hints 与 call 的路径参数有交集；多候选取最早）
    if (res.hints.length) {
      for (var ci = 0; ci < cands.length && !pick; ci++) {
        var c = cands[ci];
        if (c.used) continue;
        for (var hi = 0; hi < res.hints.length; hi++) {
          if (c.paths.indexOf(res.hints[hi]) > -1) { pick = c; how = 'hint'; break; }
        }
      }
    }
    // 2) 窗口线索（read_file_part：start 与 count 完全相等）
    if (!pick && res.win) {
      for (var c2 = 0; c2 < cands.length; c2++) {
        var cc = cands[c2];
        if (cc.used || !cc.win) continue;
        if (cc.win.start === res.win.start && (cc.win.end - cc.win.start + 1) === res.win.count) { pick = cc; how = 'win'; break; }
      }
    }
    // 3) FIFO 兜底（最早未配对）
    if (!pick) {
      for (var c3 = 0; c3 < cands.length; c3++) { if (!cands[c3].used) { pick = cands[c3]; how = 'fifo'; break; } }
    }
    if (pick) {
      pick.used = true; pick.result = res; res.call = pick; stats.paired++;
      if (how === 'hint') stats.hintMatched++; else if (how === 'win') stats.winMatched++; else stats.fifo++;
    } else {
      res.orphan = true; stats.unpairedResults++;
    }
  }
  for (var k = 0; k < calls.length; k++) if (!calls[k].used) stats.unpairedCalls++;
  return stats;
}

/** 文件形态：image（图片扩展名）→ dir（目录目标）→ text */
function fa2Form(tool, path) {
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(path)) return 'image';
  if (/\/$/.test(path)) return 'dir';
  if (tool === 'list_files' || tool === 'make_directory') return 'dir';
  return 'text';
}

/** 参数估算 delta（结果无 file-diff 时的兜底；对齐上游「从调用参数估算」） */
function fa2ArgDelta(c, which) {
  var p = c.params;
  if (c.tool === 'edit_file') return which === 'added' ? fa2LinesOf(p['new']) : fa2LinesOf(p.old);
  if (c.tool === 'create_file') return which === 'added' ? fa2LinesOf(p['new']) : 0;
  if (c.tool === 'write_file') return which === 'added' ? fa2LinesOf(p.content) : 0;
  return 0;
}

/** 读取窗口：结果 exact（Lines a-b / 行号范围）优先，参数 est 兜底 */
function fa2ReadWindow(c, r) {
  if (r.win) return { start: r.win.start, count: r.win.count };
  if (r.lineRange) return { start: r.lineRange.start, count: r.lineRange.count };
  if (c.win) return { count: c.win.end - c.win.start + 1, est: true };
  return null;
}

/** 聚合：按路径折叠成 FileEntry + totals（对齐上游 aggregateOps；搜索按命中文件逐行） */
function fa2Aggregate(calls) {
  var totals = { read: { files: 0, ops: 0 }, write: { files: 0, ops: 0 }, search: { files: 0, ops: 0 }, image: { files: 0, ops: 0 }, added: 0, removed: 0 };
  var byPath = {};
  function addOp(path, op, patternMark) {
    var entry = byPath[path];
    if (!entry) {
      entry = byPath[path] = { path: path, form: fa2Form(op.tool, path), reads: 0, writes: 0, searches: 0, added: 0, removed: 0, errs: 0, ops: [] };
      if (patternMark) entry.pattern = true;
    }
    if (op.kind === 'read') entry.reads++;
    else if (op.kind === 'write') entry.writes++;
    else entry.searches++;
    entry.added += op.added; entry.removed += op.removed;
    if (op.err) entry.errs++;
    entry.ops.push(op);
  }
  for (var i = 0; i < calls.length; i++) {
    var c = calls[i], r = c.result;
    if (!r) continue; // 只折叠 settled（有 result 的）调用
    var base = { seq: r.idx, kind: c.kind, tool: c.tool, added: 0, removed: 0, err: r.err === true, callIdx: c.idx, resultIdx: r.idx };
    if (c.kind === 'search') {
      var pattern = typeof c.params.pattern === 'string' ? c.params.pattern : '';
      var target = c.paths.length ? c.paths[0] : '';
      var narrowed = !!target;
      var files = r.searchFiles;
      if (files) {
        // 逐文件行 + target 行（target 与命中文件重复时跳过；对齐上游）
        var skipTarget = false;
        for (var sf = 0; sf < files.length; sf++) if (files[sf].path === target) { skipTarget = true; break; }
        if (target && !skipTarget) {
          var to = { seq: base.seq, kind: 'search', tool: c.tool, path: target, added: 0, removed: 0, err: base.err, callIdx: base.callIdx, resultIdx: base.resultIdx, hits: r.hits || 0 };
          if (narrowed && pattern) to.detail = pattern;
          if (!narrowed) to.pattern = true;
          addOp(target, to, !narrowed);
        }
        for (var fi = 0; fi < files.length; fi++) {
          var fo = { seq: base.seq, kind: 'search', tool: c.tool, path: files[fi].path, added: 0, removed: 0, err: base.err, callIdx: base.callIdx, resultIdx: base.resultIdx };
          if (pattern) fo.detail = pattern;
          if (files[fi].hits > 0) fo.hits = files[fi].hits;
          addOp(files[fi].path, fo, false);
        }
        continue;
      }
      if (!target) continue;
      var so = { seq: base.seq, kind: 'search', tool: c.tool, path: target, added: 0, removed: 0, err: base.err, callIdx: base.callIdx, resultIdx: base.resultIdx };
      if (narrowed && pattern) so.detail = pattern;
      if (!narrowed) so.pattern = true;
      if (r.hits) so.hits = r.hits;
      addOp(target, so, !narrowed);
      continue;
    }
    var path = c.paths.length ? c.paths[0] : '';
    if (!path) continue;
    var op = { seq: base.seq, kind: c.kind, tool: c.tool, path: path, added: 0, removed: 0, err: base.err, callIdx: base.callIdx, resultIdx: base.resultIdx };
    op.added = r.hasDelta ? r.added : fa2ArgDelta(c, 'added');
    op.removed = r.hasDelta ? r.removed : fa2ArgDelta(c, 'removed');
    if (c.kind === 'read') {
      var rw = fa2ReadWindow(c, r);
      if (rw) op.read = rw;
    }
    addOp(path, op, false);
  }
  var entries = [];
  for (var p in byPath) entries.push(byPath[p]);
  for (var ei = 0; ei < entries.length; ei++) {
    var en = entries[ei];
    en.ops.sort(function (a, b) { return (b.seq || 0) - (a.seq || 0); });
    if (en.reads > 0) totals.read.files++;
    if (en.writes > 0) totals.write.files++;
    if (en.searches > 0) totals.search.files++;
    if (en.form === 'image') { totals.image.files++; totals.image.ops += en.ops.length; }
    totals.added += en.added; totals.removed += en.removed;
    totals.read.ops += en.reads; totals.write.ops += en.writes; totals.search.ops += en.searches;
  }
  entries.sort(function (a, b) { return ((b.ops[0] || { seq: 0 }).seq || 0) - ((a.ops[0] || { seq: 0 }).seq || 0); });
  return { entries: entries, totals: totals };
}

/** v2 主入口：preparedHistory → {entries, totals, stats, legacyItems} */
function fa2Compute(hist) {
  var calls = [], results = [], userIdx = [];
  for (var i = 0; i < hist.length; i++) {
    var it = hist[i] || {};
    var k = String(it.kind || '').toUpperCase();
    var c = String(it.content || '');
    if (k === 'USER') { userIdx.push(i); }
    else if (k === 'TOOL_CALL') { var pc = fa2ParseCall(c, i); if (pc) calls.push(pc); }
    else if (k === 'TOOL_RESULT') { var pr = fa2ParseResult(c, i); if (pr) results.push(pr); }
  }
  var stats = fa2Pair(calls, results);
  var agg = fa2Aggregate(calls);
  // legacy items（v1 前端兼容：现页面继续可用；W2 切到 entries/totals）
  var items = [];
  for (var e = 0; e < agg.entries.length; e++) {
    var en = agg.entries[e];
    var toolsSeen = {}, order = [];
    for (var oi = 0; oi < en.ops.length; oi++) {
      var tn = en.ops[oi].tool;
      if (!toolsSeen[tn]) { toolsSeen[tn] = 1; order.push(tn); }
    }
    items.push({ path: en.path, reads: en.reads + en.searches, writes: en.writes, count: en.reads + en.searches + en.writes, tools: order.join(' · ') });
  }
  items.sort(function (a, b) { return b.count - a.count; });
  return { entries: agg.entries, totals: agg.totals, stats: stats, userIdx: userIdx, legacyItems: items.slice(0, 60) };
}
/**
 * W3 定位联动：锚点下标 → 含锚点的页参数（纯函数，供 apiRawSection 与离线自检共用）。
 * revIdxs = 倒序（最新在前）的 idx 数组；lim = 页大小。
 * 返回 null = 未传 focus；{miss:true, idx} = 未命中；{offset, pos, idx} = 命中页起点。
 */
function fa2FocusPage(revIdxs, focusIdx, lim) {
  var fo = (focusIdx === undefined || focusIdx === null || focusIdx === "") ? -1 : parseInt(String(focusIdx), 10);
  if (fo < 0) return null;
  for (var q = 0; q < revIdxs.length; q++) {
    if (revIdxs[q] === fo) return { offset: Math.floor(q / lim) * lim, pos: q, idx: fo };
  }
  return { miss: true, idx: fo };
}
// ==== FILE_ACTIVITY_V2 END ====
// ==== W7_BRIEF BEGIN（步 brief：请求点→本轮/输入/回复锚点；W9① 起由 apiStepBrief 单步现算，纯函数、供对拍脚本共用）====
/** hist 下标 → kind（大写；越界='(EOF)'） */
function w7KindAt(hist, x) {
  return (x >= 0 && x < hist.length) ? String((hist[x] && (hist[x].kind || hist[x].role)) || "").toUpperCase() : "(EOF)";
}
/** 预览清洗：去 attachment 整块/未闭合块与其余标签 → 压缩空白 → ≤48 码点 */
function w7Preview(s) {
  var t = String(s == null ? "" : s);
  t = t.replace(/<attachment[\s\S]*?<\/attachment>/g, " ");
  t = t.replace(/<attachment[\s\S]*$/, " ");
  t = t.replace(/<[^>]*>/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  if (t.length > 200) t = t.slice(0, 200);
  var a = typeof Array.from === "function" ? Array.from(t) : t.split("");
  return a.slice(0, 48).join("");
}
/** 请求点扫描：与 apiSteps 主扫描同判定（USER / 连续 TOOL_RESULT 段末） */
function w7PointIdxs(hist) {
  var ids = [];
  for (var x = 0; x < hist.length; x++) {
    var k = w7KindAt(hist, x);
    if (k === "USER") ids.push(x);
    else if (k === "TOOL_RESULT" && w7KindAt(hist, x + 1) !== "TOOL_RESULT") ids.push(x);
  }
  return ids;
}
/** W9①：步 brief 单步现算（apiStepBrief 按需调用；与旧全量 w7BriefOf 第 s 项逐字节一致）。
 * hist=preparedHistory；pIdxs=请求点下标；s=步序号（0 起）。返回 {pIdx, openerIdx, op, ins, res}。
 * 口径（与旧版同源；2026-09-17 全库 51 raw / 1934 步对拍零差异）：
 *   opener = pIdxs 中 ≤s 的最近 USER；
 *   prevTail = 上一步产出块尾（P_prev+1 起连续 ASSISTANT/TOOL_CALL 的末位；空块 = P_prev）；
 *   ins = (prevTail, P] 的余条目（轮首 / 首步恒空）；res = P+1 起连续 ASSISTANT/TOOL_CALL。 */
function w7BriefOne(hist, pIdxs, s) {
  if (!(s >= 0) || s >= pIdxs.length) return null;
  var P = pIdxs[s];
  var kP = w7KindAt(hist, P);
  // opener：pIdxs 中 ≤s 的最近 USER（同一 pIdxs 上下文内自洽，截尾场景与旧版一致）
  var openerIdx = null;
  for (var q = s; q >= 0; q--) {
    if (w7KindAt(hist, pIdxs[q]) === "USER") { openerIdx = pIdxs[q]; break; }
  }
  var op = null;
  if (openerIdx !== null && hist[openerIdx]) {
    op = [openerIdx, w7Preview(fa2Unesc(String(hist[openerIdx].content || "").slice(0, 6000)))];
  }
  // 产出块：P+1 起连续 ASSISTANT/TOOL_CALL
  var resp = [];
  var x = P + 1;
  while (x < hist.length) {
    var k = w7KindAt(hist, x);
    if (k !== "ASSISTANT" && k !== "TOOL_CALL") break;
    var c = String((hist[x] && hist[x].content) || "");
    if (k === "ASSISTANT") {
      resp.push([x, /^\s*<think[\s>]/.test(c) ? "思考" : "回复", w7Preview(fa2Unesc(c.slice(0, 6000))), "A"]);
    } else {
      var h = c.match(/<tool(?:_[A-Za-z0-9]+)?\s+name="([^"]+)"/);
      var tn = h ? h[1] : "";
      if (tn === "package_proxy") {
        var p2 = c.match(/<param name="tool_name">([^<]+)<\/param>/);
        if (p2) tn = p2[1].trim();
      }
      resp.push([x, tn ? fa2ToolTail(tn) : "调用", w7Preview(fa2Unesc(c.slice(0, 6000))), "T"]);
    }
    x++;
  }
  // 上一步产出块尾（仅 s>0 用；与旧版 prevTail 更新口径一致）
  var prevTail = -1;
  if (s > 0) {
    var Pprev = pIdxs[s - 1];
    var yEnd = Pprev + 1;
    while (yEnd < hist.length) {
      var k2 = w7KindAt(hist, yEnd);
      if (k2 !== "ASSISTANT" && k2 !== "TOOL_CALL") break;
      yEnd++;
    }
    prevTail = (yEnd > Pprev + 1) ? (yEnd - 1) : Pprev;
  }
  // 输入段：(prevTail, P]；轮首或首步恒空
  var ins = [];
  if (s > 0 && kP !== "USER") {
    for (var y = prevTail + 1; y <= P && y < hist.length; y++) {
      var cy = String((hist[y] && hist[y].content) || "");
      var ky = w7KindAt(hist, y);
      var mh = cy.match(/<tool_result(?:_[A-Za-z0-9]+)?\s+name="([^"]+)"(?:\s+status="([^"]+)")?/);
      var tag = mh ? fa2ToolTail(mh[1]) : (ky === "TOOL_RESULT" ? "结果" : ky.toLowerCase());
      var err = ((mh && mh[2] === "error") || /^<tool_result(?:_[A-Za-z0-9]+)?[^>]*>\s*<content>\s*<error>/.test(cy)) ? 1 : 0;
      ins.push([y, tag, w7Preview(fa2Unesc(cy.slice(0, 6000))), err]);
    }
  }
  return { pIdx: P, openerIdx: openerIdx, op: op, ins: ins, res: resp };
}
// ==== W7_BRIEF END ====

/** 文件活动：从 raw 的 TOOL_CALL / TOOL_RESULT 解析文件操作记录（v2：op 级 + 配对 + 聚合；零新增写入） */
/** 文件打开：宿主 Files.open（系统默认应用打开）。
 *  o2.17（2026-10-21）：Operit2 2.0 的 Tools.Files.open 有宿主侧 bug——
 *  内部 JSON 反序列化要求 isDirectory 字段，但实际返回里没有，任何路径都抛
 *  "JSONException: No value for isDirectory"（exists 正常，open 必炸，两种文件都复现）。
 *  所以这里做成两级：
 *    ① 先试 Files.open —— 宿主哪天修好就自动恢复原生体验
 *    ② 失败则回落到**面板内预览**（read 出文本前 N 行），至少让用户能看内容
 *  预览内容随返回值外带，前端负责弹层展示。 */
async function apiOpenPath(pathIn) {
  var p = typeof pathIn === "string" ? pathIn.trim() : "";
  if (!p) return { ok: false, error: "empty path" };
  if (p.length > 512) return { ok: false, error: "path too long" };
  for (var ci = 0; ci < p.length; ci++) {
    var cc = p.charCodeAt(ci);
    if (cc < 32 || cc === 127) return { ok: false, error: "invalid path chars" };
  }
  var P = { p: p };
  try { P.tOpen = typeof (Tools && Tools.Files && Tools.Files.open); } catch (e0) { P.tOpen = "ex0"; }

  // ① 原生打开
  var r = null;
  try {
    r = await Tools.Files.open(p);
    P.t1 = "ok";
  } catch (e1) {
    P.t1 = "ex:" + String(e1 && e1.message ? e1.message : e1);
  }
  if (r !== null && r !== undefined && !(r && r.successful === false)) {
    return { ok: true, mode: "system", path: p, details: (r && r.details) || "", probe: P };
  }

  // ② 回落：面板内预览
  try {
    var content = await Tools.Files.read(p);
    var text = _readStr(content);
    var isBinary = false;
    // 简单二进制判定：含 NUL 或大量控制字符
    var probeLen = Math.min(text.length, 2000);
    var ctrl = 0;
    for (var bi = 0; bi < probeLen; bi++) {
      var c = text.charCodeAt(bi);
      if (c === 0) { isBinary = true; break; }
      if (c < 9 || (c > 13 && c < 32)) ctrl++;
    }
    if (!isBinary && probeLen > 0 && ctrl / probeLen > 0.1) isBinary = true;

    if (isBinary) {
      return {
        ok: false, mode: "preview", path: p, probe: P,
        error: "系统打开失败（宿主 Files.open bug），且该文件为二进制，无法在面板内预览"
      };
    }
    var LIMIT = 200000;              // 预览上限，防止超大文件把桥打爆
    var truncated = text.length > LIMIT;
    return {
      ok: true, mode: "preview", path: p,
      size: text.length, truncated: truncated,
      text: truncated ? text.slice(0, LIMIT) : text,
      note: "系统打开不可用（宿主 Files.open bug），已改为面板内预览" + (truncated ? "（已截断）" : ""),
      probe: P
    };
  } catch (e2) {
    return {
      ok: false, path: p, probe: P,
      error: "打开失败：" + P.t1 + "；读取也失败：" + String(e2 && e2.message ? e2.message : e2)
    };
  }
}
async function apiFileActivity(keyIn) {
  var key = keyIn || await latestKey();
  var payload = await loadRaw(key);
  if (!payload) return rawFail(key);
  var hist = Array.isArray(payload.preparedHistory) ? payload.preparedHistory : [];
  var act = fa2Compute(hist);
  return { ok: true, total: act.entries.length, items: act.legacyItems, entries: act.entries, totals: act.totals, stats: act.stats, userIdx: act.userIdx };
}


/** 工具使用统计：从 raw 的 TOOL_CALL 聚合各工具调用次数（零新增写入） */
/** W7② 会话计费累计：全库 chatmsg 里当前会话「完成态消息」的求和（in/out/cached）。
 * 口径=计费（消息级合计含多轮工具往返；与「上下文大小」用途严格区分）；
 * 跨天安全：读全部 chatmsg-*.jsonl（按天滚动，量级 x百 KB）。 */
async function apiSessionUsage(keyIn) {
  var key = keyIn || await latestKey();
  if (!key) return { ok: false, error: "no key" };
  var names = await listChatmsgFiles(90);
  var sum = { rows: 0, input: 0, output: 0, cached: 0, first: 0, last: 0 };
  for (var i = 0; i < names.length; i++) {
    var t = await readText(PV_DIR + "/" + names[i]);
    if (!t) continue;
    var lines = t.split("\n");
    for (var j = 0; j < lines.length; j++) {
      var ln = lines[j];
      if (!ln || !ln.trim()) continue;
      var o = null;
      try { o = JSON.parse(ln); } catch (e2) { continue; }
      if (!o || o.session !== key || o.done !== true) continue;
      sum.rows += 1;
      sum.input += Number(o.inputTokens) || 0;
      sum.output += Number(o.outputTokens) || 0;
      sum.cached += Number(o.cachedInputTokens) || 0;
      var s = Number(o.sentAt) || 0;
      if (s > 0) { if (!sum.first || s < sum.first) sum.first = s; if (s > sum.last) sum.last = s; }
    }
  }
  return { ok: true, session: key, rows: sum.rows, input: sum.input, output: sum.output, cached: sum.cached, first: sum.first, last: sum.last };
}

// ==== OVERVIEW_V1 BEGIN（P4-5A 2026-11-23；纯函数段：node 自检脚本按标记提取，勿在段内用宿主 API）====
// 洞察页数据层：跨会话总览（KPI / 7 天双柱 / 8 周热力图 / 会话卡）。
//
// 性能红线（不可退让）：本段只吃「index.json 条目」和「chatmsg-*.jsonl 行」，
// **永不读 raw_<key>.json**——raw 单份 30KB~900KB，扫一遍就是秒级卡顿（见 GAP.md 4.1）。
// 因此 composition（会话构成圆环）故意不在此计算：它必须读该会话 raw，留给后续按卡懒加载接口。
//
// 口径（与既有 apiSessionUsage / apiTodayMessages 对齐，勿各算各的）：
//   · 行过滤：done === true 且带 session（半写行、未完成行都不计）
//   · 计费时间：sentAt（请求发出时间）优先；sentAt=0 的行是同一轮的续写/工具往返，
//     用 completedAt / atMs 兜底 —— 否则这些行的 token 会整体丢失
//   · tokens：inputTokens + outputTokens（cachedInputTokens 是 input 的子集，单独出，不重复计）
//   · turns：同一会话内「不重复的 sentAt>0」个数 = 用户发起的新轮次；sentAt=0 不增轮次
//   · 日期：本地时区（chatmsg 文件按本地日期滚动，用 UTC 会错日）
var OV_HEAT_DAYS = 56;   // 热力图窗口：8 周
var OV_CHAT_FILES = 14;  // chatmsg 最多读 14 个按天文件（与采集层 RETAIN_LOG_DAYS 同量级）

/** 本地日期 key（YYYY-MM-DD） */
function ovDayKey(ms) {
  var d = new Date(ms);
  var mo = d.getMonth() + 1;
  var dd = d.getDate();
  return d.getFullYear() + "-" + (mo < 10 ? "0" : "") + mo + "-" + (dd < 10 ? "0" : "") + dd;
}
/** 本地当天 00:00 的毫秒时间戳 */
function ovDayStart(ms) {
  var d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
/** 以 nowMs 当天为最后一天，回溯 n 天；升序返回（最旧 → 今天）。
 *  用 setDate 做日期加减，不用 -86400000，避免夏令时错位。 */
function ovDayList(nowMs, n) {
  var base = new Date(ovDayStart(nowMs));
  var out = [];
  for (var i = n - 1; i >= 0; i--) {
    var d = new Date(base.getTime());
    d.setDate(d.getDate() - i);
    out.push({ date: ovDayKey(d.getTime()), ms: d.getTime() });
  }
  return out;
}
function ovNum(v) {
  var n = Number(v);
  return isFinite(n) ? n : 0;
}
/** 计费时间锚点：sentAt > completedAt > atMs（见上方口径注释） */
function ovRowTime(row) {
  var s = ovNum(row.sentAt);
  if (s > 0) return s;
  var c = ovNum(row.completedAt);
  if (c > 0) return c;
  return ovNum(row.atMs);
}
function ovBucket() {
  return { in: 0, out: 0, cached: 0, msgs: 0, turns: 0, activeMs: 0 };
}
/** 跨会话聚合（纯函数，无 IO）。
 *  rows      chatmsg 行对象数组（原样传入，过滤在本函数内做）
 *  indexArr  index.json 数组（会话清单 / 热力图 sessions 指标来源）
 *  range     "today" | "7d"：只影响 KPI 与会话卡数字；days 恒定 7 天、heat 恒定 56 天
 *  nowMs     当前时间（注入以便自检）
 *  chatFiles 实际读到的 chatmsg 文件数（coverage 用）
 */
function ovBuild(rows, indexArr, range, nowMs, chatFiles) {
  var isToday = range === "today";
  var rangeDays = ovDayList(nowMs, isToday ? 1 : 7);
  var rangeSet = {};
  for (var r0 = 0; r0 < rangeDays.length; r0++) rangeSet[rangeDays[r0].date] = 1;
  var heatDays = ovDayList(nowMs, OV_HEAT_DAYS);
  var heatSet = {};
  for (var h0 = 0; h0 < heatDays.length; h0++) heatSet[heatDays[h0].date] = 1;

  var byDay = {};       // date -> bucket（只装窗口内日期）
  var daySess = {};     // date -> {key:1}：该日有消息的会话（chatmsg 口径）
  var bySess = {};      // key -> { days:{date:bucket}, lastMs, chatId }
  var turnSeen = {};    // key|sentAt -> 1：同一请求多行只算一轮
  var modelsRange = {}; // model -> bucket：只统计 range 窗口内（供前端按价格表估成本）
  var used = 0;
  var skipped = 0;
  var firstMs = 0;
  var lastMs = 0;

  for (var i = 0; i < (rows ? rows.length : 0); i++) {
    var row = rows[i];
    if (!row || row.done !== true || !row.session) { skipped++; continue; }
    var ts = ovRowTime(row);
    if (!(ts > 0)) { skipped++; continue; }
    var date = ovDayKey(ts);
    if (!heatSet[date]) { skipped++; continue; } // 超出 8 周窗口（保留期仅 14 天，正常不会命中）
    var key = String(row.session);
    var inTok = ovNum(row.inputTokens);
    var outTok = ovNum(row.outputTokens);
    var cached = ovNum(row.cachedInputTokens);
    if (cached > inTok) cached = inTok; // 防御脏数据：cached 不可能大于 input
    var active = ovNum(row.waitMs) + ovNum(row.outMs);

    var d = byDay[date];
    if (!d) { d = ovBucket(); byDay[date] = d; }
    d.in += inTok; d.out += outTok; d.cached += cached; d.msgs += 1; d.activeMs += active;
    if (!daySess[date]) daySess[date] = {};
    daySess[date][key] = 1;

    var s = bySess[key];
    if (!s) { s = { days: {}, lastMs: 0, chatId: "" }; bySess[key] = s; }
    if (!s.chatId) s.chatId = String(row.chatId || "");
    var sd = s.days[date];
    if (!sd) { sd = ovBucket(); s.days[date] = sd; }
    sd.in += inTok; sd.out += outTok; sd.cached += cached; sd.msgs += 1; sd.activeMs += active;
    if (ts > s.lastMs) s.lastMs = ts;

    // 轮次：只有带 sentAt 的行代表一次新请求；同 sentAt 多行（流式/多段落盘）合并成 1 轮
    var sentAt = ovNum(row.sentAt);
    if (sentAt > 0) {
      var tk = key + "|" + sentAt;
      if (!turnSeen[tk]) {
        turnSeen[tk] = 1;
        d.turns += 1;
        sd.turns += 1;
      }
    }
    var mn = String(row.modelName || "");
    if (mn && rangeSet[date]) {
      var mb = modelsRange[mn];
      if (!mb) { mb = ovBucket(); modelsRange[mn] = mb; }
      mb.in += inTok; mb.out += outTok; mb.cached += cached; mb.msgs += 1;
    }
    used++;
    if (!firstMs || ts < firstMs) firstMs = ts;
    if (ts > lastMs) lastMs = ts;
  }

  // ---- index.json：会话清单 + 热力图 sessions 指标（capturedAtMs，能覆盖 8 周；chatmsg 只有 14 天）----
  var idxList = [];
  var idxByDay = {}; // date -> {key:1}：该日有 raw 快照的会话
  for (var j = 0; j < (indexArr ? indexArr.length : 0); j++) {
    var e = indexArr[j];
    if (!e || !e.key) continue;
    var ek = String(e.key);
    idxList.push(e);
    var cap = ovNum(e.capturedAtMs);
    if (cap > 0) {
      var cd = ovDayKey(cap);
      if (heatSet[cd]) {
        if (!idxByDay[cd]) idxByDay[cd] = {};
        idxByDay[cd][ek] = 1;
      }
    }
  }

  // ---- KPI（range 窗口）----
  var kpi = { sessions: 0, turns: 0, billedTokens: 0, inTok: 0, outTok: 0, cachedTok: 0, msgs: 0, activeMs: 0, cacheHit: 0, cost: 0 };
  var sessKeys = Object.keys(bySess);
  for (var k1 = 0; k1 < sessKeys.length; k1++) {
    var ent = bySess[sessKeys[k1]];
    var dk = Object.keys(ent.days);
    var hit = false;
    for (var q1 = 0; q1 < dk.length; q1++) {
      if (!rangeSet[dk[q1]]) continue;
      var b1 = ent.days[dk[q1]];
      kpi.inTok += b1.in; kpi.outTok += b1.out; kpi.cachedTok += b1.cached;
      kpi.msgs += b1.msgs; kpi.turns += b1.turns; kpi.activeMs += b1.activeMs;
      hit = true;
    }
    if (hit) kpi.sessions += 1;
  }
  kpi.billedTokens = kpi.inTok + kpi.outTok;
  kpi.cacheHit = kpi.inTok > 0 ? (kpi.cachedTok / kpi.inTok) : 0; // 0..1 比例（前端 ×100 显示）

  // ---- 7 天双柱（恒定 7 天，缺日补 0；range 只影响 KPI 与会话卡，不影响这条日序列）----
  var seven = ovDayList(nowMs, 7);
  var days7 = [];
  for (var d1 = 0; d1 < seven.length; d1++) {
    days7.push(ovDayOut(seven[d1].date, byDay[seven[d1].date]));
  }

  // ---- 8 周热力图（56 天，升序，缺日补 0）----
  var heat = [];
  for (var h1 = 0; h1 < heatDays.length; h1++) {
    var hd = heatDays[h1].date;
    var hb = byDay[hd] || null;
    heat.push({
      date: hd,
      tokens: hb ? (hb.in + hb.out) : 0,
      sessions: idxByDay[hd] ? Object.keys(idxByDay[hd]).length : 0, // index 快照口径（8 周可覆盖）
      activeSessions: daySess[hd] ? Object.keys(daySess[hd]).length : 0, // chatmsg 口径（仅 14 天）
      turns: hb ? hb.turns : 0
    });
  }

  // ---- 会话卡列表（index 为骨架，按最近活动降序）----
  var sessions = [];
  var seenKeys = {};
  for (var k2 = 0; k2 < idxList.length; k2++) {
    var ie = idxList[k2];
    var ik = String(ie.key);
    seenKeys[ik] = 1;
    sessions.push(ovSessOut(ik, ie, bySess[ik], rangeSet));
  }
  // chatmsg 里出现、但已滚出 index 环（100 条）的会话：补进来，否则 KPI 会话数与列表对不上
  for (var k3 = 0; k3 < sessKeys.length; k3++) {
    if (seenKeys[sessKeys[k3]]) continue;
    sessions.push(ovSessOut(sessKeys[k3], null, bySess[sessKeys[k3]], rangeSet));
  }
  sessions.sort(function (a, b) { return (b.lastActiveMs || 0) - (a.lastActiveMs || 0); });

  // ---- 分模型（range 窗口，供前端价格表估成本）----
  var models = [];
  for (var mk in modelsRange) {
    var mv = modelsRange[mk];
    models.push({ model: mk, tokens: mv.in + mv.out, inTok: mv.in, outTok: mv.out, cachedTok: mv.cached, msgs: mv.msgs });
  }
  models.sort(function (a, b) { return b.tokens - a.tokens; });

  return {
    ok: true,
    range: isToday ? "today" : "7d",
    kpi: kpi,
    days: days7,
    heat: heat,
    sessions: sessions,
    models: models,
    // cost 恒为 0：桥层没有价格表（价格表在前端 localStorage 'dsh-prices-v2'）。
    // 前端用 tokens / 分模型明细自行换算；costReady=false 可用来禁用成本柱/成本格。
    costReady: false,
    coverage: {
      since: heatDays[0].ms,
      until: nowMs,
      rawSessions: idxList.length,
      chatDays: chatFiles || 0,
      chatRows: used,
      skippedRows: skipped,
      firstMsgMs: firstMs,
      lastMsgMs: lastMs,
      heatDays: OV_HEAT_DAYS
    }
  };
}
function ovDayOut(date, b) {
  return {
    date: date,
    tokens: b ? (b.in + b.out) : 0,
    inTok: b ? b.in : 0,
    outTok: b ? b.out : 0,
    cachedTok: b ? b.cached : 0,
    turns: b ? b.turns : 0,
    msgs: b ? b.msgs : 0,
    cost: 0
  };
}
function ovSessOut(key, ie, agg, rangeSet) {
  var t = ovBucket();
  var active = false;
  if (agg) {
    var dk = Object.keys(agg.days);
    for (var i = 0; i < dk.length; i++) {
      if (!rangeSet[dk[i]]) continue;
      var b = agg.days[dk[i]];
      t.in += b.in; t.out += b.out; t.cached += b.cached;
      t.msgs += b.msgs; t.turns += b.turns; t.activeMs += b.activeMs;
      active = true;
    }
  }
  var cap = ie ? ovNum(ie.capturedAtMs) : 0;
  return {
    key: key,
    chatId: String((ie && ie.chatId) || (agg && agg.chatId) || ""),
    preview: String((ie && ie.preview) || ""),
    capturedAtMs: cap,
    lastActiveMs: agg && agg.lastMs ? agg.lastMs : cap,
    tokens: t.in + t.out,
    inTok: t.in,
    outTok: t.out,
    cachedTok: t.cached,
    turns: t.turns,
    msgs: t.msgs,
    activeMs: t.activeMs,
    chars: ie ? ovNum(ie.chars) : 0,
    lines: ie ? ovNum(ie.lines) : 0,
    indexed: !!ie,
    active: active, // range 窗口内是否有活动（前端可按此过滤空卡）
    cost: 0
    // composition：需要读 raw_<key>.json（每份几十~几百 KB）→ 违反性能红线，故意不提供；
    // 前端拿不到该字段就不画构成圆环（契约里它是可选的）。
  };
}
// ==== OVERVIEW_V1 END ====

// chatmsg 行缓存（洞察页专用，按文件名）。
// 为什么安全：chatmsg 文件名就是追加当天的本地日期（新一轮消息只会写进「今天」那个文件），
// 历史文件写死后不再变；所以**只缓存非最新文件**，最新那份（names[0]）每次重读，
// 保证刚发生的消息一定进统计。给 range 切换 / 手动刷新省掉「重读 + 重解析 14 个文件」。
// 上限 = OV_CHAT_FILES 个文件，按插入顺序淘汰；读失败的文件不缓存（下次自动重试）。
var ovRowCache = {};
function ovCacheGet(name) {
  return Object.prototype.hasOwnProperty.call(ovRowCache, name) ? ovRowCache[name] : null;
}
function ovCachePut(name, list) {
  if (Object.prototype.hasOwnProperty.call(ovRowCache, name)) { ovRowCache[name] = list; return; }
  var keys = Object.keys(ovRowCache);
  if (keys.length >= OV_CHAT_FILES) delete ovRowCache[keys[0]];
  ovRowCache[name] = list;
}

/** P4-5A：洞察页数据层入口（跨会话总览）。
 *  IO 只有两处：index.json（≤100 条，KB 级）+ 最近 OV_CHAT_FILES 个 chatmsg-*.jsonl，**不碰 raw**。
 *  历史 chatmsg 文件走 ovRowCache；只有最新那份每次重读（当天还在追加）。
 *  返回里带 ms（端到端计时）、coverage.chatRows（纳入统计行数）、coverage.cachedFiles（命中缓存的文件数），便于回归自检。 */
async function apiOverview(rangeIn, filesIn) {
  var t0 = Date.now();
  var range = String(rangeIn || "7d") === "today" ? "today" : "7d";
  var maxFiles = Math.floor(ovNum(filesIn));
  if (!(maxFiles > 0)) maxFiles = OV_CHAT_FILES;
  if (maxFiles > OV_CHAT_FILES) maxFiles = OV_CHAT_FILES; // 硬上限：不许为了「更全」去多读

  // ① index.json：会话清单 + 热力图 sessions 指标
  var indexArr = [];
  var tIdx = await readText(PV_DIR + "/index.json");
  if (tIdx) {
    try {
      var parsed = JSON.parse(stripNl(tIdx));
      if (parsed && Array.isArray(parsed)) indexArr = parsed;
    } catch (e1) { /* 索引坏了按空列表继续，不抛 */ }
  }

  // ② chatmsg-*.jsonl：按天文件一次遍历成行数组（最多 14 个）
  var names = await listChatmsgFiles(maxFiles);
  var rows = [];
  var chatDays = 0;
  var cachedFiles = 0;
  for (var f = 0; f < names.length; f++) {
    var nm = names[f];
    var hitRows = f === 0 ? null : ovCacheGet(nm); // 最新文件不缓存：当天还会被追加
    if (hitRows) {
      chatDays++;
      cachedFiles++;
      for (var ci = 0; ci < hitRows.length; ci++) rows.push(hitRows[ci]);
      continue;
    }
    var txt = await readText(PV_DIR + "/" + nm);
    if (!txt) continue; // 读失败：不缓存，下次重试
    chatDays++;
    var fileRows = [];
    var lines = txt.split("\n");
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (!ln || !ln.trim()) continue;
      try { fileRows.push(JSON.parse(ln)); } catch (e2) { /* 半写行：跳过 */ }
    }
    if (f > 0) ovCachePut(nm, fileRows);
    for (var pi = 0; pi < fileRows.length; pi++) rows.push(fileRows[pi]);
  }

  var out = ovBuild(rows, indexArr, range, Date.now(), chatDays);
  out.coverage.cachedFiles = cachedFiles;
  out.ms = Date.now() - t0; // 计时自检（宿主 api 日志里还有一份 method/ms）
  return out;
}

async function apiToolUsage(keyIn) {
  var key = keyIn || await latestKey();
  var payload = await loadRaw(key);
  if (!payload) return rawFail(key);
  var hist = Array.isArray(payload.preparedHistory) ? payload.preparedHistory : [];
  var counts = {};
  for (var i = 0; i < hist.length; i++) {
    var it = hist[i] || {};
    if (String(it.kind || "").toUpperCase() !== "TOOL_CALL") continue;
    var c = String(it.content || "");
    var nm = c.match(/name="([^"]+)"/);
    if (!nm) continue;
    counts[nm[1]] = (counts[nm[1]] || 0) + 1;
  }
  var out = [];
  for (var k in counts) out.push({ name: k, count: counts[k] });
  out.sort(function (a, b) { return b.count - a.count; });
  return { ok: true, total: out.length, items: out.slice(0, 50) };
}

async function apiMessages(keyIn) {
  var key = keyIn || await latestKey();
  var msgs = await readJsonl("chatmsg-", 3);
  var seen = {};
  var out = [];
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    if (!key || m.session === key) {
      if (!m.done) continue;
      var sk = String(m.sentAt);
      if (seen[sk]) continue;
      seen[sk] = 1;
      out.push({
        t: m.completedAt || m.atMs,
        sentAt: m.sentAt,
        input: m.inputTokens || 0,
        output: m.outputTokens || 0,
        cached: m.cachedInputTokens || 0,
        waitMs: m.waitMs || 0,
        outMs: m.outMs || 0,
        roleName: m.roleName || "",
        model: m.modelName || ""
      });
    }
  }
  out.sort(function (a, b) { return (a.sentAt || 0) - (b.sentAt || 0); });
  return { ok: true, items: out };
}

/** 浏览器下钻：按分类取内容（system/worldbook 全文；tools/消息类列表分页） */
async function apiRawSection(keyIn, section, offset, limit, focusIdx) {
  var key = keyIn || await latestKey();
  var payload = await loadRaw(key);
  if (!payload) return rawFail(key);
  var hist = Array.isArray(payload.preparedHistory) ? payload.preparedHistory : [];
  var sec = String(section || "history");
  if (sec === "inject") sec = "worldbook"; // 兼容前端分类 key：inject = 世界书
  var off = offset || 0;
  var lim = limit || 30;

  if (sec === "summary") {
    var sumText = "";
    for (var si = 0; si < hist.length; si++) {
      if (String(hist[si].kind || "").toUpperCase() === "SUMMARY") { sumText = String(hist[si].content || ""); break; }
    }
    return { ok: true, kind: "text", total: sumText ? 1 : 0, chars: sumText.length, content: sumText };
  }

  if (sec === "system" || sec === "worldbook" || sec === "skill" || sec === "profile") {
    var sysText = "";
    for (var i = 0; i < hist.length; i++) {
      if (String(hist[i].kind || "").toUpperCase() === "SYSTEM") { sysText = String(hist[i].content || ""); break; }
    }
    var wb = extractWorldbook(sysText);
    var sk = extractSkillPack(sysText);
    var up = extractUserProfile(sysText);
    if (sec === "worldbook") {
      return { ok: true, kind: "text", total: wb.entries, chars: wb.chars, names: wb.names, content: (wb.blockTexts || []).join("\n\n") };
    }
    if (sec === "skill") {
      return { ok: true, kind: "text", total: sk.chars > 0 ? 1 : 0, chars: sk.chars, content: sk.text };
    }
    if (sec === "profile") {
      return { ok: true, kind: "text", total: up.chars > 0 ? 1 : 0, chars: up.chars, content: up.text };
    }
    var rest = sysText;
    var bt = wb.blockTexts || [];
    for (var j = 0; j < bt.length; j++) { rest = rest.split(bt[j]).join(""); }
    if (sk.text) rest = rest.split(sk.text).join("");
    if (up.text) rest = rest.split(up.text).join("");
    return { ok: true, kind: "text", total: 1, chars: rest.length, content: rest };
  }

  if (sec === "tools") {
    var tools = Array.isArray(payload.availableTools) ? payload.availableTools : [];
    var tItems = [];
    for (var t = 0; t < tools.length; t++) {
      var tool = tools[t] || {};
      var tChars = 0;
      try { tChars = JSON.stringify(tool).length; } catch (e1) {}
      tItems.push({ idx: "tool:" + t, name: String(tool.name || "?"), preview: String(tool.description || "").slice(0, 160), chars: tChars });
    }
    return { ok: true, kind: "list", total: tItems.length, items: tItems.slice(off, off + lim) };
  }

  var picked = [];
  for (var m = 0; m < hist.length; m++) {
    var it = hist[m] || {};
    var k = String(it.kind || "OTHER").toUpperCase();
    if (sec === "user" && k !== "USER") continue;
    if (sec === "assistant" && k !== "ASSISTANT") continue;
    if (sec === "tool" && k !== "TOOL_CALL" && k !== "TOOL_RESULT") continue;
    if (sec !== "history" && sec !== "user" && sec !== "assistant" && sec !== "tool") continue;
    var content = String(it.content || "");
    picked.push({ idx: m, kind: k, toolName: String(it.toolName || ""), chars: content.length, preview: content.replace(/\s+/g, " ").slice(0, 180) });
  }
  var total = picked.length;
  var rev = picked.slice().reverse();
  // W3 focus：锚点（preparedHistory 下标）→ 含锚点的页一页直达；未命中回 focusMiss
  var fr = fa2FocusPage(rev.map(function (x) { return x.idx; }), focusIdx, lim);
  if (fr !== null) {
    if (fr.miss) return { ok: true, kind: "list", total: total, items: [], focusMiss: true, focusIdx: fr.idx };
    return { ok: true, kind: "list", total: total, offset: fr.offset, items: rev.slice(fr.offset, fr.offset + lim), focusIdx: fr.idx };
  }
  return { ok: true, kind: "list", total: total, offset: off, items: rev.slice(off, off + lim) };
}

/** 浏览器下钻：按原始 index 取单条全文 */
async function apiRawItem(keyIn, index) {
  var key = keyIn || await latestKey();
  var payload = await loadRaw(key);
  if (!payload) return rawFail(key);
  // 工具条目：index 形如 "tool:3"，从 availableTools 取并格式化为 JSON 文本
  var idxStr = String(index);
  if (idxStr.indexOf("tool:") === 0) {
    var tools = Array.isArray(payload.availableTools) ? payload.availableTools : [];
    var tool = tools[parseInt(idxStr.slice(5), 10)];
    if (!tool) return { ok: false, error: "工具索引越界" };
    var txt = "";
    try { txt = JSON.stringify(tool, null, 2); } catch (eT) { txt = String(tool); }
    return { ok: true, kind: "TOOL", toolName: String(tool.name || ""), content: txt };
  }
  var hist = Array.isArray(payload.preparedHistory) ? payload.preparedHistory : [];
  var it = hist[index];
  if (!it) return { ok: false, error: "index 越界" };
  return { ok: true, kind: String(it.kind || ""), toolName: String(it.toolName || ""), content: String(it.content || "") };
}

function Screen(ctx) {
  UI_CTX = ctx; // 数据层用 ctx.callTool 通道
  var UI = ctx.UI;
  var controller = ctx.createWebViewController("dashboard_webview");
  // 预览态：宿主 Files.open 不可用时的兜底展示（o2.17）
  var previewState = ctx.useState("preview", null);
  var preview = previewState[0];
  var setPreview = previewState[1];

  function hostLog(obj) {
    try {
      var line = JSON.stringify(obj) + "\n";
      try { Tools.Files.mkdir("/sdcard/Download/Operit/prompt_viewer", true); } catch (e0) {}
      Tools.Files.write(bridgeLogPath(), line, true);
    } catch (e) { /* ignore */ }
  }

  function initBridge() {
    controller.addJavascriptInterface("CtxProbe", {
      report: async function (payload) {
        hostLog({ dir: "page->host", at: nowIso(), payload: String(payload || "") });
        return JSON.stringify({ ok: true, at: nowIso() });
      },
      ping: function () {
        return JSON.stringify({ from: "host", at: nowIso(), pkg: "com.operit.prompt_viewer_ui" });
      },
      api: async function (payloadJson) {
        // 单参数协议（Android 桥接多参数会被合并）：{"m":"summary"}
        var t0 = Date.now();
        var method = "";
        try {
          var req = JSON.parse(String(payloadJson || "{}"));
          method = String(req.m || "");
          // overview 是跨会话总览，不依赖「当前会话 key」：跳过 latestKey（免得白付一次 getChatId / list_chats 解析）
          var key = method === "overview" ? "" : await latestKey();
          if (key && LAST_KEY && key !== LAST_KEY) {
            rawCache = { key: "", at: 0, data: null }; // 切会话：丢上一会话的内存缓存
          }
          if (key) LAST_KEY = key;
          var out;
          if (method === "summary") out = await apiSummary(key);
          else if (method === "stats") out = await apiStats(key);
          else if (method === "timeline") out = await apiTimeline(key);
          else if (method === "steps") out = await apiSteps(key);
          else if (method === "stepBrief") out = await apiStepBrief(key, req.pIdx);
          else if (method === "events") out = await apiEvents(key);
          else if (method === "milestones") out = await apiMilestones(key);
          else if (method === "fileActivity") out = await apiFileActivity(key);
          else if (method === "openPath") {
            out = await apiOpenPath(req.path);
            // 回落预览：把内容交给 Compose 层弹窗（前端 bundle 没有预览能力，只能宿主侧做）
            try {
              if (out && out.mode === "preview" && out.ok && out.text) {
                // 按行切分给 LazyColumn（只有它能滚动）。行数封顶，防止超大文件把渲染拖死。
                var MAX_LINES = 5000;
                var rawLines = String(out.text).split("\n");
                var cut = rawLines.length > MAX_LINES;
                var useLines = cut ? rawLines.slice(0, MAX_LINES) : rawLines;
                var nodes = [];
                for (var li = 0; li < useLines.length; li++) {
                  nodes.push(UI.Text({
                    key: "pv_line_" + li,
                    text: useLines[li] === "" ? " " : useLines[li],
                    style: "bodySmall",
                    color: "#d6d8db"
                  }));
                }
                var note = String(out.note || "");
                if (cut) note += "（仅显示前 " + MAX_LINES + " 行，共 " + rawLines.length + " 行）";
                setPreview({
                  path: out.path,
                  lineNodes: nodes,
                  lineCount: rawLines.length,
                  size: out.size,
                  note: note
                });
              }
            } catch (ePv) { /* ignore */ }
            try { hostLog({ dir: "openprobe", at: nowIso(), res: JSON.stringify({ ok: out && out.ok, mode: out && out.mode, err: out && out.error }).slice(0, 400) }); } catch (ePo) {}
          }
          else if (method === "toolUsage") out = await apiToolUsage(key);
          else if (method === "sessionUsage") out = await apiSessionUsage(key);
          else if (method === "overview") out = await apiOverview(req.range, req.files);
          else if (method === "messages") out = await apiMessages(key);
          else if (method === "todayMessages") out = await apiTodayMessages();
          else if (method === "rawSection") out = await apiRawSection(key, req.section, req.offset, req.limit, req.focusIdx);
          else if (method === "rawItem") out = await apiRawItem(key, req.index);
          else out = { ok: false, error: "unknown method: " + method };
          hostLog({ dir: "api", at: nowIso(), method: method, key: key, ms: Date.now() - t0, ok: !!(out && out.ok) });
          return JSON.stringify(out);
        } catch (e) {
          hostLog({ dir: "api", at: nowIso(), method: method, ms: Date.now() - t0, err: String(e && e.message ? e.message : e) });
          return JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) });
        }
      }
    });
  }

  // ---- v2 页面资源装载（o2.15 → o2.16）----
  // Operit2 的 UI WebView 不能靠 file:// 直读物理文件（走宿主代理 → ERR_INVALID_RESPONSE）。
  // 改为：readResource 拿到导出后的**真实路径**（注意：它返回路径字符串，不是文件内容），
  //       再用 Tools.Files.read 读内容 → 缓存到内存 → onInterceptRequest 按 URL 回给 WebView。
  //
  // 关键时序（o2.16 修）：WebView 的 url prop 和 onLoad 同时触发，onLoad 里的异步装载
  // 一定跑在首次请求之后 → 首帧永远命中「未就绪」分支（实测 35ms 差）。
  // 所以改成**惰性装载**：拦截器发现没装载就先装，装完再回应。boot() 只负责预热。
  var pageCache = { boot: "", app: "" };
  var pageReady = false;
  var pageLoading = null;   // 装载中的 Promise，避免并发重复装载

  /** readResource 返回的是导出后的路径；把它读成文本。 */
  function readResourceText(key, outputName) {
    return Promise.resolve(ToolPkg.readResource(key, outputName)).then(function (p) {
      var path = _readStr(p);
      if (!path) throw new Error("readResource returned empty for " + key);
      return Promise.resolve(Tools.Files.read(path)).then(function (r) {
        return _readStr(r);
      });
    });
  }

  /** 装载页面资源；并发调用共享同一个 Promise。 */
  function loadPageResources() {
    if (pageReady) return Promise.resolve(true);
    if (pageLoading) return pageLoading;
    pageLoading = Promise.all([
      readResourceText(RES_KEY_BOOT, "boot.html"),
      readResourceText(RES_KEY_APP, "index.single.html")
    ]).then(function (arr) {
      pageCache.boot = arr[0] || "";
      pageCache.app = arr[1] || "";
      pageReady = !!(pageCache.boot && pageCache.app);
      pageLoading = null;
      hostLog({
        dir: "host", at: nowIso(), event: "resources loaded",
        bootLen: pageCache.boot.length, appLen: pageCache.app.length, ready: pageReady
      });
      return pageReady;
    }).catch(function (e) {
      pageLoading = null;
      hostLog({ dir: "host", at: nowIso(), event: "resources load failed", err: String(e && e.message ? e.message : e) });
      return false;
    });
    return pageLoading;
  }

  /** 拦截 WebView 请求：只认我们自己的虚拟源，其余放行。
   *  o2.16：资源没就绪时**先等装载完成**再回应（返回 Promise），不再直接回 503。
   *  因为 WebView 首次请求必定早于 onLoad 的异步装载，回 503 等于首帧必白屏。 */
  function handleResourceRequest(request) {
    try {
      var url = String((request && request.url) || "");
      if (url.indexOf(DASHBOARD_ORIGIN) !== 0) return null;   // 非本站 → 交给宿主默认处理
      var path = url.slice(DASHBOARD_ORIGIN.length).split("?")[0].split("#")[0];

      // 站内请求：先确保资源就绪，再按路径回应。返回 Promise，宿主会等它。
      return loadPageResources().then(function (ok) {
        if (!ok) {
          return {
            action: "respond",
            response: {
              mimeType: "text/html", encoding: "UTF-8", statusCode: 503, reasonPhrase: "Resource Load Failed",
              headers: { "Cache-Control": "no-store" },
              text: "<!doctype html><meta charset=utf-8><body style='background:#151517;color:#ddd;font:14px sans-serif;padding:24px'>页面资源装载失败，请查看 ui_bridge 日志。</body>"
            }
          };
        }
        if (path === "/" || path === "/boot.html") {
          return {
            action: "respond",
            response: {
              mimeType: "text/html", encoding: "UTF-8", statusCode: 200, reasonPhrase: "OK",
              headers: { "Cache-Control": "no-store" },
              text: pageCache.boot
            }
          };
        }
        if (path === "/index.single.html") {
          return {
            action: "respond",
            response: {
              mimeType: "text/html", encoding: "UTF-8", statusCode: 200, reasonPhrase: "OK",
              headers: { "Cache-Control": "no-store" },
              text: pageCache.app
            }
          };
        }
        // favicon 之类的杂项：回 204，避免日志噪音
        if (path === "/favicon.ico") {
          return { action: "respond", response: { mimeType: "image/x-icon", statusCode: 204, reasonPhrase: "No Content", headers: { "Cache-Control": "no-store" }, text: "" } };
        }
        return {
          action: "respond",
          response: {
            mimeType: "text/plain", encoding: "UTF-8", statusCode: 404, reasonPhrase: "Not Found",
            headers: { "Cache-Control": "no-store" },
            text: "not found: " + path
          }
        };
      });
    } catch (e) {
      hostLog({ dir: "host", at: nowIso(), event: "intercept failed", err: String(e && e.message ? e.message : e) });
      return null;
    }
  }

  function boot() {
    hostLog({ dir: "host", at: nowIso(), event: "boot start" });
    try {
      initBridge();
      hostLog({ dir: "host", at: nowIso(), event: "bridge injected" });
    } catch (e) {
      hostLog({ dir: "host", at: nowIso(), event: "bridge inject failed", err: String(e) });
    }
    // 预热：让装载尽早开始，但**不依赖它**——真正保证首帧有内容的是拦截器里的惰性装载。
    loadPageResources();
  }

  function pushToPage() {
    try {
      var script = "window.__hostPush && window.__hostPush('host push @ " + nowIso() + "')";
      var result = controller.evaluateJavascript(script);
      Promise.resolve(result).then(function (v) {
        hostLog({ dir: "host->page", at: nowIso(), evalResult: String(v) });
      }).catch(function (e) {
        hostLog({ dir: "host->page", at: nowIso(), evalErr: String(e) });
      });
    } catch (e) {
      hostLog({ dir: "host->page", at: nowIso(), callErr: String(e) });
    }
  }

  return UI.Box(
    { fillMaxSize: true, onLoad: boot },
    [
      UI.WebView({
        key: "dashboard_webview_node",
        controller: controller,
        url: DASHBOARD_URL,
        backgroundColor: "#151517",
        fillMaxSize: true,
        javaScriptEnabled: true,
        domStorageEnabled: true,
        supportZoom: false,
        // v2：页面内容由 onInterceptRequest 提供，不再走 file://（见 handleResourceRequest）
        onInterceptRequest: function (req) { return handleResourceRequest(req); },
        onPageFinished: function (ev) {
          var u0 = String((ev && ev.url) || "");
          hostLog({ dir: "host", at: nowIso(), event: "onPageFinished", url: u0 });
          // 引导页加载完成 → 宿主主导航到仪表盘（JS跳转在部分环境被安全策略拦截，宿主侧最稳）
          if (u0.indexOf("boot.html") >= 0) {
            try {
              controller.loadUrl(DASHBOARD_APP);
            } catch (eF) {
              hostLog({ dir: "host", at: nowIso(), event: "loadUrl fail", err: String(eF) });
            }
            return;
          }
          pushToPage();
        }
      }),
      // 文件预览弹层（宿主 Files.open 不可用时的兜底，见 apiOpenPath）
      preview ? UI.Dialog(
        {
          key: "file_preview_dialog",
          onDismissRequest: function () { setPreview(null); },
          properties: { usePlatformDefaultWidth: false }
        },
        UI.Column(
          {
            fillMaxSize: true,
            padding: 16,
            background: "#1c1c1f"
          },
          [
            UI.Row(
              { fillMaxWidth: true, contentAlignment: "center_vertical" },
              [
                UI.Text({
                  text: (preview.path || "").split("/").pop() || "预览",
                  style: "titleMedium",
                  weight: 1
                }),
                UI.TextButton({
                  text: "关闭",
                  onClick: function () { setPreview(null); }
                })
              ]
            ),
            UI.Text({
              text: (preview.note || "") + (preview.size ? ("  (" + preview.size + " 字符)") : ""),
              style: "bodySmall",
              color: "#9aa0a6"
            }),
            UI.Text({
              text: preview.path || "",
              style: "bodySmall",
              color: "#6b7075"
            }),
            UI.Box({ fillMaxSize: true, weight: 1, padding: 8 },
              [
                // LazyColumn 是 v2 里唯一带滚动的容器（Column/Box 都没有 scroll 属性）。
                // 把内容按行切开喂进去，长文件才能上下滑（o2.18）。
                UI.LazyColumn(
                  {
                    key: "file_preview_list",
                    fillMaxSize: true,
                    spacing: 0
                  },
                  (preview.lineNodes || [])
                )
              ]
            )
          ]
        )
      ) : null
    ]
  );
}