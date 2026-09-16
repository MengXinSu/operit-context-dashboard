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
var DASHBOARD_URL = "file:///sdcard/Download/Operit/projects/dsh-context-port/preview/boot.html?t=" + Date.now();
var DASHBOARD_APP = "file:///sdcard/Download/Operit/projects/dsh-context-port/preview/index.single.html";
// （原 bootedOnce 已移除：页面加载改由 WebView url prop 承担，每次进入强制刷新）

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
    var r = await Tools.Files.readBinary(path, "android");
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
    var r = await Tools.Files.read({ path: path, environment: "android" });
    if (r === null || r === undefined) return null;
    if (typeof r === "string") return r;
    if (typeof r.content === "string") return r.content;
    if (r.data && typeof r.data.content === "string") return r.data.content;
    return null;
  } catch (e) { return null; }
}

async function listPv() {
  try {
    var r = await Tools.Files.list(PV_DIR, "android");
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

/** 提取 SYSTEM 里的 <user_profile> 块（用户资料注入） */
function extractUserProfile(sysText) {
  var lines = String(sysText).split("\n");
  var start = -1;
  var end = lines.length;
  for (var i = 0; i < lines.length; i++) {
    var t = lines[i].trim();
    if (start < 0) {
      if (t.indexOf("<user_profile") === 0) start = i;
      continue;
    }
    if (t.indexOf("</user_profile>") === 0) { end = i + 1; break; }
  }
  if (start < 0) return { chars: 0, text: "", found: false };
  var seg = lines.slice(start, end).join("\n");
  return { chars: seg.length, text: seg, found: true };
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

async function loadRaw(key) {
  if (rawCache.key === key && rawCache.data && (Date.now() - rawCache.at) < 60000) return rawCache.data;
  // 防「读到半写文件」：raw 每轮被钩子覆盖写，读取可能撞上半写状态 → 解析失败时等待重试
  for (var attempt = 0; attempt < 3; attempt++) {
    var t = await readText(PV_DIR + "/raw_" + key + ".json");
    if (t) {
      try {
        var parsed = JSON.parse(stripNl(t));
        rawCache = { key: key, at: Date.now(), data: parsed };
        return parsed;
      } catch (e) { /* 半写状态，重试 */ }
    }
    await new Promise(function (r) { setTimeout(r, 250); });
  }
  return null;
}

async function apiSummary(keyIn) {
  var key = keyIn || await latestKey();
  if (!key) return { ok: false, error: "没有可用的会话数据（index.json 为空）" };
  var payload = await loadRaw(key);
  if (!payload) return { ok: false, error: "raw 解析失败: " + key };
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
      imgCount: imgCount0
    };
    rec.total = rec.system + rec.tools + rec.user + rec.inject + rec.skill + rec.summary + rec.assistant + rec.tool + (rec.img || 0);
    // 上限保护：单轮估算超过 96 万时按比例压缩
    if (rec.total > 960000) {
      anchorTo(rec, ["system", "tools", "user", "inject", "skill", "summary", "assistant", "tool", "img"], 960000);
      rec.total = rec.system + rec.tools + rec.user + rec.inject + rec.skill + rec.summary + rec.assistant + rec.tool + (rec.img || 0);
    }
    out.push(rec);
  }
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
  if (!payload) return { ok: false, error: "raw解析失败" };
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
  // W7①：挂步 brief（本轮/输入/回复锚点；失败不影响主流程）
  try {
    var pIdxs = w7PointIdxs(hist);
    if (pIdxs.length > out.length) pIdxs = pIdxs.slice(pIdxs.length - out.length);
    var briefs = w7BriefOf(hist, pIdxs);
    for (var bi = 0; bi < out.length; bi++) {
      var b = briefs[bi];
      if (!b) continue;
      out[bi].brief = { pIdx: b.pIdx, openerIdx: b.openerIdx, op: b.op, ins: b.ins, res: b.res };
    }
  } catch (eW) { /* brief 失败：趋势步仍可用 */ }
  return { ok: true, items: out };
}

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
  out.sort(function (a, b) { return (a.atMs || 0) - (b.atMs || 0); });
  return { ok: true, items: out.slice(-30) };
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
  var h = s.match(/<tool_[A-Za-z0-9]+\s+name="([^"]+)"/);
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
  var h = s.match(/<tool_result_[A-Za-z0-9]+\s+name="([^"]+)"(?:\s+status="([^"]+)")?/);
  if (!h) return null;
  var toolRaw = h[1], tool = fa2ToolTail(toolRaw);
  var kind = FA2_KIND[tool];
  if (!kind) return null;
  var err = h[2] === 'error' || /^<tool_result_[A-Za-z0-9]+[^>]*>\s*<content>\s*<error>/.test(s);
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
// ==== W7_BRIEF BEGIN（步 brief：请求点→本轮/输入/回复锚点；纯函数，供 apiSteps 挂接与离线自检共用）====
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
/** 步 brief 主计算（纯函数）。
 * hist=preparedHistory；pIdxs=请求点下标（与步记录一一对应）。
 * 返回 [{pIdx, openerIdx, op, ins, res}]：
 *   op  = [下标, 预览] | null —— 本轮用户消息（窗口裁剪时常缺）
 *   ins = [[下标, tag, 预览, err01]] —— 本步新增输入（工具结果；轮首步恒空）
 *   res = [[下标, tag, 预览, "A"|"T"]] —— 本步产出（A=思考/回复文本段，T=工具调用）
 * 口径（2026-09-17 全库 51 份 raw / 1934 步验证零穿插）：
 *   产出块 = P+1 起连续 ASSISTANT/TOOL_CALL；
 *   ins = (上一步产出块尾, P] 的余条目（实测仅 TOOL_RESULT）；
 *   opener = 该轮第一个请求点前的最近 USER。 */
