// bridge 数据通道：优先走宿主（ToolPkg WebView）的 window.CtxProbe.api，
// 无宿主时返回 null（App 回退到假数据预览模式）。
import type { StepBriefData } from '../shared/types'

export interface SummaryData {
  ok: boolean
  session?: string
  current?: Record<string, number>
  counts?: Record<string, number>
  toolsCount?: number
  worldbook?: { blocks: number; chars: number; entries: number; names: string[] }
  historyCount?: number
  totalChars?: number
  error?: string
}

export interface TimelineItem {
  seq: number
  t: number
  system: number
  tools: number
  user: number
  inject: number
  skill: number
  assistant: number
  tool: number
  total: number
  /** F10 时长曲线：该请求的模型等待（TTFT）毫秒；桥层匹配不到 chatmsg 时给 0（= 无测量，不是 0ms）。 */
  waitMs?: number
  /** F10 时长曲线：该请求的模型生成毫秒；同 waitMs 口径。 */
  outMs?: number
}

export interface MessageItem {
  t: number
  sentAt: number
  input: number
  output: number
  cached: number
  waitMs: number
  outMs: number
  roleName: string
  model?: string
}

declare global {
  interface Window {
    CtxProbe?: { api: (payload: string) => unknown }
  }
}

export function hasBridge(): boolean {
  return typeof window !== 'undefined' && !!(window as any).CtxProbe
}

async function call<T>(method: string, extra?: Record<string, unknown>): Promise<T | null> {
  if (!hasBridge()) return null
  try {
    // 单参数协议：Android 桥接多参数会被合并成 "a,b"，一律走 JSON 字符串
    const payload = JSON.stringify(Object.assign({ m: method }, extra || {}))
    const r = await Promise.resolve((window as any).CtxProbe.api(payload))
    if (typeof r === 'string') return JSON.parse(r) as T
    if (r && typeof r === 'object') return r as T
    return null
  } catch (e) {
    return null
  }
}

export interface RawListItem {
  idx: number
  kind?: string
  name?: string
  toolName?: string
  preview?: string
  chars: number
}

export interface RawSectionData {
  ok: boolean
  kind?: 'text' | 'list'
  total?: number
  chars?: number
  names?: string[]
  content?: string
  items?: RawListItem[]
  /** 本页在倒序（最新在前）列表中的起点；普通分页与 focus 直达共用（W3）。 */
  offset?: number
  /** focus 直达：命中的锚点（preparedHistory 下标）；用于判定命中与否。 */
  focusIdx?: number
  /** focus 直达未命中：锚点不在此范围内（已被压缩裁剪等）。 */
  focusMiss?: boolean
  error?: string
}

export async function fetchRawSection(section: string, offset = 0, limit = 30, focusIdx?: number): Promise<RawSectionData | null> {
  return call<RawSectionData>('rawSection', Object.assign({ section, offset, limit }, focusIdx === undefined ? {} : { focusIdx }))
}

export async function fetchRawItem(index: number): Promise<{ ok: boolean; content?: string; kind?: string; toolName?: string; error?: string } | null> {
  return call('rawItem', { index })
}

export async function fetchSummary(): Promise<SummaryData | null> {
  return call<SummaryData>('summary')
}

export async function fetchTimeline(): Promise<TimelineItem[] | null> {
  const r = await call<{ ok: boolean; items?: TimelineItem[] }>('timeline')
  return r && r.ok && r.items ? r.items : null
}

/** 步骤重建数据（宿主从 raw 事后切分：每轮内按工具结果批次拆步） */
export interface StepItem extends TimelineItem {
  turn?: number
  step?: number
  summary?: number
  historyCount?: number
  historyChars?: number
}

export async function fetchSteps(): Promise<StepItem[] | null> {
  const r = await call<{ ok: boolean; items?: StepItem[] }>('steps')
  return r && r.ok && r.items ? r.items : null
}

