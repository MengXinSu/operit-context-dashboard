// bridge 数据通道：优先走宿主（ToolPkg WebView）的 window.CtxProbe.api，
// 无宿主时返回 null（App 回退到假数据预览模式）。

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

export async function fetchMessages(): Promise<MessageItem[] | null> {
  const r = await call<{ ok: boolean; items?: MessageItem[] }>('messages')
  return r && r.ok && r.items ? r.items : null
}

export async function fetchEvents(): Promise<any[] | null> {
  const r = await call<{ ok: boolean; items?: any[] }>('events')
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