function w7BriefOf(hist, pIdxs) {
  var out = [];
  var curOpener = -1;
  var prevTail = -1;
  for (var s = 0; s < pIdxs.length; s++) {
    var P = pIdxs[s];
    var kP = w7KindAt(hist, P);
    if (kP === "USER") curOpener = P;
    var openerIdx = curOpener >= 0 ? curOpener : null;
    var op = (openerIdx !== null && hist[openerIdx])
      ? [openerIdx, w7Preview(fa2Unesc(String(hist[openerIdx].content || "").slice(0, 6000)))]
      : null;
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
        var h = c.match(/<tool_[A-Za-z0-9]+\s+name="([^"]+)"/);
        var tn = h ? h[1] : "";
        if (tn === "package_proxy") {
          var p2 = c.match(/<param name="tool_name">([^<]+)<\/param>/);
          if (p2) tn = p2[1].trim();
        }
        resp.push([x, tn ? fa2ToolTail(tn) : "调用", w7Preview(fa2Unesc(c.slice(0, 6000))), "T"]);
      }
      x++;
    }
    // 输入段：(prevTail, P]；轮首或窗口开头恒空
    var ins = [];
    if (s > 0 && kP !== "USER") {
      var from = (prevTail >= 0 ? prevTail : pIdxs[s - 1]) + 1;
      for (var y = from; y <= P && y < hist.length; y++) {
        var cy = String((hist[y] && hist[y].content) || "");
        var ky = w7KindAt(hist, y);
        var mh = cy.match(/<tool_result_[A-Za-z0-9]+\s+name="([^"]+)"(?:\s+status="([^"]+)")?/);
        var tag = mh ? fa2ToolTail(mh[1]) : (ky === "TOOL_RESULT" ? "结果" : ky.toLowerCase());
        var err = ((mh && mh[2] === "error") || /^<tool_result_[A-Za-z0-9]+[^>]*>\s*<content>\s*<error>/.test(cy)) ? 1 : 0;
        ins.push([y, tag, w7Preview(fa2Unesc(cy.slice(0, 6000))), err]);
      }
    }
    prevTail = resp.length ? resp[resp.length - 1][0] : P;
    out.push({ pIdx: P, openerIdx: openerIdx, op: op, ins: ins, res: resp });
  }
  return out;
}
// ==== W7_BRIEF END ====

