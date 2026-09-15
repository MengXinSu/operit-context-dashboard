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
  error?: string
}

export async function fetchRawSection(section: string, offset = 0, limit = 30): Promise<RawSectionData | null> {
  return call<RawSectionData>('rawSection', { section, offset, limit })
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

export async function fetchMessages(): Promise<MessageItem[] | null> {
  const r = await call<{ ok: boolean; items?: MessageItem[] }>('messages')
  return r && r.ok && r.items ? r.items : null
}
export async function fetchEvents(): Promise<any[] | null> {
  const r = await call<{ ok: boolean; items?: any[] }>('events')
  return r && r.ok && r.items ? r.items : null
}
export async function fetchFileActivity(): Promise<any[] | null> {
  const r = await call<{ ok: boolean; items?: any[] }>('fileActivity')
  return r && r.ok && r.items ? r.items : null
}
export async function fetchToolUsage(): Promise<any[] | null> {
  const r = await call<{ ok: boolean; items?: any[] }>('toolUsage')
  return r && r.ok && r.items ? r.items : null
}