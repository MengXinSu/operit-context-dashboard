// Based on dsh-context (https://github.com/bowenliang123/dsh-context, Apache-2.0); modified for the Operit platform.
/**
 * 洞察视图（跨会话总览），对标上游 overviewPanel.tsx + overviewUsage / heatmap / overviewCard。
 *
 * 分成两层：
 *   OverviewView —— 取数/缓存/加载态 + 头部（范围切换、刷新）；数据面只有一个入口
 *                   `call('overview', { range })`（桥层读 index.json + 最近 14 个 chatmsg-*.jsonl，
 *                   不扫 raw，真实样本实测 1–3ms）。切 tab 靠模块级 30s TTL 缓存，不重复请求。
 *   OverviewBody —— 纯展示（拿到 data 就能画）：KPI 栏 / 7 天双柱 / 8 周热力图 / 会话卡 / 覆盖脚注。
 *                   桥层已给的数字一律不再聚合；本层只补两件事：成本估算与版式。
 *
 * 成本口径（三处假设都写在 UI 上，不假装是账单数）：
 *   ① 模型占比：桥层 `models` 只下发统计窗口内的分模型 tokens，用 tokens 占比当权重；
 *   ② 峰谷：按天逐分钟采样 isOffpeak（价格表里的峰时窗 + 周末/法定节假日规则），得到当天峰时占比；
 *   ③ 日成本 = Σ模型 占比 × [(入 - 缓存) × 输入价 + 缓存 × 缓存价 + 出 × 输出价] / 1e6，
 *             单价 = 峰价 × 峰占比 + 谷价 × (1 - 峰占比)。
 *   **只要窗口内有一个模型不在价表里，整个成本就显示 —**（拿其余 tokens 的金额冒充总成本是造假），
 *   并把缺的模型名与 tokens 数写进说明，让缺口看得见。一个都匹配不到 → 同样 —。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  fetchOverview, hasBridge,
  type OverviewData, type OverviewHeatDay, type OverviewModel, type OverviewRange, type OverviewSession,
} from '../../data/bridge'
import { fmt, fmtDuration } from '../format'
import type { Translate } from '../i18n'

// ── 窗口常量（与桥层 ovBuild 的 OV_HEAT_DAYS / 7 天日序列对齐）──
const HEAT_WEEKS = 8
const HEAT_DAYS = HEAT_WEEKS * 7
const USAGE_TICKS: readonly number[] = [0, 25, 50, 75, 100]
const OV_TTL_MS = 30_000

// ── 价格表（结构兼容 App.tsx 的 PriceConfig；这里只读 models 的三项单价）──
export interface OverviewPriceTier { pin: number; pcache: number; pout: number }
export interface OverviewPriceModel { peak: OverviewPriceTier; offpeak: OverviewPriceTier }
export interface OverviewPriceConfig { models: Record<string, OverviewPriceModel> }

// ── 模块级数据缓存（30s TTL + 飞行中复用；按 range 各存一份）──
// 切视图回来时命中 TTL 内的缓存 → 不发请求，这是「切 tab 不重复请求」的落点。
interface OvCacheEntry { at: number; data: OverviewData }
const ovCache = new Map<OverviewRange, OvCacheEntry>()
let ovInflight: { range: OverviewRange; promise: Promise<OverviewData | null> } | null = null

function peekOverview(range: OverviewRange): OverviewData | null {
  const hit = ovCache.get(range)
  return hit && Date.now() - hit.at < OV_TTL_MS ? hit.data : null
}

/** 取数：同一范围并发调用共享一个 Promise（StrictMode 下也只发一次请求）。 */
function loadOverview(range: OverviewRange): Promise<OverviewData | null> {
  if (ovInflight && ovInflight.range === range) return ovInflight.promise
  const promise = fetchOverview(range)
    .then((data) => { if (data) ovCache.set(range, { at: Date.now(), data }); return data })
    .catch(() => null)
    .finally(() => { if (ovInflight && ovInflight.promise === promise) ovInflight = null })
  ovInflight = { range, promise }
  return promise
}

// ── 本地日期工具（与桥层同为本地时区；日期 key 一律 YYYY-MM-DD）──
function pad2(n: number): string { return n < 10 ? '0' + n : String(n) }

function dayKeyOf(d: Date): string {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

/** 'YYYY-MM-DD' → 本地当天 00:00 毫秒；坏值返回 0。 */
function dayStartOfKey(key: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''))
  if (!m) return 0
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
}

