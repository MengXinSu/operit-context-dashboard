"use strict";
/**
 * 完整提示词 · 侧边栏查看面板（Compose DSL / ui 上下文）
 *
 * 数据源：main 侧 prompt_finalize 钩子落盘的文件
 *   /sdcard/Download/Operit/prompt_viewer/
 *
 * 架构要点（踩坑后定版）：
 * 本 DSL 里，await 之后调用的 setState「值会写入、但不会触发重渲染」，
 * 表现为「点一下是读取中、再点一下才显示」。所以：
 *   1) 所有数据放模块级仓库 ST，渲染时直接读 ST；
 *   2) 点击只做「同步 setState」（切 tab / 切末尾 / 改搜索词）→ 必定刷新；
 *   3) 异步只负责往 ST 里填数据，填完尝试 bump() 触发一次重绘。
 */

const OUT_DIR = "/sdcard/Download/Operit/prompt_viewer";
const INDEX_PATH = OUT_DIR + "/index.json";
/** 每个对话一份快照文件；key 是对话 ID 前 8 位。
 *  key = "legacy" 是兼容分支：新钩子重启后才生效，在它跑出第一个 index.json 之前，
 *  面板先读旧的单文件格式（raw_payload.json / meta.json），避免「重启后首次打开是空白」。 */
function metaPath(key) { return key === "legacy" ? OUT_DIR + "/meta.json" : OUT_DIR + "/meta_" + key + ".json"; }
function rawPath(key) { return key === "legacy" ? OUT_DIR + "/raw_payload.json" : OUT_DIR + "/raw_" + key + ".json"; }

const FILES = [
  { tab: "索引", name: "00_索引.md", path: OUT_DIR + "/00_索引.md" },
  { tab: "SYSTEM", name: "01_SYSTEM原文.md", path: OUT_DIR + "/01_SYSTEM原文.md" },
  { tab: "世界书", name: "04_世界书.md", path: OUT_DIR + "/04_世界书.md" },
  { tab: "工具", name: "02_可用工具.md", path: OUT_DIR + "/02_可用工具.md" },
  { tab: "历史", name: "03_消息历史.md", path: OUT_DIR + "/03_消息历史.md" },
  { tab: "全量", name: "99_全量原文.md", path: OUT_DIR + "/99_全量原文.md" }
];

/** 模块级数据仓库：跨渲染保留，不依赖 setState */
const ST = {
  cache: {},
  meta: null,
  key: "",        // 当前选中的对话（= 当前所在对话）
  snaps: [],      // 索引里的对话列表
  isLegacy: false,  // 是否在读旧的单文件格式（新钩子首跑之前）
  curId: "",        // 当前对话 ID（list_chats 拿到的）
  status: "idle",   // idle | loading | ready
  msg: "",
  prog: 0,
  rev: 0,
  running: false,
  runStart: 0,
  genErr: "",
  genTail: "",
  watching: false,
  watchTimer: null
};

/** 每次渲染刷新，保存最新一批 setter */
let SET = {};
/** 最近一次可用的 ctx（给模块级异步函数用） */
let CTX = null;

function bump() {
  ST.rev++;
  try { if (SET.tick) SET.tick(ST.rev); } catch (e) { /* ignore */ }
}

/** 面板自证：把这次加载的关键事实落盘，用于定位「看到的是哪一份、为什么没更新」 */
async function diagLog(note) {
  try {
    let g = "n/a";
    try {
      g = (typeof getChatId === "function") ? String(getChatId()) : ("not-a-function:" + (typeof getChatId));
    } catch (e) { g = "throw:" + (e && e.message ? e.message : e); }
    const snaps = (ST.snaps || []).map(function (s) {
      return (s.key || "") + "|" + String(s.chatId || "").slice(0, 8) + "|" + (s.preview ? String(s.preview).slice(0, 6) : "-");
    }).join("  ");
    const cache = FILES.map(function (f) { return f.tab + ":" + ((ST.cache[f.tab] || "").length); }).join(" ");
    const txt = [
      "note=" + note,
      "getChatId=" + g,
      "ST.key=" + ST.key,
      "isLegacy=" + ST.isLegacy,
      "status=" + ST.status,
      "msg=" + ST.msg,
      "snaps[" + (ST.snaps || []).length + "]= " + snaps,
      "cache= " + cache,
      "genErr=" + (ST.genErr || "-"),
      "genTail=" + (ST.genTail || "-"),
      "Tools=" + (typeof Tools) + " Files=" + ((typeof Tools !== "undefined" && Tools && Tools.Files) ? "yes" : "no"),
      "curId=" + (ST.curId || "-"),
      "meta: generated=" + (ST.meta ? ST.meta.generated : "n/a") +
        " generatedFor=" + (ST.meta ? ST.meta.generatedFor : "n/a") +
        " capturedAtMs=" + (ST.meta ? ST.meta.capturedAtMs : "n/a")
    ].join("\n");
    await writeOne(OUT_DIR + "/_ui_log.txt", "[" + new Date().toISOString() + "]\n" + txt + "\n");
  } catch (e) { /* 诊断失败不影响主流程 */ }
}

const CHUNK_LINES = 120;      // 渲染分块行数
const READ_CHUNK = 300;       // 每次读盘行数（read_file_part 单次约 36KB 上限）
const READ_BATCH = 1;         // 读取并发数：真机上并发调用 read_file_part 会互相干扰，
                              // 表现为「只读到第一块就停」，所以固定串行
const MAX_READ_BLOCKS = 200;  // 未知总行数时的安全上限

/** 从 read_file / read_file_part 返回里取原始正文（保留「行号 | 」前缀） */
function rawContent(r) {
  if (!r) return "";
  if (typeof r === "string") {
    try {
      const o = JSON.parse(r);
      if (o && o.data && typeof o.data.content === "string") return o.data.content;
      if (o && typeof o.content === "string") return o.content;
    } catch (e) { /* 不是 json */ }
    return r;
  }
  if (typeof r.content === "string") return r.content;
  if (r.data && typeof r.data.content === "string") return r.data.content;
  return "";
}