/** 文件活动：从 raw 的 TOOL_CALL / TOOL_RESULT 解析文件操作记录（v2：op 级 + 配对 + 聚合；零新增写入） */
/** W6 文件名打开：宿主 Files.open（系统默认应用打开）；只做结构校验，结果由宿主 API 返回。 */
async function apiOpenPath(pathIn) {
  var p = typeof pathIn === "string" ? pathIn.trim() : "";
  if (!p) return { ok: false, error: "empty path" };
  if (p.length > 512) return { ok: false, error: "path too long" };
  for (var ci = 0; ci < p.length; ci++) {
    var cc = p.charCodeAt(ci);
    if (cc < 32 || cc === 127) return { ok: false, error: "invalid path chars" };
  }
  try {
    var r = await Tools.Files.open(p, "android");
    var okOpen = !(r && r.successful === false);
    return { ok: okOpen, path: p, details: (r && r.details) || "", data: r || null };
  } catch (e) {
    return { ok: false, path: p, error: String(e && e.message ? e.message : e) };
  }
}
async function apiFileActivity(keyIn) {
  var key = keyIn || await latestKey();
  var payload = await loadRaw(key);
  if (!payload) return { ok: false, error: "raw解析失败" };
  var hist = Array.isArray(payload.preparedHistory) ? payload.preparedHistory : [];
  var act = fa2Compute(hist);
  return { ok: true, total: act.entries.length, items: act.legacyItems, entries: act.entries, totals: act.totals, stats: act.stats, userIdx: act.userIdx };
}


/** 工具使用统计：从 raw 的 TOOL_CALL 聚合各工具调用次数（零新增写入） */
async function apiToolUsage(keyIn) {
  var key = keyIn || await latestKey();
  var payload = await loadRaw(key);
  if (!payload) return { ok: false, error: "raw解析失败" };
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
  if (!payload) return { ok: false, error: "raw 解析失败" };
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
  if (!payload) return { ok: false, error: "raw 解析失败" };
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

  function hostLog(obj) {
    try {
      var line = JSON.stringify(obj) + "\n";
      try { Tools.Files.mkdir("/sdcard/Download/Operit/prompt_viewer", true, "android"); } catch (e0) {}
      Tools.Files.write(bridgeLogPath(), line, true, "android");
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
          var key = await latestKey();
          if (key && LAST_KEY && key !== LAST_KEY) {
            rawCache = { key: "", at: 0, data: null }; // 切会话：丢上一会话的内存缓存
          }
          if (key) LAST_KEY = key;
          var out;
          if (method === "summary") out = await apiSummary(key);
          else if (method === "timeline") out = await apiTimeline(key);
          else if (method === "steps") out = await apiSteps(key);
          else if (method === "events") out = await apiEvents(key);
          else if (method === "fileActivity") out = await apiFileActivity(key);
          else if (method === "openPath") out = await apiOpenPath(req.path);
          else if (method === "toolUsage") out = await apiToolUsage(key);
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

  function boot() {
    hostLog({ dir: "host", at: nowIso(), event: "boot start" });
    try {
      initBridge();
      hostLog({ dir: "host", at: nowIso(), event: "bridge injected" });
    } catch (e) {
      hostLog({ dir: "host", at: nowIso(), event: "bridge inject failed", err: String(e) });
    }
    // 页面加载交给 WebView 的 url prop（DASHBOARD_URL 为模块级常量，稳定值不会引发重载循环）
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
        allowFileAccess: true,
        supportZoom: false,
        onPageFinished: function (ev) {
          var u0 = String((ev && ev.url) || "");
          hostLog({ dir: "host", at: nowIso(), event: "onPageFinished", url: u0 });
          // 引导页加载完成 → 宿主主导航到仪表盘（JS跳转在部分环境被file安全策略拦截，宿主侧最稳）
          if (u0.indexOf("boot.html") >= 0) {
            try {
              controller.loadUrl(DASHBOARD_APP + "?v=" + Date.now());
            } catch (eF) {
              hostLog({ dir: "host", at: nowIso(), event: "loadUrl fail", err: String(eF) });
            }
            return;
          }
          pushToPage();
        }
      })
    ]
  );
}