/** W9①：单步 brief 按需拉取（宿主桥 apiStepBrief；单步现算，毫秒级）。 */
export async function fetchStepBrief(pIdx: number): Promise<StepBriefData | null> {
  const r = await call<{ ok: boolean; brief?: StepBriefData; error?: string }>('stepBrief', { pIdx })
  if (!r || !r.ok || !r.brief) return null
  return r.brief
}

export async function fetchMessages(): Promise<MessageItem[] | null> {
  const r = await call<{ ok: boolean; items?: MessageItem[] }>('messages')
  return r && r.ok && r.items ? r.items : null
}

export async function fetchEvents(): Promise<any[] | null> {
  const r = await call<{ ok: boolean; items?: any[] }>('events')
  return r && r.ok && r.items ? r.items : null
}

export interface MilestoneItem {
  seq: number
  time: number
  kind: string
  name?: string
  detail?: string
  items?: string[]
  count?: number
  turn?: number
  step?: number
}

export async function fetchMilestones(): Promise<MilestoneItem[] | null> {
  const r = await call<{ ok: boolean; items?: MilestoneItem[] }>('milestones')
  return r && r.ok && r.items ? r.items : null
}

// ── 文件活动 v2（宿主桥 apiFileActivity 2.2.0：op 级记录 + 按路径聚合 + 总览）──

export interface FileActivityOp {
  /** 完成该操作的 TOOL_RESULT 的 preparedHistory 下标（= resultIdx；W3 定位锚点）。 */
  seq: number
  kind: 'read' | 'write' | 'search'
  tool: string
  /** 操作目标；pathless 搜索时是搜索 pattern 本身（pattern: true）。 */
  path: string
  added: number
  removed: number
  err: boolean
  /** 配对锚点：源 TOOL_CALL / TOOL_RESULT 的 preparedHistory 下标（W3 定位用）。 */
  callIdx: number
  resultIdx: number
  /** 读操作：结果 meta 的精确窗口，或 limit 参数的估算（est: true）。 */
  read?: { start: number; count: number } | { count: number; est: true }
  /** 搜索命中行数。 */
  hits?: number
  /** 搜索的操作数（同时有路径与 pattern 时）。 */
  detail?: string
  /** path 是 pathless 搜索的 pattern，不是文件路径。 */
  pattern?: true
}

export interface FileActivityEntry {
  path: string
  form: 'text' | 'image' | 'dir'
  reads: number
  writes: number
  searches: number
  added: number
  removed: number
  errs: number
  /** 最新在前。 */
  ops: FileActivityOp[]
  /** path 是 pathless 搜索的 pattern（展示不按路径处理）。 */
  pattern?: true
}

export interface FileActivityTotals {
  read: { files: number; ops: number }
  write: { files: number; ops: number }
  search: { files: number; ops: number }
  image: { files: number; ops: number }
  added: number
  removed: number
}

export interface FileActivityData {
  entries: FileActivityEntry[]
  totals: FileActivityTotals
  /** W6 scope：数据窗口的 USER 消息锚点（preparedHistory 下标，升序）。 */
  userIdx?: number[]
}

export const EMPTY_FA_TOTALS: FileActivityTotals = {
  read: { files: 0, ops: 0 }, write: { files: 0, ops: 0 }, search: { files: 0, ops: 0 }, image: { files: 0, ops: 0 },
  added: 0, removed: 0,
}

export async function fetchFileActivity(): Promise<FileActivityData | null> {
  const r = await call<{ ok: boolean; entries?: FileActivityEntry[]; totals?: FileActivityTotals; userIdx?: number[] }>('fileActivity')
  if (!r || !r.ok) return null
  return { entries: r.entries || [], totals: r.totals || EMPTY_FA_TOTALS, userIdx: r.userIdx || [] }
}

/** W6：用系统默认应用打开文件（宿主 Files.open；返回结构含失败原因）。 */
export async function fetchOpenPath(path: string): Promise<{ ok: boolean; path?: string; details?: string; error?: string } | null> {
  return call('openPath', { path })
}

