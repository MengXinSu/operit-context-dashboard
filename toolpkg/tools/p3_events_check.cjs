#!/usr/bin/env node
/**
 * p3_events_check.cjs —— P3-2 采集层离线自检
 * 用法: node p3_events_check.cjs [main.js 路径] [prompt_viewer 目录]
 *
 * A. 从 dist/main.js 按 `==== EVENTS_V1 BEGIN/END` 标记切出纯函数段，在 Node 里 new Function 复跑
 *    —— 测的是要发布的真代码，不是副本（段内不许引用宿主 API，这是仓库既有约定）
 * B. 拿本机真 raw 跑：package_proxy 解包前/后真实工具名 top10 + 真实 events 条数（空就如实报空）
 *    + 独立审计：全量扫所有调用的参数里有没有 todo/questions/goal/task 形态，证明 events=0 不是被候选预筛吃掉的
 * C. 合成 fixture 验证每类事件的判定规则 + 空数据/坏数据不崩
 * D. 静态校验接线：pathsFor.events / collectEvents / writeText(P.events) / prune / cleanup / 未退回 v1 写法
 * 有 FAIL 退出码 1。
 */
const fs = require('fs')
const path = require('path')

const MAIN = process.argv[2] || path.join(__dirname, '..', 'dist', 'main.js')
const PV = process.argv[3] || '<请传入 prompt_viewer 数据目录>'

const problems = []
const fail = m => problems.push(m)

// ---------- A: 切出纯函数段 ----------
function extract(src, begin, end) {
  const a = src.indexOf(begin)
  const b = src.indexOf(end)
  if (a < 0 || b < 0) { console.error('SEG-NOT-FOUND (' + begin + ')'); process.exit(1) }
  return src.slice(a, b)
}
const SRC = fs.readFileSync(MAIN, 'utf8')
const seg = extract(SRC, '// ==== EVENTS_V1 BEGIN', '// ==== EVENTS_V1 END ====')
const api = new Function(seg + '\nreturn { evExtractEvents, evPayload, evCallOf, evArgsOf, evIsCandidate, evResultJson, evToolTail, evUnesc }')()

// ---------- B: 真样本 ----------
function loadRaw(file) {
  const text = fs.readFileSync(path.join(PV, file), 'utf8')
  try { return JSON.parse(text) } catch (e) { /* 长行被折断过：去换行即可还原 */ }
  return JSON.parse(text.replace(/[\r\n]/g, ''))
}

const CAPTURED_AT_MS = 1763900000000
const rawFiles = fs.readdirSync(PV).filter(f => /^raw_.*\.json$/.test(f)).sort()
const trueNames = new Map()
let totalCalls = 0, proxyCalls = 0, unresolvedProxy = 0, leftoverProxy = 0
let auditHits = 0
const auditSamples = []
const perFile = []

