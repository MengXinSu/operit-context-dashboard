import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DICT_ZH } from './client/i18n'
import { makeViewKit } from './client/viewkit'
import { makeStackedBar, makeLegend } from './client/components/stackedBar'
import { makeDonut } from './client/components/donut'
import { makeTrendChart, aggregateByTurn } from './client/components/trendChart'
import { makeFileCard } from './client/components/fileCard'
import { partsOf, IMG_COLOR } from './client/categories'
import {
  fetchSummary, fetchTimeline, fetchMessages, hasBridge,
  fetchRawSection, fetchRawItem, fetchEvents, fetchFileActivity, fetchToolUsage,
  fetchTodayMessages, fetchSteps, type TodaySessionGroup,
  type MessageItem, type RawSectionData, type RawListItem, type FileActivityData, type FileActivityOp,
} from './data/bridge'
import type { ContextEventRecord, RequestRecord } from './shared/types'

// Operit 语境覆盖
const OVERRIDES: Record<string, string> = { 'cat.inject': '世界书', 'cat.profile': '用户资料', 'cat.summary': '对话总结', 'settings.title': '设置', 'settings.desc': '各卡显示的默认偏好 · 改动自动保存' }

// ── 价格配置（峰谷双价，页面内可编辑，localStorage 持久；单位：人民币元/百万 token）──
// 官方规则（2026-09 核实）：峰时 = 北京时间工作日 09:00-12:00、14:00-18:00（其余含周末为谷时）
type PriceTier = { pin: number; pcache: number; pout: number }
type ModelPrice = { peak: PriceTier; offpeak: PriceTier }
type PriceSpan = { start: string; end: string }
type PriceConfig = { peaks: PriceSpan[]; weekdaysOnly: boolean; models: Record<string, ModelPrice> }
const DEFAULT_PRICES: PriceConfig = {
  peaks: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
  weekdaysOnly: true,
  models: {
    'deepseek-flash': { peak: { pin: 2, pcache: 0.04, pout: 8 }, offpeak: { pin: 1, pcache: 0.02, pout: 4 } },
    'deepseek-v4-pro': { peak: { pin: 9, pcache: 0.3, pout: 27 }, offpeak: { pin: 4.5, pcache: 0.15, pout: 13.5 } },
  },
}
function loadPriceConfig(): PriceConfig {
  try {
    const raw = localStorage.getItem('dsh-prices-v2')
    if (raw) { const j = JSON.parse(raw); if (j && j.models && Array.isArray(j.peaks)) return j }
  } catch (e) { /* fall through */ }
  return JSON.parse(JSON.stringify(DEFAULT_PRICES))
}
function inSpan(d: Date, sp: PriceSpan): boolean {
  const cur = d.getHours() * 60 + d.getMinutes()
  const [sh, sm] = sp.start.split(':').map(Number)
  const [eh, em] = sp.end.split(':').map(Number)
  const st = sh * 60 + sm, en = eh * 60 + em
  if (st <= en) return cur >= st && cur < en
  return cur >= st || cur < en // 跨零点
}
function isOffpeakAt(cfg: PriceConfig, d: Date): boolean {
  if (cfg.weekdaysOnly) {
    const wd = d.getDay()
    if (wd === 0 || wd === 6) return true // 周末全天谷时
  }
  return !cfg.peaks.some((sp) => inSpan(d, sp))
}

// ── 用户偏好持久化（localStorage，跟价格同一套机制）──
const PREF_KEY = 'dsh-prefs-v1'
function loadPrefs(): Record<string, unknown> {
  try { const r = localStorage.getItem(PREF_KEY); if (r) return JSON.parse(r) } catch (e) {}
  return {}
}
function savePref(key: string, value: string): void {
  try { const p = loadPrefs(); p[key] = value; localStorage.setItem(PREF_KEY, JSON.stringify(p)) } catch (e) {}
}

const pInp: import('react').CSSProperties = { width: 44, padding: '2px 4px', fontSize: 11, textAlign: 'center', borderRadius: 4, border: '1px solid rgba(128,128,128,0.4)', background: 'transparent', color: 'inherit', outline: 'none' }
const pNum: import('react').CSSProperties = { width: 50, padding: '2px 4px', fontSize: 11, textAlign: 'center', borderRadius: 4, border: '1px solid rgba(128,128,128,0.4)', background: 'transparent', color: 'inherit', outline: 'none' }

const t = (key: string, params?: Record<string, string | number>): string => {
  let s: string = OVERRIDES[key] ?? DICT_ZH[key] ?? key
  if (params) {
    for (const k of Object.keys(params)) {
      s = s.split('{' + k + '}').join(String(params[k]))
    }
  }
  return s
}

const kit = makeViewKit(t as any)
const StackedBar = makeStackedBar(kit)
const Legend = makeLegend(kit)
const Donut = makeDonut(kit)
const TrendChart = makeTrendChart(kit)
const FileCard = makeFileCard(kit)

const DEMO_CURRENT = {
  system: 16000, tools: 12000, user: 2000, inject: 1000, skill: 1000,
  assistant: 160000, tool: 400000, total: 592000,
}

/** 桥 timeline/steps 原始项 → RequestRecord 统一映射（步骤重建数据同形状） */
function toRequests(items: any[] | null): RequestRecord[] {
  return (items || []).map((it, i) => ({
    seq: it.seq || i + 1,
    turn: it.turn || Math.ceil((i + 1) / 8),
    step: it.step || (i % 8) + 1,
    time: it.t,
    system: it.system, tools: it.tools, user: it.user, inject: it.inject,
    skill: it.skill, summary: it.summary, assistant: it.assistant, tool: it.tool, total: it.total,
    historyCount: it.historyCount, historyChars: it.historyChars,
    skip: it.skip,
    img: it.img, imgCount: it.imgCount,
  }))
}
function demoRequests(): RequestRecord[] {
  const out: RequestRecord[] = []
  for (let i = 1; i <= 60; i++) {
    const user = 520 + (i % 5) * 80
    const tool = 2400 + (i % 11) * 420
    const assistant = 900 + (i % 9) * 160
    const img = i % 16 === 0 ? 690 : 0
    const total = 16000 + 12000 + user + assistant + tool + img
    out.push({
      seq: i, turn: Math.ceil(i / 8), step: ((i - 1) % 8) + 1,
      time: Date.now() - (61 - i) * 45000,
      system: 16000, tools: 12000, user, inject: 0, skill: 0, assistant, tool, img, imgCount: img ? 1 : 0, total,
      output: 280, cacheRead: Math.round(total * 0.7), prompt: total + 300,
    })
  }
  return out
}

