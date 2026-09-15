import { useEffect, useMemo, useState } from 'react'
import { DICT_ZH } from './client/i18n'
import { makeViewKit } from './client/viewkit'
import { makeStackedBar, makeLegend } from './client/components/stackedBar'
import { makeDonut } from './client/components/donut'
import { makeTrendChart } from './client/components/trendChart'
import { partsOf } from './client/categories'
import {
  fetchSummary, fetchTimeline, fetchMessages, hasBridge,
  fetchRawSection, fetchRawItem, fetchEvents, fetchFileActivity, fetchToolUsage,
  type MessageItem, type RawSectionData,
} from './data/bridge'
import type { ContextEventRecord, RequestRecord } from './shared/types'

// Operit 语境覆盖
const OVERRIDES: Record<string, string> = { 'cat.inject': '世界书', 'cat.profile': '用户资料', 'cat.summary': '对话总结' }

// 模型价格表（人民币元/百万 token，按约 7.2 汇率自美元价换算；估算用，可自行调整）
const PRICES: Record<string, { pin: number; pcache: number; pout: number }> = {
  'deepseek-flash': { pin: 2, pcache: 0.2, pout: 3 },
  'deepseek-chat': { pin: 2, pcache: 0.2, pout: 3 },
  'deepseek-reasoner': { pin: 4, pcache: 1, pout: 15.8 },
}

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

const DEMO_CURRENT = {
  system: 14906, tools: 11270, user: 1463, inject: 0, skill: 0,
  assistant: 155975, tool: 432412, total: 615226,
}