/** 剥掉每行开头的「行号 | 」前缀 */
function stripLines(text) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) out.push(lines[i].replace(/^\s*\d+\|\s?/, ""));
  return out.join("\n");
}

function extractText(r) {
  return stripLines(rawContent(r));
}

/** 取这段内容里最大的一行行号（判断读盘是否还在前进） */
function lastLineNo(text) {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*(\d+)\|/);
    if (m) return parseInt(m[1], 10);
  }
  return 0;
}

// ---------- 派生文件生成（懒生成：只在打开面板 / 手动刷新时做） ----------
//
// 钩子只写 raw_payload.json + meta.json。下面这套渲染逻辑从 main.js 搬来，
// 放在 UI 侧的原因：① 钩子路径上零渲染，发消息时只做一次 JSON.stringify + 一次写盘；
// ② 不依赖跨模块 require；③ 以后改显示样式只动这一处。
//
// 生成时机：meta.generated !== true，或 generatedFor 与钩子写的 capturedAtMs 不一致。

function str(v) {
  return v === null || v === undefined ? "" : String(v);
}

/** 安全 JSON：遇到循环引用/怪值不炸，逐字段降级 */
function safeJson(value, indent) {
  const space = indent === undefined ? 2 : indent;
  try {
    return JSON.stringify(value, null, space);
  } catch (e) {
    if (value && typeof value === "object") {
      const out = {};
      const keys = Object.keys(value);
      for (let i = 0; i < keys.length; i++) {
        try {
          JSON.stringify(value[keys[i]]);
          out[keys[i]] = value[keys[i]];
        } catch (e2) {
          out[keys[i]] = "[unserializable: " + (e2 && e2.message ? e2.message : e2) + "]";
        }
      }
      try {
        return JSON.stringify(out, null, space);
      } catch (e3) {
        return "{\"__error\": \"json stringify failed\"}";
      }
    }
    return "\"" + (e && e.message ? e.message : String(e)) + "\"";
  }
}

function turnKind(t) {
  return str((t && (t.kind || t.role)) || "UNKNOWN");
}

function turnContent(t) {
  return t && t.content !== null && t.content !== undefined ? str(t.content) : "";
}

function turnTool(t) {
  return t && t.toolName ? str(t.toolName) : "";
}

function banner(title, note) {
  const out = [];
  out.push("# " + title);
  out.push("");
  if (note) {
    out.push("> " + note);
    out.push("");
  }
  return out;
}

/** 世界书：从 SYSTEM 文本里逐字抽出 <worldbook> 块，按出现顺序拼接 */
function renderWorldbook(systemText) {
  const text = str(systemText);
  const OPEN = "<worldbook>";
  const CLOSE = "</worldbook>";
  const DQ = String.fromCharCode(34);
  const blocks = [];
  let pos = 0;
  while (true) {
    const a = text.indexOf(OPEN, pos);
    if (a < 0) break;
    let b = text.indexOf(CLOSE, a);
    if (b < 0) { blocks.push(text.slice(a)); break; }
    b += CLOSE.length;
    blocks.push(text.slice(a, b));
    pos = b;
  }
  const names = [];
  const parts = text.split("<entry name=" + DQ);
  for (let i = 1; i < parts.length; i++) {
    const q = parts[i].indexOf(DQ);
    names.push(q < 0 ? parts[i].slice(0, 40) : parts[i].slice(0, q));
  }
  let note = "从 SYSTEM 里逐字抽出的 <worldbook> 块，按出现顺序拼接，未做删改。共 " + blocks.length + " 块 / " + names.length + " 个条目";
  if (names.length) note += "：" + names.join("、");
  note += "。";
  const out = banner("世界书 · 模型看到的世界书原文", note);
  if (!blocks.length) {
    out.push("（本轮 SYSTEM 里没有 <worldbook> 块，世界书未激活或未命中）");
    return out.join("\n");
  }
  for (let j = 0; j < blocks.length; j++) {
    out.push(blocks[j]);
    out.push("");
    if (j < blocks.length - 1) {
      out.push("---");
      out.push("");
    }
  }
  return out.join("\n");
}

function renderTools(tools, toolPrompt, modelParameters) {
  const out = banner("可用工具 · 模型看到的工具面", "由 prompt_finalize 钩子逐字抓取，工具名/描述/参数结构未做删改。");
  const list = Array.isArray(tools) ? tools : [];
  out.push("工具数量：" + list.length);
  out.push("");
  for (let i = 0; i < list.length; i++) {
    const t = list[i] && typeof list[i] === "object" ? list[i] : {};
    const fn = t.function && typeof t.function === "object" ? t.function : null;
    const name = str(t.name || (fn && fn.name) || ("tool_" + (i + 1)));
    const desc = str(t.description || (fn && fn.description));
    const params = t.parameters || (fn && fn.parameters) || t.parametersStructured;
    out.push("### " + (i + 1) + ". " + name);
    if (desc) {
      out.push("");
      out.push(desc);
    }
    if (Array.isArray(params)) {
      out.push("");
      for (let j = 0; j < params.length; j++) {
        const p = params[j] && typeof params[j] === "object" ? params[j] : {};
        out.push("- `" + str(p.name || "?") + "`（" + str(p.type || "未指定") + "）：" + str(p.description || ""));
      }
    } else if (params && typeof params === "object") {
      out.push("");
      out.push("```json");
      out.push(safeJson(params));
      out.push("```");
    }
    out.push("");
  }
  out.push("---");
  out.push("");
  out.push("## 工具提示词（toolPrompt 原文）");
  out.push("");
  out.push(str(toolPrompt) || "(空)");
  out.push("");
  out.push("---");
  out.push("");
  out.push("## 模型参数（modelParameters）");
  out.push("");
  if (modelParameters === null || modelParameters === undefined || modelParameters === "") {
    out.push("(空)");
  } else if (typeof modelParameters === "object") {
    out.push("```json");
    out.push(safeJson(modelParameters));
    out.push("```");
  } else {
    out.push(str(modelParameters));
  }
  out.push("");
  return out.join("\n");
}