export async function fetchToolUsage(): Promise<any[] | null> {
  const r = await call<{ ok: boolean; items?: any[] }>('toolUsage')
  return r && r.ok && r.items ? r.items : null
}
export interface SessionUsageData {
  ok: boolean
  session?: string
  rows: number
  input: number
  output: number
  cached: number
  first: number
  last: number
}
/** W7② 会话计费累计（全库 chatmsg，当前会话完成态求和） */
export async function fetchSessionUsage(): Promise<SessionUsageData | null> {
  const r = await call<SessionUsageData>('sessionUsage')
  return r && r.ok ? r : null
}

// ── P4-4A 上下文统计卡聚合（宿主桥 apiStats）──
// 结构照抄上游 statsContext.tsx 的数据面：KPI 六格（turns/steps/skills/answers/events）
// + IO 账本（输入四项 / 输出工具调用总数）+ 工具名 chips + 命令行 chips。
// 字段口径由桥层 apiStats 决定；本层只做类型与通道，不做任何再聚合。
export interface StatsCoreEvents {
  inject: number
  compaction: number
  prune: number
}

export interface StatsData {
  ok: boolean
  key?: string
  core: {
    turns: number
    steps: number
    skills: number
    answers: number
    events: StatsCoreEvents
  }
  io: {
    in: { user: number; read: number; write: number; search: number }
    out: { tools: number }
  }
  /** 按真实工具名聚合（package_proxy 已由采集层解包）：`name` 是全名（跳转用），`short` 是展示短名。 */
  tools: Array<{ name: string; count: number; short?: string }>
  /** 命令执行：name = 程序名/命令名，failed = 失败次数（无耗时口径）。 */
  commands: Array<{ name: string; count: number; failed: number }>
  /**
   * 命令**行**调用次数（一条命令行里可能跑多个程序，所以 ≠ sum(commands.count)）。
   * 标题数字用这个口径；桥层未下发时由页面回退到 sum(commands.count)。
   */
  runs?: number
  error?: string
}

/**
 * P4-4A：工具 chips 的展示短名。
 * 上游原版 chip 显示 `bash` / `read` / `grep`，不是 `super_admin:bash` —— 桥层若下发 `short`
 * 就用它，否则取 `:` 尾段兜底（不依赖桥层改动先后），空值退回全名。
 * 只影响展示：跳转/定位一律用全名 `name`。
 */
export function toolShortName(name: string, short?: string): string {
  if (short !== undefined && short !== null && short !== '') return String(short)
  const tail = String(name).split(':').pop()
  return tail !== undefined && tail !== '' ? tail : String(name)
}

/** P4-4A：上下文统计卡数据；桥层未就绪时返回 null，由页面用已有真实数据兜底。 */
export async function fetchStats(): Promise<StatsData | null> {
  const r = await call<StatsData>('stats')
  if (!r || !r.ok) return null
  const tools = Array.isArray(r.tools) ? r.tools : []
  return {
    ...r,
    tools: tools.map((t) => {
      const name = String(t.name || '')
      return { name, count: Number(t.count) || 0, short: toolShortName(name, t.short) }
    }),
  }
}

// ── P4-6 洞察页（跨会话总览）：宿主桥 apiOverview ──
// 桥层取数纪律：只读 index.json + 最近 14 个 chatmsg-*.jsonl，不扫 raw（真实样本实测 <50ms）。
// 本层只做类型与通道；**成本不由桥层下发**（costReady:false，桥层没有价格表），
// 由页面按 localStorage 'dsh-prices-v2' 自己估。字段口径与桥层 ovBuild 严格对齐。
export type OverviewRange = 'today' | '7d'

export interface OverviewKpi {
  /** range 窗口内有活动的会话数（≠ 会话卡总数）。 */
  sessions: number
  turns: number
  /** inTok + outTok。 */
  billedTokens: number
  inTok: number
  outTok: number
  cachedTok: number
  msgs: number
  /** Σ(waitMs + outMs)：模型等待 + 生成，不是墙钟时长。 */
  activeMs: number
  /** 0..1 比例（页面 ×100 显示）。 */
  cacheHit: number
  /** 桥层恒 0（无价格表）。 */
  cost: number
  costReady?: boolean
}