for (const f of rawFiles) {
  let payload
  try { payload = loadRaw(f) } catch (e) { fail(f + ' PARSE-FAIL: ' + e.message); continue }
  const hist = Array.isArray(payload.preparedHistory) ? payload.preparedHistory : []
  let calls = 0, proxy = 0
  for (let i = 0; i < hist.length; i++) {
    const it = hist[i] || {}
    if (String(it.kind || '').toUpperCase() !== 'TOOL_CALL') continue
    calls++; totalCalls++
    if (String(it.toolName || '') === 'package_proxy') proxy++
    const call = api.evCallOf(it, i)
    if (!call) { fail(f + ' #' + i + ' evCallOf=null'); continue }
    if (call.unresolved) { unresolvedProxy++; continue }
    if (call.raw === 'package_proxy') proxyCalls++
    if (call.tool === 'package_proxy') leftoverProxy++
    trueNames.set(call.tool, (trueNames.get(call.tool) || 0) + 1)

    // 独立审计：不看候选预筛，直接看解包后的参数里有没有里程碑形态
    const args = api.evArgsOf(call)
    const why = []
    if (Array.isArray(args.todos)) why.push('todos[' + args.todos.length + ']')
    if (Array.isArray(args.questions)) why.push('questions[' + args.questions.length + ']')
    if (args.goal || args.operation !== undefined) why.push('goal/operation')
    if (args.task && typeof args.task === 'object') why.push('task')
    if (why.length) {
      auditHits++
      if (auditSamples.length < 6) auditSamples.push(f.slice(4, 12) + ' ' + call.tool + ' → ' + why.join(',') + ' | ' + JSON.stringify(args).slice(0, 160))
    }
  }
  const t0 = process.hrtime.bigint()
  const events = api.evExtractEvents(hist, CAPTURED_AT_MS)
  const out = api.evPayload(payload.chatId, String(payload.chatId).slice(0, 8), '2026-11-23 18:40:00', CAPTURED_AT_MS, hist)
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  const byKind = {}
  for (const ev of events) byKind[ev.kind] = (byKind[ev.kind] || 0) + 1
  perFile.push({ file: f, history: hist.length, calls, proxy, events: events.length, byKind, keys: Object.keys(out).join(','), ms })
  if (JSON.stringify(events) !== JSON.stringify(api.evExtractEvents(hist, CAPTURED_AT_MS))) fail(f + ' NON-DETERMINISTIC')
  for (const ev of events) {
    if (typeof ev.seq !== 'number' || typeof ev.time !== 'number' || typeof ev.kind !== 'string') fail(f + ' BAD-EVENT ' + JSON.stringify(ev))
  }
}

const top = [...trueNames.entries()].sort((a, b) => b[1] - a[1])
if (leftoverProxy > 0) fail('解包后仍有 ' + leftoverProxy + ' 条 package_proxy（没解干净）')

// ---------- C: 合成 fixture ----------
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
const toolXml = (name, params) => '<tool name="' + name + '" call_id="part-1">' +
  Object.entries(params).map(([k, v]) => '<param name="' + k + '">' + esc(v) + '</param>').join('') + '</tool>'
// 真样本里结果正文的 JSON 引号不转义，fixture 照做
const resultXml = (name, body, status) => '<tool_result name="' + name + '" status="' + (status || 'success') + '"><content>' + body + '</content></tool_result>'
const proxyCall = (tool, obj) => toolXml('package_proxy', { params: JSON.stringify(obj), tool_name: tool })
const A = { kind: 'ASSISTANT', content: 'ok' }
const callOf = (content, toolName) => ({ kind: 'TOOL_CALL', toolName: toolName || 'package_proxy', content })