function renderHistory(turns) {
  const out = banner("消息历史 · 模型看到的逐字原文", "不含 SYSTEM；顺序与发送顺序一致；未做清洗或截断。");
  let idx = 0;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (turnKind(t) === "SYSTEM") continue;
    idx++;
    const c = turnContent(t);
    const tool = turnTool(t);
    out.push("---");
    out.push("");
    out.push("## [" + idx + "] " + turnKind(t) + (tool ? " · 工具:" + tool : "") + " · " + c.length + " 字符");
    out.push("");
    out.push(c);
    out.push("");
  }
  out.push("---");
  out.push("");
  out.push("（共 " + idx + " 条非 SYSTEM 消息）");
  out.push("");
  return out.join("\n");
}

function renderFull(turns) {
  const out = banner("完整提示词 · 全量消息序列", "含 SYSTEM，顺序即发送顺序，内容逐字未加工。");
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const c = turnContent(t);
    const tool = turnTool(t);
    out.push("---");
    out.push("");
    out.push("## [" + (i + 1) + "] " + turnKind(t) + (tool ? " · 工具:" + tool : "") + " · " + c.length + " 字符");
    out.push("");
    out.push(c);
    out.push("");
  }
  return out.join("\n");
}

function renderIndex(info) {
  const out = banner("完整提示词 · 索引", "prompt_finalize 钩子在「即将发给模型之前」抓取的原文：模型看到什么，这里就是什么。");
  out.push("- 抓取时间：" + info.capturedAt);
  out.push("- 消息条数：" + info.messageCount + "（其中 SYSTEM " + info.systemCount + " 条）");
  out.push("- SYSTEM 字符数：" + info.systemChars);
  out.push("- 历史字符数：" + info.historyChars);
  out.push("- 可用工具数：" + info.toolCount);
  out.push("- 总量字符数：" + info.totalChars);
  out.push("");
  out.push("## 文件清单");
  out.push("");
  out.push("| 文件 | 字符 | 说明 |");
  out.push("| --- | --- | --- |");
  out.push("| 01_SYSTEM原文.md | " + info.systemChars + " | 系统提示词逐字原文 |");
  out.push("| 02_可用工具.md | " + info.toolsChars + " | 可用工具清单 + 工具提示词 + 模型参数 |");
  out.push("| 03_消息历史.md | " + info.historyChars + " | SYSTEM 之外的每条消息 |");
  out.push("| 04_世界书.md | " + info.worldbookChars + " | SYSTEM 里的 <worldbook> 块逐字抽出 |");
  out.push("| 99_全量原文.md | " + info.totalChars + " | 含 SYSTEM 的完整序列 |");
  out.push("| raw_" + ST.key + ".json | " + info.rawChars + " | hook payload 原始 JSON |");
  out.push("");
  out.push("## 本次 payload 顶层字段");
  out.push("");
  out.push("`" + info.payloadKeys.join("`, `") + "`");
  out.push("");
  out.push("## 怎么读");
  out.push("");
  out.push("1. 只想看人格 / 角色卡 → 01_SYSTEM原文.md");
  out.push("2. 世界书条目（<worldbook> 块）→ 04_世界书.md");
  out.push("3. 想看这轮模型能调什么工具、参数长什么样 → 02_可用工具.md");
  out.push("4. 想看刚才那几轮到底发了什么 → 03_消息历史.md");
  out.push("5. 想核对是否一字不差 → 同目录下的 raw_" + ST.key + ".json");
  out.push("");
  return out.join("\n");
}

/** 由原始 payload 生成全部派生文件内容（纯函数，不碰 IO） */
function buildAll(payload, capturedAt, rawChars) {
  const turns = Array.isArray(payload.preparedHistory) ? payload.preparedHistory
    : (Array.isArray(payload.chatHistory) ? payload.chatHistory : []);

  let systemText = "";
  let systemCount = 0;
  for (let i = 0; i < turns.length; i++) {
    if (turnKind(turns[i]) === "SYSTEM") {
      systemCount++;
      if (!systemText) systemText = turnContent(turns[i]);
    }
  }
  if (!systemText) systemText = str(payload.systemPrompt);

  const systemLines = banner("SYSTEM 原文 · 模型看到的系统提示词",
    "逐字未加工，来源：preparedHistory 中的 SYSTEM turn" +
    (systemCount > 1 ? "（本轮有 " + systemCount + " 条 SYSTEM，此处取第一条）" : "") + "。");
  systemLines.push(systemText);
  const systemFile = systemLines.join("\n");

  const toolsFile = renderTools(payload.availableTools, payload.toolPrompt, payload.modelParameters);
  const historyFile = renderHistory(turns);
  const fullFile = renderFull(turns);
  const worldbookFile = renderWorldbook(systemText);

  let payloadKeys = [];
  try { payloadKeys = Object.keys(payload); } catch (e) { /* ignore */ }

  const info = {
    capturedAt: capturedAt || "",
    messageCount: turns.length,
    systemCount: systemCount,
    systemChars: systemText.length,
    worldbookChars: worldbookFile.length,
    historyChars: historyFile.length,
    toolsChars: toolsFile.length,
    totalChars: fullFile.length,
    rawChars: rawChars || 0,
    toolCount: Array.isArray(payload.availableTools) ? payload.availableTools.length : 0,
    payloadKeys: payloadKeys
  };
  const indexFile = renderIndex(info);

  const list = [
    { tab: "索引", name: "00_索引.md", path: OUT_DIR + "/00_索引.md", content: indexFile },
    { tab: "SYSTEM", name: "01_SYSTEM原文.md", path: OUT_DIR + "/01_SYSTEM原文.md", content: systemFile },
    { tab: "世界书", name: "04_世界书.md", path: OUT_DIR + "/04_世界书.md", content: worldbookFile },
    { tab: "工具", name: "02_可用工具.md", path: OUT_DIR + "/02_可用工具.md", content: toolsFile },
    { tab: "历史", name: "03_消息历史.md", path: OUT_DIR + "/03_消息历史.md", content: historyFile },
    { tab: "全量", name: "99_全量原文.md", path: OUT_DIR + "/99_全量原文.md", content: fullFile }
  ];
  return { list: list, info: info };
}