/** `days` 恒定 7 天升序（最旧 → 今天），缺日补 0；range 只影响 KPI 与会话卡，不改这条日序列。 */
export interface OverviewDay {
  date: string
  tokens: number
  inTok: number
  outTok: number
  cachedTok: number
  turns: number
  msgs: number
  cost?: number
}

/** `heat` 恒定 56 天升序（含今天）。sessions = index 快照口径（8 周可覆盖）；
 *  tokens / activeSessions = chatmsg 口径（仅最近 14 天有数据）。两个口径窗口不同，UI 必须注明。 */
export interface OverviewHeatDay {
  date: string
  tokens: number
  turns: number
  /** index.json 里该日有快照的会话数（8 周窗口）。 */
  sessions: number
  /** chatmsg 里该日有计费行的会话数（仅 14 天）。 */
  activeSessions: number
}

/** 会话卡：index 为骨架 + chatmsg 聚合。active=false 表示 range 窗口内无活动（历史会话）。 */
export interface OverviewSession {
  key: string
  chatId: string
  preview: string
  capturedAtMs: number
  lastActiveMs: number
  tokens: number
  inTok?: number
  outTok?: number
  cachedTok?: number
  turns: number
  msgs: number
  activeMs: number
  chars: number
  lines: number
  /** 是否在 index.json 里（false = 已滚出 100 条环、只有计费行）。 */
  indexed: boolean
  active: boolean
  cost?: number
}

/** 分模型明细：只统计 range 窗口内，供前端按价格表估成本（桥层不下发成本）。 */
export interface OverviewModel {
  model: string
  tokens: number
  inTok: number
  outTok: number
  cachedTok: number
  msgs: number
}

export interface OverviewCoverage {
  /** 热力窗口起点（今天往前 56 天的 00:00）。 */
  since: number
  until: number
  rawSessions: number
  chatDays: number
  chatRows: number
  skippedRows: number
  firstMsgMs: number
  lastMsgMs: number
  heatDays: number
  cachedFiles?: number
}

export interface OverviewData {
  ok: boolean
  range: OverviewRange
  /** 桥层端到端耗时（自检用）。 */
  ms?: number
  kpi: OverviewKpi
  days: OverviewDay[]
  heat: OverviewHeatDay[]
  sessions: OverviewSession[]
  models: OverviewModel[]
  /** 恒 false：成本必须由前端按本地价格表估。 */
  costReady: boolean
  coverage: OverviewCoverage
  error?: string
}

/** 洞察页唯一入口：一次调用拿全量（KPI + 7 天 + 热力 + 会话卡 + 分模型）。
 *  返回 null = 无宿主桥或桥层报错（页面显示空态，不造假数据）。 */
export async function fetchOverview(range: OverviewRange): Promise<OverviewData | null> {
  const r = await call<OverviewData>('overview', { range })
  if (!r || !r.ok) return null
  return {
    ...r,
    range: r.range === 'today' ? 'today' : '7d',
    days: Array.isArray(r.days) ? r.days : [],
    heat: Array.isArray(r.heat) ? r.heat : [],
    sessions: Array.isArray(r.sessions) ? r.sessions : [],
    models: Array.isArray(r.models) ? r.models : [],
    kpi: r.kpi || {
      sessions: 0, turns: 0, billedTokens: 0, inTok: 0, outTok: 0, cachedTok: 0,
      msgs: 0, activeMs: 0, cacheHit: 0, cost: 0, costReady: false,
    },
    coverage: r.coverage || {
      since: 0, until: 0, rawSessions: 0, chatDays: 0, chatRows: 0, skippedRows: 0,
      firstMsgMs: 0, lastMsgMs: 0, heatDays: 56,
    },
  }
}

export interface TodaySessionGroup {
  session: string
  base: { input: number; output: number; cached: number }
  items: MessageItem[]
}
export interface TodayMessagesData {
  ok: boolean
  groups?: TodaySessionGroup[]
  error?: string
}
export async function fetchTodayMessages(): Promise<TodayMessagesData | null> {
  return call<TodayMessagesData>('todayMessages')
}