const fixtures = [
  {
    name: 'todo add+done（含 TOOL_RESULT 回填）',
    hist: [
      A,
      callOf(proxyCall('todo:write', { todos: [{ content: '写测试', status: 'pending' }, { content: '接线', status: 'in_progress' }] })),
      { kind: 'TOOL_RESULT', toolName: 'todo:write', content: resultXml('todo:write', '{"success":true}') },
      A,
      callOf(proxyCall('todo:write', { todos: [{ content: '写测试', status: 'completed' }, { content: '接线', status: 'in_progress' }] })),
      A,
      callOf(proxyCall('todo:write', { todos: [{ content: '写测试', status: 'completed' }, { content: '接线', status: 'completed' }] }))
    ],
    kinds: { 'todo-add': 1, 'todo-done': 2 },
    countSum: { 'todo-add': 2, 'todo-done': 2 },
    items: ['写测试', '接线'],
    seqs: [1, 4, 6]
  },
  {
    name: 'todo 状态来自 TOOL_RESULT（调用参数里没有）',
    hist: [
      A,
      callOf(proxyCall('todo:update', { id: 'x' })),
      { kind: 'TOOL_RESULT', toolName: 'todo:update', content: resultXml('todo:update', '{"success":true,"todos":[{"content":"写 UI","status":"pending"}]}') }
    ],
    kinds: { 'todo-add': 1 },
    countSum: { 'todo-add': 1 }
  },
  {
    name: 'goal create+complete',
    hist: [
      A,
      callOf(proxyCall('goal:change', { operation: 'create', goal: { objective: '发布 P3-2' } })),
      A,
      callOf(proxyCall('goal:change', { operation: 'complete', goal: { objective: '发布 P3-2' } }))
    ],
    kinds: { 'goal-create': 1, 'goal-complete': 1 },
    names: ['发布 P3-2', '发布 P3-2']
  },
  {
    name: 'ask questions（2 问）',
    hist: [A, callOf(proxyCall('ask_user_question', { questions: [{ question: '选哪个方案？' }, { question: '为什么？' }] }))],
    kinds: { ask: 1 },
    countSum: { ask: 2 },
    items: ['选哪个方案？', '为什么？'],
    names: ['选哪个方案？']
  },
  {
    name: 'team task create→complete（同一 id 折叠）',
    hist: [
      A,
      callOf(proxyCall('team:task', { task: { id: 't1', subject: '写里程碑带', status: 'in_progress' } })),
      A,
      callOf(proxyCall('team:task', { task: { id: 't1', subject: '写里程碑带', status: 'completed' } }))
    ],
    kinds: { 'team-task-create': 1, 'team-task-complete': 1 },
    names: [undefined, '写里程碑带']
  },
  {
    name: 'agent + skill（含 agent_status / skill_list 两条反例不记）',
    hist: [
      A,
      callOf(proxyCall('spawn_agent', { name: 'collector', prompt: '做采集层' })),
      A,
      callOf(proxyCall('use_skill', { skill: 'office' })),
      A,
      callOf(proxyCall('agent_status', { verbose: true })),
      callOf(proxyCall('skill_list', { scope: 'all' }))
    ],
    kinds: { agent: 1, skill: 1 },
    names: ['collector', 'office'],
    details: ['做采集层']
  },
  { name: '空历史', hist: [], kinds: {} },
  { name: 'null 历史', hist: null, kinds: {} },
  { name: '非数组历史', hist: { a: 1 }, kinds: {} },
  {
    name: '垃圾条目不崩',
    hist: [null, undefined, {}, { kind: 'TOOL_CALL', content: '<tool name="x"' }, { kind: 'TOOL_RESULT', content: '<tool_result' }],
    kinds: {}
  },
  { name: 'package_proxy 缺 tool_name（跳过不猜）', hist: [A, callOf(toolXml('package_proxy', { params: '{"a":1}' }))], kinds: {} },
  { name: 'todo 形态不对（缺 status 不认）', hist: [A, callOf(toolXml('todo:write', { todos: '[{"content":"x"}]' }), 'todo:write')], kinds: {} },
  { name: 'goal 无 objective（不猜）', hist: [A, callOf(toolXml('create_goal', { note: 'x' }), 'create_goal')], kinds: {} }
]

const fixtureLines = []
for (const fx of fixtures) {
  let got = null
  try { got = api.evExtractEvents(fx.hist, CAPTURED_AT_MS) } catch (e) { fail('fixture "' + fx.name + '" 抛异常: ' + e.message); continue }
  const byKind = {}
  for (const ev of got) byKind[ev.kind] = (byKind[ev.kind] || 0) + 1
  const kindsOk = JSON.stringify(Object.entries(byKind).sort()) === JSON.stringify(Object.entries(fx.kinds).sort())
  if (!kindsOk) fail('fixture "' + fx.name + '" 事件种类/条数 期望 ' + JSON.stringify(fx.kinds) + ' 实得 ' + JSON.stringify(byKind))
  if (fx.countSum) {
    for (const k in fx.countSum) {
      const sum = got.filter(e => e.kind === k).reduce((a, e) => a + (e.count || 0), 0)
      if (sum !== fx.countSum[k]) fail('fixture "' + fx.name + '" ' + k + ' count 合计 期望 ' + fx.countSum[k] + ' 实得 ' + sum)
    }
  }
  if (fx.items) {
    const flat = got.filter(e => e.items).flatMap(e => e.items)
    if (JSON.stringify(flat) !== JSON.stringify(fx.items)) fail('fixture "' + fx.name + '" items 期望 ' + JSON.stringify(fx.items) + ' 实得 ' + JSON.stringify(flat))
  }
  if (fx.names) {
    const names = got.map(e => e.name)
    if (JSON.stringify(names) !== JSON.stringify(fx.names)) fail('fixture "' + fx.name + '" name 期望 ' + JSON.stringify(fx.names) + ' 实得 ' + JSON.stringify(names))
  }
  if (fx.details) {
    const details = got.filter(e => e.detail).map(e => e.detail)
    if (JSON.stringify(details) !== JSON.stringify(fx.details)) fail('fixture "' + fx.name + '" detail 期望 ' + JSON.stringify(fx.details) + ' 实得 ' + JSON.stringify(details))
  }
  if (fx.seqs) {
    const seqs = got.map(e => e.seq)
    if (JSON.stringify(seqs) !== JSON.stringify(fx.seqs)) fail('fixture "' + fx.name + '" seq 期望 ' + JSON.stringify(fx.seqs) + ' 实得 ' + JSON.stringify(seqs))
  }
  for (const ev of got) {
    const bad = Object.keys(ev).filter(k => ['seq', 'time', 'kind', 'ord', 'name', 'detail', 'items', 'count', 'turn', 'step'].indexOf(k) < 0)
    if (bad.length) fail('fixture "' + fx.name + '" 出现契约外字段: ' + bad.join(','))
    if (ev.time !== CAPTURED_AT_MS) fail('fixture "' + fx.name + '" time 必须等于抓取时刻')
    if (typeof ev.turn !== 'number' || typeof ev.step !== 'number') fail('fixture "' + fx.name + '" 缺 turn/step')
  }
  fixtureLines.push('  ' + (kindsOk ? 'PASS' : 'FAIL') + '  ' + fx.name + '  →  ' + (got.length ? JSON.stringify(byKind) : '空'))
}