function nativeApi() {
  try {
    return typeof NativeInterface !== "undefined" ? NativeInterface : null;
  } catch (e) {
    return null;
  }
}

/** 当前对话 ID（Compose DSL 环境不一定提供这个全局函数，取不到就返回空串） */
function currentChatId() {
  try {
    if (typeof getChatId === "function") return str(getChatId());
  } catch (e) { /* ignore */ }
  return "";
}

/** 写一个文件。create_file 在文件已存在时会失败，所以必须先删后建。
 *  通道①（优先）NativeInterface —— 与钩子同一条通道，钩子写 raw/meta 已被实测验证可行；
 *  通道②（兜底）UI 自己的工具调用 —— 离线能过，但真机上 UI 上下文未必有写文件权限。 */
async function writeOne(path, content) {
  const body = str(content);

  // 通道①（最优先）官方文件 API —— Tools.Files.write(path, content, append=false)
  // 天然支持覆盖写，prompt_inspector 就是这么用的。
  try {
    if (typeof Tools !== "undefined" && Tools && Tools.Files && typeof Tools.Files.write === "function") {
      try { await Tools.Files.mkdir(OUT_DIR, true); } catch (e) { /* 已存在 */ }
      const r = await Tools.Files.write(path, body, false);
      if (r === undefined || r === null || r.success === undefined || r.success === true) return true;
    }
  } catch (e) { /* 落到通道② */ }

  const n = nativeApi();
  if (n) {
    try {
      try { n.callTool("default", "delete_file", JSON.stringify({ path: path })); } catch (e) { /* 不存在 */ }
      n.callTool("default", "create_file", JSON.stringify({ path: path, new: body }));
      return true;
    } catch (e) { /* 落到通道② */ }
  }

  try {
    try { await CTX.callTool("delete_file", { path: path }); } catch (e) { /* 不存在 */ }
    await CTX.callTool("create_file", { path: path, "new": body });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 懒生成：钩子有新数据时，用 raw_payload.json 重建派生文件。
 * 顺序很关键——先把内容填进 ST.cache（保证界面立刻能显示），再尝试落盘。
 * 落盘失败也不影响阅读，只是外部工具看不到新文件。
 */
/** 官方文件 API 一次性读全文（抄 prompt_inspector 的做法）：没有分块上限，不会末尾丢失。
 *  真机上 read_file_part 分块读会少最后几十字符，所以这条路必须优先。 */
async function readAllViaTools(path) {
  try {
    if (typeof Tools !== "undefined" && Tools && Tools.Files && typeof Tools.Files.read === "function") {
      const r = await Tools.Files.read(path);
      if (r && typeof r.content === "string") return r.content;
      if (typeof r === "string") return r;
    }
  } catch (e) { /* 回退分块读 */ }
  return "";
}

async function ensureGenerated() {
  ST.genErr = "";
  ST.genTail = "";
  let expectJson = 0;
  try {
    await loadMetaOnce();
    const meta = ST.meta;
    if (!meta || meta.ok !== true) { ST.genErr = "meta不可用"; return false; }
    if (meta.generated === true && meta.generatedFor === meta.capturedAtMs) return true;

    // 旧版 meta 没有 rawLines，按足够大的行数估算，靠「行号不前进」自然收敛到文件尾
    const rawLines = meta.rawLines > 0 ? meta.rawLines : 24000;

    // ① 优先：官方文件 API 一次读全文（没有分块上限，不会丢尾巴）
    let rawText = await readAllViaTools(rawPath(ST.key));
    // ② 兜底：分块读（真机上会少最后几十字符，所以只当备胎）
    if (!rawText || !rawText.trim()) {
      rawText = await readWhole(rawPath(ST.key), rawLines, null, chunkLinesFor(meta.rawChars, meta.rawLines));
    }
    if (!rawText || !rawText.trim()) { ST.genErr = "读raw为空(key=" + ST.key + ")"; return false; }

    // 钩子可能对超长行做过折断（meta.chunked）→ 去掉所有真换行即可还原成完整 JSON
    let jsonText = rawText;
    if (meta.chunked) jsonText = rawText.replace(/\n/g, "");

    // 「去折行后应有的长度」= 钩子声明的字符数 - 折行时插入的换行数（约 rawLines-1 个）
    expectJson = (meta.chunked && meta.rawLines > 0)
      ? (meta.rawChars - (meta.rawLines - 1))
      : (meta.rawChars || 0);

    // 少一个 } 整个 JSON 就废了 → 差一点都不行，换最小步子（40 行/块）重读一遍，取更长的
    if (expectJson > 0 && jsonText.length < expectJson - 2) {
      const retry = await readWhole(rawPath(ST.key), rawLines, null, 40);
      if (retry) {
        const rt = meta.chunked ? retry.replace(/\n/g, "") : retry;
        if (rt.length > jsonText.length) { rawText = retry; jsonText = rt; }
      }
    }

    const a = jsonText.indexOf("{");
    const b = jsonText.lastIndexOf("}");
    if (a < 0 || b <= a) { ST.genErr = "找不到JSON边界(len=" + jsonText.length + ")"; return false; }

    let payload = null;
    try { payload = JSON.parse(jsonText.slice(a, b + 1)); } catch (e) { ST.genTail = jsonText.slice(-240); ST.genErr = "JSON解析失败(读到" + jsonText.length + "/应有" + expectJson + "字符)"; return false; }
    if (!payload || typeof payload !== "object") { ST.genErr = "payload不是对象"; return false; }

    const built = buildAll(payload, meta.capturedAt || "", meta.rawChars || 0);

    // ① 先上屏（内存），保证「打开就能看」
    for (let i = 0; i < built.list.length; i++) {
      ST.cache[built.list[i].tab] = built.list[i].content;
    }

    // ② 再落盘（失败不影响显示；全部成功才标记「已生成」，否则下次打开会自动重试）
    let allWritten = true;
    for (let i = 0; i < built.list.length; i++) {
      const wrote = await writeOne(built.list[i].path, built.list[i].content);
      if (!wrote) allWritten = false;
    }

    // ③ 回写 meta：标记已生成 + 各文件行数（下次打开可直接跳过分块读）
    const files = built.list.map(function (it) {
      return {
        name: it.name,
        path: it.path,
        chars: it.content.length,
        lines: it.content.split("\n").length
      };
    });
    files.push({ name: "raw_" + ST.key + ".json", path: rawPath(ST.key), chars: meta.rawChars || 0 });

    const nb = {
      ok: true,
      // 这三个字段必须原样带回去，否则下次扫目录时认不出这份属于哪个对话
      chatId: meta.chatId,
      key: meta.key || ST.key,
      preview: meta.preview,
      capturedAt: meta.capturedAt || "",
      capturedAtMs: meta.capturedAtMs,
      rawChars: meta.rawChars || 0,
      rawLines: meta.rawLines || 0,
      chunked: meta.chunked || 0,
      payloadKeys: built.info.payloadKeys,
      generated: allWritten,
      generatedFor: allWritten ? meta.capturedAtMs : undefined,
      messageCount: built.info.messageCount,
      systemCount: built.info.systemCount,
      systemChars: built.info.systemChars,
      historyChars: built.info.historyChars,
      toolsChars: built.info.toolsChars,
      totalChars: built.info.totalChars,
      toolCount: built.info.toolCount,
      files: files
    };
    await writeOne(metaPath(ST.key), safeJson(nb));
    ST.meta = nb;
    if (!allWritten) ST.genErr = "部分派生文件落盘失败(显示不受影响)";
    return true;
  } catch (e) {
    ST.genErr = "异常:" + (e && e.message ? e.message : e);
    return false;
  }
}

// ---------- 数据读取（模块级，不依赖组件 state） ----------

async function readPart(path, start, end) {
  try {
    const r = await CTX.callTool("read_file_part", { path: path, start_line: start, end_line: end });
    const raw = rawContent(r);
    return { text: stripLines(raw), lastNo: lastLineNo(raw) };
  } catch (e) {
    return { text: "", lastNo: 0 };
  }
}

/** 按「单块不超过约 24000 字符」估算安全块行数（read_file_part 单次返回有大小上限） */
function chunkLinesFor(chars, lines) {
  if (!chars || !lines || lines <= 0) return READ_CHUNK;
  const per = chars / lines;
  if (!(per > 0)) return READ_CHUNK;
  const n = Math.floor(18000 / per);
  return Math.max(40, Math.min(READ_CHUNK, n));
}

/** 分块读完整文件（自适应块大小）。
 *  两个坑都在这里：
 *   1) 越界请求时工具会把文件尾部再返回一遍 → 用「行号不再前进」判断到达尾部；
 *   2) read_file_part 单次返回有大小上限，而 raw_payload.json 这类文件行长极不均匀
 *      （平均 366 字符/行，个别行几千字符）→ 按平均行长估算块大小并不安全。
 *      所以这里会检查「返回的最后行号有没有到请求的末尾」，没到就是被截断，
 *      立刻把块缩小一半，从被截断那一行重新读；读顺了再逐步放大回来。 */
async function readWhole(path, totalLines, onProgress, chunkLines) {
  const CH0 = chunkLines > 0 ? chunkLines : READ_CHUNK;
  let CH = CH0;
  const parts = [];
  let lastNo = 0;
  let guard = 0;
  let lastCut = -1;   // 上一次「疑似被截断」停在的行号

  while (guard++ < 400) {
    const starts = [];
    for (let i = 0; i < READ_BATCH; i++) {
      const s = lastNo + 1 + i * CH;
      if (totalLines > 0 && s > totalLines) break;
      starts.push(s);
    }
    if (starts.length === 0) break;

    const results = await Promise.all(starts.map(s => readPart(path, s, s + CH - 1)));

    let advanced = 0;
    let shrunk = false;

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const s = starts[i];
      if (!r || !r.text || !r.text.trim()) break;                 // 到尾部
      if (lastNo > 0 && r.lastNo > 0 && r.lastNo <= lastNo) break; // 越界重复尾部
      if (r.lastNo <= 0) break;

      const wantEnd = totalLines > 0 ? Math.min(s + CH - 1, totalLines) : s + CH - 1;
      const atFileEnd = totalLines > 0 && r.lastNo >= totalLines;
      if (r.lastNo < wantEnd && !atFileEnd) {
        // 连续两次都停在同一行 → 这不是被截断，而是文件本来就这么长，收下并结束
        if (lastCut === r.lastNo) {
          parts.push(r.text);
          lastNo = r.lastNo;
          if (onProgress) onProgress(Math.min(lastNo, totalLines), totalLines);
          return parts.join("\n");
        }
        // 第一次遇到：可能真的被截断 → 缩小块重读这一段
        lastCut = r.lastNo;
        CH = Math.max(8, Math.floor(CH / 2));
        shrunk = true;
        break;
      }

      parts.push(r.text);
      lastNo = r.lastNo;
      advanced++;
    }

    if (onProgress) {
      onProgress(totalLines > 0 ? Math.min(lastNo, totalLines) : lastNo, totalLines);
    }

    if (shrunk) {
      if (advanced === 0 && CH <= 8) break;   // 缩到最小还读不动 → 放弃（避免死循环）
      continue;
    }
    if (advanced < starts.length) break;      // 本轮没读满 → 到尾部了
    if (CH < CH0) CH = Math.min(CH0, Math.floor(CH * 1.5)); // 读顺了 → 试探性放大
  }

  return parts.join("\n");
}

function totalLinesOf(tabName) {
  const item = FILES.filter(f => f.tab === tabName)[0];
  if (!item || !ST.meta || !ST.meta.files) return 0;
  const hit = ST.meta.files.filter(f => f.name === item.name)[0];
  return hit && hit.lines ? hit.lines : 0;
}

/** 扫描输出目录，找出所有 meta_<key>.json —— 文件系统本身就是索引。
 *  这样即使钩子侧读索引失败，也能发现所有已抓取的对话。 */
async function scanMetaKeys() {
  const keys = [];
  try {
    const r = await CTX.callTool("list_files", { path: OUT_DIR });
    let jsonish = "";
    try { jsonish = JSON.stringify(r); } catch (e2) { jsonish = ""; }
    const s = str(rawContent(r)) + "\n" + str(extractText(r)) + "\n" + jsonish;
    const re = /meta_([A-Za-z0-9_\-]+)\.json/g;
    let m;
    while ((m = re.exec(s))) { if (keys.indexOf(m[1]) < 0) keys.push(m[1]); }
  } catch (e) { /* list_files 不可用 → 返回空，走下一级兜底 */ }
  return keys;
}

/** 读一个对话的 meta（含 chatId / preview / 抓取时间），失败返回 null */
async function readMeta(key) {
  try {
    const r = await CTX.callTool("read_file", { path: metaPath(key), environment: "android" });
    const s = extractText(r);
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a < 0 || b <= a) return null;
    const m = JSON.parse(s.slice(a, b + 1));
    return (m && m.ok) ? m : null;
  } catch (e) { return null; }
}

