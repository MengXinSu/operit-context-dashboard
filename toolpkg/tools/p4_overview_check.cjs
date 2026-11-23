#!/usr/bin/env node
/**
 * p4_overview_check.cjs —— P4-5A apiOverview 离线自检
 * 用法: node p4_overview_check.cjs [index.ui.js 路径] [prompt_viewer 目录]
 *
 * 与 p3_events_check.cjs 同一个思路：**跑要发布的真代码**，不复制副本。
 * 这里不是切纯函数段，而是用 new Function 把整份 index.ui.js 加载进 Node，
 * 只桩掉宿主对象 Tools.Files / getChatId —— 于是 apiOverview 的异步文件路径
 * （listChatmsgFiles / readText）和 ovBuild 的聚合逻辑全都被真实执行。
 *
 * 覆盖：
 *   A. 真样本：字段结构、7×24 天序列、56 天热力图、会话排序、KPI 与日序列自洽、
 *      **只读 index.json + chatmsg-*.jsonl（证明零 raw 读）**、独立参考实现核对 token/turn
 *   B. 性能：真样本 + 合成重载（14 文件 × 1500 行 = 21000 行 / 100 会话）计时
 *   C. 边界：空目录、坏 index.json、坏 chatmsg 行、cached > input、done=false、超出窗口的旧行
 *   D. 静态接线：dispatch 里有 method === "overview" → apiOverview(req.range, req.files)
 * 有 FAIL 退出码 1。
 */
const fs = require('fs')
const path = require('path')

const BRIDGE = process.argv[2] || path.join(__dirname, '..', 'dist', 'ui', 'dashboard', 'index.ui.js')
const PV = process.argv[3] || '<请传入 prompt_viewer 数据目录>'
const REMOTE = '/sdcard/Download/Operit/prompt_viewer'

const problems = []
const fail = m => problems.push(m)
const ok = m => console.log('  ok   ' + m)

// ---------- 加载真桥层（桩掉宿主 API） ----------
function loadBridge(pvDir, reads) {
  const src = fs.readFileSync(BRIDGE, 'utf8')
  const local = p => {
    const s = String(p)
    if (s === REMOTE) return pvDir
    if (s.indexOf(REMOTE + '/') === 0) return path.join(pvDir, s.slice(REMOTE.length + 1))
    return null
  }
  const Tools = {
    Files: {
      list: async dir => {
        const lp = local(dir)
        if (!lp || !fs.existsSync(lp)) return { entries: [] }
        return {
          entries: fs.readdirSync(lp).map(name => ({
            name,
            isDirectory: fs.statSync(path.join(lp, name)).isDirectory()
          }))
        }
      },
      read: async p => {
        reads.push(String(p))
        const lp = local(p)
        if (!lp || !fs.existsSync(lp) || fs.statSync(lp).isDirectory()) return null
        return { content: fs.readFileSync(lp, 'utf8') }
      },
      write: () => true,
      mkdir: () => true,
      exists: async p => { const lp = local(p); return !!(lp && fs.existsSync(lp)) }
    }
  }
  const fn = new Function('exports', 'Tools', 'getChatId', 'ToolPkg',
    src + '\nreturn { apiOverview: apiOverview, ovBuild: ovBuild, ovDayKey: ovDayKey, ovDayList: ovDayList };')
  const api = fn({}, Tools, () => '', { readResource: () => '' })
  return api
}