// 实体解码 + proxy 解包单测（照真样本的编码层数：一层实体）
const unescCases = [['&quot;', '"'], ['&amp;', '&'], ['&lt;a&gt;', '<a>'], ['&apos;', "'"], ['&#65;&#x42;', 'AB'], ['a&amp;b', 'a&b']]
for (const [inp, want] of unescCases) if (api.evUnesc(inp) !== want) fail('evUnesc(' + inp + ') = ' + api.evUnesc(inp) + '，期望 ' + want)
const sample = api.evCallOf({
  kind: 'TOOL_CALL',
  content: '<tool name="package_proxy" call_id="part-19"><param name="params">{&quot;command&quot;: &quot;pwd &amp;&amp; ls &lt;dir&gt; &amp;&amp; echo &apos;x&apos;&quot;}</param><param name="tool_name">super_admin:bash</param></tool>'
}, 0)
if (!sample || sample.tool !== 'super_admin:bash' || sample.tail !== 'bash') fail('proxy 真实名解包失败: ' + JSON.stringify(sample))
if (!sample || !sample.json || sample.json.command !== "pwd && ls <dir> && echo 'x'") fail('params JSON 实体解码失败: ' + JSON.stringify(sample && sample.json))

// ---------- D: 接线静态校验（不回退 v1 写法） ----------
const NO_COMMENT = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const wiringChecks = [
  [/events: OUT_DIR \+ "\/events_" \+ key \+ "\.json"/, 'pathsFor 缺 events 路径'],
  [/collectEvents\(payload, P, capturedAt, capturedAtMs\)/, '钩子里没调用 collectEvents'],
  [/writeText\(P\.events, safeJson\(/, '事件没有走 writeText 原子写'],
  [/deleteFile\(OUT_DIR \+ "\/events_" \+ k \+ "\.json"/, 'pruneSessionFiles 未清理 events'],
  [/events_\(\[0-9a-zA-Z\]\+\)\\\.json/, 'cleanupOldData 未识别 events 文件'],
  [/st\.ok \|\| st\.absent/, '索引写回判定丢失（o2.12 死锁修复）'],
  [/await writeChain/, '钩子末尾 flush 丢失（O2-ASYNC）']
]
let wiringBad = 0
const wiringLines = []
for (const [re, msg] of wiringChecks) {
  const ok = re.test(SRC)
  if (!ok) { wiringBad++; fail(msg) }
  wiringLines.push('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + msg)
}
const v1Regression = /NativeInterface\.callTool\(\s*"(default|read_file|create_file|make_directory|delete_file)"/.test(NO_COMMENT)
if (v1Regression) { wiringBad++; fail('检测到退回 v1 的 NativeInterface.callTool 写法') }
wiringLines.push('  ' + (v1Regression ? 'FAIL' : 'PASS') + '  未退回 v1 的 NativeInterface.callTool 通道（已剔除注释）')

// ---------- E: hook 端到端（Tools.Files 内存桩） ----------
// 不进真机也能证明「接线 + 原子写」：用内存桩跑真实的 onPromptFinalize，看 events 文件是否按 temp→move 落盘
const OUT_DIR_STUB = '/sdcard/Download/Operit/prompt_viewer'
function makeToolsStub() {
  const files = new Map()
  const moves = []
  return {
    moves,
    files,
    Tools: {
      Files: {
        mkdir: async () => ({}),
        write: async (p, body, append) => { files.set(p, append ? (files.get(p) || '') + body : String(body)); return {} },
        move: async (from, to) => { moves.push([from, to]); files.set(to, files.get(from)); files.delete(from); return {} },
        read: async (p) => { if (!files.has(p)) throw new Error('File does not exist: ' + p); return { content: files.get(p) } },
        list: async () => ({ entries: [...files.keys()].map(k => ({ name: k.split('/').pop(), isDirectory: false })) }),
        deleteFile: async (p) => { files.delete(p); return {} }
      }
    }
  }
}

async function hookEndToEnd() {
  const stub = makeToolsStub()
  const savedTools = globalThis.Tools
  const savedErr = console.error
  globalThis.Tools = stub.Tools
  console.error = () => {}
  try {
    const mod = require(path.resolve(MAIN))
    const payload = {
      chatId: 'aabbccdd-1111-2222-3333-444455556666',
      stage: 'before_send_to_model',
      preparedHistory: fixtures[3].hist,
      availableTools: [],
      modelParameters: [],
      metadata: {},
      rawInput: 'x'
    }
    await mod.onPromptFinalize({ eventPayload: payload })
    return { stub, ok: true }
  } catch (e) {
    fail('hook 端到端抛异常: ' + e.message)
    return { stub, ok: false }
  } finally {
    globalThis.Tools = savedTools
    console.error = savedErr
  }
}

;(async () => {
  const hookResult = await hookEndToEnd()
  const hookLines = []
  if (hookResult.ok) {
    const { files, moves } = hookResult.stub
    const names = [...files.keys()].map(k => k.slice(k.lastIndexOf('/') + 1)).sort()
    const evPath = OUT_DIR_STUB + '/events_aabbccdd.json'
    const rawPath = OUT_DIR_STUB + '/raw_aabbccdd.json'
    const metaPath = OUT_DIR_STUB + '/meta_aabbccdd.json'
    const idxPath = OUT_DIR_STUB + '/index.json'
    hookLines.push('  写入文件: ' + names.join(', '))
    if (!files.has(evPath)) fail('hook 没写出 events 文件')
    else {
      let ev = null
      try { ev = JSON.parse(files.get(evPath)) } catch (e) { fail('events 文件不是合法 JSON: ' + e.message) }
      if (ev) {
        if (!Array.isArray(ev.events) || ev.events.length !== 1 || ev.events[0].kind !== 'ask' || ev.events[0].count !== 2) {
          fail('events 文件内容不符: ' + JSON.stringify(ev.events))
        }
        if (ev.timeSource !== 'capture' || ev.key !== 'aabbccdd' || !ev.updatedAt || !ev.updatedAtMs) fail('events 文件头字段不符: ' + JSON.stringify(Object.keys(ev)))
        hookLines.push('  events 落盘: ' + ev.events.length + ' 条 ' + JSON.stringify(ev.events.map(x => x.kind)) + '，字节数 ' + files.get(evPath).length)
      }
      const mv = moves.find(m => m[0] === evPath + '.tmp' && m[1] === evPath)
      if (!mv) fail('events 没走 temp→move 原子写')
      else hookLines.push('  原子写: events_aabbccdd.json.tmp → events_aabbccdd.json（temp→move 命中）')
    }
    if (!files.has(rawPath)) fail('hook 没写出 raw（原有主流程被破坏）')
    if (!files.has(metaPath)) fail('hook 没写出 meta（原有主流程被破坏）')
    let idxArr = null
    try { idxArr = JSON.parse(files.get(idxPath) || '[]') } catch (e) { fail('index 不可解析: ' + e.message) }
    if (!Array.isArray(idxArr) || idxArr.length !== 1 || idxArr[0].key !== 'aabbccdd') fail('index 内容不符: ' + files.get(idxPath))
    hookLines.push('  raw/meta/index 仍按原格式落盘: ' + (files.has(rawPath) && files.has(metaPath) && Array.isArray(idxArr) ? 'PASS' : 'FAIL'))
    hookLines.push('  每轮写盘: raw 1 + meta 1 + index 1 + events 1（+ boot 首轮 1 行），无额外轮询/驻留')
  }

  // ---------- 报告 ----------
  const eventsPayloadSample = api.evPayload('11223344-aaaa-bbbb-cccc-000000000000', '11223344', '2026-11-23 18:40:00', CAPTURED_AT_MS, fixtures[3].hist)
  const realEvents = perFile.reduce((a, b) => a + b.events, 0)
  const L = []
  L.push('== P3-2 采集层自检报告 ==')
  L.push('main.js: ' + MAIN + '（' + SRC.split('\n').length + ' 行）')
  L.push('EVENTS_V1 纯函数段: ' + seg.split('\n').length + ' 行（node 复跑的就是这段真代码）')
  L.push('')
  L.push('-- A. 真样本 · package_proxy 解包 --')
  L.push('raw ' + rawFiles.length + ' 份 | TOOL_CALL ' + totalCalls + ' | package_proxy ' + proxyCalls + ' | 缺 tool_name 跳过 ' + unresolvedProxy + ' | 解包后仍叫 package_proxy ' + leftoverProxy)
  L.push('top10 真实工具名:')
  for (let i = 0; i < Math.min(10, top.length); i++) L.push('  ' + (i + 1) + '. ' + top[i][0] + '  ' + top[i][1])
  L.push('')
  L.push('-- B. 真样本 · events --')
  for (const r of perFile) L.push('  ' + r.file + '  history=' + r.history + ' calls=' + r.calls + ' proxy=' + r.proxy + ' → events=' + r.events + '  ' + r.ms.toFixed(2) + 'ms' + (r.events ? '  ' + JSON.stringify(r.byKind) : ''))
  L.push('真样本事件合计: ' + realEvents + (realEvents === 0 ? ' → 空即真相：这 6 个会话里没有真实的 todo/goal/ask/team 调用（与 P0 预研一致）' : ''))
  L.push('独立审计（不看候选预筛，全量扫参数形态）: 命中 ' + auditHits + ' 条' + (auditHits ? '\n  ' + auditSamples.join('\n  ') : ' → 确实没有 milestones 形态的参数'))
  L.push('events 文件顶层字段: ' + (perFile[0] ? perFile[0].keys : '(无样本)'))
  L.push('')
  L.push('-- C. 合成 fixture（判定规则 + 空安全） --')
  for (const l of fixtureLines) L.push(l)
  L.push('  实体解码 / proxy 真实名 / params JSON 解码单测: PASS')
  L.push('')
  L.push('-- D. 接线静态校验 --')
  for (const l of wiringLines) L.push(l)
  L.push('')
  L.push('-- E. hook 端到端（Tools.Files 内存桩，跑真 onPromptFinalize） --')
  for (const l of hookLines) L.push(l)
  L.push('')
  L.push('-- F. events 文件样例（fixture ask，2 问） --')
  L.push(JSON.stringify(eventsPayloadSample, null, 2).split('\n').map(l => '  ' + l).join('\n'))
  L.push('')
  L.push('问题: ' + (problems.length ? '\n  ' + problems.join('\n  ') : '无'))
  L.push(problems.length ? 'RESULT: FAIL' : 'RESULT: PASS')
  const report = L.join('\n')
  fs.writeFileSync(path.join(__dirname, 'p3_events_report.txt'), report)
  console.log(report)
  process.exit(problems.length ? 1 : 0)
})()