/** 读钩子写的 index.json（扫描不可用时的第二级来源） */
async function readIndexFile() {
  try {
    const r = await CTX.callTool("read_file", { path: INDEX_PATH, environment: "android" });
    const s = extractText(r);
    const a = s.indexOf("[");
    const b = s.lastIndexOf("]");
    if (a >= 0 && b > a) {
      const arr = JSON.parse(s.slice(a, b + 1));
      if (Array.isArray(arr)) return arr;
    }
  } catch (e) { /* 忽略 */ }
  return [];
}

/** 当前对话 ID（异步版）：①全局 getChatId（真机面板里取不到）
 *  ②list_chats 里带 is_current 的那条 —— 抄 prompt_viewer 的做法。 */
async function currentChatIdAsync() {
  const direct = currentChatId();
  if (direct) return direct;
  try {
    const r = await CTX.callTool("list_chats", {});
    let o = r;
    if (typeof r === "string") { try { o = JSON.parse(r); } catch (e) { o = null; } }
    const d = (o && o.data) ? o.data : o;
    let arr = d && (d.chats || d.items || d.list || d);
    if (arr && !Array.isArray(arr) && typeof arr === "object") {
      try { arr = Object.values(arr); } catch (e) { arr = null; }
    }
    if (Array.isArray(arr)) {
      for (let i = 0; i < arr.length; i++) {
        const c = arr[i];
        if (c && (c.is_current === true || c.current === true || c.isCurrent === true)) {
          const id = c.id || c.chat_id || c.chatId || c.uuid;
          if (id) return String(id);
        }
      }
    }
  } catch (e) { /* 拿不到就退化为「最新一份」 */ }
  return "";
}