function localDayKey(ms) {
  const d = new Date(ms), m = d.getMonth() + 1, dd = d.getDate()
  return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (dd < 10 ? '0' : '') + dd
}
function median(nums) {
  const s = nums.slice().sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

// 独立参考实现：只算「窗口内所有 done 行」的 in+out / 不重复 (session,sentAt)。
// 不共用 ov* 任何代码，用来核对聚合有没有漏行/重复计。
function refWindow(rows, fromMs, toMs) {
  let inTok = 0, outTok = 0, cached = 0, turns = 0, msgs = 0
  const seen = new Set(), sess = new Set()
  for (const r of rows) {
    if (!r || r.done !== true || !r.session) continue
    let ts = Number(r.sentAt) || 0
    if (!(ts > 0)) ts = Number(r.completedAt) || 0
    if (!(ts > 0)) ts = Number(r.atMs) || 0
    if (!(ts >= fromMs && ts <= toMs)) continue
    inTok += Number(r.inputTokens) || 0
    outTok += Number(r.outputTokens) || 0
    cached += Number(r.cachedInputTokens) || 0
    msgs++
    sess.add(r.session)
    const s = Number(r.sentAt) || 0
    if (s > 0) seen.add(r.session + '|' + s)
  }
  return { inTok, outTok, cached, turns: seen.size, msgs, sessions: sess.size }
}
function readAllChatRows(dir) {
  const rows = []
  for (const f of fs.readdirSync(dir).filter(f => /^chatmsg-.*\.jsonl$/.test(f)).sort()) {
    for (const ln of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!ln.trim()) continue
      try { rows.push(JSON.parse(ln)) } catch (e) { /* skip */ }
    }
  }
  return rows
}

