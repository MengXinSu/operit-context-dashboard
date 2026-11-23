// Based on dsh-context (https://github.com/bowenliang123/dsh-context, Apache-2.0); modified for the Operit platform.
/** Shared dependency bag for component factories, built once per plugin apply (t, formatters, catLabel, event-text helpers). */

import type { ContextEventRecord } from '../shared/types'
import { fmt, fmtDuration, fmtShare, fmtTime } from './format'
import type { Translate } from './i18n'
// Operit 移植版：events.tsx 依赖已剥离；
// eventLabel/eventAt 暂以 stub 实现（Phase3 接 Operit 事件模型时按
// dsh-context src/client/components/events.tsx 的 makeEventText 补全）。

export interface ViewKit {
  t: Translate
  fmt: typeof fmt
  fmtTime: typeof fmtTime
  fmtDuration: typeof fmtDuration
  fmtShare: typeof fmtShare
  catLabel: (key: string) => string
  eventLabel: (ev: ContextEventRecord) => string
  eventAt: (ev: ContextEventRecord) => string | null
}

export function makeViewKit(t: Translate): ViewKit {
  // stub：真实实现待 Phase3（参考 events.tsx 的 makeEventText）
  const eventLabel = (ev: ContextEventRecord): string => t('ev.' + ((ev && ev.kind) || 'event'))
  const eventAt = (_ev: ContextEventRecord): string | null => null
  return {
    t,
    fmt,
    fmtTime,
    fmtDuration,
    fmtShare,
    catLabel: (key: string) => t('cat.' + key),
    eventLabel,
    eventAt,
  }
}
