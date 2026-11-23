// Based on dsh-context (https://github.com/bowenliang123/dsh-context, Apache-2.0); modified for the Operit platform.
/**
 * The milestone band above the timeline card: one pin per `seq` boundary,
 * flags for every kind recorded at that boundary side by side, and a count
 * badge on each flag whose event carries more than one item. Pure display:
 * the parent owns the events fetch (events_<key>.json), the active jump seq
 * and the pick handler. An empty event list renders nothing, unless the parent
 * passes `emptyHint` — then one muted hint row with an × dismiss takes its place.
 *
 * Grouping follows dsh-context's milestone model: events sharing a seq form
 * one group, and same-kind events in that group fold into one flag whose
 * badge is the summed item count. Flags are ordered by the upstream
 * MILESTONE_PRIORITY so the lead colour is stable. The band scrolls inside
 * its own width (never the page) once the pins no longer fit.
 */

import type { CSSProperties, ReactElement, ReactNode } from 'react'

export interface MilestoneEvent {
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

export interface MilestoneBandProps {
  events: MilestoneEvent[]
  activeSeq: number | null
  onPick: (seq: number) => void
  bandLabel: string
  /**
   * 无事件时的一行淡灰说明（空串/缺省 → 整条带子不渲染）。它是独立的一行，
   * 不进入旗子组；有事件时忽略该 prop。
   */
  emptyHint?: string
  /** 空态提示的关闭回调；缺省时提示只读、不渲染 ×。 */
  onDismissEmpty?: () => void
}

const NEUTRAL_COLOR = 'var(--dsw-alias-label-secondary)'

export const MILESTONE_COLOR: Record<string, string> = {
  compaction: 'var(--dsw-alias-state-error-primary)',
  prune: 'var(--color-violet-500)',
  skill: 'var(--color-orange-500)',
  agent: 'var(--color-purple-500)',
  spawn: 'var(--dsw-alias-state-success-primary)',
  model: 'var(--dsw-alias-label-secondary)',
  longest: 'var(--color-blue-500)',
  growth: 'var(--color-teal-500)',
  'goal-create': 'var(--color-blue-500)',
  'goal-complete': 'var(--dsw-alias-state-success-primary)',
  'todo-add': 'var(--color-indigo-500)',
  'todo-done': 'var(--color-teal-500)',
  ask: 'var(--dsw-alias-state-warn-primary)',
  'team-task-create': 'var(--color-pink-500)',
  'team-task-complete': 'var(--color-violet-500)',
}

export const MILESTONE_PRIORITY: Record<string, number> = {
  compaction: 0,
  prune: 1,
  'goal-complete': 2,
  'team-task-complete': 3,
  'todo-done': 4,
  'goal-create': 5,
  'team-task-create': 6,
  'todo-add': 7,
  ask: 8,
  longest: 9,
  growth: 10,
  spawn: 11,
  agent: 12,
  skill: 13,
  model: 14,
}

const GLYPHS: Record<string, ReactNode> = {
  compaction: (
    <>
      <circle cx="2.6" cy="2.6" r="1.2" />
      <circle cx="2.6" cy="7.4" r="1.2" />
      <path d="M3.6 3.4L8.2 6.8M3.6 6.6L8.2 3.2" />
    </>
  ),
  prune: <path d="M1.6 2.2h6.8L6 5.1v2.4L4 8.3V5.1z" />,
  skill: <path d="M5 1.2l.9 2.6 2.6.9-2.6.9L5 8.8 4.1 5.6 1.5 4.7l2.6-.9z" />,
  agent: (
    <>
      <path d="M1.8 2.2h6.4v4.1H5.1L3 8.1V6.3H1.8z" />
      <circle cx="3.6" cy="4.3" r=".35" fill="currentColor" stroke="none" />
      <circle cx="6.4" cy="4.3" r=".35" fill="currentColor" stroke="none" />
    </>
  ),
  spawn: (
    <>
      <circle cx="2.5" cy="2.5" r="1" />
      <circle cx="2.5" cy="7.5" r="1" />
      <circle cx="7.5" cy="5" r="1" />
      <path d="M3.5 2.5h1.6v2.5M3.5 7.5h1.6V5" />
    </>
  ),
  model: <path d="M1.8 3.4h5.2L5.6 2M8.2 6.6H3L4.4 8" />,
  longest: (
    <>
      <circle cx="5" cy="5.6" r="3.1" />
      <path d="M5 2.5V1.4M4 1.4h2M5 5.6l1.4 1" />
    </>
  ),
  growth: (
    <>
      <path d="M1.5 7.4L4 4.9l1.4 1.4L8.5 3" />
      <path d="M6.3 3h2.2v2.2" />
    </>
  ),
  'goal-create': (
    <>
      <circle cx="5" cy="5" r="3.2" />
      <circle cx="5" cy="5" r="1.2" />
      <path d="M5 1.8V.6M8.2 5h1.2" />
    </>
  ),
  'goal-complete': (
    <>
      <path d="M2.2 8.6V1.4M2.2 1.8h5.4L6.6 3.6l1 1.8H2.2" />
      <path d="M6.2 7.1l1 1 1.8-1.8" />
    </>
  ),
  'todo-add': (
    <>
      <path d="M1.8 2.2h4.4M1.8 5h3M1.8 7.8h3" />
      <path d="M7.2 5.4v3.2M5.6 7h3.2" />
    </>
  ),
  'todo-done': (
    <>
      <path d="M1.8 2.2h4.4M1.8 5h3M1.8 7.8h2.2" />
      <path d="M5.8 7l1.2 1.2 2-2.2" />
    </>
  ),
  ask: (
    <>
      <path d="M1.8 2h6.4v4H5.2L3.1 7.8V6H1.8z" />
      <path d="M4 3.3c.1-.5.5-.8 1-.8.6 0 1 .4 1 .9 0 .7-.9.8-.9 1.4" />
      <circle cx="5.1" cy="5.2" r=".25" fill="currentColor" stroke="none" />
    </>
  ),
  'team-task-create': (
    <>
      <rect x="2.8" y="1.8" width="4.4" height="6.4" rx=".5" />
      <path d="M4 1.8V1h2v.8" />
      <path d="M5 4v2.2M3.9 5.1h2.2" />
    </>
  ),
  'team-task-complete': (
    <>
      <rect x="2.8" y="1.8" width="4.4" height="6.4" rx=".5" />
      <path d="M4 1.8V1h2v.8" />
      <path d="M4.1 5l.8.8 1.5-1.5" />
    </>
  ),
}

interface MilestoneEntry {
  kind: string
  events: MilestoneEvent[]
  count: number
}

interface MilestoneGroup {
  seq: number
  entries: MilestoneEntry[]
}

function colorOf(kind: string): string {
  return MILESTONE_COLOR[kind] ?? NEUTRAL_COLOR
}

function priorityOf(kind: string): number {
  return MILESTONE_PRIORITY[kind] ?? 99
}

/**
 * The badge count. `count` wins because the collector clips `items` to 8 while
 * keeping the real total in `count`; `items.length` is the fallback for
 * hand-built events, and a single item is the floor.
 */
function countOf(ev: MilestoneEvent): number {
  if (typeof ev.count === 'number' && ev.count > 0) return ev.count
  if (Array.isArray(ev.items) && ev.items.length > 0) return ev.items.length
  return 1
}

function tipOf(entry: MilestoneEntry): string {
  const items: string[] = []
  for (const ev of entry.events) {
    if (!Array.isArray(ev.items)) continue
    for (const item of ev.items) {
      if (items.length >= 3) break
      items.push(item)
    }
    if (items.length >= 3) break
  }
  const named = entry.events.find(ev => typeof ev.name === 'string' && ev.name !== '')
  const parts: string[] = [entry.kind]
  if (named !== undefined && typeof named.name === 'string' && named.name !== items[0]) parts.push(named.name)
  if (items.length > 0) parts.push(items.join('、') + (entry.count > items.length ? '…' : ''))
  else if (entry.count > 1) parts.push('×' + entry.count)
  return parts.join(' · ')
}

function groupEvents(events: MilestoneEvent[]): MilestoneGroup[] {
  const bySeq = new Map<number, Map<string, MilestoneEvent[]>>()
  for (const ev of events) {
    if (ev === null || ev === undefined) continue
    if (typeof ev.seq !== 'number' || typeof ev.kind !== 'string' || ev.kind === '') continue
    let byKind = bySeq.get(ev.seq)
    if (byKind === undefined) {
      byKind = new Map<string, MilestoneEvent[]>()
      bySeq.set(ev.seq, byKind)
    }
    const list = byKind.get(ev.kind)
    if (list === undefined) byKind.set(ev.kind, [ev])
    else list.push(ev)
  }
  const groups: MilestoneGroup[] = []
  for (const [seq, byKind] of bySeq) {
    const entries: MilestoneEntry[] = []
    for (const [kind, list] of byKind) {
      let count = 0
      for (const ev of list) count += countOf(ev)
      entries.push({ kind, events: list, count })
    }
    entries.sort((a, b) => priorityOf(a.kind) - priorityOf(b.kind) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
    groups.push({ seq, entries })
  }
  groups.sort((a, b) => a.seq - b.seq)
  return groups
}

function MilestoneGlyph({ kind }: { kind: string }): ReactElement {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {GLYPHS[kind] ?? <circle cx="5" cy="5" r="1.5" />}
    </svg>
  )
}

export function MilestoneBand(props: MilestoneBandProps): ReactElement | null {
  const groups = groupEvents(props.events)
  if (groups.length === 0) {
    const hint = props.emptyHint
    if (hint === undefined || hint === '') return null
    const dismiss = props.onDismissEmpty
    return (
      <div className="lc-ms-empty" role="note">
        <span className="lc-ms-empty-glyph" aria-hidden="true">⚠</span>
        <span className="lc-ms-empty-text" title={hint}>{hint}</span>
        {dismiss !== undefined ? (
          <button type="button" className="lc-ms-empty-x" aria-label="关闭提示" title="关闭提示" onClick={dismiss}>×</button>
        ) : null}
      </div>
    )
  }
  return (
    <div className="lc-milestones-band" role="group" aria-label={props.bandLabel}>
      <div className="lc-ms-track">
        {groups.map((group) => {
          const active = props.activeSeq === group.seq
          const lead = group.entries[0]
          return (
            <button
              key={group.seq}
              type="button"
              className={'lc-ms' + (active ? ' lc-ms-active' : '')}
              style={{ '--lc-ms-c': colorOf(lead.kind) } as CSSProperties}
              data-seq={group.seq}
              aria-pressed={active}
              aria-label={group.entries.map(tipOf).join('；')}
              onClick={() => { props.onPick(group.seq) }}
            >
              <span className="lc-ms-flags">
                {group.entries.map((entry) => (
                  <span
                    key={entry.kind}
                    className="lc-ms-flag"
                    data-kind={entry.kind}
                    title={tipOf(entry)}
                    style={{ '--lc-ms-c': colorOf(entry.kind) } as CSSProperties}
                  >
                    <MilestoneGlyph kind={entry.kind} />
                    {entry.count > 1 ? <span className="lc-ms-count">{entry.count}</span> : null}
                  </span>
                ))}
              </span>
              <span className="lc-ms-pole" aria-hidden="true" />
              <span className="lc-ms-foot" aria-hidden="true" />
            </button>
          )
        })}
      </div>
    </div>
  )
}