async function main() {
  const now = new Date()
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0)
  const from7 = new Date(todayStart); from7.setDate(from7.getDate() - 6)

  // ================= A. 真样本 =================
  console.log('A. 真样本：' + PV)
  const reads = []
  const api = loadBridge(PV, reads)

  // A0 只读两类文件（且零 raw）
  const o7 = await api.apiOverview('7d')
  const oToday = await api.apiOverview('today')
  const rawReads = reads.filter(p => /raw_/.test(p))
  if (rawReads.length) fail('读了 raw：' + rawReads.slice(0, 3).join(', '))
  else ok('零 raw 读（' + reads.length + ' 次读全部是 index.json / chatmsg-*.jsonl）')
  const badReads = reads.filter(p => !/index\.json$|chatmsg-\d{8}\.jsonl$/.test(p))
  if (badReads.length) fail('读了非白名单文件：' + badReads.join(', '))
  else ok('读盘白名单：index.json + chatmsg-YYYYMMDD.jsonl')

  // A1 结构
  if (!o7.ok) fail('apiOverview(7d) ok!=true: ' + JSON.stringify(o7).slice(0, 200))
  const keys = ['ok', 'range', 'kpi', 'days', 'heat', 'sessions', 'models', 'costReady', 'coverage', 'ms']
  for (const k of keys) if (!(k in o7)) fail('缺字段 ' + k)
  ok('返回字段齐：' + keys.join(', '))

  if (o7.range !== '7d' || oToday.range !== 'today') fail('range 回显错')
  if (o7.days.length !== 7) fail('days 长度 != 7: ' + o7.days.length)
  else ok('days = 7 天（' + o7.days[0].date + ' → ' + o7.days[6].date + '，升序）')
  if (o7.days[6].date !== localDayKey(now.getTime())) fail('days 最后一天不是今天：' + o7.days[6].date)
  for (let i = 1; i < o7.days.length; i++) if (o7.days[i].date <= o7.days[i - 1].date) fail('days 未升序')
  if (o7.heat.length !== 56) fail('heat 长度 != 56: ' + o7.heat.length)
  else ok('heat = 56 天（' + o7.heat[0].date + ' → ' + o7.heat[55].date + '）')
  for (let i = 1; i < o7.heat.length; i++) if (o7.heat[i].date <= o7.heat[i - 1].date) fail('heat 未升序')
  if (o7.heat[55].date !== localDayKey(now.getTime())) fail('heat 末格不是今天')

  // A2 排序 + 会话卡字段
  for (let i = 1; i < o7.sessions.length; i++) {
    if ((o7.sessions[i - 1].lastActiveMs || 0) < (o7.sessions[i].lastActiveMs || 0)) fail('sessions 未按 lastActiveMs 降序')
  }
  const s0 = o7.sessions[0] || {}
  const sessKeys = ['key', 'chatId', 'preview', 'capturedAtMs', 'tokens', 'turns', 'cost', 'lastActiveMs', 'active', 'indexed', 'inTok', 'outTok', 'cachedTok']
  for (const k of sessKeys) if (!(k in s0)) fail('会话卡缺字段 ' + k)
  ok('会话卡字段齐（key/chatId/preview/capturedAtMs/tokens/turns/lastActiveMs/active/indexed/…），composition 有意缺省')

  // A3 KPI 与 7 天序列自洽：7d 窗口 = days 的 7 天
  const sumDayTok = o7.days.reduce((a, d) => a + d.tokens, 0)
  if (sumDayTok !== o7.kpi.billedTokens) fail('7d: sum(days.tokens)=' + sumDayTok + ' != kpi.billedTokens=' + o7.kpi.billedTokens)
  else ok('自洽：sum(days.tokens) = kpi.billedTokens = ' + sumDayTok)
  const sumDayTurns = o7.days.reduce((a, d) => a + d.turns, 0)
  if (sumDayTurns !== o7.kpi.turns) fail('7d: sum(days.turns)=' + sumDayTurns + ' != kpi.turns=' + o7.kpi.turns)
  else ok('自洽：sum(days.turns) = kpi.turns = ' + sumDayTurns)

  // A4 独立参考实现核对（真样本所有行都落在 7d 窗口内）
  const rows = readAllChatRows(PV)
  const ref7 = refWindow(rows, from7.getTime(), now.getTime())
  const todayStartMs = todayStart.getTime()
  const refToday = refWindow(rows, todayStartMs, now.getTime())
  const cmp = (label, got, want) => { if (got !== want) fail(label + ' 期望 ' + want + ' 实得 ' + got); else ok(label + ' = ' + want + '（与独立参考实现一致）') }
  cmp('7d kpi.inTok', o7.kpi.inTok, ref7.inTok)
  cmp('7d kpi.outTok', o7.kpi.outTok, ref7.outTok)
  cmp('7d kpi.billedTokens', o7.kpi.billedTokens, ref7.inTok + ref7.outTok)
  cmp('7d kpi.turns', o7.kpi.turns, ref7.turns)
  cmp('7d kpi.msgs', o7.kpi.msgs, ref7.msgs)
  cmp('7d kpi.sessions', o7.kpi.sessions, ref7.sessions)
  cmp('today kpi.billedTokens', oToday.kpi.billedTokens, refToday.inTok + refToday.outTok)
  cmp('today kpi.turns', oToday.kpi.turns, refToday.turns)
  cmp('today kpi.sessions', oToday.kpi.sessions, refToday.sessions)
  if (o7.kpi.cacheHit < 0 || o7.kpi.cacheHit > 1) fail('cacheHit 越界: ' + o7.kpi.cacheHit)
  else ok('cacheHit = ' + (o7.kpi.cacheHit * 100).toFixed(1) + '%（0..1 比例，cachedTok/inTok）')

  // A5 heat 的 sessions 指标 = index 快照口径（可覆盖 8 周）
  const idx = JSON.parse(fs.readFileSync(path.join(PV, 'index.json'), 'utf8').replace(/\r?\n/g, ''))
  const idxHeat = {}
  for (const e of idx) {
    const c = Number(e.capturedAtMs) || 0
    if (!c) continue
    const dk = localDayKey(c)
    if (o7.heat.some(h => h.date === dk)) idxHeat[dk] = (idxHeat[dk] || 0) + 1
  }
  const heatIdxSum = o7.heat.reduce((a, h) => a + h.sessions, 0)
  const wantIdxSum = Object.values(idxHeat).reduce((a, b) => a + b, 0)
  if (heatIdxSum !== wantIdxSum) fail('heat.sessions 合计 ' + heatIdxSum + ' != index 快照数 ' + wantIdxSum)
  else ok('heat.sessions 合计 = index 快照数 = ' + wantIdxSum + '（跨 ' + Object.keys(idxHeat).length + ' 天）')

  // A6 迟到数据不越界
  if (oToday.kpi.billedTokens > o7.kpi.billedTokens) fail('today tokens > 7d tokens')
  else ok('today ⊆ 7d（' + oToday.kpi.billedTokens + ' ≤ ' + o7.kpi.billedTokens + '）')

  console.log('\n  —— 真样本 7d 摘要 ——')
  console.log('  ' + JSON.stringify({
    kpi: o7.kpi,
    daysNonZero: o7.days.filter(d => d.tokens > 0).map(d => d.date + ':' + d.tokens),
    heatNonZero: o7.heat.filter(h => h.tokens > 0 || h.sessions > 0).length + '/56',
    sessions: o7.sessions.length,
    sessionsActiveInRange: o7.sessions.filter(s => s.active).length,
    models: o7.models.map(m => m.model + ':' + m.tokens),
    coverage: o7.coverage,
    ms: o7.ms
  }, null, 2).split('\n').map(l => '  ' + l).join('\n'))

  console.log('\n  —— 真样本 today ——')
  console.log('  ' + JSON.stringify({ kpi: oToday.kpi, activeSessions: oToday.sessions.filter(s => s.active).map(s => s.key), ms: oToday.ms }))

  // ================= B. 性能 =================
  console.log('\nB. 性能（目标 <50ms/次）')
  const times = []
  for (let i = 0; i < 15; i++) { const t0 = process.hrtime.bigint(); await api.apiOverview(i % 2 ? 'today' : '7d'); times.push(Number(process.hrtime.bigint() - t0) / 1e6) }
  const realMs = median(times)
  console.log('  真样本（7 会话 / 3 天 chatmsg，' + rows.length + ' 行）中位 ' + realMs.toFixed(2) + 'ms，最大 ' + Math.max(...times).toFixed(2) + 'ms')
  if (realMs >= 50) fail('真样本中位 ' + realMs.toFixed(2) + 'ms ≥ 50ms')

  // 合成三档：每天 200 / 500 / 1500 行 × 14 天。每档测四个数：
  //   ① 首触冷调用（文件刚写盘，含操作系统/杀软首次读取）
  //   ② 冷调用（OS 缓存已热，但桥层行缓存空）→ 考核「读+解析+聚合」的真成本
  //   ③ 热调用（行缓存命中，只重读最新那份）
  async function timed(apiRef, range) { const t0 = process.hrtime.bigint(); const r = await apiRef.apiOverview(range); return [r, Number(process.hrtime.bigint() - t0) / 1e6] }
  async function medAsync(apiRef, range, n) {
    const a = []
    for (let i = 0; i < n; i++) { const [, ms] = await timed(apiRef, range); a.push(ms) }
    a.sort((x, y) => x - y)
    return a[Math.floor(a.length / 2)]
  }
  function makeFixture(name, perDay, days, sessN) {
    const dir = path.join(__dirname, '.tmp_ov_' + name)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    const DAY = 86400000
    for (let d = days - 1; d >= 0; d--) {
      const day = new Date(todayStart.getTime() - d * DAY)
      const mm = String(day.getMonth() + 1).padStart(2, '0'), dd = String(day.getDate()).padStart(2, '0')
      const lines = []
      for (let i = 0; i < perDay; i++) {
        const ts = day.getTime() + Math.floor(i * (86300000 / perDay))
        lines.push(JSON.stringify({
          at: 'x', atMs: ts, session: 'sess' + String(i % sessN).padStart(4, '0'), chatId: 'chat' + (i % sessN),
          sender: 'ai', contentLen: 40, inputTokens: 20000 + (i % 5000), outputTokens: 120 + (i % 900),
          cachedInputTokens: 10000 + (i % 3000), provider: 'DeepSeek', modelName: 'deepseek-flash',
          sentAt: i % 3 === 0 ? 0 : ts, completedAt: ts + 1500, waitMs: 300 + (i % 700), outMs: 800 + (i % 500),
          done: true, displayMode: 'NORMAL'
        }))
      }
      fs.writeFileSync(path.join(dir, 'chatmsg-' + day.getFullYear() + mm + dd + '.jsonl'), lines.join('\n') + '\n')
    }
    const idx = []
    for (let i = 0; i < 100; i++) idx.push({ key: 'sess' + String(i % sessN).padStart(4, '0'), chatId: 'chat' + (i % sessN), capturedAt: 'x', capturedAtMs: now.getTime() - i * 3600000, preview: 'p' + i, chars: 1000 + i, lines: 50 })
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(idx, null, 2))
    return dir
  }

  const tiers = []
  for (const [label, perDay] of [['200行/天', 200], ['500行/天', 500], ['1500行/天', 1500]]) {
    const dir = makeFixture('t' + perDay, perDay, 14, 40)
    const chatFiles = fs.readdirSync(dir).filter(f => /^chatmsg-/.test(f))
    const sizeMB = (chatFiles.reduce((a, f) => a + fs.statSync(path.join(dir, f)).size, 0) / 1048576).toFixed(2)
    // ① 首触：文件刚写盘就调
    const firstApi = loadBridge(dir, [])
    const [, firstTouchMs] = await timed(firstApi, '7d')
    // 预热 OS 缓存（读一遍丢弃）：之后所有数字只反映桥层自身成本
    for (const f of chatFiles) fs.readFileSync(path.join(dir, f))
    // ② 冷调用：桥层行缓存空（每次 new 一个实例），OS 缓存已热
    const colds = []
    let coldRes = null
    for (let i = 0; i < 5; i++) { const a = loadBridge(dir, []); const [r, ms] = await timed(a, '7d'); colds.push(ms); if (!coldRes) coldRes = r }
    colds.sort((x, y) => x - y)
    const coldMs = colds[2]
    // ③ 热调用：同一实例第二次起（行缓存命中，只重读最新文件）
    const warmApi = loadBridge(dir, [])
    await warmApi.apiOverview('7d')
    const warmMs = await medAsync(warmApi, '7d', 9)
    const warmReads = []
    // 用新实例 + 一次预热后统计读盘：证明热调用只读最新 1 个 chatmsg
    const probe = loadBridge(dir, warmReads)
    await probe.apiOverview('7d')
    warmReads.length = 0
    const warmRes = await probe.apiOverview('7d')
    const warmChatReads = warmReads.filter(p => /chatmsg-/.test(p)).length
    if (warmRes.coverage.cachedFiles < 10) fail(label + ' 行缓存未生效：cachedFiles=' + warmRes.coverage.cachedFiles)
    tiers.push({ label, rows: perDay * 14, mb: sizeMB, firstTouchMs, coldMs, warmMs, warmChatReads, coldRes })
    if (warmChatReads > 1) fail(label + ' 热调用重读了 ' + warmChatReads + ' 个 chatmsg（应为 1）')
    // 缓存不能改变数字
    if (JSON.stringify(warmRes.kpi) !== JSON.stringify(coldRes.kpi) || JSON.stringify(warmRes.days) !== JSON.stringify(coldRes.days) || JSON.stringify(warmRes.heat) !== JSON.stringify(coldRes.heat)) {
      fail(label + ' 热调用结果与冷调用不一致（缓存污染）')
    } else ok(label + ' 冷/热结果完全一致（缓存不改变数字）')
    // 新鲜度：最新文件追加一行必须立刻反映，历史仍旧走缓存
    const newest = chatFiles.slice().sort().pop()
    fs.appendFileSync(path.join(dir, newest), JSON.stringify({ session: 'sess0000', done: true, sentAt: now.getTime() - 1000, completedAt: now.getTime(), atMs: now.getTime(), inputTokens: 777, outputTokens: 7, cachedInputTokens: 0 }) + '\n')
    warmReads.length = 0
    const fresh = await probe.apiOverview('7d')
    const freshChatReads = warmReads.filter(p => /chatmsg-/.test(p)).length
    if (fresh.kpi.outTok !== warmRes.kpi.outTok + 7) fail(label + ' 追加最新文件后未反映（outTok ' + fresh.kpi.outTok + ' vs ' + warmRes.kpi.outTok + '+7）')
    else ok(label + ' 新鲜度：最新文件追加 1 行立刻反映（outTok +7），只重读 ' + freshChatReads + ' 个 chatmsg')
    fs.rmSync(dir, { recursive: true, force: true })
  }
  for (const t of tiers) {
    console.log('  合成 ' + t.label + '（14 天 / ' + t.rows + ' 行 / ' + t.mb + 'MB）：' +
      '首触冷 ' + t.firstTouchMs.toFixed(2) + 'ms ｜ OS热冷 ' + t.coldMs.toFixed(2) + 'ms ｜ 行缓存热 ' + t.warmMs.toFixed(2) + 'ms')
    if (t.rows <= 7000 && t.coldMs >= 50) fail('合成 ' + t.label + ' 冷调用 ' + t.coldMs.toFixed(2) + 'ms ≥ 50ms')
    if (t.warmMs >= 50) fail('合成 ' + t.label + ' 热调用 ' + t.warmMs.toFixed(2) + 'ms ≥ 50ms')
  }
  const realistic = tiers.find(t => t.rows === 7000)
  if (realistic && realistic.coldMs < 50) ok('现实重载档（14 天 × 500 行 = 7000 行 / 2MB+）冷 ' + realistic.coldMs.toFixed(2) + 'ms < 50ms，热 ' + realistic.warmMs.toFixed(2) + 'ms')
  const extreme = tiers.find(t => t.rows === 21000)
  if (extreme) {
    console.log('  ' + (extreme.coldMs < 50 ? '极端档' : '⚠ 极端档') + '（14 天 × 1500 行 = 21000 行 / ' + extreme.mb + 'MB，约为本机真样本体积的 4000 倍）：' +
      '冷 ' + extreme.coldMs.toFixed(2) + 'ms，热 ' + extreme.warmMs.toFixed(2) + 'ms' +
      (extreme.coldMs < 50 ? ' —— 仍在 50ms 预算内' : ' —— 冷调用超 50ms 预算，主因是 14 个文件 6MB+ 的读+逐行 JSON.parse'))
  }

  // files 参数硬上限：传 999 也只能读 14 个
  const capDir = makeFixture('cap', 20, 20, 5) // 20 天文件，验证只取最近 14 个
  const r2 = []
  const capApi = loadBridge(capDir, r2)
  const oCap = await capApi.apiOverview('7d', 999)
  const nChat = r2.filter(p => /chatmsg-/.test(p)).length
  if (nChat > 14) fail('files 上限失效：读了 ' + nChat + ' 个 chatmsg')
  else ok('files 上限生效：目录有 20 个 chatmsg，传 999 实际只读 ' + nChat + ' 个（硬上限 14）')
  if (oCap.coverage.chatDays !== nChat) fail('coverage.chatDays 与实际读文件数不一致：' + oCap.coverage.chatDays + ' vs ' + nChat)
  fs.rmSync(capDir, { recursive: true, force: true })

  // ================= C. 边界 =================
  console.log('\nC. 边界')
  const empty = path.join(__dirname, '.tmp_ov_empty')
  fs.rmSync(empty, { recursive: true, force: true }); fs.mkdirSync(empty, { recursive: true })
  const eApi = loadBridge(empty, [])
  const e1 = await eApi.apiOverview('7d')
  if (!e1.ok) fail('空目录 ok!=true')
  if (e1.kpi.billedTokens !== 0 || e1.kpi.turns !== 0 || e1.kpi.sessions !== 0 || e1.kpi.cacheHit !== 0) fail('空目录 KPI 非 0')
  if (e1.days.length !== 7 || e1.days.some(d => d.tokens !== 0)) fail('空目录 days 未补 0')
  if (e1.heat.length !== 56 || e1.sessions.length !== 0) fail('空目录 heat/sessions 错')
  ok('空目录：KPI 全 0、days 7 天补 0、heat 56 格补 0、sessions []、不抛')

  const nowTs = Date.now()
  fs.writeFileSync(path.join(empty, 'index.json'), '{ this is not json')
  fs.writeFileSync(path.join(empty, 'chatmsg-20260101.jsonl'),
    JSON.stringify({ session: 'aa', done: true, sentAt: nowTs, completedAt: nowTs, atMs: nowTs, inputTokens: 10, outputTokens: 2, cachedInputTokens: 99 }) + '\n' +
    JSON.stringify({ session: 'bb', done: false, sentAt: nowTs, inputTokens: 10, outputTokens: 2 }) + '\n' +
    'not-json\n' + '\n' +
    JSON.stringify({ session: 'cc', done: true, sentAt: 100, completedAt: 100, atMs: 100, inputTokens: 999, outputTokens: 999 }) + '\n')
  const e2 = await eApi.apiOverview('today')
  if (!e2.ok) fail('坏 index.json 应降级为 ok:true，实得 ' + JSON.stringify(e2).slice(0, 120))
  else ok('坏 index.json：降级 index=[]，不抛（kpi.turns=' + e2.kpi.turns + '，sessions=' + e2.sessions.length + '）')
  if (e2.kpi.msgs !== 1) fail('done=false / 坏行 / 窗口外旧行未被跳过：msgs=' + e2.kpi.msgs)
  else ok('坏行 + done=false 行被跳过（msgs=1）')
  if (e2.kpi.cachedTok !== 10) fail('cached>input 未被夹住：cachedTok=' + e2.kpi.cachedTok + '（期望 10）')
  else ok('cached>input 脏数据被夹到 input（10）')
  if (e2.kpi.billedTokens !== 12) fail('1970 年旧行不该计入窗口，billedTokens=' + e2.kpi.billedTokens)
  else ok('窗口外旧行被丢弃（billedTokens=12）')
  fs.rmSync(empty, { recursive: true, force: true })

  // ================= D. 静态接线 =================
  console.log('\nD. 静态接线')
  const src = fs.readFileSync(BRIDGE, 'utf8')
  if (!/method === "overview"\)\s*out = await apiOverview\(req\.range, req\.files\)/.test(src)) fail('dispatch 未接 overview → apiOverview(req.range, req.files)')
  else ok('dispatch: method === "overview" → apiOverview(req.range, req.files)')
  if (!src.includes('// ==== OVERVIEW_V1 BEGIN')) fail('缺 OVERVIEW_V1 BEGIN 标记')
  else ok('OVERVIEW_V1 纯函数段标记在位')
  if (!/async function apiOverview\(rangeIn, filesIn\)/.test(src)) fail('apiOverview 签名不符')
  if (src.includes('raw_') && /OVERRIDE|raw_" \+ key/.test(src.slice(src.indexOf('OVERVIEW_V1 BEGIN'), src.indexOf('OVERVIEW_V1 END')))) fail('纯函数段引用 raw')
  else ok('纯函数段内零 raw 引用')

  console.log('\n' + (problems.length ? 'FAIL (' + problems.length + ')\n- ' + problems.join('\n- ') : 'ALL PASS'))
  process.exit(problems.length ? 1 : 0)
}

main().catch(e => { console.error('EXCEPTION: ' + (e && e.stack || e)); process.exit(1) })
