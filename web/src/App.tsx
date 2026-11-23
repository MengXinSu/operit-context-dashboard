import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { fmtBytes, estimateImageTokens, cacheHitPercent } from './client/format'
import { DICT_ZH } from './client/i18n'
import { makeViewKit } from './client/viewkit'
import { makeStackedBar, makeLegend, AUTO_COMPACT_RATIO } from './client/components/stackedBar'
import { makeDonut } from './client/components/donut'
import { makeTrendChart, aggregateByTurn } from './client/components/trendChart'
import { makeFileCard } from './client/components/fileCard'
import { CATS, partsOf, IMG_COLOR } from './client/categories'
import {
  fetchSummary, fetchTimeline, fetchMessages, hasBridge,
  fetchRawSection, fetchRawItem, fetchEvents, fetchFileActivity, fetchToolUsage, fetchOpenPath,
  fetchTodayMessages, fetchSteps, fetchSessionUsage, fetchStepBrief, fetchMilestones, fetchStats, toolShortName,
  type TodaySessionGroup, type SessionUsageData,
  type MessageItem, type RawSectionData, type RawListItem, type FileActivityData, type FileActivityOp, type MilestoneItem,
  type StatsData,
} from './data/bridge'
import { MilestoneBand } from './client/components/milestoneBand'
import { OverviewView } from './client/components/overviewView'
import type { DurationSample } from './client/components/timelineWindow'
import type { ContextEventRecord, RequestRecord, StepBriefData } from './shared/types'

// Operit 语境覆盖
const OVERRIDES: Record<string, string> = { 'cat.inject': '世界书', 'cat.profile': '用户资料', 'cat.summary': '对话总结', 'settings.title': '设置', 'settings.desc': '各卡显示的默认偏好 · 改动自动保存' }

// F25 插件信息卡：名称与版本（构建时由队长与 manifest 对齐）。更新检查无宿主接口，故不做。
const PLUGIN_NAME = 'dsh-context × Operit'
const PLUGIN_VERSION = 'v2.11.0-o2.13'

// ── 价格配置（峰谷双价，页面内可编辑，localStorage 持久；单位：人民币元/百万 token）──
// 官方规则（2026-09-19 更新核实）：峰时 = 北京时间工作日（不含法定节假日）09:00-12:00、14:00-18:00；
// 其余时段、周末（含调休上班日）与法定节假日全天均为谷时。
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
// 法定节假日表（北京日历日，全天谷时）。2026 年国务院安排共 33 天（数据源：github.com/NateScarlet/holiday-cn）；
// 只列放假日——调休上班的周末无需列入，周末本就全天谷时。次年安排公布后在此追加。
const HOLIDAYS: ReadonlySet<string> = new Set([
  // 元旦
  '2026-01-01', '2026-01-02', '2026-01-03',
  // 春节
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  // 清明节
  '2026-04-04', '2026-04-05', '2026-04-06',
  // 劳动节
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  // 端午节
  '2026-06-19', '2026-06-20', '2026-06-21',
  // 中秋节
  '2026-09-25', '2026-09-26', '2026-09-27',
  // 国庆节
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
  '2026-10-06', '2026-10-07',
])
function localDateKey(d: Date): string {
  const m = d.getMonth() + 1, day = d.getDate()
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : String(m)) + '-' + (day < 10 ? '0' + day : String(day))
}
function isOffpeakAt(cfg: PriceConfig, d: Date): boolean {
  if (HOLIDAYS.has(localDateKey(d))) return true // 法定节假日全天谷时
  if (cfg.weekdaysOnly) {
    const wd = d.getDay()
    if (wd === 0 || wd === 6) return true // 周末全天谷时（含调休上班）
  }
  return !cfg.peaks.some((sp) => inSpan(d, sp))
}

// ── 用户偏好持久化（localStorage，跟价格同一套机制）──
const PREF_KEY = 'dsh-prefs-v1'
function loadPrefs(): Record<string, unknown> {
  try { const r = localStorage.getItem(PREF_KEY); if (r) return JSON.parse(r) } catch (e) {}
  return {}
}
function savePref(key: string, value: unknown): void {
  try { const p = loadPrefs(); p[key] = value; localStorage.setItem(PREF_KEY, JSON.stringify(p)) } catch (e) {}
}