/** 切到另一个对话时，必须丢掉上一个对话的内存缓存，
 *  否则 preloadAll 的快速路径会直接返回，面板还显示上一份内容。 */
function switchKey(newKey) {
  if (newKey === ST.key) return;
  ST.cache = {};
  ST.meta = null;
  ST.status = "idle";
  ST.key = newKey;
}

/** 决定「看哪个对话」：优先当前所在对话，取不到就用最新抓取的那份 */
async function loadSnaps() {
  // ① 主路径：扫目录里的 meta_<key>.json
  const keys = await scanMetaKeys();
  const arr = [];
  for (let i = 0; i < keys.length; i++) {
    const m = await readMeta(keys[i]);
    if (!m) continue;
    arr.push({
      key: keys[i],
      chatId: str(m.chatId),
      capturedAt: m.capturedAt || "",
      capturedAtMs: m.capturedAtMs || 0,
      preview: m.preview || "",
      chars: m.rawChars || 0,
      lines: m.rawLines || 0
    });
  }

  // ② 扫不到 → 退回钩子写的 index.json
  if (!arr.length) {
    const fromIndex = await readIndexFile();
    for (let i = 0; i < fromIndex.length; i++) if (fromIndex[i] && fromIndex[i].key) arr.push(fromIndex[i]);
  }

  // ③ 还是空 → 兼容旧单文件格式（新钩子首跑之前），不留空白
  if (!arr.length) {
    ST.snaps = [{ key: "legacy", chatId: "", preview: "" }];
    ST.isLegacy = true;
    switchKey("legacy");
    return;
  }

  arr.sort(function (x, y) { return (y.capturedAtMs || 0) - (x.capturedAtMs || 0); });
  ST.snaps = arr;
  ST.isLegacy = false;

  const cur = await currentChatIdAsync();
  ST.curId = cur;
  let sel = null;
  if (cur) {
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i].chatId === cur) { sel = arr[i]; break; }
    }
  }
  if (!sel) sel = arr[0];   // 取不到当前对话 ID 时，用最新抓取的那一份
  switchKey(sel && sel.key ? String(sel.key) : "");
}

async function loadMetaOnce() {
  try {
    await loadSnaps();
    if (!ST.key) return;
    const r = await CTX.callTool("read_file", { path: metaPath(ST.key), environment: "android" });
    const s = extractText(r);
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a >= 0 && b > a) ST.meta = JSON.parse(s.slice(a, b + 1));
  } catch (e) { /* 忽略 */ }
}

async function loadFile(name) {
  const item = FILES.filter(f => f.tab === name)[0] || FILES[0];
  const total = totalLinesOf(name);
  const hit = (ST.meta && ST.meta.files) ? ST.meta.files.filter(f => f.name === item.name)[0] : null;
  const text = await readWhole(item.path, total, (done, t) => {
    ST.prog = t > 0 ? Math.min(1, done / t) : 0;
    ST.msg = t > 0 ? ("读取 " + name + " " + done + " / " + t + " 行") : ("读取 " + name + " 已读 " + done + " 行");
  }, chunkLinesFor(hit && hit.chars, total));
  ST.cache[name] = text || "";
  return ST.cache[name];
}