function demoRequests(): RequestRecord[] {
  const out: RequestRecord[] = []
  for (let i = 1; i <= 60; i++) {
    const user = 520 + (i % 5) * 80
    const tool = 2400 + (i % 11) * 420
    const assistant = 900 + (i % 9) * 160
    const total = 14906 + 11270 + user + assistant + tool
    out.push({
      seq: i, turn: Math.ceil(i / 8), step: ((i - 1) % 8) + 1,
      time: Date.now() - (61 - i) * 45000,
      system: 14906, tools: 11270, user, inject: 0, skill: 0, assistant, tool, total,
      output: 280, cacheRead: Math.round(total * 0.7), prompt: total + 300,
    })
  }
  return out
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
  messages?: MessageItem[]
  events?: any[]
  fileActivity?: any[]
  toolUsage?: any[]
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
}

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
function TextPreview({ text }: { text: string }) {
  const [full, setFull] = useState(false)
  const LIMIT = 4000
  if (text.length <= LIMIT) return <pre style={rawPreStyle}>{text}</pre>
  return (
    <div>
      <pre style={rawPreStyle}>{full ? text : text.slice(0, LIMIT) + '\n\n…（仅预览前 ' + LIMIT + ' 字，数据未丢失）'}</pre>
      <button className="lc-gran-btn" style={{ marginTop: 6 }} onClick={() => setFull(!full)}>
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
  const [granularity, setGranularity] = useState<'step' | 'turn'>('step')
  const [mode, setMode] = useState<'total' | 'delta'>('total')
  const [state, setState] = useState<DataState>({ phase: 'loading' })
  const [refreshN, setRefreshN] = useState(0)
  const [browser, setBrowser] = useState<BrowserState>({ cat: null, label: '', data: null, loading: false, error: '', expanded: {}, expanding: null })

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
      setBrowser({ cat: null, label: '', data: null, loading: false, error: '', expanded: {}, expanding: null })
      const [sum, tl, msgs, evs, fa, tu] = await Promise.all([fetchSummary(), fetchTimeline(), fetchMessages(), fetchEvents(), fetchFileActivity(), fetchToolUsage()])
      if (!alive) return
      if (!sum || !sum.ok || !sum.current) {
        setState({ phase: 'error', error: (sum && sum.error) || '数据读取失败' })
        return
      }
      const requests: RequestRecord[] = (tl || []).map((it, i) => ({
        seq: it.seq || i + 1,
        turn: (it as any).turn || Math.ceil((i + 1) / 8),
        step: (it as any).step || (i % 8) + 1,
        time: it.t,
        system: it.system, tools: it.tools, user: it.user, inject: it.inject,
        skill: it.skill, summary: (it as any).summary, assistant: it.assistant, tool: it.tool, total: it.total,
        historyCount: (it as any).historyCount, historyChars: (it as any).historyChars,
      }))
      setState({
        phase: 'ready', session: sum.session, cardName: (sum as any).cardName, current: sum.current,
        counts: sum.counts, worldbook: sum.worldbook,
        historyCount: sum.historyCount, requests, messages: msgs || [],
        events: evs || [], fileActivity: fa || [], toolUsage: tu || [],
      })
    }
    load()
    return () => { alive = false }
  }, [refreshN])

  const current = state.current || (state.phase === 'demo' ? DEMO_CURRENT : { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 })
  const requests = state.requests || []
  const parts = useMemo(() => partsOf(current as any), [current])
  const segments = useMemo(() => parts.map((p) => ({ key: p.key, color: p.color, value: p.value })), [parts])

  const markers = useMemo<(ContextEventRecord | undefined)[]>(() => {
    return requests.map((r, idx) => {
      if (idx > 0) {
        const prev = requests[idx - 1]
        const hc0 = prev.historyCount || 0
        const hc1 = r.historyCount || 0
        if (hc0 > 0 && hc1 > 0 && hc1 < hc0 * 0.5) {
          return { kind: 'compaction', count: Math.max(0, hc0 - hc1), turn: r.turn, step: r.step } as ContextEventRecord
        }
      }
      return undefined
    })
  }, [requests])

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
      const price = PRICES[String(m.model || '')]
      if (price) {
        costKnown = true
        const cachePart = Math.min(dCached, dIn)
        cost += ((dIn - cachePart) * price.pin + cachePart * price.pcache + dOut * price.pout) / 1e6
      }
    }
    return {
      turns: requests.length,
      turnCount: lastTurn,
      steps: requests.length,
      toolCalls: state.counts ? (state.counts.TOOL_CALL || 0) : 0,
      hit: inSum > 0 ? Math.round((cachedSum / inSum) * 100) : 0,
      waitSum,
      outSum,
      activeMs: firstT && lastT ? Math.max(0, lastT - firstT) : 0,
      answers: msgs.length,
      cost,
      costKnown,
    }
  }, [state, requests])

  const totalTok = current.total || 0

  // 选中趋势柱 → 该轮详情（组成 + 对应完成态的用量/耗时）
  const selectedInfo = useMemo(() => {
    if (selected === null) return null
    const idx = requests.findIndex((r) => r.seq === selected)
    if (idx < 0) return null
    const r = requests[idx]
    const t0 = r.time
    const t1 = idx + 1 < requests.length ? requests[idx + 1].time : Number.MAX_SAFE_INTEGER
    const msgs = state.messages || []
    const hit = msgs.filter((m) => m.sentAt >= t0 && m.sentAt < t1)
    const usage = hit.length ? hit[hit.length - 1] : (msgs.find((m) => m.sentAt >= t0) || null)
    return { r, usage }
  }, [selected, requests, state.messages])

  async function openSection(cat: string, label: string) {
    if (browser.cat === cat) {
      setBrowser({ cat: null, label: '', data: null, loading: false, error: '', expanded: {}, expanding: null })
      return
    }
    setBrowser({ cat, label, data: null, loading: true, error: '', expanded: {}, expanding: null })
    const d = await fetchRawSection(cat, 0, 30)
    setBrowser((b) => b.cat === cat ? { ...b, data: d, loading: false, error: d && d.ok ? '' : ((d && (d as any).error) || '读取失败') } : b)
  }

  async function loadMore() {
    const b = browser
    if (!b.cat || !b.data || !b.data.items) return
    const more = await fetchRawSection(b.cat, b.data.items.length, 30)
    if (more && more.ok && more.items) {
      setBrowser((prev) => prev.cat === b.cat && prev.data ? { ...prev, data: { ...prev.data, items: [...(prev.data.items || []), ...(more.items || [])] } } : prev)
    }
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
    setBrowser((b) => ({ ...b, expanding: idx }))
    const item = await fetchRawItem(idx)
    setBrowser((b) => ({ ...b, expanding: null, expanded: item && item.ok && item.content !== undefined ? { ...b.expanded, [idx]: item.content } : b.expanded }))
  }

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
        <button className="lc-gran-btn" style={{ marginLeft: 'auto' }} onClick={() => setRefreshN(refreshN + 1)}>刷新</button>
        <button className="lc-gran-btn" onClick={() => setDark(!dark)}>{dark ? '浅色' : '深色'}</button>
      </div>

      <div className="lc-card" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, textAlign: 'center' }}>
        <div><div style={{ fontSize: 16, fontWeight: 600 }}>{stats.turnCount}</div><div style={{ fontSize: 10, opacity: 0.65 }}>轮次</div></div>
        <div><div style={{ fontSize: 16, fontWeight: 600 }}>{stats.steps}</div><div style={{ fontSize: 10, opacity: 0.65 }}>步骤</div></div>
        <div><div style={{ fontSize: 16, fontWeight: 600 }}>{stats.toolCalls}</div><div style={{ fontSize: 10, opacity: 0.65 }}>工具调用</div></div>
        <div><div style={{ fontSize: 16, fontWeight: 600 }}>{stats.hit}%</div><div style={{ fontSize: 10, opacity: 0.65 }}>缓存命中</div></div>
      </div>

      <div className="lc-card" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, textAlign: 'center' }}>
        <div><div style={{ fontSize: 16, fontWeight: 600 }}>{fmtDur(stats.activeMs)}</div><div style={{ fontSize: 10, opacity: 0.65 }}>活跃时长</div></div>
        <div><div style={{ fontSize: 16, fontWeight: 600 }}>{fmtDur(stats.waitSum)}</div><div style={{ fontSize: 10, opacity: 0.65 }}>模型等待</div></div>
        <div><div style={{ fontSize: 16, fontWeight: 600 }}>{fmtDur(stats.outSum)}</div><div style={{ fontSize: 10, opacity: 0.65 }}>模型生成</div></div>
        <div><div style={{ fontSize: 16, fontWeight: 600 }}>{stats.answers}</div><div style={{ fontSize: 10, opacity: 0.65 }}>回答数</div></div>
        <div title="按模型价格表估算（¥/百万token）"><div style={{ fontSize: 16, fontWeight: 600 }}>{stats.costKnown ? '¥' + stats.cost.toFixed(2) : '—'}</div><div style={{ fontSize: 10, opacity: 0.65 }}>估算花费</div></div>
      </div>

      <div className="lc-card">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('overview.title')}</span>
          <span style={{ marginLeft: 'auto', fontSize: 11, opacity: 0.7 }}>≈{fmtTok(totalTok)} tokens</span>
        </div>
        <StackedBar
          parts={parts}
          max={totalTok > 0 ? Math.ceil(totalTok * 1.3) : 1000000}
          reserve={{ ratio: 0.8, label: t('overview.compactReserve', { pct: 80 }) }}
          hoverKey={hoverCat}
          onHoverKey={setHoverCat}
        />
        <Legend parts={parts} hoverKey={hoverCat} onHoverKey={setHoverCat} />
      </div>

      <div className="lc-card">
        <div className="lc-card-title">
          <span className="lc-card-title-text">上下文浏览器</span>
          <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.55 }}>点分类展开 · 点条目看全文</span>
        </div>
        {BROWSER_CATS.map((c) => {
          const isOpen = browser.cat === c.key
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
                  {browser.loading ? (
                    <div style={{ fontSize: 12, opacity: 0.6 }}>读取中…</div>
                  ) : browser.error ? (
                    <div style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' }}>{browser.error}</div>
                  ) : browser.data && browser.data.kind === 'text' ? (
                    <TextPreview text={browser.data.content || ''} />
                  ) : browser.data && browser.data.items && browser.data.items.length > 0 ? (
                    <div>
                      {browser.data.items.map((it) => (
                        <div key={it.idx} onClick={() => expandItem(it.idx)} style={{ padding: '7px 2px', borderBottom: '1px solid var(--dsw-alias-border-l1)', cursor: 'pointer' }}>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 12 }}>
                            <span style={{ flex: 'none', fontSize: 10, opacity: 0.8, background: 'var(--dsw-alias-bg-layer-2)', padding: '1px 5px', borderRadius: 4 }}>{kindLabel(it.kind)}</span>
                            {it.toolName || it.name ? <b style={{ fontWeight: 600 }}>{it.toolName || it.name}</b> : null}
                            <span style={{ marginLeft: 'auto', opacity: 0.55, fontSize: 10 }}>{it.chars} 字符</span>
                            {browser.expanding === it.idx ? <span style={{ fontSize: 10, opacity: 0.6 }}>…</span> : null}
                          </div>
                          <div style={{ fontSize: 11.5, opacity: 0.85, marginTop: 4, lineHeight: 1.5 }}>{it.preview}</div>
                          {browser.expanded[it.idx] !== undefined ? <pre style={rawPreStyle}>{browser.expanded[it.idx]}</pre> : null}
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
          <span className="lc-card-title-text">{t('stats.title')}</span>
        </div>
        <Donut segments={segments} centerTop={'≈' + fmtTok(totalTok)} centerSub={t('overview.estimate')} hoverKey={hoverCat} onHoverKey={setHoverCat} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginTop: 10, fontSize: 11.5 }}>
          {segments.filter((s) => s.value > 0).map((s) => (
            <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 7, height: 7, borderRadius: 4, background: s.color, flex: 'none' }} />
              <span>{t('cat.' + s.key)}</span>
              <b style={{ fontWeight: 600 }}>≈{fmtTok(s.value)}</b>
              <span style={{ opacity: 0.55 }}>{totalTok > 0 ? Math.round((s.value / totalTok) * 100) : 0}%</span>
            </span>
          ))}
        </div>
      </div>

      <div className="lc-card">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('trend.title')}</span>
          <span style={{ display: 'inline-flex', gap: 6, marginLeft: 'auto' }}>
            <button className="lc-gran-btn" onClick={() => setGranularity(granularity === 'step' ? 'turn' : 'step')}>
              {granularity === 'step' ? 'Step' : 'Turn'}
            </button>
            <button className="lc-gran-btn" onClick={() => setMode(mode === 'total' ? 'delta' : 'total')}>
              {mode === 'total' ? 'Total' : 'Delta'}
            </button>
          </span>
        </div>
        {requests.length > 0 ? (
          <TrendChart
            requests={requests}
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
              <span style={{ fontWeight: 600 }}>Turn {selectedInfo.r.turn} · Step {selectedInfo.r.step}</span>
              <span style={{ opacity: 0.6 }}>{new Date(selectedInfo.r.time).toLocaleTimeString('zh-CN', { hour12: false })}</span>
              <button className="lc-gran-btn" style={{ marginLeft: 'auto' }} onClick={() => setSelected(null)}>✕</button>
            </div>
            <div style={{ opacity: 0.9 }}>组成 ≈{fmtTok(selectedInfo.r.total)}：系统 {fmtTok(selectedInfo.r.system)} · 技能 {fmtTok(selectedInfo.r.skill)} · 世界书 {fmtTok(selectedInfo.r.inject)} · 工具 {fmtTok(selectedInfo.r.tools)} · 用户 {fmtTok(selectedInfo.r.user)} · 助手 {fmtTok(selectedInfo.r.assistant)} · 结果 {fmtTok(selectedInfo.r.tool)}</div>
            {selectedInfo.usage ? (
              <div style={{ opacity: 0.9 }}>本轮用量：输入 {fmtTok(selectedInfo.usage.input)} · 输出 {fmtTok(selectedInfo.usage.output)} · 缓存 {fmtTok(selectedInfo.usage.cached)}（{Math.round(selectedInfo.usage.cached / Math.max(1, selectedInfo.usage.input) * 100)}%）· 等待 {(selectedInfo.usage.waitMs / 1000).toFixed(1)}s · 生成 {(selectedInfo.usage.outMs / 1000).toFixed(1)}s</div>
            ) : null}
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
          <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.55 }}>压缩 / 模型切换</span>
        </div>
        {(state.events || []).length > 0 ? (state.events || []).map((ev: any, i: number) => (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12, padding: '7px 2px', borderBottom: '1px solid var(--dsw-alias-border-l1)' }}>
            <span style={{ flex: 'none' }}>{ev.kind === 'compaction' ? '✂' : ev.kind === 'model' ? '⇄' : '•'}</span>
            <span>{ev.kind === 'compaction'
              ? '压缩了 ' + ev.count + ' 条消息（' + ev.from + ' → ' + ev.to + '）'
              : ev.kind === 'model' ? '模型切换：' + ev.from + ' → ' + ev.to : String(ev.kind)}</span>
            {ev.kind === 'compaction' && ev.savedChars ? <span style={{ opacity: 0.55, fontSize: 10 }}>释放 {Math.round(ev.savedChars / 1000)}k 字符</span> : null}
            <span style={{ marginLeft: 'auto', opacity: 0.55, fontSize: 10 }}>{String(ev.at || '').slice(11, 16)}</span>
          </div>
        )) : (
          <div style={{ fontSize: 12, opacity: 0.55 }}>暂无事件（发生压缩 / 模型切换时自动出现）</div>
        )}
      </div>

      <div className="lc-card">
        <div className="lc-card-title">
          <span className="lc-card-title-text">文件活动</span>
          <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.55 }}>从工具调用解析 · 零新增写入</span>
        </div>
        {(state.fileActivity || []).length > 0 ? (state.fileActivity || []).map((f: any, i: number) => (
          <div key={i} style={{ padding: '7px 2px', borderBottom: '1px solid var(--dsw-alias-border-l1)' }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 12 }}>
              <span style={{ flex: 'none', fontSize: 10, opacity: 0.85, background: 'var(--dsw-alias-bg-layer-2)', padding: '1px 5px', borderRadius: 4 }}>{f.writes > 0 && f.reads > 0 ? '读写' : f.writes > 0 ? '写' : '读'}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={String(f.path || '')}>{String(f.path || '')}</span>
              <span style={{ marginLeft: 'auto', flex: 'none', opacity: 0.55, fontSize: 10 }}>{f.count} 次</span>
            </div>
            <div style={{ fontSize: 10, opacity: 0.5, marginTop: 2 }}>{f.tools}</div>
          </div>
        )) : (
          <div style={{ fontSize: 12, opacity: 0.55 }}>本轮未检测到文件操作（read/write/edit 等工具会显示在这里）</div>
        )}
      </div>

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

      <div className="lc-card" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11 }}>
        <span style={{ opacity: 0.6 }}>dsh-context × Operit · 真数据版 · v2.1</span>
      </div>
    </div>
  )
}
