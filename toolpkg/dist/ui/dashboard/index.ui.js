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
    var files = await listChatmsgFiles(3);
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
  var curTurn = 0;
  var curStep = 0;
  var lastUserCount = -1;
  for (var k = 0; k < merged.length; k++) {
    var r = merged[k];
    var cb = r.charsByKind || {};
    var uc = (r.countByKind && r.countByKind.USER) || 0;
    if (uc !== lastUserCount) { curTurn = uc > 0 ? uc : curTurn + 1; curStep = 1; lastUserCount = uc; }
    else { curStep++; }
    var seg = r.sys || liveSeg || null;
    var wb0 = seg ? (seg.wb || 0) : 0;
    var sk0 = seg ? (seg.sk || 0) : 0;
    var up0 = seg ? (seg.up || 0) : 0;
    var rec = {
      seq: k + 1,
      turn: curTurn,
      step: curStep,
      t: r.atMs,
      stage: r.stage,
      system: estTok(Math.max(0, (cb.SYSTEM || 0) - wb0 - sk0 - up0)),
      tools: estTok(r.toolsChars),
      user: estTok(cb.USER),
      inject: estTok(wb0),
      skill: estTok(sk0),
      summary: estTok(cb.SUMMARY),
      assistant: estTok(cb.ASSISTANT),
      tool: estTok((cb.TOOL_CALL || 0) + (cb.TOOL_RESULT || 0)),
      historyCount: r.historyCount || 0,
      historyChars: r.historyChars || 0
    };
    rec.total = rec.system + rec.tools + rec.user + rec.inject + rec.skill + rec.summary + rec.assistant + rec.tool;
    // 上限保护：单轮估算超过 96 万时按比例压缩
    if (rec.total > 960000) {
      anchorTo(rec, ["system", "tools", "user", "inject", "skill", "summary", "assistant", "tool"], 960000);
      rec.total = rec.system + rec.tools + rec.user + rec.inject + rec.skill + rec.summary + rec.assistant + rec.tool;
    }
    out.push(rec);
  }
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

/** 文件活动：从 raw 的 TOOL_CALL 解析文件读写记录（零新增写入） */
async function apiFileActivity(keyIn) {
  var key = keyIn || await latestKey();
  var payload = await loadRaw(key);
  if (!payload) return { ok: false, error: "raw解析失败" };
  var hist = Array.isArray(payload.preparedHistory) ? payload.preparedHistory : [];
  var FILE_TOOLS = { read_file: 1, read_file_part: 1, write_file: 1, edit_file: 1, create_file: 1, delete_file: 1, list_files: 1, make_directory: 1, find_files: 1, file_exists: 1, move_file: 1, copy_file: 1, file_info: 1, unzip_files: 1, zip_files: 1, open_file: 1, share_file: 1, grep_code: 1, grep_context: 1 };
  var READ_OPS = { read_file: 1, read_file_part: 1, list_files: 1, find_files: 1, file_exists: 1, file_info: 1, grep_code: 1, grep_context: 1 };
  var PATH_PARAMS = { path: 1, old_path: 1, new_path: 1, source_path: 1, destination: 1, target_path: 1, source: 1, destination_path: 1, file_path: 1 };
  var byPath = {};
  for (var i = 0; i < hist.length; i++) {
    var it = hist[i] || {};
    if (String(it.kind || "").toUpperCase() !== "TOOL_CALL") continue;
    var c = String(it.content || "");
    var nm = c.match(/name="([a-z_]+)"/);
    if (!nm || !FILE_TOOLS[nm[1]]) continue;
    var op = nm[1];
    var re = /<param name="([a-z_]+)">([^<]*)<\/param>/g;
    var paths = [];
    var m2;
    while ((m2 = re.exec(c)) !== null) {
      if (PATH_PARAMS[m2[1]] && m2[2]) paths.push(m2[2]);
    }
    for (var j = 0; j < paths.length; j++) {
      var p = paths[j];
      if (!p || p.length > 400) continue;
      var rec = byPath[p] || (byPath[p] = { path: p, reads: 0, writes: 0, tools: {} });
      if (READ_OPS[op]) rec.reads++; else rec.writes++;
      rec.tools[op] = true;
    }
  }
  var out = [];
  for (var kk in byPath) {
    var r2 = byPath[kk];
    out.push({ path: r2.path, reads: r2.reads, writes: r2.writes, count: r2.reads + r2.writes, tools: Object.keys(r2.tools).join(" · ") });
  }
  out.sort(function (a, b) { return b.count - a.count; });
  return { ok: true, total: out.length, items: out.slice(0, 60) };
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
async function apiRawSection(keyIn, section, offset, limit) {
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
  return { ok: true, kind: "list", total: total, items: rev.slice(off, off + lim) };
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
          else if (method === "events") out = await apiEvents(key);
          else if (method === "fileActivity") out = await apiFileActivity(key);
          else if (method === "toolUsage") out = await apiToolUsage(key);
          else if (method === "messages") out = await apiMessages(key);
          else if (method === "todayMessages") out = await apiTodayMessages();
          else if (method === "rawSection") out = await apiRawSection(key, req.section, req.offset, req.limit);
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