/** 详情卡图例短名（手机窄屏防截断；仅用于趋势详情卡） */
const DETAIL_SHORT: Record<string, string> = {
  system: '系统', skill: '技能', inject: '世界书', profile: '资料', summary: '总结',
  tools: '工具定义', user: '用户', assistant: '助手', tool: '结果', img: '图片',
}

type DataState = {
  phase: 'loading' | 'ready' | 'error' | 'demo'
  session?: string
  cardName?: string
  current?: Record<string, number>
  counts?: Record<string, number>
  worldbook?: { blocks: number; chars: number; entries: number; names: string[] }
  historyCount?: number
  requests?: RequestRecord[]
  steps?: RequestRecord[]
  messages?: MessageItem[]
  events?: any[]
  fileActivity?: FileActivityData | null
  toolUsage?: any[]
  todayGroups?: TodaySessionGroup[]
  imgAtt?: { count: number; tokens: number }
  error?: string
}

type BrowserState = {
  cat: string | null
  label: string
  data: RawSectionData | null
  loading: boolean
  error: string
  expanded: Record<number, string>
  expanding: number | null
  loadingMore?: boolean
  /** W3：定位未命中时的一次性提示（打开分类 / 成功定位时清除）。 */
  notice?: string
  /** W5：条目全文读取失败标记（条目下显示「点击重试」；下次读取成功时清除）。 */
  expandFailed?: Record<number, boolean>
}

/** W5事件卡筛选：与宿主 apiEvents 产出的 kind 对齐（压缩/模型切换）。 */
const EVENT_KINDS: string[] = ['compaction', 'model']

const BROWSER_CATS: { key: string; label: string; color: string }[] = [
  // 按上下文注入顺序排：SYSTEM 内四段 → 总结 → 工具 → 历史消息
  { key: 'system', label: '系统提示词', color: 'var(--color-indigo-500)' },
  { key: 'skill', label: '技能注入', color: 'var(--color-orange-500)' },
  { key: 'inject', label: '世界书', color: 'var(--color-purple-500)' },
  { key: 'profile', label: '用户资料', color: 'var(--color-pink-500)' },
  { key: 'summary', label: '对话总结', color: 'var(--color-red-500)' },
  { key: 'tools', label: '工具定义', color: 'var(--color-amber-500)' },
  { key: 'user', label: '用户消息', color: 'var(--color-green-500)' },
  { key: 'assistant', label: '助手消息', color: 'var(--color-blue-500)' },
  { key: 'tool', label: '工具结果', color: 'var(--color-teal-500)' },
  { key: 'history', label: '全部历史', color: 'var(--dsw-alias-label-tertiary)' },
]