/** 内存里是否已经有一份完整数据 */
function cacheComplete() {
  for (let i = 0; i < FILES.length; i++) {
    const v = ST.cache[FILES[i].tab];
    if (typeof v !== "string" || !v) return false;
  }
  return true;
}

async function preloadAll() {
  // 防呆：上一次若因中途关面板 / 切走而卡住，running 会一直是 true，后续打开全被它拦住。
  // 超过 45 秒视为失效，强制重来。
  if (ST.running && (Date.now() - (ST.runStart || 0) < 45000)) return;
  ST.running = false;

  // 快速路径：重开面板且内存里已有完整数据时，只比对一次 meta.json（很小），
  // 没有新数据就什么都不做 —— 不闪「读取中」，也不重读文件。
  if (ST.status === "ready" && cacheComplete()) {
    try {
      await loadMetaOnce();
      const m = ST.meta;
      if (m && m.generated === true && m.generatedFor === m.capturedAtMs) {
        await diagLog("跳过(无新数据)");
        return;
      }
    } catch (e) { /* 读不到就往下走正常流程 */ }
  }

  let gen = false;
  ST.running = true;
  ST.runStart = Date.now();
  ST.status = "loading";
  ST.prog = 0;
  ST.msg = "读取中…";
  bump();
  try {
    // ① 钩子有新数据时，先用 raw_<key>.json 重建派生文件（重建完内容已在 ST.cache，可直接上屏）
    const gen = await ensureGenerated();
    // ② 剩下还没进内存的，照旧分块读盘
    for (let i = 0; i < FILES.length; i++) {
      const n = FILES[i].tab;
      if (typeof ST.cache[n] === "string" && ST.cache[n]) continue; // 懒生成已填好，免二次读盘
      try {
        await loadFile(n);
      } catch (e) {
        ST.cache[n] = ST.cache[n] || "";
      }
    }
    ST.status = "ready";
    ST.msg = "";
    ST.prog = 0;
  } catch (e) {
    ST.status = "ready";
    ST.msg = "读取失败：" + (e && e.message ? e.message : e);
  }
  ST.running = false;
  bump();
  try { await diagLog("完成 gen=" + gen + " 用时" + (Date.now() - ST.runStart) + "ms"); } catch (e) { /* 诊断绝不影响主流程 */ }
}

/** 只补读某一个 tab（预加载还没跑完时点到的） */
async function ensureTab(name) {
  if (ST.cache[name] !== undefined) return;
  try {
    await loadFile(name);
    if (!ST.running) bump();
  } catch (e) { /* ignore */ }
}

/** 短命轮询：异步读盘期间，隔一会儿捅一次状态，尝试触发重绘（ready 后自行停止） */
function startWatch() {
  if (ST.watching) return;
  if (typeof setTimeout !== "function") return;
  ST.watching = true;
  let n = 0;
  const step = () => {
    n++;
    try { if (SET.tick) SET.tick(ST.rev + n * 0.001); } catch (e) { /* ignore */ }
    if (ST.status !== "ready" && n < 90) {
      try { ST.watchTimer = setTimeout(step, 500); } catch (e) { ST.watching = false; }
    } else {
      ST.watching = false;
    }
  };
  try { ST.watchTimer = setTimeout(step, 400); } catch (e) { ST.watching = false; }
}