function fmtDateTime(ms: number): string {
  if (!(ms > 0)) return '—'
  const d = new Date(ms)
  if (isNaN(d.getTime())) return '—'
  return dayKeyOf(d) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

function fmtCost(v: number): string {
  if (!Number.isFinite(v) || v === 0) return '¥0'
  if (v < 0) return '—'
  if (v < 0.01) return '¥' + v.toFixed(4)
  if (v < 10) return '¥' + v.toFixed(2)
  if (v < 100) return '¥' + v.toFixed(1)
  return '¥' + v.toFixed(0)
}

/** 相对时间：1 分钟内「刚刚」，随后 m/h/d，超过 7 天落回 MM-DD（与上游 relativeTime 同密度）。 */
function relTime(t: Translate, ms: number, now: number): string {
  if (!(ms > 0)) return '—'
  const gap = Math.max(0, now - ms)
  if (gap < 60_000) return t('insights.rel.now')
  if (gap < 3_600_000) return Math.floor(gap / 60_000) + 'm'
  if (gap < 86_400_000) return Math.floor(gap / 3_600_000) + 'h'
  if (gap < 7 * 86_400_000) return Math.floor(gap / 86_400_000) + 'd'
  return dayKeyOf(new Date(ms)).slice(5)
}

// ── 成本估算 ──
interface CostMixEntry { share: number; price: OverviewPriceModel }

interface CostMix {
  /** 命中价格表的模型（占比之和 ≤ 1）。 */
  mix: CostMixEntry[]
  /** 价格表里找不到的 tokens 占比（0..1）。 */
  unpricedShare: number
  /** 价表里没有的模型（按 tokens 降序，最多 3 个），展示成 `名字（N tokens）`。 */
  unpricedNames: string[]
  /** 至少命中一个模型；false 时成本不可估。 */
  known: boolean
}

const UNPRICED_NAMES_MAX = 3

function buildCostMix(models: OverviewModel[] | undefined, priceCfg: OverviewPriceConfig | undefined): CostMix {
  const list = models || []
  let total = 0
  for (const m of list) total += Number(m && m.tokens) || 0
  const mix: CostMixEntry[] = []
  const missing: Array<{ name: string; tokens: number }> = []
  let unpriced = 0
  if (total > 0 && priceCfg && priceCfg.models) {
    for (const m of list) {
      const tokens = Number(m && m.tokens) || 0
      if (!(tokens > 0)) continue
      const name = String((m && m.model) || '')
      const price = priceCfg.models[name]
      if (!price) { unpriced += tokens; missing.push({ name: name || '?', tokens }); continue }
      mix.push({ share: tokens / total, price })
    }
  }
  missing.sort((a, b) => b.tokens - a.tokens)
  return {
    mix,
    unpricedShare: total > 0 ? unpriced / total : 0,
    unpricedNames: missing.slice(0, UNPRICED_NAMES_MAX).map((x) => x.name + '（' + fmt(x.tokens) + ' tokens）'),
    known: mix.length > 0,
  }
}

/** 当天峰时占比（0..1）：按分钟采样 isOffpeak。峰时窗走价格表配置，周末/法定节假日自动落到 0。 */
function peakShareOfDay(isOffpeak: (ms: number) => boolean, dayMs: number): number {
  const start = new Date(dayMs)
  if (isNaN(start.getTime())) return 0
  start.setHours(0, 0, 0, 0)
  const stop = new Date(start.getTime())
  stop.setDate(stop.getDate() + 1)
  const step = 60_000
  let peak = 0, total = 0
  for (let ms = start.getTime(); ms < stop.getTime(); ms += step) {
    total += 1
    if (!isOffpeak(ms)) peak += 1
  }
  return total > 0 ? peak / total : 0
}

interface DayTokens { inTok: number; outTok: number; cachedTok: number }

/** 单日成本：模型占比 × 峰谷加权单价（输入里的缓存部分按缓存价，其余按输入价）。 */
function estimateDayCost(mix: CostMixEntry[], day: DayTokens, peakShare: number): number {
  if (mix.length === 0) return 0
  const inTok = Number(day.inTok) || 0
  const outTok = Number(day.outTok) || 0
  const cached = Math.min(Number(day.cachedTok) || 0, inTok)
  const billed = Math.max(0, inTok - cached)
  let cost = 0
  for (const m of mix) {
    const p = m.price
    const pin = p.peak.pin * peakShare + p.offpeak.pin * (1 - peakShare)
    const pcache = p.peak.pcache * peakShare + p.offpeak.pcache * (1 - peakShare)
    const pout = p.peak.pout * peakShare + p.offpeak.pout * (1 - peakShare)
    cost += m.share * (billed * pin + cached * pcache + outTok * pout) / 1e6
  }
  return cost
}

// ── 热力图网格（8 列 × 7 行，周日打头，与上游 heatmap.tsx 同构）──
interface HeatCell { key: string; future: boolean; entry?: OverviewHeatDay }

function buildHeatGrid(heat: OverviewHeatDay[] | undefined, today: string): HeatCell[][] {
  const byDate = new Map<string, OverviewHeatDay>()
  for (const h of heat || []) if (h && h.date) byDate.set(h.date, h)
  const base = dayStartOfKey(today)
  if (!base) return []
  const anchor = new Date(base)
  anchor.setDate(anchor.getDate() - anchor.getDay()) // 本周日
  const first = new Date(anchor.getTime())
  first.setDate(anchor.getDate() - 7 * (HEAT_WEEKS - 1))
  const cols: HeatCell[][] = []
  for (let w = 0; w < HEAT_WEEKS; w++) {
    const col: HeatCell[] = []
    for (let d = 0; d < 7; d++) {
      const cur = new Date(first.getTime())
      cur.setDate(first.getDate() + w * 7 + d)
      const key = dayKeyOf(cur)
      col.push({ key, future: key > today, entry: byDate.get(key) })
    }
    cols.push(col)
  }
  return cols
}

function heatLevel(value: number, max: number): number {
  if (!(value > 0) || !(max > 0)) return 0
  const ratio = value / max
  if (ratio <= 0.25) return 1
  if (ratio <= 0.5) return 2
  if (ratio <= 0.75) return 3
  return 4
}

export interface OverviewBodyProps {
  t: Translate
  /** 桥层 apiOverview 的原始响应（本层不再聚合，只做成本估算与版式）。 */
  data: OverviewData
  /** 当前统计范围：只影响 KPI 口径与成本估算用的模型占比。 */
  range: OverviewRange
  /** App 的 localStorage 价格表。 */
  priceCfg: OverviewPriceConfig
  /** App 的 isOffpeakAt 绑定 priceCfg 后的纯函数：峰时 = false。 */
  isOffpeak: (ms: number) => boolean
}

export function OverviewView(props: {
  t: Translate
  range: OverviewRange
  onRange: (range: OverviewRange) => void
  priceCfg: OverviewPriceConfig
  isOffpeak: (ms: number) => boolean
}): ReactElement {
  const { t, range, onRange, priceCfg, isOffpeak } = props
  const [state, setState] = useState<{ phase: 'loading' | 'ready' | 'error'; data: OverviewData | null; cached: boolean }>(() => {
    const hit = peekOverview(range)
    return hit ? { phase: 'ready', data: hit, cached: true } : { phase: 'loading', data: null, cached: false }
  })
  const [tick, setTick] = useState(0)
  const forceRef = useRef(false)

  const refresh = useCallback((): void => {
    forceRef.current = true
    setTick((v) => v + 1)
  }, [])

  useEffect(() => {
    let alive = true
    const force = forceRef.current
    forceRef.current = false
    const hit = force ? null : peekOverview(range)
    if (hit) {
      // TTL 内：直接用缓存，不发请求（「切 tab 不重复请求」就靠这里）。
      setState({ phase: 'ready', data: hit, cached: true })
      return () => { alive = false }
    }
    // 过期缓存先上屏（不闪白），再后台重取。
    setState((prev) => ({
      phase: prev.data && prev.data.range === range ? 'ready' : 'loading',
      data: prev.data && prev.data.range === range ? prev.data : null,
      cached: false,
    }))
    loadOverview(range).then((data) => {
      if (!alive) return
      if (!data) { setState({ phase: 'error', data: null, cached: false }); return }
      setState({ phase: 'ready', data, cached: false })
    })
    return () => { alive = false }
  }, [range, tick])

  const data = state.data
  const head = (
    <div className="lc-ov-head">
      <span className="lc-ov-title">{t('insights.title')}</span>
      <span className="lc-ov-sub">{t('insights.desc')}</span>
      <span className="lc-ov-tools">
        {state.cached ? <span className="lc-ov-badge" title={t('insights.cachedHint')}>{t('insights.cached')}</span> : null}
        {data && data.ms !== undefined ? <span className="lc-ov-ms">{t('insights.ms', { n: data.ms })}</span> : null}
        <span className="lc-gran" role="group" aria-label={t('insights.rangeLabel')}>
          {(['today', '7d'] as const).map((r) => (
            <button
              key={r}
              type="button"
              className={'lc-gran-btn' + (range === r ? ' lc-gran-on' : '')}
              aria-pressed={range === r}
              onClick={() => { if (range !== r) onRange(r) }}
            >{t('overview.range.' + r)}</button>
          ))}
        </span>
        <button type="button" className="lc-gran-btn lc-ov-refresh" onClick={refresh} aria-busy={state.phase === 'loading' || undefined}>
          {state.phase === 'loading' ? t('insights.loading') : t('insights.refresh')}
        </button>
      </span>
    </div>
  )

  if (!hasBridge()) {
    return (
      <div className="lc-ov-page">
        {head}
        <div className="lc-card">
          <div className="lc-empty">
            {t('insights.noBridge')}
            <div className="lc-ov-empty-hint">{t('insights.noBridgeHint')}</div>
          </div>
        </div>
      </div>
    )
  }

  if (state.phase === 'error' && !data) {
    return (
      <div className="lc-ov-page">
        {head}
        <div className="lc-card">
          <div className="lc-empty">
            {t('insights.error')}
            <div className="lc-ov-empty-hint">{t('insights.errorHint')}</div>
          </div>
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="lc-ov-page">
        {head}
        <div className="lc-card"><div className="lc-empty">{t('insights.loading')}</div></div>
      </div>
    )
  }

  return (
    <div className="lc-ov-page">
      {head}
      <OverviewBody t={t} data={data} range={range} priceCfg={priceCfg} isOffpeak={isOffpeak} />
    </div>
  )
}

export function OverviewBody(props: OverviewBodyProps): ReactElement {
  const { t, data, range, priceCfg, isOffpeak } = props
  const [metric, setMetric] = useState<'tokens' | 'sessions'>('tokens')
  const [pickedDay, setPickedDay] = useState<string | null>(null)
  const [activeOnly, setActiveOnly] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const nowMs = Date.now()
  const today = useMemo(() => dayKeyOf(new Date()), [])

  const cost = useMemo(() => {
    const mix = buildCostMix(data.models, priceCfg)
    const rows = (data.days || []).map((d) => {
      const start = dayStartOfKey(d.date)
      const peak = start ? peakShareOfDay(isOffpeak, start) : 0
      return { day: d, peak, cost: estimateDayCost(mix.mix, d, peak) }
    })
    const inRange = range === 'today' ? rows.slice(-1) : rows
    let sum = 0, tokens = 0
    for (const r of inRange) { sum += r.cost; tokens += Number(r.day.tokens) || 0 }
    // 成本只在「窗口内每个 token 都能定价」时给出：只要有一个模型不在价表里，就不拿
    // 剩下那部分 tokens 的金额冒充总成本（宁可 —，不造假）。
    return { mix, rows, sum, tokens, ready: mix.known && mix.unpricedShare < 1e-9 && tokens > 0 }
  }, [data, priceCfg, isOffpeak, range])

  const grid = useMemo(() => buildHeatGrid(data.heat, today), [data, today])

  const sessions = useMemo(() => {
    const list = (data.sessions || []).slice()
    list.sort((a, b) => (Number(b.lastActiveMs) || 0) - (Number(a.lastActiveMs) || 0))
    return activeOnly ? list.filter((s) => !!s.active) : list
  }, [data, activeOnly])

  const kpi = data.kpi
  const coverage = data.coverage
  const costReady = cost.ready
  const costNoUsage = cost.tokens <= 0
  const unpricedPct = cost.mix.unpricedShare > 0 ? Math.max(1, Math.round(cost.mix.unpricedShare * 100)) : 0
  /** 成本副标：算得出报口径；算不出报原因（没记录 / 价表缺模型），不假装是账单数。 */
  const costSubText = costReady
    ? (range === 'today' ? t('insights.kpi.costSubToday') : t('insights.kpi.costSub'))
    : (costNoUsage ? t('insights.costNoUsage') : (cost.mix.known ? t('insights.kpi.costPartial', { n: unpricedPct }) : t('insights.costUnknown')))
  /** 成本说明：价表缺模型时报出缺谁；算得出时报方法与外推口径；没记录时不说废话。 */
  const costNoteText = costNoUsage
    ? ''
    : (!cost.mix.known
      ? t('insights.costUnknown')
      : (!costReady
        ? t('insights.costMissing', { names: cost.mix.unpricedNames.join('、') })
        : (range === 'today' ? t('insights.costExtrapolate') + ' ' : '') + t('insights.costNote')))

  const totalTokens = cost.rows.reduce((s, r) => s + (Number(r.day.tokens) || 0), 0)
  const usageEmpty = totalTokens <= 0
  let maxTokens = 0, maxCost = 0
  for (const r of cost.rows) {
    const tok = Number(r.day.tokens) || 0
    if (tok > maxTokens) maxTokens = tok
    if (r.cost > maxCost) maxCost = r.cost
  }
  const barHeight = (value: number, max: number): string => (max <= 0 || value <= 0 ? '0%' : Math.max(4, Math.round((value / max) * 100)) + '%')
  const tokenTick = (pct: number): string => fmt(Math.round((maxTokens * pct) / 100))
  const costTick = (pct: number): string => (!costReady ? '—' : pct === 0 ? '¥0' : fmtCost((maxCost * pct) / 100))

  let maxHeatTokens = 0, maxHeatSessions = 0
  for (const col of grid) {
    for (const cell of col) {
      if (!cell.entry) continue
      if (cell.entry.tokens > maxHeatTokens) maxHeatTokens = cell.entry.tokens
      if (cell.entry.sessions > maxHeatSessions) maxHeatSessions = cell.entry.sessions
    }
  }
  const heatMax = metric === 'tokens' ? maxHeatTokens : maxHeatSessions
  const heatValueOf = (h: OverviewHeatDay): number => (metric === 'tokens' ? h.tokens : h.sessions)
  const heatHasAny = maxHeatTokens > 0 || maxHeatSessions > 0
  const weekdayLabels: Record<number, string> = { 1: t('insights.heat.wd1'), 3: t('insights.heat.wd3'), 5: t('insights.heat.wd5') }

  return (
    <>
      <div className="lc-ov-cols">
        <div className="lc-ov-main">
          <div className="lc-ov-kpis">
            <div className="lc-stat lc-ov-kpi" title={t('insights.kpi.sessionsTip')}>
              <span className="lc-stat-label">{t('insights.kpi.sessions')}</span>
              <span className="lc-stat-value">{kpi.sessions}</span>
              <span className="lc-stat-sub">{t('insights.kpi.sessionsSub', { n: coverage ? coverage.rawSessions : 0 })}</span>
            </div>
            <div className="lc-stat lc-ov-kpi">
              <span className="lc-stat-label">{t('stats.turns')}</span>
              <span className="lc-stat-value">{fmt(kpi.turns)}</span>
              <span className="lc-stat-sub">{t('insights.kpi.turnsSub', { n: fmt(kpi.msgs) })}</span>
            </div>
            <div className="lc-stat lc-ov-kpi" title={t('insights.kpi.tokensTip')}>
              <span className="lc-stat-label">{t('insights.kpi.tokens')}</span>
              <span className="lc-stat-value">{fmt(kpi.billedTokens)}</span>
              <span className="lc-stat-sub">{t('insights.kpi.tokensSub', { in: fmt(kpi.inTok), out: fmt(kpi.outTok) })}</span>
            </div>
            <div className="lc-stat lc-ov-kpi" title={t('insights.costNote')}>
              <span className="lc-stat-label">{t('insights.kpi.cost')}</span>
              <span className="lc-stat-value">{costReady ? fmtCost(cost.sum) : '—'}</span>
              <span className="lc-stat-sub">{costSubText}</span>
            </div>
            <div className="lc-stat lc-ov-kpi" title={t('insights.kpi.cacheTip')}>
              <span className="lc-stat-label">{t('stats.cacheHit')}</span>
              <span className="lc-stat-value">{kpi.inTok > 0 ? (kpi.cacheHit * 100).toFixed(2) + '%' : '—'}</span>
              <span className="lc-stat-sub">{t('insights.kpi.cacheHitSub', { n: fmt(kpi.cachedTok) })}</span>
            </div>
            <div className="lc-stat lc-ov-kpi" title={t('insights.kpi.activeTip')}>
              <span className="lc-stat-label">{t('insights.kpi.active')}</span>
              <span className="lc-stat-value">{fmtDuration(kpi.activeMs)}</span>
              <span className="lc-stat-sub">{t('insights.kpi.activeSub')}</span>
            </div>
          </div>
          {costNoteText ? <div className="lc-ov-note">{costNoteText}</div> : null}

          <div className="lc-card lc-ov-usage">
            <div className="lc-card-title">
              <span className="lc-card-title-text">{t('insights.usage.title')}</span>
              {pickedDay ? (
                <button type="button" className="lc-ov-day-chip" title={t('insights.usage.pickedTip')} onClick={() => setPickedDay(null)}>
                  {t('insights.usage.picked', { date: pickedDay.slice(5) })} ×
                </button>
              ) : null}
            </div>
            {usageEmpty ? (
              <div className="lc-empty">{t('insights.usage.empty')}</div>
            ) : (
              <div className="lc-ov-usage-plot">
                <div className="lc-ov-usage-rail lc-ov-usage-rail-l" aria-hidden="true">
                  {USAGE_TICKS.map((p) => <span key={p} className="lc-ov-usage-tick" style={{ top: (100 - p) + '%' }}>{tokenTick(p)}</span>)}
                </div>
                <div className="lc-ov-usage-grid">
                  <div className="lc-ov-usage-cols">
                    {USAGE_TICKS.map((p) => (
                      <span key={p} className={'lc-ov-usage-line' + (p === 0 ? ' lc-ov-usage-line-0' : '')} style={{ bottom: p + '%' }} aria-hidden="true" />
                    ))}
                    {cost.rows.map((r) => {
                      const tokens = Number(r.day.tokens) || 0
                      const picked = pickedDay === r.day.date
                      const tip = t('insights.usage.tip', {
                        date: r.day.date,
                        tokens: fmt(tokens),
                        in: fmt(r.day.inTok),
                        out: fmt(r.day.outTok),
                        cost: costReady ? fmtCost(r.cost) : '—',
                        turns: fmt(r.day.turns),
                      })
                      return (
                        <button
                          key={r.day.date}
                          type="button"
                          className={'lc-ov-usage-col' + (picked ? ' lc-ov-usage-col-on' : '')}
                          title={tip}
                          aria-pressed={picked}
                          onClick={() => setPickedDay(picked ? null : r.day.date)}
                        >
                          <span className="lc-ov-usage-bars">
                            <span className="lc-ov-usage-bar lc-ov-usage-tokens" style={{ height: barHeight(tokens, maxTokens) }}>
                              {tokens > 0 ? <span className="lc-ov-usage-value">{fmt(tokens)}</span> : null}
                            </span>
                            <span className="lc-ov-usage-bar lc-ov-usage-cost" style={{ height: costReady ? barHeight(r.cost, maxCost) : '0%' }} />
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
                <div className="lc-ov-usage-rail lc-ov-usage-rail-r" aria-hidden="true">
                  {USAGE_TICKS.map((p) => <span key={p} className="lc-ov-usage-tick" style={{ top: (100 - p) + '%' }}>{costTick(p)}</span>)}
                </div>
                <div className="lc-ov-usage-days" aria-hidden="true">
                  {cost.rows.map((r) => (
                    <span key={r.day.date} className={'lc-ov-usage-day' + (pickedDay === r.day.date ? ' lc-ov-usage-day-on' : '')}>{r.day.date.slice(5)}</span>
                  ))}
                </div>
              </div>
            )}
            <div className="lc-ov-usage-key" aria-hidden="true">
              <span className="lc-ov-usage-swatch lc-ov-usage-tokens" />
              <span className="lc-ov-usage-key-label">{t('insights.usage.tokens')}</span>
              <span className={'lc-ov-usage-swatch lc-ov-usage-cost' + (costReady ? '' : ' lc-ov-usage-swatch-off')} />
              <span className="lc-ov-usage-key-label">{costReady ? t('insights.usage.cost') : t('insights.usage.costOff')}</span>
            </div>
          </div>

          <div className="lc-card lc-ov-heat-card">
            <div className="lc-card-title">
              <span className="lc-card-title-text">{t('insights.heat.title')}</span>
              <span className="lc-gran" role="group" aria-label={t('insights.heat.metricLabel')}>
                {(['tokens', 'sessions'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={'lc-gran-btn' + (metric === m ? ' lc-gran-on' : '')}
                    aria-pressed={metric === m}
                    onClick={() => setMetric(m)}
                  >{t('insights.heat.' + m)}</button>
                ))}
              </span>
            </div>
            <div className="lc-ov-note lc-ov-heat-note">{t('insights.heat.note', { metric: t('insights.heat.' + metric), days: HEAT_DAYS })}</div>
            {!heatHasAny ? (
              <div className="lc-empty">{t('insights.heat.empty')}</div>
            ) : (
              <div className="lc-heat-wrap">
                <div className="lc-heat-scroll">
                  <div className="lc-heat" role="group" aria-label={t('insights.heat.title')}>
                    <div className="lc-heat-wds" aria-hidden="true">
                      {[0, 1, 2, 3, 4, 5, 6].map((row) => (
                        <span key={row} className="lc-heat-wd">{weekdayLabels[row] || ''}</span>
                      ))}
                    </div>
                    <div className="lc-heat-cols">
                      {grid.map((col, wi) => {
                        const firstMonth = col[0].key.slice(0, 7)
                        const prevMonth = wi > 0 ? grid[wi - 1][0].key.slice(0, 7) : ''
                        const opens = wi === 0 || firstMonth !== prevMonth
                        return (
                          <div key={wi} className="lc-heat-col">
                            {opens ? <span className="lc-heat-mon" aria-hidden="true">{t('insights.heat.month', { m: Number(firstMonth.slice(5, 7)) })}</span> : null}
                            {col.map((cell) => {
                              if (cell.future) return <span key={cell.key} className="lc-heat-cell lc-heat-future" aria-hidden="true" />
                              if (!cell.entry) return <span key={cell.key} className="lc-heat-cell lc-heat-0" title={cell.key} />
                              const entry = cell.entry
                              const level = heatLevel(heatValueOf(entry), heatMax)
                              const label = t('insights.heat.cell', {
                                date: cell.key,
                                tokens: fmt(entry.tokens),
                                turns: fmt(entry.turns),
                                sessions: entry.sessions,
                                active: entry.activeSessions,
                              })
                              return (
                                <button
                                  key={cell.key}
                                  type="button"
                                  className={'lc-heat-cell lc-heat-' + level + (pickedDay === cell.key ? ' lc-heat-on' : '')}
                                  title={label}
                                  aria-label={label}
                                  aria-pressed={pickedDay === cell.key}
                                  onClick={() => setPickedDay(pickedDay === cell.key ? null : cell.key)}
                                />
                              )
                            })}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
                <div className="lc-heat-legend" aria-hidden="true">
                  <span className="lc-heat-key">{t('insights.heat.less')}</span>
                  {[0, 1, 2, 3, 4].map((level) => <span key={level} className={'lc-heat-cell lc-heat-' + level} />)}
                  <span className="lc-heat-key">{t('insights.heat.more')}</span>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="lc-ov-side">
          <div className="lc-card lc-ov-list">
            <div className="lc-card-title">
              <span className="lc-card-title-text">{t('insights.sessions.title')}</span>
              <span className="lc-ov-count">{sessions.length}</span>
              <span className="lc-gran" role="group" aria-label={t('insights.sessions.filterLabel')}>
                <button type="button" className={'lc-gran-btn' + (activeOnly ? '' : ' lc-gran-on')} aria-pressed={!activeOnly} onClick={() => setActiveOnly(false)}>{t('insights.sessions.all')}</button>
                <button type="button" className={'lc-gran-btn' + (activeOnly ? ' lc-gran-on' : '')} aria-pressed={activeOnly} onClick={() => setActiveOnly(true)}>{t('insights.sessions.activeOnly')}</button>
              </span>
            </div>
            <div className="lc-ov-note">{t('insights.sessions.noSwitch')}</div>
            {sessions.length === 0 ? (
              <div className="lc-empty">{activeOnly ? t('insights.sessions.noActive') : t('insights.sessions.empty')}</div>
            ) : (
              <div className="lc-ov-grid">
                {sessions.map((s: OverviewSession) => {
                  const open = expanded === s.key
                  const title = String(s.preview || '').replace(/\s+/g, ' ').trim()
                  return (
                    <button
                      key={s.key}
                      type="button"
                      className={'lc-ov-session' + (s.active ? '' : ' lc-ov-session-off') + (open ? ' lc-ov-session-on' : '')}
                      aria-expanded={open}
                      title={open ? t('insights.sessions.collapse') : t('insights.sessions.expand')}
                      onClick={() => setExpanded(open ? null : s.key)}
                    >
                      <span className="lc-ov-session-head">
                        <span className="lc-ov-session-title">{title || s.key}</span>
                        <span className="lc-ov-session-times">
                          <span className="lc-ov-session-time">{relTime(t, Number(s.lastActiveMs) || 0, nowMs)}</span>
                        </span>
                      </span>
                      <span className="lc-ov-session-crumb">
                        <span className="lc-ov-crumb-key">{s.key || '—'}</span>
                        <span className="lc-ov-badge">{s.indexed ? t('insights.sessions.indexed') : t('insights.sessions.chargeOnly')}</span>
                        <span className={'lc-ov-badge' + (s.active ? ' lc-ov-badge-on' : '')}>{s.active ? t('insights.sessions.active') : t('insights.sessions.inactive')}</span>
                      </span>
                      <span className="lc-ov-mini-stats">
                        <span className="lc-ov-mini-stat"><span className="lc-ov-mini-label">{t('insights.sessions.tokens')}</span><span className="lc-ov-mini-value">{fmt(s.tokens)}</span></span>
                        <span className="lc-ov-mini-stat"><span className="lc-ov-mini-label">{t('insights.sessions.turns')}</span><span className="lc-ov-mini-value">{fmt(s.turns)}</span></span>
                        <span className="lc-ov-mini-stat"><span className="lc-ov-mini-label">{t('insights.sessions.msgs')}</span><span className="lc-ov-mini-value">{fmt(s.msgs)}</span></span>
                        <span className="lc-ov-mini-stat"><span className="lc-ov-mini-label">{t('insights.sessions.activeTime')}</span><span className="lc-ov-mini-value">{fmtDuration(s.activeMs)}</span></span>
                      </span>
                      {open ? (
                        <span className="lc-ov-session-detail">
                          <span className="lc-ov-detail-row"><span>{t('insights.sessions.key')}</span><b>{s.key || '—'}</b></span>
                          <span className="lc-ov-detail-row"><span>{t('insights.sessions.chatId')}</span><b>{s.chatId || '—'}</b></span>
                          <span className="lc-ov-detail-row"><span>{t('insights.sessions.lastActive')}</span><b>{fmtDateTime(Number(s.lastActiveMs) || 0)}</b></span>
                          <span className="lc-ov-detail-row"><span>{t('insights.sessions.captured')}</span><b>{fmtDateTime(Number(s.capturedAtMs) || 0)}</b></span>
                          <span className="lc-ov-detail-row"><span>{t('insights.sessions.file')}</span><b>{t('insights.sessions.charsLines', { chars: s.chars, lines: s.lines })}</b></span>
                          <span className="lc-ov-detail-row"><span>{t('insights.sessions.io')}</span><b>{t('insights.sessions.ioVal', { in: fmt(s.inTok), out: fmt(s.outTok), cached: fmt(s.cachedTok) })}</b></span>
                        </span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="lc-card lc-ov-coverage">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('insights.coverage.title')}</span>
          <span className="lc-card-sub">{t('insights.coverage.note')}</span>
        </div>
        <div className="lc-ov-cov-rows">
          <span>{t('insights.coverage.raw', { n: coverage ? coverage.rawSessions : 0 })}</span>
          <span>{t('insights.coverage.chat', { days: coverage ? coverage.chatDays : 0, rows: coverage ? coverage.chatRows : 0, skipped: coverage ? coverage.skippedRows : 0 })}</span>
          <span>{t('insights.coverage.span', { from: fmtDateTime(coverage ? coverage.firstMsgMs : 0), to: fmtDateTime(coverage ? coverage.lastMsgMs : 0) })}</span>
          <span>{t('insights.coverage.heat', { n: coverage ? coverage.heatDays : HEAT_DAYS })}</span>
          <span>{t('insights.coverage.window', { from: fmtDateTime(coverage ? coverage.since : 0), to: fmtDateTime(coverage ? coverage.until : 0) })}</span>
        </div>
      </div>
    </>
  )
}