function kindLabel(k?: string): string {
  switch (k) {
    case 'USER': return '用户'
    case 'ASSISTANT': return '助手'
    case 'TOOL_CALL': return '调用'
    case 'TOOL_RESULT': return '结果'
    case 'SYSTEM': return '系统'
    case 'SUMMARY': return '总结'
    default: return k || ''
  }
}
const rawPreStyle: React.CSSProperties = { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11.5, lineHeight: 1.6, maxHeight: '55vh', overflow: 'auto', background: 'var(--dsw-alias-bg-layer-2)', padding: 10, borderRadius: 8, margin: '6px 0 0' }
function TextPreview({ text, limit = 4000 }: { text: string; limit?: number }) {
  const [full, setFull] = useState(false)
  const LIMIT = limit
  if (text.length <= LIMIT) return <pre style={rawPreStyle}>{text}</pre>
  return (
    <div>
      <pre style={rawPreStyle}>{full ? text : text.slice(0, LIMIT) + '\n\n…（仅预览前 ' + LIMIT + ' 字，数据未丢失）'}</pre>
      <button className="lc-gran-btn" style={{ marginTop: 6 }} onClick={(e) => { e.stopPropagation(); setFull(!full) }}>
        {full ? '收起' : '展开全部（' + text.length + ' 字符）'}
      </button>
    </div>
  )
}
function fmtTok(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

function fmtDur(ms: number): string {
  if (ms >= 3600000) return (ms / 3600000).toFixed(1) + 'h'
  if (ms >= 60000) return (ms / 60000).toFixed(1) + 'm'
  return (ms / 1000).toFixed(0) + 's'
}

export function App() {
  const [dark, setDark] = useState(() => {
    try { const v = localStorage.getItem('dsh_dark'); return v === null ? true : v === '1' } catch (e) { return true }
  })
  const [selected, setSelected] = useState<number | null>(null)
  const [hovered, setHovered] = useState<number | null>(null)
  const [hoverCat, setHoverCat] = useState<string | null>(null)
  //轮次/步骤视图切换：轮次=快照聚合（每轮1条）；步骤=宿主从 raw 事后切分重建（每请求1条）。偏好持久化。
  const [granularity, setGranularity] = useState<'step' | 'turn'>(() => (loadPrefs().granularity === 'step' ? 'step' : 'turn'))
  const [mode, setMode] = useState<'total' | 'delta'>(() => (loadPrefs().mode === 'delta' ? 'delta' : 'total'))
  // W4 设置卡：文件卡 / 工具定义排序偏好（localStorage 持久化；工具定义的消费点在 W5 浏览器细则接入）。
  const [fileSort, setFileSort] = useState<'count' | 'latest' | 'path'>(() => { const v = loadPrefs().fileSort; return v === 'latest' || v === 'path' ? v : 'count' })
  const [toolSort, setToolSort] = useState<'size' | 'count' | 'name'>(() => { const v = loadPrefs().toolSort; return v === 'size' || v === 'name' ? v : 'count' })
  const [settingsOpen, setSettingsOpen] = useState(false)
  // W5事件卡：kind筛选（默认全选；与上游一致，取消全部选择时列表显示空态）
  const [pickedKinds, setPickedKinds] = useState<string[]>(() => EVENT_KINDS.slice())
  /** 偏好写回：更新 state + localStorage（设置卡与卡内切换共用；工具定义的消费点 W5 接入）。 */
  const pickGran = (v: 'step' | 'turn'): void => { setGranularity(v); savePref('granularity', v) }
  const pickMode = (v: 'total' | 'delta'): void => { setMode(v); savePref('mode', v) }
  const pickFileSort = (v: 'count' | 'latest' | 'path'): void => { setFileSort(v); savePref('fileSort', v) }
  const pickToolSort = (v: 'size' | 'count' | 'name'): void => { setToolSort(v); savePref('toolSort', v) }
  const [state, setState] = useState<DataState>({ phase: 'loading' })
  const [refreshN, setRefreshN] = useState(0)
  const [priceCfg, setPriceCfg] = useState<PriceConfig>(loadPriceConfig)
  const [pricesOpen, setPricesOpen] = useState(false)
  const updatePriceCfg = (next: PriceConfig) => {
    setPriceCfg(next)
    try { localStorage.setItem('dsh-prices-v2', JSON.stringify(next)) } catch (e) { /* ignore */ }
  }
  const setTier = (name: string, key: 'peak' | 'offpeak', field: 'pin' | 'pcache' | 'pout', val: number) => {
    const m = priceCfg.models[name]
    if (!m) return
    updatePriceCfg({ ...priceCfg, models: { ...priceCfg.models, [name]: { ...m, [key]: { ...m[key], [field]: val } } } })
  }
  const updPeak = (i: number, k: 'start' | 'end', v: string) => {
    updatePriceCfg({ ...priceCfg, peaks: priceCfg.peaks.map((sp, j) => (j === i ? { ...sp, [k]: v } : sp)) })
  }
  const offpeakNow = isOffpeakAt(priceCfg, new Date())
  const [browser, setBrowser] = useState<BrowserState>({ cat: null, label: '', data: null, loading: false, error: '', expanded: {}, expanding: null, notice: '' })
  const [hoverTiming, setHoverTiming] = useState<string | null>(null)
  // W3 定位联动：浏览器卡锚点、条目 ref 表、browser 镜像（供稳定回调读 latest）、定位序号（迟到响应防串台）。
  const browserCardRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef<Record<number, HTMLElement | null>>({})
  const browserRef = useRef(browser)
  useEffect(() => { browserRef.current = browser }, [browser])
  const locateSeq = useRef(0)
  const [pendingFocus, setPendingFocus] = useState<{ idx: number } | null>(null)

  useEffect(() => {
    if (dark) document.body.setAttribute('data-ds-dark-theme', '')
    else document.body.removeAttribute('data-ds-dark-theme')
    try { localStorage.setItem('dsh_dark', dark ? '1' : '0') } catch (e) {}
  }, [dark])

  useEffect(() => {
    let alive = true
    async function load() {
      if (!hasBridge()) {
        setState({ phase: 'demo', current: DEMO_CURRENT, requests: demoRequests() })
        return
      }
      setState({ phase: 'loading' })
      setBrowser({ cat: null, label: '', data: null, loading: false, error: '', expanded: {}, expanding: null, notice: '', expandFailed: {} })
      const [sum, tl, msgs, evs, fa, tu, tm, st] = await Promise.all([fetchSummary(), fetchTimeline(), fetchMessages(), fetchEvents(), fetchFileActivity(), fetchToolUsage(), fetchTodayMessages(), fetchSteps()])
      if (!alive) return
      if (!sum || !sum.ok || !sum.current) {
        setState({ phase: 'error', error: (sum && sum.error) || '数据读取失败' })
        return
      }
      const requests = toRequests(tl)
      const steps = toRequests(st)
      setState({
        phase: 'ready', session: sum.session, cardName: (sum as any).cardName, current: sum.current,
        counts: sum.counts, worldbook: sum.worldbook,
        historyCount: sum.historyCount, requests, steps, messages: msgs || [],
        events: evs || [], fileActivity: fa || null, toolUsage: tu || [],
        todayGroups: (tm && tm.ok && tm.groups) ? tm.groups : [],
        imgAtt: (sum as any).imgAttachments || undefined,
      })
    }
    load()
    return () => { alive = false }
  }, [refreshN])

  const current = state.current || (state.phase === 'demo' ? DEMO_CURRENT : { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 })
  const requests = state.requests || []
  const parts = useMemo(() => {
    const ps = partsOf(current as any)
    //「图片」第十段（动态）：仅当上下文含图片附件 token 时追加到九段之后；无图时不占位
    const imgTok = (current as any).img || 0
    if (imgTok > 0) ps.push({ key: 'img', color: IMG_COLOR, value: imgTok })
    return ps
  }, [current])
  const segments = useMemo(() => parts.map((p) => ({ key: p.key, color: p.color, value: p.value })), [parts])

  //轮次/步骤切换：轮次=每轮一根柱（取该轮末步记录聚合，附 stepCount）；步骤=每步一根柱。与上游 dsh-context 行为一致。
  const displayRequests = useMemo(
    () => (granularity === 'turn' ? aggregateByTurn(requests) : (hasBridge() ? (state.steps || []) : requests)),
    [requests, granularity, state.steps],
  )

  const markers = useMemo<(ContextEventRecord | undefined)[]>(() => {
    return displayRequests.map((r, idx) => {
      if (idx > 0) {
        const prev = displayRequests[idx - 1]
        const hc0 = prev.historyCount || 0
        const hc1 = r.historyCount || 0
        if (hc0 > 0 && hc1 > 0 && hc1 < hc0 * 0.5) {
          return { kind: 'compaction', count: Math.max(0, hc0 - hc1), turn: r.turn, step: r.step } as ContextEventRecord
        }
      }
      return undefined
    })
  }, [displayRequests])

  const stats = useMemo(() => {
    const msgs = state.messages || []
    let inSum = 0, cachedSum = 0
    let waitSum = 0, outSum = 0
    let firstT = 0, lastT = 0
    for (const m of msgs) {
      inSum += m.input; cachedSum += m.cached
      waitSum += m.waitMs || 0; outSum += m.outMs || 0
      if (m.sentAt && (!firstT || m.sentAt < firstT)) firstT = m.sentAt
      if (m.t && m.t > lastT) lastT = m.t
    }
    const lastTurn = requests.length ? (requests[requests.length - 1].turn || 0) : 0
    // 估算费用：按完成态消息的累计值 delta（处理重置）
    let cost = 0, costKnown = false
    let lastIn = 0, lastOut = 0, lastCached = 0
    for (const m of msgs) {
      const dIn = m.input >= lastIn ? m.input - lastIn : m.input
      const dOut = m.output >= lastOut ? m.output - lastOut : m.output
      const dCached = m.cached >= lastCached ? m.cached - lastCached : m.cached
      lastIn = m.input; lastOut = m.output; lastCached = m.cached
      const mp = priceCfg.models[String(m.model || '')]
      if (mp) {
        costKnown = true
        const tier = isOffpeakAt(priceCfg, new Date(m.sentAt)) ? mp.offpeak : mp.peak
        const cachePart = Math.min(dCached, dIn)
        cost += ((dIn - cachePart) * tier.pin + cachePart * tier.pcache + dOut * tier.pout) / 1e6
      }
    }
    return {
      turns: requests.length,
      turnCount: lastTurn,
      steps: (state.steps && state.steps.length > 0) ? state.steps.length : requests.length,
      toolCalls: state.counts ? (state.counts.TOOL_CALL || 0) : 0,
      hit: inSum > 0 ? ((cachedSum / inSum) * 100).toFixed(2) : null,
      waitSum,
      outSum,
      activeMs: firstT && lastT ? Math.max(0, lastT - firstT) : 0,
      restMs: Math.max(0, (firstT && lastT ? Math.max(0, lastT - firstT) : 0) - waitSum - outSum),
      answers: msgs.length,
      cost,
      costKnown,
    }
  }, [state, requests, priceCfg])

  // 今日花费：今天全部会话（分组 delta，基准 = 各会话今天之前最后一条累计值）
  const todayCost = useMemo(() => {
    const groups = state.todayGroups || []
    let cost = 0, known = false
    for (const g of groups) {
      let lastIn = g.base.input, lastOut = g.base.output, lastCached = g.base.cached
      for (const m of g.items) {
        const dIn = m.input >= lastIn ? m.input - lastIn : m.input
        const dOut = m.output >= lastOut ? m.output - lastOut : m.output
        const dCached = m.cached >= lastCached ? m.cached - lastCached : m.cached
        lastIn = m.input; lastOut = m.output; lastCached = m.cached
        const mp = priceCfg.models[String(m.model || '')]
        if (mp) {
          known = true
          const tier = isOffpeakAt(priceCfg, new Date(m.sentAt)) ? mp.offpeak : mp.peak
          const cachePart = Math.min(dCached, dIn)
          cost += ((dIn - cachePart) * tier.pin + cachePart * tier.pcache + dOut * tier.pout) / 1e6
        }
      }
    }
    return { cost, known }
  }, [state.todayGroups, priceCfg])

  const totalTok = current.total || 0

  // 选中趋势柱 → 该轮详情（组成 + 对应完成态的用量/耗时）
  const selectedInfo = useMemo(() => {
    if (selected === null) return null
    const pool = granularity === 'step' ? displayRequests : requests
    const idx = pool.findIndex((r) => r.seq === selected)
    if (idx < 0) return null
    const r = pool[idx]
    const t0 = r.time
    const t1 = idx + 1 < pool.length ? pool[idx + 1].time : Number.MAX_SAFE_INTEGER
    const msgs = state.messages || []
    const hit = msgs.filter((m) => m.sentAt >= t0 && m.sentAt < t1)
    const usage = hit.length ? hit[hit.length - 1] : (msgs.find((m) => m.sentAt >= t0) || null)
    // 该轮步数：取聚合记录自带的 stepCount（连续段内精确计数；直接 filter 全表会把压缩前后的同名轮串起来算多）
    const agg = displayRequests.find((x) => x.seq === selected)
    const turnSteps = agg && agg.stepCount !== undefined ? agg.stepCount : 0
    const mkIdx = displayRequests.findIndex((x) => x.seq === selected)
    const marker = mkIdx >= 0 ? (markers[mkIdx] || null) : null
    return { r, usage, turnSteps, marker, parts: (() => { const ps = partsOf(r as any); const iv = (r as any).img || 0; if (iv > 0) ps.push({ key: 'img', color: IMG_COLOR, value: iv }); return ps })() }
  }, [selected, requests, state.messages, displayRequests, markers])

  // W5复核新增：事件筛选辅助 + 工具定义排序（设置卡 toolSort 的消费点；其余分类维持宿主顺序）。
  const toggleKind = (k: string): void => { setPickedKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k])) }
  const evCounts = useMemo(() => { const m: Record<string, number> = {}; for (const ev of (state.events || [])) { const k = String(ev.kind || ''); m[k] = (m[k] || 0) + 1 } return m }, [state.events])
  const shownEvents = useMemo(() => (state.events || []).filter((ev: any) => pickedKinds.includes(ev.kind)).slice().reverse(), [state.events, pickedKinds])
  const toolCounts = useMemo(() => { const m = new Map<string, number>(); for (const u of (state.toolUsage || [])) m.set(String(u.name || ''), Number(u.count) || 0); return m }, [state.toolUsage])
  /** size=体量（chars）降序；count=本会话调用次数降序（同次按名称）；name=字母序。 */
  const sortToolItems = (items: RawListItem[]): RawListItem[] => {
    const arr = items.slice()
    if (toolSort === 'size') arr.sort((a, b) => (b.chars || 0) - (a.chars || 0))
    else if (toolSort === 'count') arr.sort((a, b) => (toolCounts.get(String(b.name)) || 0) - (toolCounts.get(String(a.name)) || 0) || (String(a.name) < String(b.name) ? -1 : 1))
    else arr.sort((a, b) => (String(a.name) < String(b.name) ? -1 : 1))
    return arr
  }

  async function openSection(cat: string, label: string) {
    if (browser.cat === cat) {
      setBrowser({ cat: null, label: '', data: null, loading: false, error: '', expanded: {}, expanding: null, notice: '', expandFailed: {} })
      return
    }
    setBrowser({ cat, label, data: null, loading: true, error: '', expanded: {}, expanding: null, notice: '', expandFailed: {} })
    const d = await fetchRawSection(cat, 0, 30)
    setBrowser((b) => b.cat === cat ? { ...b, data: d, loading: false, error: d && d.ok ? '' : ((d && (d as any).error) || '读取失败') } : b)
  }

  async function loadMore() {
    const b = browser
    if (!b.cat || !b.data || !b.data.items) return
    if (b.loadingMore) return // 防重入：连点会重复追加同一段
    setBrowser((prev) => ({ ...prev, loadingMore: true }))
    const more = await fetchRawSection(b.cat, (b.data.offset || 0) + b.data.items.length, 30)
    setBrowser((prev) => {
      if (prev.cat !== b.cat || !prev.data) return { ...prev, loadingMore: false }
      const items = (more && more.ok && more.items) ? [...(prev.data.items || []), ...more.items] : prev.data.items
      return { ...prev, loadingMore: false, data: { ...prev.data, items } }
    })
  }

  async function expandItem(idx: number) {
    // 已展开 → 收起（toggle）
    if (browser.expanded[idx] !== undefined) {
      setBrowser((b) => {
        const ex = { ...b.expanded }
        delete ex[idx]
        return { ...b, expanded: ex, expanding: null }
      })
      return
    }
    if (browser.expanding === idx) return
    const catAtReq = browser.cat
    setBrowser((b) => ({ ...b, expanding: idx }))
    const item = await fetchRawItem(idx)
    // 迟到响应防串台：分类没变才写入（与 openSection 的守卫同款）
    setBrowser((b) => {
      if (b.cat !== catAtReq) return b
      const ok = !!(item && item.ok && item.content !== undefined)
      const exf = { ...(b.expandFailed || {}) }
      if (ok) delete exf[idx]
      else exf[idx] = true
      return { ...b, expanding: null, expanded: ok ? { ...b.expanded, [idx]: item!.content! } : b.expanded, expandFailed: exf }
    })
  }

  // W3 定位联动：点文件卡操作行 → 打开「工具结果」分类，把对应条目滚入视野并展开。
  // 快路径：目标已在当前列表 → 零网络直达；否则桥 focus 一页直达（返回含锚点的页）。
  // 失败分支：result / call 两个锚点都未命中 → notice 提示（可能已被压缩裁剪）。
  const locateOp = useCallback(async (op: FileActivityOp) => {
    const seq = ++locateSeq.current
    try { browserCardRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }) } catch (e) { /* 忽略：滚动失败不阻断定位 */ }
    const b0 = browserRef.current
    if (b0.cat === 'tool' && b0.data && b0.data.items) {
      if (b0.data.items.some(it => it.idx === op.resultIdx)) { setPendingFocus({ idx: op.resultIdx }); return }
      if (b0.data.items.some(it => it.idx === op.callIdx)) { setPendingFocus({ idx: op.callIdx }); return }
    }
    setBrowser((b) => b.cat === 'tool'
      ? { ...b, loading: true, notice: '' }
      : { cat: 'tool', label: '工具结果', data: null, loading: true, error: '', expanded: {}, expanding: null, notice: '', expandFailed: {} })
    const targets = op.resultIdx === op.callIdx ? [op.resultIdx] : [op.resultIdx, op.callIdx]
    for (const t of targets) {
      const d = await fetchRawSection('tool', 0, 30, t)
      if (seq !== locateSeq.current) return // 新一次定位已发起：放弃迟到响应
      const hit = !!(d && d.ok && d.items && d.items.some(it => it.idx === t))
      if (hit) {
        setBrowser((b) => b.cat !== 'tool' ? b : { ...b, data: d, loading: false, error: '', notice: '' })
        setPendingFocus({ idx: t })
        return
      }
    }
    if (seq !== locateSeq.current) return
    setBrowser((b) => b.cat !== 'tool' ? b : { ...b, loading: false, notice: '未找到对应结果（可能已被压缩裁剪）' })
  }, [])

  // pendingFocus 消费：目标条目已在列表 → 展开（如未展开）+ 滚入视野，然后清空。
  useEffect(() => {
    if (!pendingFocus) return
    const items = browser.cat === 'tool' && browser.data ? browser.data.items : undefined
    if (!items || !items.some(it => it.idx === pendingFocus.idx)) return
    const idx = pendingFocus.idx
    if (browser.expanded[idx] === undefined && browser.expanding !== idx) {
      void expandItem(idx)
    }
    const el = itemRefs.current[idx]
    if (el) {
      try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }) } catch (e) { try { el.scrollIntoView() } catch (e2) { /* 忽略 */ } }
    }
    setPendingFocus(null)
  }, [pendingFocus, browser])

  return (
    <div className="lc-root" style={{ maxWidth: 600, margin: '0 auto', minHeight: '100vh' }}>
      <div className="lc-card" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600 }}>
          {state.phase === 'ready' ? ((state.cardName ? state.cardName + ' · ' : '') + (state.session || '')) :
           state.phase === 'demo' ? '预览模式（无宿主数据）' :
           state.phase === 'loading' ? '加载中…' : '数据异常'}
        </span>
        {state.phase === 'ready' && state.worldbook && state.worldbook.entries > 0 ? (
          <span style={{ opacity: 0.75 }}>世界书 {state.worldbook.entries} 条</span>
        ) : null}
        {state.error ? <span style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{state.error}</span> : null}
        <button className="lc-gran-btn" style={{ marginLeft: 'auto' }} onClick={() => { try { location.reload() } catch (e) { setRefreshN(refreshN + 1) } }}>刷新</button>
        <button className="lc-gran-btn" onClick={() => setDark(!dark)}>{dark ? '浅色' : '深色'}</button>
      </div>

      <div className="lc-card" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, textAlign: 'center' }}>
        <div><div style={{ fontSize: 16, fontWeight: 600 }}>{stats.turnCount}</div><div style={{ fontSize: 10, opacity: 0.65 }}>轮次</div></div>
        <div><div style={{ fontSize: 16, fontWeight: 600 }}>{stats.steps}</div><div style={{ fontSize: 10, opacity: 0.65 }}>步骤</div></div>
        <div><div style={{ fontSize: 16, fontWeight: 600 }}>{stats.toolCalls}</div><div style={{ fontSize: 10, opacity: 0.65 }}>工具调用</div></div>
        <div><div style={{ fontSize: 16, fontWeight: 600 }}>{stats.hit === null ? '—' : stats.hit + '%'}</div><div style={{ fontSize: 10, opacity: 0.65 }}>缓存命中</div></div>
      </div>

      <div className="lc-card" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, textAlign: 'center' }}>
        <div><div style={{ fontSize: 16, fontWeight: 600 }}>{fmtDur(stats.activeMs)}</div><div style={{ fontSize: 10, opacity: 0.65 }}>活跃时长</div></div>
        <div><div style={{ fontSize: 16, fontWeight: 600 }}>{fmtDur(stats.waitSum)}</div><div style={{ fontSize: 10, opacity: 0.65 }}>模型等待</div></div>
        <div><div style={{ fontSize: 16, fontWeight: 600 }}>{fmtDur(stats.outSum)}</div><div style={{ fontSize: 10, opacity: 0.65 }}>模型生成</div></div>
        <div><div style={{ fontSize: 16, fontWeight: 600 }}>{stats.answers}</div><div style={{ fontSize: 10, opacity: 0.65 }}>回答数</div></div>
        <div title="本会话按模型价格表估算（¥/百万token）· 点击设置峰谷价、查看今日花费" style={{ cursor: 'pointer' }} onClick={() => setPricesOpen(!pricesOpen)}><div style={{ fontSize: 16, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}><span style={{ fontSize: 10, padding: '1px 4px', borderRadius: 4, background: offpeakNow ? 'rgba(34,197,94,0.18)' : 'rgba(249,115,22,0.18)', color: offpeakNow ? '#22c55e' : '#f97316' }}>{offpeakNow ? '谷' : '峰'}</span><span>{stats.costKnown ? '¥' + stats.cost.toFixed(2) : '—'}</span></div><div style={{ fontSize: 10, opacity: 0.65 }}>仅本会话</div></div>
      </div>
      {pricesOpen ? (
        <div className="lc-card" style={{ fontSize: 11 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, opacity: 0.7 }}>今日花费</span>
            <span style={{ fontSize: 22, fontWeight: 700 }}>{todayCost.known ? '¥' + todayCost.cost.toFixed(2) : '—'}</span>
            <span style={{ fontSize: 10, opacity: 0.5 }}>今天全部会话 · 估算</span>
          </div>
          <div style={{ height: 1, background: 'rgba(128,128,128,0.28)', margin: '10px 0' }} />
          <div style={{ fontWeight: 600, marginBottom: 6, opacity: 0.85 }}>价格设置（元/百万 token · 改动自动保存）</div>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
            <span style={{ opacity: 0.75 }}>峰时（工作日）：</span>
            {priceCfg.peaks.map((sp, i) => (
              <span key={i} style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
                {i > 0 ? <span style={{ opacity: 0.45 }}>·</span> : null}
                <input type="text" inputMode="numeric" maxLength={5} value={sp.start} onChange={(e) => updPeak(i, 'start', e.target.value)} style={pInp} />
                <span style={{ opacity: 0.5 }}>~</span>
                <input type="text" inputMode="numeric" maxLength={5} value={sp.end} onChange={(e) => updPeak(i, 'end', e.target.value)} style={pInp} />
              </span>
            ))}
            <span style={{ opacity: 0.55 }}>其余含周末为谷时</span>
          </div>
          {Object.keys(priceCfg.models).map((name) => (
            <div key={name} style={{ marginBottom: 6 }}>
              <div style={{ fontWeight: 600, marginBottom: 3, opacity: 0.85 }}>{name}</div>
              {(['peak', 'offpeak'] as const).map((tk) => (
                <div key={tk} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 3 }}>
                  <span style={{ opacity: 0.7, width: 14, textAlign: 'center' }}>{tk === 'peak' ? '峰' : '谷'}</span>
                  {(['pin', 'pcache', 'pout'] as const).map((f) => (
                    <input key={f} type="number" step="0.01" value={priceCfg.models[name][tk][f]} onChange={(e) => setTier(name, tk, f, Number(e.target.value))} style={pNum} />
                  ))}
                </div>
              ))}
            </div>
          ))}
          <button className="lc-gran-btn" onClick={() => updatePriceCfg(JSON.parse(JSON.stringify(DEFAULT_PRICES)))}>恢复默认价</button>
        </div>
      ) : null}

      <div className="lc-card">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('stats.title')}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <Donut segments={segments} centerTop={'≈' + fmtTok(totalTok)} centerSub={t('overview.estimate')} hoverKey={hoverCat} onHoverKey={setHoverCat} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11.5, minWidth: 150, flex: 1 }}>
            {segments.map((s) => (
              <span key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 7, height: 7, borderRadius: 4, background: s.color, flex: 'none' }} />
                <span>{t('cat.' + s.key)}</span>
                <b style={{ fontWeight: 600, marginLeft: 'auto' }}>≈{fmtTok(s.value)}</b>
                <span style={{ opacity: 0.55, width: 32, textAlign: 'right' }}>{totalTok > 0 ? Math.round((s.value / totalTok) * 100) : 0}%</span>
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="lc-card">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('overview.title')}</span>
          <span style={{ marginLeft: 'auto', fontSize: 11, opacity: 0.7 }}>≈{fmtTok(totalTok)} / 1.0M · {Math.round(totalTok / 1e6 * 100)}%已用</span>
        </div>
        <StackedBar
          parts={parts}
          max={1000000}
          reserve={{ ratio: 0.8, label: t('overview.compactReserve', { pct: 80 }) }}
          hoverKey={hoverCat}
          onHoverKey={setHoverCat}
        />
        <Legend parts={parts} hoverKey={hoverCat} onHoverKey={setHoverCat} />
        {state.imgAtt && state.imgAtt.count > 0 ? (
          <div style={{ fontSize: 10, opacity: 0.6, marginTop: 6, textAlign: 'center' }}>图片附件 {state.imgAtt.count} 张 ≈{state.imgAtt.tokens} tokens（按官方图片计费公式估算）</div>
        ) : null}
      </div>
      <div className="lc-card" ref={browserCardRef}>
        <div className="lc-card-title">
          <span className="lc-card-title-text">上下文浏览器</span>
          <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.55 }}>点分类展开 · 点条目看全文</span>
        </div>
        {BROWSER_CATS.map((c) => {
          const isOpen = browser.cat === c.key
          // W5工具定义排序（设置卡 toolSort 的消费点；其余分类维持宿主顺序）
          const items = browser.data && browser.data.items ? (c.key === 'tools' ? sortToolItems(browser.data.items) : browser.data.items) : []
          const countText = isOpen && browser.data && browser.data.ok
            ? (browser.data.kind === 'text' ? '≈' + (browser.data.chars || 0) + ' 字符' : (browser.data.total || 0) + ' 项')
            : null
          return (
            <div key={c.key}>
              <div
                onClick={() => openSection(c.key, c.label)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 2px', borderBottom: '1px solid var(--dsw-alias-border-l1)', cursor: 'pointer' }}
              >
                <span style={{ width: 7, height: 7, borderRadius: 4, background: c.color, flex: 'none' }} />
                <span style={{ fontSize: 12.5, fontWeight: isOpen ? 600 : 400 }}>{c.label}</span>
                <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.55 }}>{countText ?? '›'}</span>
              </div>
              {isOpen ? (
                <div style={{ padding: '4px 0 8px 15px' }}>
                  {browser.notice ? <div style={{ fontSize: 11, color: 'var(--dsw-alias-state-warn-primary)', padding: '2px 0 6px' }}>{browser.notice}</div> : null}
                  {c.key === 'tools' && !browser.loading && !browser.error && browser.data && browser.data.kind === 'list' ? (<div style={{ display: 'flex', padding: '2px 0 4px' }}><span className="lc-gran" role="group" style={{ marginLeft: 0, display: 'inline-flex' }} title={t('tool.sortTip')}>{(['size', 'count', 'name'] as const).map((k) => (<button key={k} type="button" className={'lc-gran-btn' + (toolSort === k ? ' lc-gran-on' : '')} onClick={() => pickToolSort(k)}>{t('tool.sort.' + k)}</button>))}</span></div>) : null}
                  {browser.loading ? (
                    <div style={{ fontSize: 12, opacity: 0.6 }}>读取中…</div>
                  ) : browser.error ? (
                    <div style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' }}>{browser.error}</div>
                  ) : browser.data && browser.data.kind === 'text' ? (
                    <TextPreview text={browser.data.content || ''} />
                  ) : browser.data && browser.data.items && browser.data.items.length > 0 ? (
                    <div>
                      {items.map((it) => (
                        <div key={it.idx} ref={(el) => { itemRefs.current[it.idx] = el }} onClick={() => expandItem(it.idx)} style={{ padding: '7px 2px', borderBottom: '1px solid var(--dsw-alias-border-l1)', cursor: 'pointer' }}>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 12 }}>
                            <span style={{ flex: 'none', fontSize: 10, opacity: 0.8, background: 'var(--dsw-alias-bg-layer-2)', padding: '1px 5px', borderRadius: 4 }}>{kindLabel(it.kind)}</span>
                            {it.toolName || it.name ? <b style={{ fontWeight: 600 }}>{it.toolName || it.name}</b> : null}
                            <span style={{ marginLeft: 'auto', opacity: 0.55, fontSize: 10 }}>{c.key === 'tools' ? '×' + (toolCounts.get(String(it.name)) || 0) + ' · ' : ''}{it.chars} 字符</span>
                            {browser.expanding === it.idx ? <span style={{ fontSize: 10, opacity: 0.6 }}>…</span> : null}
                          </div>
                          <div style={{ fontSize: 11.5, opacity: 0.85, marginTop: 4, lineHeight: 1.5 }}>{it.preview}</div>
                          {browser.expandFailed && browser.expandFailed[it.idx] ? <div style={{ fontSize: 10, marginTop: 3, color: 'var(--dsw-alias-state-error-primary)' }}>读取失败 · 点击重试</div> : null}
                          {browser.expanded[it.idx] !== undefined ? <TextPreview text={browser.expanded[it.idx]} limit={1200} /> : null}
                        </div>
                      ))}
                      {browser.data.items.length < (browser.data.total || 0) ? (
                        <button className="lc-gran-btn" style={{ marginTop: 8 }} onClick={loadMore}>加载更多（已显示 {browser.data.items.length}/{browser.data.total}）</button>
                      ) : null}
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, opacity: 0.55 }}>
                      {c.key === 'inject' ? '本轮未注入世界书（未命中关键词，或该角色卡未配置世界书）' : '（空）'}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      <div className="lc-card">
        <div className="lc-card-title">
          <span className="lc-card-title-text">耗时统计</span>
          <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.55 }}>活跃时长构成</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <Donut
            segments={[
              { key: 'twait', color: '#f59e0b', value: stats.waitSum },
              { key: 'tgen', color: '#3b82f6', value: stats.outSum },
              { key: 'trest', color: '#94a3b8', value: stats.restMs },
            ].filter((sg) => sg.value > 0)}
            centerTop={fmtDur(stats.activeMs)}
            centerSub="活跃时长"
            hoverKey={hoverTiming}
            onHoverKey={setHoverTiming}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, minWidth: 150, flex: 1 }}>
            {[
              { key: 'twait', color: '#f59e0b', label: '模型等待', v: stats.waitSum },
              { key: 'tgen', color: '#3b82f6', label: '模型生成', v: stats.outSum },
              { key: 'trest', color: '#94a3b8', label: '工具与开销', v: stats.restMs },
            ].map((row) => (
              <div key={row.key} style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: hoverTiming && hoverTiming !== row.key ? 0.55 : 1 }} onMouseEnter={() => setHoverTiming(row.key)} onMouseLeave={() => setHoverTiming(null)}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: row.color, display: 'inline-block' }} />
                <span style={{ opacity: 0.8 }}>{row.label}</span>
                <b style={{ marginLeft: 'auto' }}>{fmtDur(row.v)}</b>
                <span style={{ opacity: 0.5, width: 36, textAlign: 'right' }}>{stats.activeMs > 0 ? Math.round((row.v / stats.activeMs) * 100) : 0}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>


      <div className="lc-card">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('trend.title')}</span>
          <span style={{ display: 'inline-flex', gap: 6, marginLeft: 'auto' }}>
            <button className="lc-gran-btn" onClick={() => pickGran(granularity === 'step' ? 'turn' : 'step')}>
              {granularity === 'step' ? '步骤' : '轮次'}
            </button>
            <button className="lc-gran-btn" onClick={() => pickMode(mode === 'total' ? 'delta' : 'total')}>
              {mode === 'total' ? '全量' : '增量'}
            </button>
          </span>
        </div>
        {requests.length > 0 ? (
          <TrendChart
            requests={displayRequests}
            markers={markers}
            selectedSeq={selected}
            hoveredSeq={hovered}
            activeTurn={null}
            granularity={granularity}
            mode={mode}
            focusTurn={null}
            hoverCat={hoverCat}
            adaptive
            onSelect={setSelected}
            onHover={setHovered}
            onHoverTurn={() => {}}
            onPickTurn={() => {}}
            onFocusTurnHandled={() => {}}
          />
        ) : (
          <div style={{ fontSize: 12, opacity: 0.6, padding: '8px 0' }}>暂无趋势数据（下一轮对话后出现）</div>
        )}
        {selectedInfo ? (
          <div style={{ marginTop: 8, padding: '8px 10px', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 8, fontSize: 11.5, lineHeight: 1.9 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 600 }}>{granularity === 'step' ? `第 ${selectedInfo.r.turn} 轮 · 第 ${selectedInfo.r.step} 步` : (selectedInfo.turnSteps > 1 ? `第 ${selectedInfo.r.turn} 轮 · 共 ${selectedInfo.turnSteps} 步` : `第 ${selectedInfo.r.turn} 轮`)}</span>
              <span style={{ opacity: 0.6 }}>{new Date(selectedInfo.r.time).toLocaleTimeString('zh-CN', { hour12: false })}</span>{selectedInfo.marker ? <span style={{ fontSize: 10, color: 'var(--dsw-alias-state-warn-primary)' }} title="该轮与上一步之间发生过上下文压缩">✂压缩 −{selectedInfo.marker.count}条</span> : null}<span style={{ opacity: 0.7 }}>≈{fmtTok(selectedInfo.r.total)}</span>
              <button className="lc-gran-btn" style={{ marginLeft: 'auto' }} onClick={() => setSelected(null)}>✕</button>
            </div>
                        <div style={{ marginTop: 8 }}>
              <StackedBar parts={selectedInfo.parts} hoverKey={hoverCat} onHoverKey={setHoverCat} />
            </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '4px 10px', marginTop: 6 }}>
              {selectedInfo.parts.map((p) => (
                <span key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap', minWidth: 0 }}>
                  <span style={{ width: 7, height: 7, borderRadius: 4, background: p.color, flex: 'none' }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{DETAIL_SHORT[p.key] || t('cat.' + p.key)}</span>
                  <b style={{ fontWeight: 600 }}>≈{fmtTok(p.value)}</b>
                  <span style={{ opacity: 0.55 }}>{selectedInfo.r.total > 0 ? Math.round((p.value / selectedInfo.r.total) * 100) : 0}%</span>
                </span>
              ))}
            </div>
            {selectedInfo.usage ? (
              <div style={{ opacity: 0.9 }}>本轮用量：输入 {fmtTok(selectedInfo.usage.input)} · 输出 {fmtTok(selectedInfo.usage.output)} · 缓存 {fmtTok(selectedInfo.usage.cached)}（{Math.round(selectedInfo.usage.cached / Math.max(1, selectedInfo.usage.input) * 100)}%）· 等待 {(selectedInfo.usage.waitMs / 1000).toFixed(1)}s · 生成 {(selectedInfo.usage.outMs / 1000).toFixed(1)}s</div>
            ) : (<div style={{ opacity: 0.55, fontSize: 11 }}>本轮用量：待该轮完成后显示</div>)}
          </div>
        ) : (
          <div style={{ marginTop: 6, fontSize: 11, opacity: 0.5 }}>点柱子查看该轮详情</div>
        )}
      </div>

      {state.phase === 'ready' && state.worldbook && state.worldbook.entries > 0 ? (
        <div className="lc-card">
          <div className="lc-card-title">
            <span className="lc-card-title-text">世界书 · 本轮注入</span>
            <span style={{ marginLeft: 'auto', fontSize: 11, opacity: 0.7 }}>≈{state.worldbook.chars} 字符</span>
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.8 }}>
            {state.worldbook.names.map((n, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                <span style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--color-purple-500)', flex: 'none', position: 'relative', top: -1 }} />
                <span>{n}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="lc-card">
        <div className="lc-card-title">
          <span className="lc-card-title-text">上下文事件</span>
          <span className="lc-kinds" role="group" style={{ marginLeft: 'auto' }}>
          {EVENT_KINDS.map((k) => (
            <button key={k} type="button" className={'lc-gran-btn' + (pickedKinds.includes(k) ? ' lc-gran-on' : '')} onClick={() => toggleKind(k)}>
              {t('kind.' + k)}{evCounts[k] ? <span className="lc-kind-n">{evCounts[k]}</span> : null}
            </button>
          ))}
        </span>
        </div>
        {state.events && state.events.length > 0 ? (shownEvents.length > 0 ? shownEvents.map((ev: any, i: number) => (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12, padding: '7px 2px', borderBottom: '1px solid var(--dsw-alias-border-l1)' }}>
            <span style={{ flex: 'none' }}>{ev.kind === 'compaction' ? '✂' : ev.kind === 'model' ? '⇄' : '•'}</span>
            <span className={'lc-kind lc-kind-' + ev.kind}>{t('kind.' + ev.kind)}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.kind === 'compaction'
              ? '压缩了 ' + ev.count + ' 条消息（' + ev.from + ' → ' + ev.to + '）'
              : ev.kind === 'model' ? '模型切换：' + ev.from + ' → ' + ev.to : String(ev.kind)}</span>
            {ev.kind === 'compaction' && ev.savedChars ? <span style={{ opacity: 0.55, fontSize: 10, flex: 'none' }}>释放 {Math.round(ev.savedChars / 1000)}k 字符</span> : null}
            <span style={{ marginLeft: 'auto', opacity: 0.55, fontSize: 10, flex: 'none' }}>{String(ev.at || '').slice(11, 16)}</span>
          </div>
        )) : (<div style={{ fontSize: 12, opacity: 0.55 }}>{t('events.empty')}</div>)) : (
          <div style={{ fontSize: 12, opacity: 0.55 }}>{t('events.empty')}</div>
        )}
      </div>

      <FileCard activity={state.fileActivity || null}
        loading={state.phase === 'loading'}
        failed={state.phase === 'error'}
        onRetry={() => { try { location.reload() } catch (e) { setRefreshN(refreshN + 1) } }}
        onLocate={locateOp}
        sort={fileSort}
        onSortChange={pickFileSort}
      />

      <div className="lc-card">
        <div className="lc-card-title">
          <span className="lc-card-title-text">工具使用</span>
          <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.55 }}>本会话调用统计</span>
        </div>
        {(state.toolUsage || []).length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 12px', fontSize: 11.5, lineHeight: 1.7 }}>
            {(state.toolUsage || []).map((u: any, i: number) => (
              <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <b style={{ fontWeight: 600 }}>{u.name}</b>
                <span style={{ opacity: 0.5, fontSize: 10 }}>{u.count}</span>
              </span>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 12, opacity: 0.55 }}>暂无工具调用记录</div>
        )}
      </div>

      <div className="lc-card">
        <button type="button" className="lc-settings-head" aria-expanded={settingsOpen} onClick={() => { setSettingsOpen(!settingsOpen) }}>
          <span className="lc-settings-headtext">
            <span className="lc-settings-name">{t('settings.title')}</span>
            <span className="lc-settings-desc">{t('settings.desc')}</span>
          </span>
          <span className={'lc-br-chev' + (settingsOpen ? ' lc-br-chev-on' : '')} />
        </button>
        {settingsOpen ? (
          <div className="lc-settings-body">
            <div className="lc-settings-row">
              <span className="lc-settings-label">{t('settings.gran')}</span>
              <span className="lc-gran" role="group">
                {(['step', 'turn'] as const).map(k => (
                  <button key={k} type="button" className={'lc-gran-btn' + (granularity === k ? ' lc-gran-on' : '')} onClick={() => pickGran(k)}>{t('gran.' + k)}</button>
                ))}
              </span>
            </div>
            <div className="lc-settings-row">
              <span className="lc-settings-label">{t('settings.mode')}</span>
              <span className="lc-gran" role="group">
                {(['total', 'delta'] as const).map(k => (
                  <button key={k} type="button" className={'lc-gran-btn' + (mode === k ? ' lc-gran-on' : '')} onClick={() => pickMode(k)}>{t('gran.' + k)}</button>
                ))}
              </span>
            </div>
            <div className="lc-settings-row">
              <span className="lc-settings-label">{t('settings.fileSort')}</span>
              <span className="lc-gran" role="group">
                {(['count', 'latest', 'path'] as const).map(k => (
                  <button key={k} type="button" className={'lc-gran-btn' + (fileSort === k ? ' lc-gran-on' : '')} onClick={() => pickFileSort(k)}>{t('files.sort.' + k)}</button>
                ))}
              </span>
            </div>
            <div className="lc-settings-row">
              <span className="lc-settings-label">{t('settings.toolSort')}</span>
              <span className="lc-gran" role="group">
                {(['size', 'count', 'name'] as const).map(k => (
                  <button key={k} type="button" className={'lc-gran-btn' + (toolSort === k ? ' lc-gran-on' : '')} onClick={() => pickToolSort(k)}>{t('tool.sort.' + k)}</button>
                ))}
              </span>
            </div>
          </div>
        ) : null}
      </div>

      <div className="lc-card" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11 }}>
        <span style={{ opacity: 0.6 }}>dsh-context × Operit · 真数据版 · v2.1</span>
      </div>
    </div>
  )
}