// ── 展示比例尺偏好（设置卡消费）：上下文窗口上限 ──
// 采集层不发布宿主模型的窗口大小，这一项只决定「当前上下文」卡的占用率、预留带与文案比例尺，不改宿主行为。
// 压缩预留带固定按 AUTO_COMPACT_RATIO（0.8）绘制：Operit2 自带压缩入口，插件不再提供阈值设置（P3-6 删除）。
const CTX_WINDOWS: readonly number[] = [128000, 200000, 400000, 1000000]
const DEFAULT_CTX_WINDOW = 1000000
function windowLabel(n: number): string {
  return n >= 1000000 ? (n / 1000000).toFixed(1) + 'M' : Math.round(n / 1000) + 'k'
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
// P4-10：当前上下文明细复用上游 Legend（.lc-legend 芯片网格），不再手搓九行竖排。
const Legend = makeLegend(kit)
const Donut = makeDonut(kit)
const TrendChart = makeTrendChart(kit)
const FileCard = makeFileCard(kit)

const DEMO_CURRENT = {
  system: 16000, tools: 12000, user: 2000, inject: 1000, skill: 1000,
  assistant: 160000, tool: 400000, total: 592000,
}

/** 桥 timeline/steps 原始项 → RequestRecord 统一映射（步骤重建数据同形状） */
function toRequests(items: any[] | null): TimedRequest[] {
  return (items || []).map((it, i) => ({
    seq: it.seq || i + 1,
    turn: it.turn || Math.ceil((i + 1) / 8),
    step: it.step || (i % 8) + 1,
    time: it.t,
    system: it.system, tools: it.tools, user: it.user, inject: it.inject,
    skill: it.skill, summary: it.summary, assistant: it.assistant, tool: it.tool, total: it.total,
    historyCount: it.historyCount, historyChars: it.historyChars,
    skip: it.skip,
    skipWarns: it.skipWarns,
    brief: it.brief,
    pIdx: it.pIdx,
    img: it.img, imgCount: it.imgCount,
    // F10：桥层 apiTimeline 下发的时长（apiSteps 不带；缺失读 undefined → 曲线按无测量断线）
    waitMs: it.waitMs, outMs: it.outMs,
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

/** timeline/steps 记录 + 桥层下发的时长字段（F10）。RequestRecord 本身不含 waitMs/outMs，故在本地扩展。 */
type TimedRequest = RequestRecord & { waitMs?: number; outMs?: number }

type DataState = {
  phase: 'loading' | 'ready' | 'error' | 'demo'
  session?: string
  cardName?: string
  current?: Record<string, number>
  counts?: Record<string, number>
  worldbook?: { blocks: number; chars: number; entries: number; names: string[] }
  historyCount?: number
  requests?: TimedRequest[]
  steps?: TimedRequest[]
  messages?: MessageItem[]
  events?: any[]
  milestones?: MilestoneItem[]
  fileActivity?: FileActivityData | null
  toolUsage?: any[]
  todayGroups?: TodaySessionGroup[]
  sessionUsage?: SessionUsageData | null
  /** P4-4A 上下文统计卡聚合（桥层 apiStats）；null/缺失时页面用已有真实数据兜底渲染。 */
  stats?: StatsData | null
  imgAtt?: { count: number; tokens: number }
  error?: string
  /** P4-1 桥层失败码：'no-raw' = 当前会话还没有记录（正常空态）；'parse-error' = raw 存在但解析失败（真异常）。 */
  code?: string
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

/**
 * F18 事件卡筛选：与宿主 apiEvents 产出的 kind 对齐。
 * compaction/model/warn 是原有三种；prune/inject 由快照推导，skill/agent 来自采集层 events_ 投影（桥层 P4-2C）。
 */
const EVENT_KINDS: string[] = ['compaction', 'prune', 'inject', 'model', 'skill', 'agent', 'warn']
/** 单选项：'all' = 不筛选（与上游 EVENT_FILTERS 同构）。 */
const EVENT_FILTERS: string[] = ['all', ...EVENT_KINDS]

/** 事件行左侧字形（原有 compaction/model/warn 口径不变，补齐新 kind）。 */
const EVENT_GLYPH: Record<string, string> = { compaction: '✂', prune: '⌫', inject: '⊕', model: '⇄', skill: '✦', agent: '⌬', warn: '⚠' }

/**
 * 新 kind 的 chip 底色：base.css 只为 compaction/model/warn 定义了 .lc-kind-* 配色，
 * 这里用内联兜底（不碰 CSS，也不影响既有三种的样式）。
 */
const EVENT_KIND_TINT: Record<string, import('react').CSSProperties> = {
  prune: { background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 15%, transparent)', color: 'var(--dsw-alias-state-warn-primary)' },
  inject: { background: 'color-mix(in srgb, var(--color-purple-500) 15%, transparent)', color: 'var(--color-purple-500)' },
  skill: { background: 'color-mix(in srgb, var(--color-orange-500) 15%, transparent)', color: 'var(--color-orange-500)' },
  agent: { background: 'color-mix(in srgb, var(--color-teal-500) 15%, transparent)', color: 'var(--color-teal-500)' },
}

// ── P4-4A 上下文统计卡（结构照上游 statsContext.tsx；数据换成桥层 apiStats 的口径）──
// chips 配色：上游按排位取色（TOOL_SHADE / nameColorOf），这里用已有 --color-* token 循环取色。
const CHIP_SHADES: readonly string[] = [
  'var(--color-blue-500)', 'var(--color-teal-500)', 'var(--color-purple-500)', 'var(--color-orange-500)',
  'var(--color-amber-500)', 'var(--color-green-500)', 'var(--color-pink-500)', 'var(--color-indigo-500)',
  'var(--color-red-500)', 'var(--color-violet-500)',
]
/** 折叠 chip 的中性色（上游 TOOL_REST）。 */
const CHIP_REST = 'var(--dsw-alias-label-tertiary)'
/** IO 四个输入方向的固定色（上游 IO_COLOR）。 */
const IO_COLORS: Record<string, string> = {
  user: 'var(--color-green-500)', read: 'var(--color-blue-500)', write: 'var(--color-amber-500)', search: 'var(--color-teal-500)',
}
/** KPI 里「上下文事件」三小格：kind → 取色（与事件卡 .lc-kind-* 同源）。 */
const EVENT_KPI: { kind: 'inject' | 'compaction' | 'prune'; color: string }[] = [
  { kind: 'inject', color: 'var(--color-purple-500)' },
  { kind: 'compaction', color: 'var(--dsw-alias-state-error-primary)' },
  { kind: 'prune', color: 'var(--dsw-alias-state-warn-primary)' },
]
/** chips 折叠上限：桥层 apiStats 已按「前 12 + 其他」下发；这是兜底数据源（apiToolUsage）的硬上限。 */
const CHIP_TOP = 16

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
/** 预览行清洗：attachment 块（含被截断的不完整块）→「［图片：文件名］」；link 与其余文本原样保留（与展开正文的图卡语义对齐）。 */
function cleanPreview(s: string): string {
  return s
    .replace(/<attachment\s+([^<>]*?)>([\s\S]*?)(?:<\/attachment>|$)/gi, (_m, attrs) => {
      const fn = (/filename\s*=\s*"([^"]*)"/i.exec(attrs) || [])[1] || '';
      const tp = (/type\s*=\s*"([^"]*)"/i.exec(attrs) || [])[1] || '';
      if (/^image\//i.test(tp)) return fn ? `［图片：${fn}］` : '［图片］';
      return fn ? `［附件：${fn}］` : '［附件］';
    })
    .replace(/<attachment\s+[^<>]*$/i, '［附件］');
}

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

// ── W7④ 图片附件：文本内嵌 <attachment> 标签 → 图片卡/灯箱（上下文浏览器条目内）──
type AttInfo = { path: string; filename: string; mime: string; size: number }
type AttSeg = { kind: 'text'; text: string } | { kind: 'img'; att: AttInfo }

function parseAttAttrs(raw: string): Record<string, string> {
  const o: Record<string, string> = {}
  const re = /([a-zA-Z_]+)="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) o[m[1]] = m[2]
  return o
}

/** 把含 <attachment …> 标签的文本切成文本/图片段；无图片标签时返回 null（调用方走原 TextPreview）。 */
function splitAttachments(text: string): AttSeg[] | null {
  const re = /<attachment\s+([^>]*)>/g
  let m: RegExpExecArray | null
  const segs: AttSeg[] = []
  let last = 0
  let hasImg = false
  while ((m = re.exec(text)) !== null) {
    const attrs = parseAttAttrs(m[1])
    const mime = String(attrs.type || '')
    if (!/^image(\/|$)/i.test(mime)) continue // 非图片附件（如时间 bundle）保持原文
    hasImg = true
    if (m.index > last) segs.push({ kind: 'text', text: text.slice(last, m.index) })
    segs.push({ kind: 'img', att: { path: String(attrs.id || ''), filename: String(attrs.filename || t('attach.image')), mime, size: Number(attrs.size) || 0 } })
    const end0 = m.index + m[0].length
    // 吞掉「内部平台提示 + 闭合标签」：图片块语义只需卡片本身（对齐上游纯 image block）
    const closeAt = text.indexOf('</attachment>', end0)
    const nextOpenAt = text.indexOf('<attachment', end0)
    const hasClosing = closeAt >= 0 && (nextOpenAt < 0 || closeAt < nextOpenAt)
    last = hasClosing ? closeAt + '</attachment>'.length : end0
  }
  if (!hasImg) return null
  if (last < text.length) segs.push({ kind: 'text', text: text.slice(last) })
  return segs
}

function AttachmentLightbox({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div className="lc-att-lightbox" role="dialog" aria-modal="true" aria-label={t('attach.preview')} onClick={(e) => e.stopPropagation()}>
      <div className="lc-att-lightbox-mask" aria-hidden="true" onClick={onClose} />
      <img className="lc-att-lightbox-img" src={src} alt={name} />
      <button type="button" className="lc-att-lightbox-close" aria-label={t('attach.close')} onClick={onClose}>✕</button>
    </div>,
    document.body,
  )
}

/** 单张图片附件卡：64px 缩略图 + 文件名/尺寸/大小/≈token；点开灯箱，失败点击重试。 */
function AttachmentCard({ att }: { att: AttInfo }) {
  const [fail, setFail] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  const [preview, setPreview] = useState(false)
  const src = 'file://' + att.path
  const tokens = dims ? estimateImageTokens(dims.w, dims.h) : null
  const onClick = (e: import('react').MouseEvent) => {
    e.stopPropagation()
    if (fail) { setFail(false); setAttempt((a) => a + 1); return }
    setPreview(true)
  }
  const dimText = dims ? dims.w + '×' + dims.h : ''
  const sizeText = att.size > 0 ? fmtBytes(att.size) : ''
  const meta2 = [dimText, sizeText].filter(Boolean).join(' · ')
  return (
    <>
      <button type="button" className="lc-att-item" title={fail ? t('attach.loadFailed') : t('attach.open')} onClick={onClick}>
        <span className="lc-att-thumb">
          {fail
            ? <span className="lc-att-err">⚠</span>
            : <img key={attempt} src={src} alt={att.filename} onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} onError={() => setFail(true)} />}
        </span>
        <span className="lc-att-meta">
          <span className="lc-att-name" title={att.filename}>{att.filename}</span>
          <span className="lc-att-row">{meta2 || (fail ? '' : '…')}</span>
          {tokens !== null ? <span className="lc-att-row"><b className="lc-att-row-label">{t('attach.token')}</b>{'≈' + fmtTok(tokens)}</span> : null}
        </span>
      </button>
      {preview ? <AttachmentLightbox src={src} name={att.filename} onClose={() => setPreview(false)} /> : null}
    </>
  )
}

/** 条目富内容渲染：图片标签 → 图片卡，其余文本走 TextPreview；无图时与原来完全一致。 */
function RichContent({ text, limit }: { text: string; limit?: number }) {
  const segs = useMemo(() => splitAttachments(text), [text])
  if (!segs) return <TextPreview text={text} limit={limit} />
  return (
    <div>
      {segs.map((s, i) => s.kind === 'img'
        ? <AttachmentCard key={'att' + i} att={s.att} />
        : (s.text.trim() === '' ? null : <TextPreview key={'txt' + i} text={s.text.replace(/^\n+|\n+$/g, '')} limit={limit} />))}
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

/** P4-8 大号数字的 tokens 精确读数：千分位分组（527,586），不缩写成 k/M（缩写留在小字读数里）。 */
function fmtFull(n: number): string {
  const v = Number.isFinite(n) && n > 0 ? Math.round(n) : 0
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * P4-8 一次性发送估算的费用读数：小额（< ¥1）保留 6 位小数 —— 上下文只有一次发送的金额很小，
 * 四舍五入到 ¥0.53 会把两次估算的差别抹平；≥ ¥1 仍按 2 位（与页内其它费用读数同密度）。
 */
function fmtEstCost(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '¥0'
  return v < 1 ? '¥' + v.toFixed(6) : '¥' + v.toFixed(2)
}

// ── U1 卡片标题图标：14px 内联 SVG（currentColor，无第三方依赖；简单几何图形即可）──
type CardIconName = 'stats' | 'tokens' | 'context' | 'timing' | 'browser' | 'timeline' | 'events' | 'files' | 'tools' | 'settings' | 'plugin'

function CardIcon({ name }: { name: CardIconName }) {
  const base: import('react').SVGProps<SVGSVGElement> = {
    width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.35, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
    style: { flex: 'none', opacity: 0.68, marginRight: 5, verticalAlign: '-2px' },
  }
  switch (name) {
    case 'stats': return <svg {...base}><path d="M3 13V8.2M6.3 13V4.8M9.7 13V9.6M13 13V6.4" /></svg>
    case 'tokens': return <svg {...base}><circle cx="8" cy="8" r="5.2" /><path d="M8 4.9V8l2.1 1.4" /></svg>
    case 'context': return <svg {...base}><rect x="2.4" y="2.8" width="11.2" height="2.8" rx="1" /><rect x="2.4" y="7.2" width="7.6" height="2.8" rx="1" /><rect x="2.4" y="11.6" width="4.4" height="1.6" rx="0.8" /></svg>
    case 'timing': return <svg {...base}><circle cx="8" cy="8.6" r="5" /><path d="M8 3.6V1.8M6.4 1.8h3.2M8 6v2.8l1.9 1.2" /></svg>
    case 'browser': return <svg {...base}><path d="M2.4 12.9V3.6h4.1l1.3 1.7h5.8v7.6z" /><path d="M2.4 3.6V2.5h4.3l1 1.1" /></svg>
    case 'timeline': return <svg {...base}><path d="M2.4 12.6l3.1-4.1 3 2.2 5-6.1" /><circle cx="2.6" cy="12.6" r="1" /><circle cx="13.5" cy="4.6" r="1" /></svg>
    case 'events': return <svg {...base}><path d="M2.8 4.4h10.4M2.8 8h10.4M2.8 11.6h6.4" /></svg>
    case 'files': return <svg {...base}><path d="M4 2.4h5l3 3v8.2H4z" /><path d="M9 2.4v3h3" /></svg>
    case 'tools': return <svg {...base}><path d="M10.2 2.7l3.1 3.1-1.9 1.9-1.2-1.2-4.6 4.6a1.35 1.35 0 0 1-1.9-1.9l4.6-4.6-1.2-1.2z" /></svg>
    case 'settings': return <svg {...base}><circle cx="8" cy="8" r="2.2" /><path d="M8 1.9v1.7M8 12.4v1.7M1.9 8h1.7M12.4 8h1.7M3.7 3.7l1.2 1.2M11.1 11.1l1.2 1.2M12.3 3.7l-1.2 1.2M4.9 11.1l-1.2 1.2" /></svg>
    case 'plugin': return <svg {...base}><path d="M8 2.2l1.7 3.5 3.8.6-2.8 2.7.7 3.8L8 11.5l-3.4 1.3.7-3.8-2.8-2.7 3.8-.6z" /></svg>
    default: return null
  }
}

/** F18 事件行正文：原有 compaction/model/warn 口径不变；prune/inject/skill/agent 按桥层下发的字段渲染。 */
function eventTextOf(ev: any): string {
  const k = String(ev.kind || '')
  if (k === 'compaction') return '压缩了 ' + ev.count + ' 条消息（' + ev.from + ' → ' + ev.to + '）'
  if (k === 'prune') {
    const n = Number(ev.count) || 0
    return n > 0
      ? '剪掉 ' + n + ' 条消息（' + ev.from + ' → ' + ev.to + '）'
      : '工具输出被剪（' + ev.from + ' → ' + ev.to + ' 条消息）'
  }
  if (k === 'inject') {
    const d = Number(ev.deltaChars) || 0
    const tail = typeof ev.detail === 'string' && ev.detail !== '' ? ev.detail : (d > 0 ? '+' : '-') + Math.abs(d) + ' 字符'
    return (ev.name ? String(ev.name) + ' ' : '') + tail
  }
  if (k === 'model') return '模型切换：' + ev.from + ' → ' + ev.to
  if (k === 'skill') return '技能加载' + (ev.name ? '：' + ev.name : '') + (ev.detail ? ' · ' + ev.detail : '')
  if (k === 'agent') return '子代理' + (ev.name ? '：' + ev.name : '') + (ev.detail ? ' · ' + ev.detail : '')
  if (k === 'mode') return String(ev.name || ev.detail || '')
  return String(k)
}

/** F10：一条 request 的时长样本（缺字段/非法值读 0 = 无测量，曲线在该点断开）。 */
function timingOf(r: { waitMs?: number; outMs?: number } | null | undefined): DurationSample {
  return { waitMs: Math.max(0, Number((r && r.waitMs) || 0)), outMs: Math.max(0, Number((r && r.outMs) || 0)) }
}

/**
 * F10 时长曲线样本：必须与传给 TrendChart 的请求数组 **同长同序**（长度不符时 TrendChart 整条曲线不画）。
 * - turn 粒度：displayRequests 是 aggregateByTurn(requests) 的结果（每轮一根柱，只保留该轮末步记录），
 *   直接读它的 waitMs/outMs 只是末步的值 → 必须回到 timeline 原始请求，按轮把该轮所有 step 的时长求和。
 * - step 粒度：displayRequests 已是逐步记录；桥层 apiSteps 不携带时长字段，按「轮:步」对齐到 timeline 的同一步。
 *   两套重建口径有差异时对不上 → 给 0（无测量 → 曲线断线，绝不编造）。
 * - demo（无宿主）请求本就没有时长，全部为 0 → 曲线自然不画。
 */
function durationsFor(displayRequests: RequestRecord[], requests: TimedRequest[], granularity: 'step' | 'turn'): DurationSample[] {
  if (granularity === 'turn') {
    const byTurn = new Map<number, DurationSample>()
    for (const r of requests) {
      const key = r.turn ?? 0
      const cur = byTurn.get(key) || { waitMs: 0, outMs: 0 }
      const d = timingOf(r)
      cur.waitMs += d.waitMs
      cur.outMs += d.outMs
      byTurn.set(key, cur)
    }
    return displayRequests.map((r) => byTurn.get(r.turn ?? 0) || { waitMs: 0, outMs: 0 })
  }
  const byStep = new Map<string, DurationSample>()
  for (const r of requests) byStep.set((r.turn ?? 0) + ':' + (r.step ?? 0), timingOf(r))
  return displayRequests.map((r) => byStep.get((r.turn ?? 0) + ':' + (r.step ?? 0)) || { waitMs: 0, outMs: 0 })
}

// ── W7① 步 brief：本轮/输入/回复三行（点击直达浏览器对应条目）──
function BriefChip(props: { label: string | null; text: string; err?: number; onClick?: () => void }) {
  return (
    <span
      className="lc-brief-chip"
      onClick={props.onClick ? (e) => { e.stopPropagation(); if (props.onClick) props.onClick() } : undefined}
      title={(props.label ? props.label + ' · ' : '') + props.text + (props.onClick ? ' —— ' + t('brief.locate') : '')}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: '100%', minWidth: 0,
        padding: '1px 6px', borderRadius: 5,
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
        background: 'var(--dsw-alias-bg-layer-2)',
        fontSize: 10.5, lineHeight: 1.8,
        cursor: props.onClick ? 'pointer' : 'default',
      }}
    >
      {props.err === 1 ? <span style={{ width: 5, height: 5, borderRadius: 3, background: 'var(--dsw-alias-state-warn-primary, #f59e0b)', flex: 'none' }} /> : null}
      {props.label ? <span style={{ opacity: 0.72, flex: 'none' }}>{props.label}</span> : null}
      {props.text ? <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{props.text}</span> : null}
    </span>
  )
}
function BriefSection(props: { brief: StepBriefData | null | undefined; onLocate: (goals: Array<{ idx: number; cat: string }>) => void }) {
  const br = props.brief
  if (!br) return null
  const bRowS: import('react').CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 6, minWidth: 0, marginTop: 5 }
  const bTagS: import('react').CSSProperties = { flex: 'none', width: 26, textAlign: 'right', opacity: 0.55, fontSize: 10.5, lineHeight: '21px' }
  const bWrapS: import('react').CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 4, minWidth: 0, flex: 1 }
  const bEmptyS: import('react').CSSProperties = { opacity: 0.45, fontSize: 10.5, lineHeight: '21px' }
  const bMoreS: import('react').CSSProperties = { opacity: 0.55, fontSize: 10.5, lineHeight: '21px' }
  const MAX = 3
  const op = br.op
  const ins = br.ins || []
  const res = br.res || []
  return (
    <div style={{ marginTop: 7, marginBottom: 1 }}>
      <div style={bRowS}>
        <span className="lc-brief-tag" style={bTagS}>{t('brief.turn')}</span>
        <div style={bWrapS}>
          {op
            ? <BriefChip label="用户" text={op[1]} onClick={() => props.onLocate([{ idx: op[0], cat: 'user' }])} />
            : <span style={bEmptyS}>—</span>}
        </div>
      </div>
      <div style={bRowS}>
        <span className="lc-brief-tag" style={bTagS}>{t('brief.input')}</span>
        <div style={bWrapS}>
          {ins.length === 0
            ? <span style={bEmptyS}>{t('brief.noInputs')}</span>
            : (
              <>
                {ins.slice(0, MAX).map((e) => (
                  <BriefChip key={e[0]} label={e[1]} text={e[2]} err={e[3]} onClick={() => props.onLocate([{ idx: e[0], cat: 'tool' }])} />
                ))}
                {ins.length > MAX ? <span style={bMoreS}>{t('brief.more', { n: ins.length - MAX })}</span> : null}
              </>
            )}
        </div>
      </div>
      <div style={bRowS}>
        <span className="lc-brief-tag" style={bTagS}>{t('brief.reply')}</span>
        <div style={bWrapS}>
          {res.length === 0
            ? <span style={bEmptyS}>—</span>
            : (
              <>
                {res.slice(0, MAX).map((e) => (
                  <BriefChip key={e[0]} label={e[1]} text={e[2]} onClick={() => props.onLocate([{ idx: e[0], cat: e[3] === 'A' ? 'assistant' : 'tool' }])} />
                ))}
                {res.length > MAX ? <span style={bMoreS}>{t('brief.more', { n: res.length - MAX })}</span> : null}
              </>
            )}
        </div>
      </div>
    </div>
  )
}

/** W6 scope 副标题：与趋势详情卡一致的轮/步文案。 */
function scopeLabelOf(r: RequestRecord, granularity: 'step' | 'turn', turnSteps: number): string {
  return granularity === 'step'
    ? `第 ${r.turn} 轮 · 第 ${r.step} 步`
    : (turnSteps > 1 ? `第 ${r.turn} 轮 · 共 ${turnSteps} 步` : `第 ${r.turn} 轮`)
}

/**
 * F26「增量基线」的消费点 —— 趋势卡增量模式下每根柱与谁对比。
 *
 * trendChart 的增量固定是「相邻两根柱相减」（图组件不接受基线参数，本轮不改它），
 * 所以这里把「期望的增量」编码成前缀和再交给图：图算出的相邻差 = 我们想要的 Δ。
 *   base='step' → 原样返回（等价于现状：与上一根柱相减）
 *   base='turn' → 与「上一轮的最后一步」相减（对齐上游 baseRequestOf 口径；
 *                 同一轮内每一步都与上一轮末步比，换轮时基线自然切换）
 * 已知代价（写清以免被当成 bug）：
 *   0) 第 1 轮没有「上一轮」→ 退化为与上一步比（整轮画 0 等于谎报「没有变化」）；
 *   1) 日志第一根柱没有基线 → 图为它画 Δ=0（本来就是这样）；
 *   2) 增量模式只画 Δ 与 churn，不看累计值，故前缀和的绝对量不会露到刻度/tooltip 上。
 * 轮粒度调用方不进来：displayRequests 已经是「每轮一根柱」，相邻相减本来就是按轮比。
 */
export function deltaBaseRequests(rows: RequestRecord[], base: 'step' | 'turn'): RequestRecord[] {
  if (base !== 'turn' || rows.length === 0) return rows
  const keys = CATS.map((c) => c.key as string)
  // 每一轮最后一条记录的下标（日志里轮号递增，所以取到的下标一定在当前行之前）
  const lastIdxOfTurn = new Map<number, number>()
  for (let i = 0; i < rows.length; i++) lastIdxOfTurn.set(rows[i].turn ?? 0, i)
  const out: RequestRecord[] = [{ ...rows[0] }]
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    const bi = lastIdxOfTurn.get((r.turn ?? 0) - 1)
    // 第 1 轮没有「上一轮」→ 退化为与上一步比：否则整轮都画 0，等于谎报「本轮没有变化」
    const baseRow = bi !== undefined && bi < i ? rows[bi] : rows[i - 1]
    const prev = out[i - 1]
    const next: RequestRecord = { ...r }
    for (const k of keys) {
      const v = (r as unknown as Record<string, number>)[k] || 0
      const b = (baseRow as unknown as Record<string, number>)[k] || 0
      ;(next as unknown as Record<string, number>)[k] = ((prev as unknown as Record<string, number>)[k] || 0) + (v - b)
    }
    const imgV = r.img || 0
    const imgB = baseRow.img || 0
    next.img = (prev.img || 0) + (imgV - imgB)
    out.push(next)
  }
  return out
}

/**
 * F24 计费三桶：缓存读 / 未缓存输入 / 输出（上游 statsTokens 是四桶，我们少「缓存写」一桶）。
 *   cacheRead     = cachedInputTokens
 *   uncachedInput = inputTokens − cachedInputTokens（chatmsg 的 inputTokens 含缓存部分）
 *   output        = outputTokens
 * 三桶之和恒等于 inputTokens + outputTokens（= 计费卡 total）；cached 脏数据夹到 [0, input]，
 * 不产生负数。缓存写宿主没有上报（chatmsg 无 cacheWrite 字段）→ 不做第四桶、也不按比例估算。
 */
export function tokenBucketsOf(
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
): { cacheRead: number; uncachedInput: number; output: number } {
  const input = Math.max(0, inputTokens || 0)
  const output = Math.max(0, outputTokens || 0)
  const cached = Math.max(0, Math.min(cachedInputTokens || 0, input))
  return { cacheRead: cached, uncachedInput: input - cached, output }
}

export function App() {
  const [dark, setDark] = useState(() => {
    try { const v = localStorage.getItem('dsh_dark'); return v === null ? true : v === '1' } catch (e) { return true }
  })
  // P4-6 视图切换：'session' = 当前会话（默认，不持久化 —— 每次打开面板都从当前会话看起），'insights' = 跨会话洞察。
  const [view, setView] = useState<'session' | 'insights'>('session')
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
  // W10 偏好：自适应缩放、窗口比例尺（设置卡统一入口；均有真实消费点）。
  const [adaptive, setAdaptive] = useState<boolean>(() => loadPrefs().adaptive !== 'off')
  const [ctxWindow, setCtxWindow] = useState<number>(() => { const v = Number(loadPrefs().ctxWindow); return CTX_WINDOWS.includes(v) ? v : DEFAULT_CTX_WINDOW })
  // 里程碑空态：关闭后持久化（'1'）；有事件时照常显示旗子，且不清除该标记（下次无事件仍保持关闭）。
  const [msHintDismissed, setMsHintDismissed] = useState<boolean>(() => loadPrefs().msHintDismissed === '1')
  // F10 时长曲线开关（默认关；与其它卡内偏好同套持久化，改动即时生效）
  const [durationCurve, setDurationCurve] = useState<boolean>(() => loadPrefs().durationCurve === 'on')
  // F26 增量基线：'step' = 与上一根柱比（默认，= 旧行为）；'turn' = 与上一轮末步比（仅步骤粒度下有区别）
  const [deltaBase, setDeltaBase] = useState<'step' | 'turn'>(() => (loadPrefs().deltaBase === 'turn' ? 'turn' : 'step'))
  // F26 洞察页两项：本批只持久化偏好，等洞察页（apiOverview + 页面）接入后消费；设置行带「预留」标记
  const [overviewRange, setOverviewRange] = useState<'today' | '7d'>(() => (loadPrefs().overviewRange === '7d' ? '7d' : 'today'))
  const [insightsEntry, setInsightsEntry] = useState<'show' | 'hide'>(() => (loadPrefs().insightsEntry === 'hide' ? 'hide' : 'show'))
  // F18 事件卡：单选筛选（'all' = 不筛选）；事件卡 chips 与设置卡「事件 · 默认筛选」共用同一 state 与持久化。
  const [eventKind, setEventKind] = useState<string>(() => {
    const v = loadPrefs().eventKind
    return typeof v === 'string' && (v === 'all' || EVENT_KINDS.includes(v)) ? v : 'all'
  })
  /** 偏好写回：更新 state + localStorage（设置卡与卡内切换共用）。 */
  const pickGran = (v: 'step' | 'turn'): void => { setGranularity(v); savePref('granularity', v) }
  const pickMode = (v: 'total' | 'delta'): void => { setMode(v); savePref('mode', v) }
  const pickFileSort = (v: 'count' | 'latest' | 'path'): void => { setFileSort(v); savePref('fileSort', v) }
  const pickToolSort = (v: 'size' | 'count' | 'name'): void => { setToolSort(v); savePref('toolSort', v) }
  const pickAdaptive = (v: boolean): void => { setAdaptive(v); savePref('adaptive', v ? 'on' : 'off') }
  const pickCtxWindow = (v: number): void => { setCtxWindow(v); savePref('ctxWindow', String(v)) }
  const pickDurationCurve = (v: boolean): void => { setDurationCurve(v); savePref('durationCurve', v ? 'on' : 'off') }
  const pickDeltaBase = (v: 'step' | 'turn'): void => { setDeltaBase(v); savePref('deltaBase', v) }
  const pickOverviewRange = (v: 'today' | '7d'): void => { setOverviewRange(v); savePref('overviewRange', v) }
  const pickInsightsEntry = (v: 'show' | 'hide'): void => { setInsightsEntry(v); savePref('insightsEntry', v) }
  const pickEventKind = (k: string): void => { setEventKind(k); savePref('eventKind', k) }
  /** 里程碑空态提示关闭：写回 localStorage，之后即使仍无事件也不再提示。 */
  const dismissMsHint = (): void => { setMsHintDismissed(true); savePref('msHintDismissed', '1') }
  const [state, setState] = useState<DataState>({ phase: 'loading' })
  const [refreshN, setRefreshN] = useState(0)
  // W6：瞬态提示（打开失败等；自动消失，无持久化）
  const [flash, setFlash] = useState('')
  const flashTimer = useRef<number | null>(null)
  const showFlash = useCallback((msg: string): void => {
    setFlash(msg)
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => { setFlash('') }, 2600)
  }, [])
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
  // P4-6 洞察页成本估算：把峰谷判定绑到当前价格表，传给洞察视图（它是纯函数，身份稳定 → 视图内 useMemo 不会白算）。
  const isOffpeakMs = useCallback((ms: number): boolean => isOffpeakAt(priceCfg, new Date(ms)), [priceCfg])
  const [browser, setBrowser] = useState<BrowserState>({ cat: null, label: '', data: null, loading: false, error: '', expanded: {}, expanding: null, notice: '' })
  const [hoverTiming, setHoverTiming] = useState<string | null>(null)
  // W7② 计费卡 hover（与统计卡独立）
  const [billingHover, setBillingHover] = useState<string | null>(null)
  // W3 定位联动：浏览器卡锚点、条目 ref 表、browser 镜像（供稳定回调读 latest）、定位序号（迟到响应防串台）。
  const browserCardRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef<Record<number, HTMLElement | null>>({})
  const browserRef = useRef(browser)
  useEffect(() => { browserRef.current = browser }, [browser])
  const locateSeq = useRef(0)
  const [pendingFocus, setPendingFocus] = useState<{ idx: number } | null>(null)
  // F25 插件信息卡「打开设置」：展开设置卡并滚过去（下一帧滚动，让展开后的高度先参与布局）。
  const settingsCardRef = useRef<HTMLDivElement | null>(null)
  // P4-4A 统计卡 chips 的跳转锚点：跳不到浏览器具体条目时滚到对应卡片（不假装能定位）。
  const fileCardRef = useRef<HTMLDivElement | null>(null)
  const eventsCardRef = useRef<HTMLDivElement | null>(null)
  const scrollToCard = (ref: { current: HTMLDivElement | null }): void => {
    try { ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }) } catch (e) { /* 滚动失败不阻断其它交互 */ }
  }
  const openSettingsCard = (): void => {
    setSettingsOpen(true)
    window.requestAnimationFrame(() => {
      try { settingsCardRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }) } catch (e) { /* 滚动失败不阻断展开 */ }
    })
  }
  /** P4-4A：统计卡的「上下文事件」KPI → 事件卡的单选筛选联动（同一 state，事件卡立刻按此过滤）+ 滚过去。 */
  const showEventKind = (kind: string): void => { pickEventKind(kind); scrollToCard(eventsCardRef) }

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
      const [sum, tl, msgs, evs, fa, tu, tm, st, su, ml, sst] = await Promise.all([fetchSummary(), fetchTimeline(), fetchMessages(), fetchEvents(), fetchFileActivity(), fetchToolUsage(), fetchTodayMessages(), fetchSteps(), fetchSessionUsage(), fetchMilestones(), fetchStats()])
      if (!alive) return
      if (!sum || !sum.ok || !sum.current) {
        // P4-1：桥层带回 code —— 'no-raw' 是「还没有记录」的正常空态，其余才是真异常。
        const code = sum ? String((sum as any).code || '') : ''
        setState({ phase: 'error', code: code || undefined, error: code === 'no-raw' ? '' : ((sum && sum.error) || '数据读取失败') })
        return
      }
      const requests = toRequests(tl)
      const steps = toRequests(st)
      setState({
        phase: 'ready', session: sum.session, cardName: (sum as any).cardName, current: sum.current,
        counts: sum.counts, worldbook: sum.worldbook,
        historyCount: sum.historyCount, requests, steps, messages: msgs || [],
        events: evs || [], milestones: ml || [], fileActivity: fa || null, toolUsage: tu || [],
        todayGroups: (tm && tm.ok && tm.groups) ? tm.groups : [],
        sessionUsage: su || null,
        stats: sst || null,
        imgAtt: (sum as any).imgAttachments || undefined,
      })
    }
    load()
    return () => { alive = false }
  }, [refreshN])

  const current = state.current || (state.phase === 'demo' ? DEMO_CURRENT : { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 })
  // P4-1：无记录 ≠ 真异常；只影响顶部状态条与主体空态，不改任何取数逻辑。
  const noRaw = state.code === 'no-raw'
  const requests = state.requests || []
  // 里程碑空态提示：无事件、未关闭、且数据已就绪（ready/demo）才传；有事件时组件忽略该 prop，照常渲染旗子。
  const msEmptyHint = !msHintDismissed && (state.phase === 'ready' || state.phase === 'demo') && (state.milestones === undefined || state.milestones.length === 0)
    ? t('milestone.emptyHint')
    : undefined
  const parts = useMemo(() => {
    const ps = partsOf(current as any)
    //「图片」第十段（动态）：仅当上下文含图片附件 token 时追加到九段之后；无图时不占位
    const imgTok = (current as any).img || 0
    if (imgTok > 0) ps.push({ key: 'img', color: IMG_COLOR, value: imgTok })
    return ps
  }, [current])

  //轮次/步骤切换：轮次=每轮一根柱（取该轮末步记录聚合，附 stepCount）；步骤=每步一根柱。与上游 dsh-context 行为一致。
  const displayRequests = useMemo(
    () => (granularity === 'turn' ? aggregateByTurn(requests) : (hasBridge() ? (state.steps || []) : requests)),
    [requests, granularity, state.steps],
  )

  // F10 时长曲线：样本严格对齐 displayRequests（同长同序）；开关关闭时传 null（整条曲线+右轴都不渲染）。
  const durations = useMemo<DurationSample[] | null>(
    () => (durationCurve ? durationsFor(displayRequests, requests, granularity) : null),
    [durationCurve, displayRequests, requests, granularity],
  )

  // F26 增量基线（趋势卡增量模式的消费点）：步骤粒度 + 基线=上一轮时，把柱换成「相对上一轮末步」的前缀和，
  // 图算出的相邻差就是期望的 Δ。其余组合原样下发（与旧行为完全一致）；长度/顺序不变，markers 与 durations 仍对齐。
  const chartRequests = useMemo<RequestRecord[]>(
    () => (mode === 'delta' && deltaBase === 'turn' && granularity === 'step' ? deltaBaseRequests(displayRequests, 'turn') : displayRequests),
    [mode, deltaBase, granularity, displayRequests],
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
    let waitSum = 0, outSum = 0
    // P4-8 耗时卡口径：只有真正测到时长的完成消息才计入「N 条」样本数（0 = 无测量，不是 0ms）
    let waitN = 0, outN = 0
    let firstT = 0, lastT = 0
    for (const m of msgs) {
      const w = m.waitMs || 0
      const o = m.outMs || 0
      waitSum += w; outSum += o
      if (w > 0) waitN += 1
      if (o > 0) outN += 1
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
      waitSum,
      outSum,
      waitN,
      outN,
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

  // P4-8 当前上下文大号数字的费用口径：上下文 tokens × 本会话最后一条完成消息模型的当前峰谷输入价（全部按非缓存输入）。
  // 缺模型或价表里没这个模型 → 费用显示 —（与洞察页同口径：拿别的模型价冒充总价属于造假）。
  const estModel = useMemo(() => {
    const msgs = state.messages || []
    for (let i = msgs.length - 1; i >= 0; i--) {
      const name = String(msgs[i].model || '')
      if (name) return name
    }
    return ''
  }, [state.messages])
  const estPrice = (estModel && priceCfg.models[estModel]) ? priceCfg.models[estModel] : null
  const estTier = estPrice ? (offpeakNow ? estPrice.offpeak : estPrice.peak) : null
  const estCost = (estTier !== null && totalTok > 0) ? (totalTok * estTier.pin) / 1e6 : null
  const estCostText = estCost === null ? '—' : '≈' + fmtEstCost(estCost)
  const estTierLabel = offpeakNow ? t('overview.tierOffpeak') : t('overview.tierPeak')
  // P4-10 脚注压成一行：可见行只留最短口径/缺价原因，完整口径 + 计价依据放进 title。
  const estBasisText = estCost === null
    ? (estModel ? t('overview.estMissing', { model: estModel }) : t('overview.estNoModel'))
    : t('overview.estBasis', { tier: estTierLabel, pin: estTier ? estTier.pin : 0, model: estModel })
  const estNoteShort = estCost === null
    ? (estModel ? t('overview.estMissingShort', { model: estModel }) : t('overview.estNoModelShort'))
    : t('overview.estNoteShort')
  const estNoteFull = t('overview.estNote') + ' ' + estBasisText

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
    const skipN = granularity === 'step' ? (r.skip || 0) : ((agg && agg.skip !== undefined) ? agg.skip : (r.skip || 0))
    const skipWarns = granularity === 'step' ? (r.skipWarns || []) : ((agg && agg.skipWarns) || [])
    return { r, usage, turnSteps, marker, skipN, skipWarns, parts: (() => { const ps = partsOf(r as any); const iv = (r as any).img || 0; if (iv > 0) ps.push({ key: 'img', color: IMG_COLOR, value: iv }); return ps })() }
  }, [selected, requests, state.messages, displayRequests, markers])

  // W9①步 brief 按需化：apiSteps 不再附带全量 brief；选中步/轮时单步拉取（毫秒级）+会话内缓存。
  // 步模式 = r.pIdx；轮模式 = 该轮最后一步的 pIdx（输入行留空，与上游 turn 语义一致）。
  const briefCacheRef = useRef<Map<number, StepBriefData | null>>(new Map())
  // 会话/数据刷新时清缓存（pIdx 在压缩 / 会话切换后可能漂移）
  useEffect(() => { briefCacheRef.current.clear() }, [state.session, state.requests])
  const [briefData, setBriefData] = useState<StepBriefData | null>(null)
  const briefTarget = useMemo(() => {
    if (!selectedInfo) return null
    if (granularity === 'step') return typeof selectedInfo.r.pIdx === 'number' ? selectedInfo.r.pIdx : null
    const steps = state.steps || []
    let last: RequestRecord | null = null
    for (const s of steps) { if (s && s.turn === selectedInfo.r.turn) last = s }
    return last && typeof last.pIdx === 'number' ? last.pIdx : null
  }, [selectedInfo, granularity, state.steps])
  useEffect(() => {
    if (briefTarget === null) { setBriefData(null); return }
    const cache = briefCacheRef.current
    if (cache.has(briefTarget)) { setBriefData(cache.get(briefTarget) || null); return }
    setBriefData(null)
    if (!hasBridge()) return
    let alive = true
    fetchStepBrief(briefTarget).then((b) => {
      cache.set(briefTarget, b)
      if (alive) setBriefData(b)
    })
    return () => { alive = false }
  }, [briefTarget])
  const briefInfo = useMemo(() => (granularity === 'turn' && briefData ? { ...briefData, ins: [] as StepBriefData['ins'] } : briefData), [briefData, granularity])
  // W7② 会话计费：输入按当前构成比例分摊（≈），输出段用真值（同上游 billedParts 口径）。
  const billing = useMemo(() => {
    const su = state.sessionUsage
    if (!su || !su.ok || !(su.rows > 0) || !((su.input + su.output) > 0)) return null
    const input = su.input
    const output = su.output
    const sumParts = parts.reduce((acc, p) => acc + p.value, 0)
    const segs: Array<{ key: string; color: string; value: number }> = parts.map((p) => ({
      key: p.key, color: p.color, value: sumParts > 0 ? Math.round(p.value * (input / sumParts)) : 0,
    }))
    segs.push({ key: 'output', color: '#f43f5e', value: output })
    // F24 计费三桶（与展开行同口径，见 tokenBucketsOf）
    const buckets = tokenBucketsOf(input, su.cached || 0, output)
    // P4-8 缓存命中：口径 = 计费输入（缓存读 / 输入），与三桶同源；公式与宿主聊天统计行同款（截断 2 位）
    return { total: input + output, rows: su.rows, segs, buckets, hit: cacheHitPercent(buckets.cacheRead, input) }
  }, [state.sessionUsage, parts])
  // F24 三桶展示行（顺序固定：缓存读 → 未缓存输入 → 输出）；颜色与耗时卡同源色系，不改样式表。
  const tokenBuckets = useMemo(() => {
    if (!billing) return [] as Array<{ key: string; label: string; color: string; value: number }>
    const b = billing.buckets
    return [
      { key: 'cacheRead', label: t('tokens.cacheRead'), color: '#3b82f6', value: b.cacheRead },
      { key: 'uncachedInput', label: t('tokens.uncachedInput'), color: '#f59e0b', value: b.uncachedInput },
      { key: 'output', label: t('tokens.output'), color: '#f43f5e', value: b.output },
    ]
  }, [billing])
  // W6 文件卡 scope：跟随趋势图选中（轮级近似过滤；userIdx = 数据窗口的 USER 锚点）。
  const fileScope = useMemo(() => {
    const def = { text: t('files.scopeLatest'), before: null as number | null, out: false }
    const u = (state.fileActivity && state.fileActivity.userIdx) ? state.fileActivity.userIdx : []
    if (selected === null || selectedInfo === null || u.length === 0) return def
    const r = selectedInfo.r
    const last = displayRequests.length ? (displayRequests[displayRequests.length - 1].turn || 0) : 0
    const cur = r.turn || 0
    if (!cur || !last) return def
    const text = scopeLabelOf(r, granularity, selectedInfo.turnSteps)
    const d = last - cur
    if (d >= u.length) return { text, before: null, out: true }
    return { text, before: d > 0 ? u[u.length - d] : null, out: false }
  }, [state.fileActivity, selected, selectedInfo, displayRequests, granularity])

  // W6 op 时间带：窗口 USER 锚点 → 该轮快照时间（与 requests 尾部对齐；供文件卡行尾时间）。
  const opTimeBands = useMemo<Array<[number, number]> | null>(() => {
    const u = (state.fileActivity && state.fileActivity.userIdx) ? state.fileActivity.userIdx : []
    if (!u.length || !requests.length) return null
    const take = Math.min(u.length, requests.length)
    const out: Array<[number, number]> = []
    for (let i = 0; i < take; i++) {
      const uu = u[u.length - take + i]
      const tt = requests[requests.length - take + i]
      if (tt && typeof tt.time === 'number' && tt.time > 0) out.push([uu, tt.time])
    }
    return out.length ? out : null
  }, [state.fileActivity, requests])

  // W5复核新增：事件筛选辅助 + 工具定义排序（设置卡 toolSort 的消费点；其余分类维持宿主顺序）。
  // F18：事件筛选为单选（eventKind='all' 即不筛选），卡内 chips 与设置卡共用同一 state。
  const evCounts = useMemo(() => { const m: Record<string, number> = {}; for (const ev of (state.events || [])) { const k = String(ev.kind || ''); m[k] = (m[k] || 0) + 1 } return m }, [state.events])
  const evTotal = (state.events || []).length
  const shownEvents = useMemo(
    () => (state.events || []).filter((ev: any) => eventKind === 'all' || String(ev.kind || '') === eventKind).slice().reverse(),
    [state.events, eventKind],
  )
  const toolCounts = useMemo(() => { const m = new Map<string, number>(); for (const u of (state.toolUsage || [])) m.set(String(u.name || ''), Number(u.count) || 0); return m }, [state.toolUsage])
  /**
   * P4-4A 上下文统计卡数据：桥层 apiStats 优先。
   * 接口未就绪/失败时用页面已有的**同一批真实数据**兜底（不虚构数字）：
   * 工具名 ← apiToolUsage（已解 proxy）、读写搜索 ← 文件活动聚合、事件三项 ← apiEvents 计数、
   * 轮次/步数/回复数/工具调用数 ← 本页既有 stats。两组都没有时才落 0。
   */
  const statsCard = useMemo(() => {
    const s = state.stats
    const fa = state.fileActivity
    const localTools = (state.toolUsage || []).map((u: any) => {
      const name = String(u.name || '')
      return { name, count: Number(u.count) || 0, short: toolShortName(name) }
    })
    const core = s ? s.core : {
      turns: stats.turnCount,
      steps: stats.steps,
      skills: 0,
      answers: stats.answers,
      events: { inject: evCounts.inject || 0, compaction: evCounts.compaction || 0, prune: evCounts.prune || 0 },
    }
    const io = s ? s.io : {
      in: {
        user: stats.turnCount,
        read: fa ? fa.totals.read.ops : 0,
        write: fa ? fa.totals.write.ops : 0,
        search: fa ? fa.totals.search.ops : 0,
      },
      out: { tools: stats.toolCalls },
    }
    const commands = (s && s.commands) ? s.commands : []
    const cmdSum = commands.reduce((a, c) => a + (Number(c.count) || 0), 0)
    return {
      core,
      io,
      tools: (s && s.tools && s.tools.length > 0) ? s.tools : localTools,
      commands,
      /** 标题数字：命令行调用次数（runs）优先；桥层未下发时回退到程序执行次数合计。 */
      runs: (s && typeof s.runs === 'number') ? s.runs : cmdSum,
      runsFromBridge: !!(s && typeof s.runs === 'number'),
    }
  }, [state.stats, state.toolUsage, state.fileActivity, stats, evCounts])
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
    const d = await fetchRawSection(cat, 0, 10)
    setBrowser((b) => b.cat === cat ? { ...b, data: d, loading: false, error: d && d.ok ? '' : ((d && (d as any).error) || '读取失败') } : b)
  }

  async function loadMore() {
    const b = browser
    if (!b.cat || !b.data || !b.data.items) return
    if (b.loadingMore) return // 防重入：连点会重复追加同一段
    setBrowser((prev) => ({ ...prev, loadingMore: true }))
    const more = await fetchRawSection(b.cat, (b.data.offset || 0) + b.data.items.length, 10)
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

  // W7① 泛化定位：任意锚点列表 → 逐目标尝试、一页直达、滚入视野（文件卡定位与步 brief 共用）。
  // 快路径：目标已在当前打开的列表 → 零网络直达；否则对每个锚发 focus 请求（返回含锚点的页）。
  // 失败分支：全部未命中 → notice 提示（可能已被压缩裁剪）。
  const locateAny = useCallback(async (goals: Array<{ idx: number; cat: string }>) => {
    if (goals.length === 0) return
    const seq = ++locateSeq.current
    try { browserCardRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }) } catch (e) { /* 忽略：滚动失败不阻断定位 */ }
    const b0 = browserRef.current
    if (b0.cat && b0.data && b0.data.items) {
      for (const g of goals) {
        if (g.cat === b0.cat && b0.data.items.some(it => it.idx === g.idx)) { setPendingFocus({ idx: g.idx }); return }
      }
    }
    for (const g of goals) {
      const label = (BROWSER_CATS.find((c) => c.key === g.cat) || { label: g.cat }).label
      setBrowser((b) => b.cat === g.cat
        ? { ...b, loading: true, notice: '' }
        : { cat: g.cat, label, data: null, loading: true, error: '', expanded: {}, expanding: null, notice: '', expandFailed: {} })
      const d = await fetchRawSection(g.cat, 0, 30, g.idx)
      if (seq !== locateSeq.current) return // 新一次定位已发起：放弃迟到响应
      const hit = !!(d && d.ok && d.items && d.items.some(it => it.idx === g.idx))
      if (hit) {
        setBrowser((b) => b.cat !== g.cat ? b : { ...b, data: d, loading: false, error: '', notice: '' })
        setPendingFocus({ idx: g.idx })
        return
      }
    }
    if (seq !== locateSeq.current) return
    const lastCat = goals[goals.length - 1].cat
    setBrowser((b) => b.cat !== lastCat ? b : { ...b, loading: false, notice: '未找到对应结果（可能已被压缩裁剪）' })
  }, [])
  // 文件卡操作行定位：result / call 两个锚点，落到「工具结果」分类。
  const locateOp = useCallback(async (op: FileActivityOp) => {
    const goals = op.resultIdx === op.callIdx
      ? [{ idx: op.resultIdx, cat: 'tool' }]
      : [{ idx: op.resultIdx, cat: 'tool' }, { idx: op.callIdx, cat: 'tool' }]
    await locateAny(goals)
  }, [locateAny])
  // W6 文件名打开：宿主 Files.open（系统默认应用）；失败轻提示。
  const openFile = useCallback(async (path: string) => {
    const r = await fetchOpenPath(path)
    if (!r || !r.ok) {
      const why = r ? (r.error || r.details || '') : ''
      showFlash(t('files.openFail', { msg: why || '—' }))
    }
  }, [showFlash])
  // pendingFocus 消费：目标条目已在列表 → 展开（如未展开）+ 滚入视野，然后清空。
  useEffect(() => {
    if (!pendingFocus) return
    const items = browser.data && browser.data.items ? browser.data.items : undefined
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

  // ── P4-4A 上下文统计卡的渲染件（与上游 statsContext.tsx 的 figure / chip / ChipLane 同构）──
  const sc = statsCard
  const kpiCell = (key: string, label: string, value: number) => (
    <span key={key} className={'lc-core-kv lc-core-kv-' + key}><b>{fmtTok(value)}</b><i>{label}</i></span>
  )
  const ledgerChip = (key: string, label: string, value: number, color: string, onJump?: () => void, tip?: string) => (
    <span
      key={key}
      className={'lc-ledger-chip' + (onJump ? ' lc-ledger-chip-btn' : '') + (value === 0 ? ' lc-ledger-chip-dim' : '')}
      role={onJump ? 'button' : undefined}
      tabIndex={onJump ? 0 : undefined}
      title={(tip || label) + (onJump ? ' · 点击跳到对应位置' : '')}
      onClick={onJump}
      onKeyDown={onJump ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onJump() } } : undefined}
    >
      <i style={{ background: color }} />
      <span className="lc-ledger-chip-label">{label}</span>
      <b>{fmtTok(value)}</b>
    </span>
  )
  const ioTotal = sc.io.in.user + sc.io.in.read + sc.io.in.write + sc.io.in.search
  const ioChips = ([
    { key: 'user', label: '用户', value: sc.io.in.user, jump: () => { void openSection('user', '用户消息') } },
    { key: 'read', label: '读取', value: sc.io.in.read, jump: () => scrollToCard(fileCardRef) },
    { key: 'write', label: '写入', value: sc.io.in.write, jump: () => scrollToCard(fileCardRef) },
    { key: 'search', label: '搜索', value: sc.io.in.search, jump: () => scrollToCard(fileCardRef) },
  ]).map((c) => ledgerChip(c.key, c.label, c.value, IO_COLORS[c.key], c.jump))
  /**
   * 工具调用标题口径（同上游 statsContext 的 `toolCalls ?? chips 之和`）：优先用调用总数，
   * chips 只统计「能解析出工具名」的调用；两者不等时在 hover 里写清缺口，不拿 chip 和冒充总调用数。
   */
  const toolChipSum = sc.tools.reduce((a, t) => a + (Number(t.count) || 0), 0)
  const toolTotal = (Number(sc.io.out.tools) || 0) > 0 ? Number(sc.io.out.tools) : toolChipSum
  const toolHeadTip = t('stats.toolCallsTip', { n: fmtTok(toolTotal), m: fmtTok(toolChipSum) })
  const toolShown = sc.tools.slice(0, CHIP_TOP)
  const toolHidden = sc.tools.length - toolShown.length
  /** 桥层已按「前 12 + 其余合并」下发时，合并项的名字是「其他」：按上游 stats.toolsMore 的 `其他 +N` 形态渲染。 */
  const isRestName = (n: string, short?: string): boolean => n === '其他' || n === '(其他)' || n.toLowerCase() === 'other' || short === '其他'
  const toolChips = toolShown.length > 0
    ? [
      // 展示短名（`super_admin:bash` → `bash`，与上游截图一致）；跳转与 hover 提示仍用全名。
      ...toolShown.map((td, i) => (isRestName(td.name, td.short)
        ? <span key={'__bridge_rest_' + i} className="lc-ledger-chip lc-ledger-chip-more"><i style={{ background: CHIP_REST }} /><span className="lc-ledger-chip-label">其他 +{fmtTok(td.count)}</span></span>
        : ledgerChip(td.name, td.short || td.name, td.count, CHIP_SHADES[i % CHIP_SHADES.length], () => { void openSection('tool', '工具结果') }, td.name))),
      toolHidden > 0
        ? <span key="__more" className="lc-ledger-chip lc-ledger-chip-more"><i style={{ background: CHIP_REST }} /><span className="lc-ledger-chip-label">其他 +{toolHidden}</span></span>
        : null,
    ]
    : [<span key="__none" className="lc-ledger-chip lc-ledger-chip-dim"><span className="lc-ledger-chip-label">暂无工具调用</span></span>]
  const cmdTotal = sc.commands.reduce((a, c) => a + (Number(c.count) || 0), 0)
  /** 标题数字用命令行调用次数（runs）；chips 仍是程序级 count。两者语义不同，hover 里同时写清。 */
  const cmdRuns = sc.runs
  const cmdHeadTip = cmdRuns !== cmdTotal
    ? '命令调用 ' + cmdRuns + ' 次 · 程序执行 ' + cmdTotal + ' 次' + (sc.runsFromBridge ? '' : '（runs 未下发，暂按程序执行次数合计兜底）')
    : '命令调用 ' + cmdRuns + ' 次'
  const cmdShown = sc.commands.slice(0, CHIP_TOP)
  const cmdHidden = sc.commands.length - cmdShown.length
  const cmdChips = cmdShown.length > 0
    ? [
      ...cmdShown.map((c, i) => (
        <span key={c.name} className="lc-ledger-chip" title={c.failed > 0 ? c.name + ' · 失败 ' + c.failed + ' 次' : c.name}>
          <i style={{ background: CHIP_SHADES[i % CHIP_SHADES.length] }} />
          <span className="lc-ledger-chip-label">{c.name}</span>
          <b>{fmtTok(c.count)}</b>
          {c.failed > 0 ? <em className="lc-ledger-chip-fail">✕{c.failed}</em> : null}
        </span>
      )),
      cmdHidden > 0
        ? <span key="__more" className="lc-ledger-chip lc-ledger-chip-more"><i style={{ background: CHIP_REST }} /><span className="lc-ledger-chip-label">其他 +{cmdHidden}</span></span>
        : null,
    ]
    : [<span key="__none" className="lc-ledger-chip lc-ledger-chip-dim"><span className="lc-ledger-chip-label">暂无命令执行记录</span></span>]

  return (
    <div className="lc-root">
      {flash ? <div className="lc-flash">{flash}</div> : null}
      {/* P4-6 顶部视图切换：当前会话（默认）/ 洞察。两个视图数据面独立；主题开关放在这里，两边都能用。 */}
      <div className="lc-card lc-ov-switch">
        <span className="lc-ov-tabs" role="tablist" aria-label={t('insights.viewLabel')}>
          <button type="button" role="tab" aria-selected={view === 'session'} className={'lc-gran-btn' + (view === 'session' ? ' lc-gran-on' : '')} onClick={() => setView('session')}>{t('insights.tab.session')}</button>
          <button type="button" role="tab" aria-selected={view === 'insights'} className={'lc-gran-btn' + (view === 'insights' ? ' lc-gran-on' : '')} onClick={() => setView('insights')}>{t('insights.tab.insights')}</button>
        </span>
        <button type="button" className="lc-gran-btn lc-ov-theme" onClick={() => setDark(!dark)}>{dark ? '浅色' : '深色'}</button>
      </div>

      {view === 'insights' ? (
        <OverviewView
          t={t}
          range={overviewRange}
          onRange={pickOverviewRange}
          priceCfg={priceCfg}
          isOffpeak={isOffpeakMs}
        />
      ) : (
        <>
      <div className="lc-card" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600 }}>
          {state.phase === 'ready' ? ((state.cardName ? state.cardName + ' · ' : '') + (state.session || '')) :
           state.phase === 'demo' ? '预览模式（无宿主数据）' :
           state.phase === 'loading' ? '加载中…' : noRaw ? t('empty.noRecord.title') : '数据异常'}
        </span>
        {state.phase === 'ready' && state.worldbook && state.worldbook.entries > 0 ? (
          <span style={{ opacity: 0.75 }}>世界书 {state.worldbook.entries} 条</span>
        ) : null}
        {state.error ? <span style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{state.error}</span> : null}
        <button className="lc-gran-btn" style={{ marginLeft: 'auto' }} onClick={() => { try { location.reload() } catch (e) { setRefreshN(refreshN + 1) } }}>刷新</button>
      </div>

      {noRaw ? (
        <div className="lc-card" style={{ padding: '38px 18px', textAlign: 'center' }}>
          <div style={{ fontSize: 24, lineHeight: 1, opacity: 0.4, marginBottom: 10 }}>⏳</div>
          <div style={{ fontSize: 12.5, lineHeight: 1.8, color: 'var(--dsw-alias-label-secondary)' }}>{t('empty.noRecord.hint')}</div>
          <button type="button" className="lc-gran-btn" style={{ marginTop: 14 }} onClick={() => { try { location.reload() } catch (e) { setRefreshN(refreshN + 1) } }}>刷新</button>
        </div>
      ) : (
        <>
      {/* P4-8 概览行已收敛：轮次/步数/工具调用/模型回复 → 上下文统计卡 KPI；缓存命中 → Token 统计卡标题；
          活跃时长/等待/生成 → 耗时统计卡；仅本会话费用 → 上下文统计卡账本（点击展开下面的价格设置） */}
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
            <span style={{ opacity: 0.55 }}>其余含周末、法定节假日为谷时</span>
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

      <div className="lc-cols lc-cols-main">
      <div className="lc-col">
      <div className="lc-card">
        <div className="lc-card-title">
          <span className="lc-card-title-text"><CardIcon name="stats" />{t('stats.title')}</span>
          <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.55 }}>
            {state.stats ? '本会话全量口径' : '统计接口未就绪 · 按现有数据兜底'}
          </span>
        </div>
        <div className="lc-stats">
          <div className="lc-ledger lc-ledger-no-team">
            <div className="lc-core">
              <span className="lc-core-kvs">
                {kpiCell('turns', '轮次', sc.core.turns)}
                {kpiCell('steps', '步数', sc.core.steps)}
              </span>
              <span className="lc-core-kvs">
                {kpiCell('skills', '技能加载', sc.core.skills)}
                {kpiCell('answers', '模型回复', sc.core.answers)}
              </span>
              <span className="lc-core-kv lc-core-kv-events">
                <i>上下文事件</i>
                <span className="lc-core-kv-events-list">
                  {EVENT_KPI.map((e, i) => {
                    const n = sc.core.events[e.kind] || 0
                    return (
                      <Fragment key={e.kind}>
                        {i > 0 ? <span className="lc-core-kv-sep" aria-hidden="true">/</span> : null}
                        <span
                          className={'lc-kind lc-core-kv-event lc-core-kv-event-btn' + (n === 0 ? ' lc-ledger-chip-dim' : '')}
                          style={{ color: e.color }}
                          role="button"
                          tabIndex={0}
                          title={'筛选「' + t('kind.' + e.kind) + '」事件'}
                          onClick={() => showEventKind(e.kind)}
                          onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); showEventKind(e.kind) } }}
                        >
                          {t('kind.' + e.kind)}<b>{fmtTok(n)}</b>
                        </span>
                      </Fragment>
                    )
                  })}
                </span>
              </span>
            </div>
            <div className="lc-ledger-head lc-ledger-in-head">
              <span className="lc-ledger-label">输入输出</span>
              <b className="lc-ledger-total">{fmtTok(ioTotal)}</b>
            </div>
            <div className="lc-ledger-chips lc-ledger-in-chips">{ioChips}</div>
            <div className="lc-ledger-head lc-ledger-out-head" title={toolHeadTip}>
              <span className="lc-ledger-label">工具调用</span>
              <b className="lc-ledger-total">{fmtTok(toolTotal)}</b>
            </div>
            <div className="lc-ledger-chips lc-ledger-out-chips lc-ledger-chips-fit">{toolChips}</div>
            <div className="lc-ledger-head lc-ledger-in-head2" title={cmdHeadTip}>
              <span className="lc-ledger-label">命令执行</span>
              <b className="lc-ledger-total">{fmtTok(cmdRuns)}</b>
            </div>
            <div className="lc-ledger-chips lc-ledger-in-body2 lc-ledger-chips-fit">{cmdChips}</div>
            {/* P4-8 概览行并入：仅本会话费用（上游 statsContext 的 own cost 行位置；本版无 fleet/子 agent → 单行铺满两列）。
                点击展开页面顶部的价格设置（今日花费 + 峰谷价表），与旧概览格同一个开关。 */}
            <div
              className="lc-ledger-head"
              style={{ gridColumn: '1 / -1', marginTop: 8, cursor: 'pointer' }}
              title={t('stats.costOwnTip')}
              role="button"
              tabIndex={0}
              aria-expanded={pricesOpen}
              onClick={() => setPricesOpen(!pricesOpen)}
              onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setPricesOpen(!pricesOpen) } }}
            >
              <span className="lc-ledger-label">{t('stats.cost')} · {t('stats.ownOnly')}</span>
              <b className="lc-ledger-total">{stats.costKnown ? '≈¥' + stats.cost.toFixed(2) : '—'}</b>
            </div>
          </div>
        </div>
      </div>

            <div className="lc-card">
        <div className="lc-card-title">
          <span className="lc-card-title-text"><CardIcon name="tokens" />{t('tokens.title')}</span>
          <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.55 }}>
            {billing
              ? (billing.hit !== null ? t('stats.cacheHit') + ' ' + billing.hit + '% · ' : '') + billing.rows + ' 条完成消息 · 计费口径'
              : '会话计费口径'}
          </span>
        </div>
        {billing ? (
          <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <Donut segments={billing.segs.filter((s) => s.value > 0)} centerTop={fmtTok(billing.total)} centerSub={t('tokens.total')} hoverKey={billingHover} onHoverKey={setBillingHover} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11.5, minWidth: 150, flex: 1 }}>
              {billing.segs.filter((s) => s.value > 0).map((s) => (
                <span key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 5, opacity: billingHover && billingHover !== s.key ? 0.55 : 1 }} onMouseEnter={() => setBillingHover(s.key)} onMouseLeave={() => setBillingHover(null)}>
                  <span style={{ width: 7, height: 7, borderRadius: 4, background: s.color, flex: 'none' }} />
                  <span>{s.key === 'output' ? t('tokens.output') : t('cat.' + s.key)}</span>
                  {s.key === 'output' ? <span style={{ opacity: 0.5, fontSize: 10 }}>{t('tokens.outputNote')}</span> : null}
                  <b style={{ fontWeight: 600, marginLeft: 'auto' }}>{(s.key === 'output' ? '' : '≈') + fmtTok(s.value)}</b>
                  <span style={{ opacity: 0.55, width: 32, textAlign: 'right' }}>{billing.total > 0 ? Math.round((s.value / billing.total) * 100) : 0}%</span>
                </span>
              ))}
            </div>
          </div>
          {/* F24 计费三桶：缓存读 / 未缓存输入 / 输出 + 占比；第四桶「缓存写」采集层没有（chatmsg 无字段）→ 显式标注缺省，不估算 */}
          <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid rgba(128,128,128,0.22)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, marginBottom: 6 }}>
              <span style={{ fontWeight: 600 }} title={t('tokens.bucketsTip')}>{t('tokens.buckets')}</span>
              <span
                style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.6, border: '1px dashed rgba(128,128,128,0.5)', borderRadius: 4, padding: '0 4px', whiteSpace: 'nowrap' }}
                title={t('tokens.cacheWriteNote')}
              >
                {t('tokens.cacheWriteMissing')}
              </span>
            </div>
            <div
              style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', background: 'rgba(128,128,128,0.18)' }}
              title={t('tokens.bucketsTip')}
            >
              {tokenBuckets.map((b) => (
                <span
                  key={b.key}
                  title={b.label + ' ' + fmtTok(b.value) + ' · ' + (billing.total > 0 ? Math.round((b.value / billing.total) * 100) : 0) + '%'}
                  style={{ width: (billing.total > 0 ? (b.value / billing.total) * 100 : 0) + '%', background: b.color }}
                />
              ))}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginTop: 6, fontSize: 11 }}>
              {tokenBuckets.map((b) => (
                <span key={b.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ width: 7, height: 7, borderRadius: 4, background: b.color, flex: 'none' }} />
                  <span>{b.label}</span>
                  <b style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmtTok(b.value)}</b>
                  <span style={{ opacity: 0.55, fontVariantNumeric: 'tabular-nums' }}>{billing.total > 0 ? Math.round((b.value / billing.total) * 100) : 0}%</span>
                </span>
              ))}
            </div>
          </div>
          </>
        ) : (
          <div style={{ fontSize: 11, opacity: 0.55 }}>会话暂无计费数据（完成一条消息后出现）</div>
        )}
      </div>
      <div className="lc-card lc-ctx-card">
        <div className="lc-card-title">
          <span className="lc-card-title-text"><CardIcon name="context" />{t('overview.title')}</span>
          <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.55 }}>{t('overview.window', { w: windowLabel(ctxWindow) })}</span>
        </div>
        <StackedBar
          parts={parts}
          max={ctxWindow}
          reserve={{ ratio: AUTO_COMPACT_RATIO, label: t('overview.compactReserve', { pct: Math.round(AUTO_COMPACT_RATIO * 100) }) }}
          hoverKey={hoverCat}
          onHoverKey={setHoverCat}
        />
        {/* P4-8 大号数字区（上游 .lc-overview-num 形态）：左侧 tokens 精确读数，右侧等宽字体的「一次性发送」费用。
            费用口径写在下面单行脚注里（不含缓存折扣/输出、不是累计费用），缺模型/缺单价时整个费用位显示 —。 */}
        <div className="lc-overview-num">
          <b>≈{fmtFull(totalTok)}</b>
          <span>{t('overview.estimate')} · {t('overview.usedPct', { pct: totalTok > 0 ? Math.round(totalTok / ctxWindow * 100) : 0 })}</span>
          <span className="lc-overview-pct">
            <b style={{ fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)' }}>{estCostText}</b>
            {t('overview.estSendOnce')}
          </span>
        </div>
        {/* P4-10 脚注：两行压成一行（可见行只留最短口径/缺价原因，完整口径 + 峰谷价依据进 title）。 */}
        <div className="lc-ctx-note" title={estNoteFull}>{estNoteShort}</div>
        {/* P4-10：九段明细改用上游 Legend 芯片网格（.lc-legend/.lc-chip：色点 + 名称 + ≈tokens + 占比，
            PC 3 列 / 390px 手机 2 列），与上面堆叠条共用 hoverCat 联动。
            环按原版去掉：上游 currentComposition 本卡只有「大号数字 + 堆叠条 + Legend」，环与堆叠条表达同一份
            比例；且 118px 环并排会把手机上本就只有 332px 宽的明细挤回 1 列。耗时卡仍保留环。 */}
        <Legend parts={parts} hoverKey={hoverCat} onHoverKey={setHoverCat} />
        {state.imgAtt && state.imgAtt.count > 0 ? (
          <div style={{ fontSize: 10, opacity: 0.6, marginTop: 6, textAlign: 'center' }}>图片附件 {state.imgAtt.count} 张 ≈{state.imgAtt.tokens} tokens（按官方图片计费公式估算）</div>
        ) : null}
      </div>
      <div className="lc-card">
        <div className="lc-card-title">
          <span className="lc-card-title-text"><CardIcon name="timing" />{t('timing.title')}</span>
          <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.55 }}>{t('timing.note')}</span>
        </div>
        {/* P4-8 3 段（等待/生成/其他）：上游 6 段形态里只有 waitMs / outMs 两段有真实数据，
            思考、工具参数、工具执行宿主没有采集 → 不画、不估，底下明确标注缺哪三段。 */}
        {stats.activeMs > 0 ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <Donut
                segments={[
                  { key: 'twait', color: '#f59e0b', value: stats.waitSum },
                  { key: 'tgen', color: '#3b82f6', value: stats.outSum },
                  { key: 'trest', color: '#94a3b8', value: stats.restMs },
                ].filter((sg) => sg.value > 0)}
                centerTop={fmtDur(stats.activeMs)}
                centerSub={t('timing.total')}
                hoverKey={hoverTiming}
                onHoverKey={setHoverTiming}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, minWidth: 150, flex: 1 }}>
                {[
                  { key: 'twait', color: '#f59e0b', label: t('timing.ttft'), v: stats.waitSum, n: stats.waitN, tip: t('timing.waitTip', { n: stats.waitN }) },
                  { key: 'tgen', color: '#3b82f6', label: t('timing.gen'), v: stats.outSum, n: stats.outN, tip: t('timing.genTip', { n: stats.outN }) },
                  { key: 'trest', color: '#94a3b8', label: t('timing.other'), v: stats.restMs, n: 0, tip: t('timing.otherTip') },
                ].map((row) => (
                  <div key={row.key} title={row.tip} style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: hoverTiming && hoverTiming !== row.key ? 0.55 : 1 }} onMouseEnter={() => setHoverTiming(row.key)} onMouseLeave={() => setHoverTiming(null)}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: row.color, display: 'inline-block', flex: 'none' }} />
                    <span style={{ opacity: 0.8 }}>{row.label}</span>
                    <b style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>{fmtDur(row.v)}</b>
                    {row.n > 0 ? <span style={{ opacity: 0.45, fontSize: 10, whiteSpace: 'nowrap' }}>{t('timing.callTimes', { n: row.n })}</span> : null}
                    <span style={{ opacity: 0.5, width: 36, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{stats.activeMs > 0 ? Math.round((row.v / stats.activeMs) * 100) : 0}%</span>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ fontSize: 10, opacity: 0.55, marginTop: 8, lineHeight: 1.6 }} title={t('timing.missingTip')}>
              {t('timing.notCollected', { items: t('timing.reasoning') + ' · ' + t('timing.toolArgs') + ' · ' + t('timing.tools') })}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 11, opacity: 0.55, padding: '8px 0' }}>{t('timing.empty')}</div>
        )}
      </div>
      </div>
      <div className="lc-col lc-col-browser">
      <div className="lc-card" ref={browserCardRef}>
        <div className="lc-card-title">
          <span className="lc-card-title-text"><CardIcon name="browser" />{t('browser.title')}</span>
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
                className={'lc-br-cat-row' + (isOpen ? ' lc-br-cat-open lc-br-cat-on' : '')}
                onClick={() => openSection(c.key, c.label)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px', cursor: 'pointer', '--lc-cat-hue': c.color } as import('react').CSSProperties}
              >
                <i aria-hidden="true" style={{ background: c.color }} />
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
                    <RichContent text={browser.data.content || ''} />
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
                          <div style={{ fontSize: 11.5, opacity: 0.85, marginTop: 4, lineHeight: 1.5, overflowWrap: 'anywhere' }}>{cleanPreview(it.preview)}</div>
                          {browser.expandFailed && browser.expandFailed[it.idx] ? <div style={{ fontSize: 10, marginTop: 3, color: 'var(--dsw-alias-state-error-primary)' }}>读取失败 · 点击重试</div> : null}
                          {browser.expanded[it.idx] !== undefined ? <RichContent text={browser.expanded[it.idx]} limit={1200} /> : null}
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
      </div>
      </div>

      <div className="lc-card">
        <div className="lc-card-title">
          <span className="lc-card-title-text"><CardIcon name="timeline" />{t('trend.title')}</span>
          <span style={{ display: 'inline-flex', gap: 6, marginLeft: 'auto' }}>
            <button className="lc-gran-btn" onClick={() => pickGran(granularity === 'step' ? 'turn' : 'step')}>
              {granularity === 'step' ? '步骤' : '轮次'}
            </button>
            <button className="lc-gran-btn" onClick={() => pickMode(mode === 'total' ? 'delta' : 'total')}>
              {mode === 'total' ? '全量' : '增量'}
            </button>
            {/* F10 时长曲线开关（默认关；开 = 叠画曲线 + 右侧时长轴） */}
            <button
              type="button"
              className={'lc-gran-btn' + (durationCurve ? ' lc-gran-on' : '')}
              title={t('trend.durationCurveHint')}
              aria-pressed={durationCurve}
              onClick={() => pickDurationCurve(!durationCurve)}
            >
              {t('trend.durationCurve')}
            </button>
          </span>
        </div>
        <MilestoneBand
          events={state.milestones || []}
          activeSeq={selected}
          onPick={(seq: number) => setSelected(seq)}
          bandLabel="上下文里程碑"
          emptyHint={msEmptyHint}
          onDismissEmpty={dismissMsHint}
        />
        {requests.length > 0 ? (
          <TrendChart
            requests={chartRequests}
            markers={markers}
            selectedSeq={selected}
            hoveredSeq={hovered}
            activeTurn={null}
            granularity={granularity}
            mode={mode}
            focusTurn={null}
            hoverCat={hoverCat}
            adaptive={adaptive}
            durations={durations}
            durationCurve={durationCurve}
            onSelect={setSelected}
            onHover={setHovered}
            onHoverTurn={() => {}}
            onPickTurn={() => {}}
            onFocusTurnHandled={() => {}}
          />
        ) : (
          <div style={{ fontSize: 12, opacity: 0.6, padding: '8px 0' }}>暂无时间线数据（下一轮对话后出现）</div>
        )}
        {/* 开关开着但整条都没测量值：如实提示（不画零曲线，也不假装有数据） */}
        {durations !== null && durations.length > 0 && !durations.some((d) => d.waitMs + d.outMs > 0) ? (
          <div style={{ fontSize: 10.5, opacity: 0.5, marginTop: 4 }}>{t('trend.durationEmpty')}</div>
        ) : null}
        {selectedInfo ? (
          <div style={{ marginTop: 8, padding: '8px 10px', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 8, fontSize: 11.5, lineHeight: 1.9 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 600 }}>{granularity === 'step' ? `第 ${selectedInfo.r.turn} 轮 · 第 ${selectedInfo.r.step} 步` : (selectedInfo.turnSteps > 1 ? `第 ${selectedInfo.r.turn} 轮 · 共 ${selectedInfo.turnSteps} 步` : `第 ${selectedInfo.r.turn} 轮`)}</span>
              <span style={{ opacity: 0.6 }}>{new Date(selectedInfo.r.time).toLocaleTimeString('zh-CN', { hour12: false })}</span>{selectedInfo.marker ? <span style={{ fontSize: 10, color: 'var(--dsw-alias-state-warn-primary)' }} title="该轮与上一步之间发生过上下文压缩">✂压缩 −{selectedInfo.marker.count}条</span> : null}{selectedInfo.skipN ? <span style={{ fontSize: 10, color: 'var(--dsw-alias-state-warn-primary)' }} title="此处跳过 N 个系统警告虚拟轮（截断/输出异常）">!{selectedInfo.skipN}</span> : null}<span style={{ opacity: 0.7 }}>≈{fmtTok(selectedInfo.r.total)}</span>
              <button className="lc-gran-btn" style={{ marginLeft: 'auto' }} onClick={() => setSelected(null)}>✕</button>
            </div>
                        <div style={{ marginTop: 8 }}>
              <BriefSection brief={briefInfo} onLocate={locateAny} />
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
            {selectedInfo.skipWarns.length > 0 ? (
              <div style={{ marginTop: 6, borderTop: '1px dashed var(--dsw-alias-border-l1)', paddingTop: 6 }}>
                <div style={{ color: 'var(--dsw-alias-state-warn-primary)', fontSize: 11 }}>⚠跳过明细 · {selectedInfo.skipWarns.length}条（与警告实录对拍）</div>
                {selectedInfo.skipWarns.map((w: any, wi: number) => (
                  <div key={wi} style={{ fontSize: 11, opacity: 0.85, lineHeight: 1.7 }}>· [{t('warn.' + (w.wtype || 'other'))}] {String(w.text || '')}</div>
                ))}
              </div>
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

      <div className="lc-cols">
      <div className="lc-col">
      <div className="lc-card" ref={eventsCardRef}>
        <div className="lc-card-title">
          <span className="lc-card-title-text"><CardIcon name="events" />{t('events.title')}</span>
          <span className="lc-kinds" role="group" style={{ marginLeft: 'auto', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {/* F18：单选（全部 / 压缩 / 剪枝 / 注入 / 模型 / 技能 / 代理 / 报错），默认全部 */}
          {EVENT_FILTERS.map((k) => {
            const n = k === 'all' ? evTotal : evCounts[k]
            return (
              <button key={k} type="button" className={'lc-gran-btn' + (eventKind === k ? ' lc-gran-on' : '')} aria-pressed={eventKind === k} onClick={() => pickEventKind(k)}>
                {t('kind.' + k)}{n ? <span className="lc-kind-n">{n}</span> : null}
              </button>
            )
          })}
        </span>
        </div>
        {evTotal > 0 ? (shownEvents.length > 0 ? shownEvents.map((ev: any, i: number) => {
          if (ev.kind === 'warn') {
            return (
              <div key={i} onClick={() => locateAny([{ idx: ev.idx, cat: 'user' }])} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12, padding: '7px 2px', borderBottom: '1px solid var(--dsw-alias-border-l1)', cursor: 'pointer' }}>
                <span style={{ flex: 'none' }}>⚠</span>
                <span className={'lc-kind lc-kind-warn'}>{t('kind.warn')}</span>
                <span style={{ color: 'var(--dsw-alias-state-warn-primary)' }}>[{t('warn.' + (ev.wtype || 'other'))}] {String(ev.text || '')}</span>
                <span style={{ marginLeft: 'auto', opacity: 0.55, fontSize: 10, flex: 'none' }}>{String(ev.at || '').slice(11, 16)}</span>
              </div>
            )
          }
          return (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12, padding: '7px 2px', borderBottom: '1px solid var(--dsw-alias-border-l1)' }}>
            <span style={{ flex: 'none' }}>{EVENT_GLYPH[String(ev.kind)] || '•'}</span>
            <span className={'lc-kind lc-kind-' + ev.kind} style={EVENT_KIND_TINT[String(ev.kind)]}>{t('kind.' + ev.kind)}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={eventTextOf(ev)}>{eventTextOf(ev)}</span>
            {(ev.kind === 'compaction' || ev.kind === 'prune') && ev.savedChars ? <span style={{ opacity: 0.55, fontSize: 10, flex: 'none' }}>释放 {Math.round(ev.savedChars / 1000)}k 字符</span> : null}
            {ev.kind === 'inject' && ev.tokens ? <span style={{ opacity: 0.55, fontSize: 10, flex: 'none' }}>≈{ev.tokens} tok</span> : null}
            <span style={{ marginLeft: 'auto', opacity: 0.55, fontSize: 10, flex: 'none' }}>{String(ev.at || '').slice(11, 16)}</span>
          </div>
        )}) : (<div style={{ fontSize: 12, opacity: 0.55 }}>{t('events.emptyFiltered', { kind: t('kind.' + eventKind), n: evTotal })}</div>)) : (
          <div style={{ fontSize: 12, opacity: 0.55 }}>{t('events.empty')}</div>
        )}
      </div>
      </div>
      <div className="lc-col" ref={fileCardRef}>
      <FileCard activity={state.fileActivity || null}
        icon={<CardIcon name="files" />}
        loading={state.phase === 'loading'}
        failed={state.phase === 'error'}
        onRetry={() => { try { location.reload() } catch (e) { setRefreshN(refreshN + 1) } }}
        onLocate={locateOp}
        onOpen={openFile}
        scopeText={fileScope.text}
        beforeIdx={fileScope.before}
        scopeOut={fileScope.out}
        timeBands={opTimeBands}
        sort={fileSort}
        onSortChange={pickFileSort}
      />
      </div>
      <div className="lc-col">
      <div className="lc-card">
        <div className="lc-card-title">
          <span className="lc-card-title-text"><CardIcon name="tools" />工具使用</span>
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
      </div>
      </div>

      <div className="lc-card" ref={settingsCardRef}>
        <button type="button" className="lc-settings-head" aria-expanded={settingsOpen} onClick={() => { setSettingsOpen(!settingsOpen) }}>
          <span className="lc-settings-headtext">
            <span className="lc-settings-name"><CardIcon name="settings" />{t('settings.title')}</span>
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
            {/* F26 增量基线：消费点是趋势卡增量模式（chartRequests → deltaBaseRequests），步骤粒度下与上一步/上一轮末步对比 */}
            <div className="lc-settings-row">
              <span className="lc-settings-label" title={t('settings.deltaBaseTip')}>{t('settings.deltaBase')}</span>
              <span className="lc-gran" role="group">
                {(['step', 'turn'] as const).map(k => (
                  <button key={k} type="button" className={'lc-gran-btn' + (deltaBase === k ? ' lc-gran-on' : '')} aria-pressed={deltaBase === k} onClick={() => pickDeltaBase(k)}>{t('deltaBase.' + k)}</button>
                ))}
              </span>
            </div>
            <div className="lc-settings-row">
              <span className="lc-settings-label" title={t('trend.adaptiveHint')}>{t('settings.adaptive')}</span>
              <span className="lc-gran" role="group">
                <button type="button" className={'lc-gran-btn' + (adaptive ? ' lc-gran-on' : '')} onClick={() => pickAdaptive(true)}>{t('trend.adaptiveOn')}</button>
                <button type="button" className={'lc-gran-btn' + (adaptive ? '' : ' lc-gran-on')} onClick={() => pickAdaptive(false)}>{t('trend.adaptiveOff')}</button>
              </span>
            </div>
            {/* F26 时长曲线：与时间线卡标题旁的按钮同一个 state/持久化键（durationCurve），有真实消费点 */}
            <div className="lc-settings-row">
              <span className="lc-settings-label" title={t('settings.durationCurveTip')}>{t('settings.durationCurve')}</span>
              <span className="lc-gran" role="group">
                <button type="button" className={'lc-gran-btn' + (durationCurve ? ' lc-gran-on' : '')} aria-pressed={durationCurve} onClick={() => pickDurationCurve(true)}>{t('settings.durationCurveOn')}</button>
                <button type="button" className={'lc-gran-btn' + (durationCurve ? '' : ' lc-gran-on')} aria-pressed={!durationCurve} onClick={() => pickDurationCurve(false)}>{t('settings.durationCurveOff')}</button>
              </span>
            </div>
            <div className="lc-settings-row">
              <span className="lc-settings-label" title={t('settings.windowTip')}>{t('settings.window')}</span>
              <span className="lc-gran" role="group">
                {CTX_WINDOWS.map(w => (
                  <button key={w} type="button" className={'lc-gran-btn' + (ctxWindow === w ? ' lc-gran-on' : '')} onClick={() => pickCtxWindow(w)}>{windowLabel(w)}</button>
                ))}
              </span>
            </div>
            <div className="lc-settings-row">
              <span className="lc-settings-label" title={t('settings.eventKindsTip')}>{t('settings.eventKinds')}</span>
              <span className="lc-gran" role="group" style={{ flexWrap: 'wrap' }}>
                {EVENT_FILTERS.map(k => (
                  <button key={k} type="button" className={'lc-gran-btn' + (eventKind === k ? ' lc-gran-on' : '')} aria-pressed={eventKind === k} onClick={() => pickEventKind(k)}>{t('kind.' + k)}</button>
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
            <div className="lc-settings-row">
              <span className="lc-settings-label">{t('settings.fileSort')}</span>
              <span className="lc-gran" role="group">
                {(['count', 'latest', 'path'] as const).map(k => (
                  <button key={k} type="button" className={'lc-gran-btn' + (fileSort === k ? ' lc-gran-on' : '')} onClick={() => pickFileSort(k)}>{t('files.sort.' + k)}</button>
                ))}
              </span>
            </div>
            {/* F26 洞察页两项：overviewRange 已被 P4-6 洞察视图消费（顶部入口的默认范围，改了立刻生效）；
                insightsEntry 管的是宿主侧边栏入口（由 toolpkg 注册，本轮未接），故仍标「预留」。 */}
            <div className="lc-settings-row">
              <span className="lc-settings-label" title={t('settings.overviewRangeTip')}>
                {t('settings.overviewRange')}
              </span>
              <span className="lc-gran" role="group">
                {(['today', '7d'] as const).map(k => (
                  <button key={k} type="button" className={'lc-gran-btn' + (overviewRange === k ? ' lc-gran-on' : '')} aria-pressed={overviewRange === k} onClick={() => pickOverviewRange(k)}>{t('overview.range.' + k)}</button>
                ))}
              </span>
            </div>
            <div className="lc-settings-row">
              <span className="lc-settings-label" title={t('settings.insightsEntryTip')}>
                {t('settings.insightsEntry')}
                <span style={{ marginLeft: 4, fontSize: 10, opacity: 0.55, border: '1px dashed rgba(128,128,128,0.45)', borderRadius: 4, padding: '0 3px' }} title={t('settings.reservedTip')}>{t('settings.reserved')}</span>
              </span>
              <span className="lc-gran" role="group">
                {(['show', 'hide'] as const).map(k => (
                  <button key={k} type="button" className={'lc-gran-btn' + (insightsEntry === k ? ' lc-gran-on' : '')} aria-pressed={insightsEntry === k} onClick={() => pickInsightsEntry(k)}>{t('insightsEntry.' + k)}</button>
                ))}
              </span>
            </div>
            <div className="lc-settings-row">
              <span className="lc-settings-label">{t('settings.theme')}</span>
              <span className="lc-gran" role="group">
                <button type="button" className={'lc-gran-btn' + (dark ? ' lc-gran-on' : '')} onClick={() => setDark(true)}>{t('theme.dark')}</button>
                <button type="button" className={'lc-gran-btn' + (dark ? '' : ' lc-gran-on')} onClick={() => setDark(false)}>{t('theme.light')}</button>
              </span>
            </div>
          </div>
        ) : null}
      </div>
        </>
      )}
        </>
      )}

      {/* F25 插件信息卡：名称 / 版本 / 设置入口 / 本地采集说明（不做更新检查——无版本接口） */}
      <div className="lc-card">
        <div className="lc-card-title">
          <span className="lc-card-title-text"><CardIcon name="plugin" />{t('plugin.title')}</span>
          <span className="lc-card-sub">{t('plugin.local')}</span>
        </div>
        <div className="lc-pi-grid">
          <div className="lc-pi-row">
            <div className="lc-pi-label">{t('plugin.name')}</div>
            <div className="lc-pi-value" title={PLUGIN_NAME + ' ' + PLUGIN_VERSION}>
              {PLUGIN_NAME}
              <span style={{ opacity: 0.6, fontWeight: 400, marginLeft: 5, fontVariantNumeric: 'tabular-nums' }}>{PLUGIN_VERSION}</span>
            </div>
          </div>
          <button type="button" className="lc-pi-row lc-pi-row-btn" title={t('plugin.settingsOpen')} onClick={openSettingsCard}>
            <div className="lc-pi-label">{t('plugin.settings')}</div>
            <div className="lc-pi-value">{t('plugin.settingsOpen')} <span aria-hidden="true">↓</span></div>
          </button>
        </div>
      </div>
    </div>
  )
}