function Screen(ctx) {
  CTX = ctx;
  const [tick, setTick] = ctx.useState("tick", ST.rev);
  const [tab, setTab] = ctx.useState("tab", "索引");
  const [query, setQuery] = ctx.useState("query", "");
  const [stick, setStick] = ctx.useState("stick", false);
  SET = { tick: setTick };
  const colors = ctx.MaterialTheme.colorScheme;
  const busy = ST.status === "loading";

  // ---------- 同步动作（一律只改 state，必定刷新） ----------

  function selectTab(name) {
    setQuery("");
    setStick(false);
    setTab(name);
    ensureTab(name);
  }

  function search(v) {
    setQuery(v);
  }

  function toggleJump() {
    const next = !stick;
    setStick(next);
    // 切到「贴底」时补一次内容更新：LazyColumn 的 autoScrollToEnd 是在内容变化时执行的，
    // 只翻开关不够，必须让列表收到一次新数据，才会立刻滚到已加载内容的末尾。
    if (next) bump();
  }

  // 原「刷新」按钮已删除：面板打开时本来就会自动比对 meta、有新数据就懒生成，
// 手动刷新是多余的（而且它走异步链路，在这个 DSL 里还需要再点一下才显示）。

  // ---------- 视觉小件 ----------

  function chip(name) {
    const sel = tab === name;
    return ctx.UI.Surface(
      {
        shape: { cornerRadius: 9 },
        containerColor: sel ? colors.primary : colors.surfaceVariant,
        alpha: sel ? 1 : 0.5,
        padding: { horizontal: 11, vertical: 6 },
        onClick: () => { if (!sel) selectTab(name); }
      },
      [
        ctx.UI.Text({
          text: name,
          style: "labelSmall",
          fontWeight: sel ? "bold" : "normal",
          color: sel ? colors.onPrimary : colors.onSurfaceVariant
        })
      ]
    );
  }

  function emptyBlock(title, hint) {
    return ctx.UI.Column(
      { fillMaxWidth: true, horizontalAlignment: "center", spacing: 10, paddingVertical: 30 },
      [
        ctx.UI.Icon({ name: "description", tint: colors.onSurfaceVariant.copy({ alpha: 0.35 }), size: 40 }),
        ctx.UI.Text({ text: title, style: "titleSmall", color: colors.onSurfaceVariant }),
        ctx.UI.Text({ text: hint, style: "labelSmall", color: colors.onSurfaceVariant.copy({ alpha: 0.65 }) })
      ]
    );
  }

  // ---------- 内容切分（纯内存，读 ST） ----------

  const text = ST.cache[tab] !== undefined ? ST.cache[tab] : "";
  const allLines = text ? text.split("\n") : [];
  const key = query.trim();
  const matched = key ? allLines.filter(line => line.indexOf(key) >= 0) : allLines;
  const shown = matched;

  const blocks = [];
  for (let i = 0; i < shown.length; i += CHUNK_LINES) {
    blocks.push(shown.slice(i, i + CHUNK_LINES).join("\n"));
  }

  const meta = ST.meta;
  const curSnap = (ST.snaps || []).filter(function (s) { return s && s.key === ST.key; })[0];
  const curId = ST.curId || currentChatId();
  let srcTag = "";
  if (ST.isLegacy) {
    srcTag = "⚠ 旧的单文件数据 · 发一条消息即切换到按对话分存";
  } else if (curSnap) {
    const same = curId && curSnap.chatId && curSnap.chatId === curId;
    const pv = String(curSnap.preview || "").slice(0, 14);
    srcTag = (same ? "✓ 当前对话" : "其他对话") + (pv ? "：" + pv : "");
  } else if (curId) {
    srcTag = "当前对话还没有快照";
  }
  const metaLine = meta && meta.capturedAt
    ? "抓取 " + meta.capturedAt + (srcTag ? " · " + srcTag : "")
    : "等待首次抓取 · 发一条消息即可";

  const statusText = "共 " + matched.length + " 行" + (key ? " · 含「" + key + "」" : "");

  // ---------- 组装 ----------

  const children = [];

  children.push(
    ctx.UI.Surface(
      { fillMaxWidth: true, shape: { cornerRadius: 18 }, containerColor: colors.primaryContainer, padding: 16 },
      [
        ctx.UI.Row({ verticalAlignment: "center" }, [
          ctx.UI.Icon({ name: "description", tint: colors.onPrimaryContainer, size: 24 }),
          ctx.UI.Spacer({ width: 12 }),
          ctx.UI.Column({ weight: 1, spacing: 3 }, [
            ctx.UI.Text({ text: "完整提示词", style: "titleMedium", fontWeight: "bold", color: colors.onPrimaryContainer }),
            ctx.UI.Text({ text: metaLine, style: "labelSmall", color: colors.onPrimaryContainer.copy({ alpha: 0.82 }), maxLines: 2 })
          ])
        ])
      ]
    )
  );

  const navChildren = [];
  for (let i = 0; i < FILES.length; i++) {
    navChildren.push(chip(FILES[i].tab));
    if (i < FILES.length - 1) navChildren.push(ctx.UI.Spacer({ width: 6 }));
  }
  const NavRow = ctx.UI.LazyRow || ctx.UI.Row;
  children.push(NavRow({ fillMaxWidth: true }, navChildren));

  children.push(
    ctx.UI.Row({ verticalAlignment: "center", spacing: 8 }, [
      ctx.UI.Text({ text: statusText, style: "labelSmall", color: colors.onSurfaceVariant, weight: 1 }),
      ctx.UI.Button({
        text: stick ? "回顶" : "到底",
        onClick: () => toggleJump(),
        enabled: matched.length > 0,
        contentPadding: { horizontal: 10, vertical: 4 },
        shape: { cornerRadius: 8 }
      })
    ])
  );

  children.push(
    ctx.UI.TextField({
      value: query,
      onValueChange: (v) => search(v),
      placeholder: "在本文件里搜关键词",
      singleLine: true
    })
  );

  if (busy) {
    const bar = { fillMaxWidth: true };
    if (ST.prog > 0) bar.progress = ST.prog;
    children.push(ctx.UI.LinearProgressIndicator(bar));
    if (ST.msg) children.push(ctx.UI.Text({ text: ST.msg, style: "labelSmall", color: colors.onSurfaceVariant }));
  }

  if (meta && meta.ok === false && meta.error) {
    children.push(
      ctx.UI.Row({ verticalAlignment: "center" }, [
        ctx.UI.Icon({ name: "error", tint: colors.error, size: 18 }),
        ctx.UI.Spacer({ width: 8 }),
        ctx.UI.Text({ text: "钩子报错：" + meta.error, style: "labelSmall", color: colors.error, weight: 1 })
      ])
    );
  }

  if (blocks.length === 0) {
    if (!busy) {
      if (key) children.push(emptyBlock("没有匹配的行", "换个关键词再试"));
      else children.push(emptyBlock("这份文件还是空的", "发一条消息触发抓取，面板会自动更新"));
    }
  } else {
    for (let i = 0; i < blocks.length; i++) {
      children.push(ctx.UI.Markdown({ text: blocks[i], fontSize: 12 }));
    }
  }

  if (!busy && ST.msg) {
    children.push(ctx.UI.Text({ text: ST.msg, style: "labelSmall", color: colors.onSurfaceVariant }));
  }

  children.push(
    ctx.UI.Text({
      text: "文件在 /sdcard/Download/Operit/prompt_viewer/ · 本对话ID "
        + (curId ? curId.slice(0, 8) : "取不到(getChatId不可用)")
        + " · 显示的是 " + (ST.key || "-") + " 那份",
      style: "labelSmall",
      color: colors.onSurfaceVariant.copy({ alpha: 0.55 })
    })
  );
  if (ST.genErr) {
    children.push(
      ctx.UI.Text({ text: "生成未完成：" + ST.genErr, style: "labelSmall", color: colors.error })
    );
  }

  return ctx.UI.LazyColumn(
    {
      key: "pv-" + (stick ? "bottom" : "top"),
      autoScrollToEnd: stick,
      fillMaxSize: true,
      spacing: 10,
      padding: { horizontal: 12, vertical: 14 },
      onLoad: () => {
        // 每次打开都走一遍 preloadAll：
        // 内存里已有完整数据时，它只比对一次 meta.json，没新数据就静默返回（不闪「读取中」）；
        // 钩子写了新数据时，它会用 raw_payload.json 懒生成派生文件。
        // 注意：不能因为 ST.status === "ready" 就直接 return —— 那会导致面板重开后
        // 读不到新抓取的数据，只能靠手点「刷新」。
        startWatch();
        if (ST.running) return;       // 正在加载中，别重入
        return preloadAll();          // 返回 Promise，交给 DSL 在完成后重渲染
      }
    },
    children
  );
}

exports.default = Screen;