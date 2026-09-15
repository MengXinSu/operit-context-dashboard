// Based on dsh-context (https://github.com/bowenliang123/dsh-context, Apache-2.0); modified for the Operit platform.
/**
 * Category presentation config: the seven priced buckets (system, tool
 * schemas, and the five surface categories) with their chart colors, plus
 * the part builders behind the composition card.
 *
 * Two figures ride on every part, mirroring the official chat context
 * meter's own split: `raw` is the heuristic count (the meter panel's `~`
 * rows — identical to the ring panel by construction when the official
 * `contextBreakdown` projection feeds it), while `value` is the
 * provider-anchored bar width (the ring's fill proportioned by the
 * heuristic ratios). Without a provider anchor the two are equal.
 */

import type { Category, ContextBreakdown, RequestRecord, Snapshot, TokenUsage } from '../shared/types'

export interface PartsPart {
  key: string
  color: string
  /** Bar-width figure (provider-anchored when an anchor applies). */
  value: number
  /** Heuristic count shown by the legend and tooltips (defaults to value). */
  raw?: number
  /** Tooltip display name (defaults to the category label of `key`) — DNA mode names individual items. */
  label?: string
  /** Shared-hover group: an incoming hover key equal to a part's group lights it (DNA bands light per category). */
  group?: string
}

export const CATS: { key: Category | 'system' | 'tools' | 'profile'; color: string }[] = [
  // 按 Operit 上下文里的实际注入顺序排列（一眼看出位置）：
  { key: 'system', color: 'var(--color-indigo-500)' },       // ① 系统提示词（SYSTEM 前段）
  { key: 'skill', color: 'var(--color-orange-500)' },        // ② 技能注入（包系统段，SYSTEM 中段）
  { key: 'inject', color: 'var(--color-purple-500)' },       // ③ 世界书（worldbook 块，SYSTEM 后段）
  { key: 'profile', color: 'var(--color-pink-500)' },       // ④ 用户资料（user_profile 块，SYSTEM 尾段）
  { key: 'summary', color: 'var(--color-red-500)' },         // ⑤ 对话总结（压缩产生的历史摘要）
  { key: 'tools', color: 'var(--color-amber-500)' },         // ⑥ 工具定义（请求的 tools 字段）
  { key: 'user', color: 'var(--color-green-500)' },          // ⑦ 用户消息（对话历史）
  { key: 'assistant', color: 'var(--color-blue-500)' },      // ⑧ 助手消息（对话历史）
  { key: 'tool', color: 'var(--color-teal-500)' },           // ⑨ 工具结果（对话历史）
]

/** Category key → bar color, for per-item bands (the browser's DNA mode) that bypass the CATS-order part builders. */
export const CAT_COLOR = Object.fromEntries(CATS.map(c => [c.key, c.color])) as Record<Category | 'system' | 'tools', string>

/** 「图片」第十段颜色（2026-09-15）：图片 token 作为动态段由 App 追加到 parts 末尾（不进 CATS 顺序），无图时不占位。 */
export const IMG_COLOR = 'var(--color-violet-500)'

const MESSAGE_CATS: readonly (Category | 'system' | 'tools')[] = ['user', 'inject', 'skill', 'assistant', 'tool']

export function partsOf(breakdown: Snapshot['current'] | RequestRecord): PartsPart[] {
  return CATS.map((c) => {
    return { key: c.key, color: c.color, value: breakdown[c.key] || 0 }
  })
}

/**
 * Build the pie-consistent raw parts: system/tools/messages take the
 * OFFICIAL `contextBreakdown` figures when delivered (the exact counts the
 * chat ring's panel shows), with the message bucket subdivided into the
 * four surface categories by the fold's per-category ratios (rounding
 * residue lands on the largest category, so the four always sum exactly to
 * the official message figure). Absent the projection, the fold's own sums
 * serve — the same fixed estimator, so identical on image-free sessions.
 */
export function officialParts(
  current: Snapshot['current'],
  breakdown: ContextBreakdown | null,
): PartsPart[] {
  const foldSurface = current.user + current.inject + current.skill + current.assistant + current.tool
  const system = breakdown?.systemTokens ?? current.system
  const tools = breakdown?.toolsTokens ?? current.tools
  const messages = breakdown?.messageTokens ?? foldSurface
  const shares: Record<string, number> = { system, tools }
  if (foldSurface > 0) {
    let assigned = 0
    let largest: Category = 'user'
    for (const cat of MESSAGE_CATS) {
      const count = Math.round(messages * (current[cat as Category] / foldSurface))
      shares[cat] = count
      assigned += count
      if (current[cat as Category] > current[largest]) largest = cat as Category
    }
    // Rounding residue lands on the largest category; clamp so a tiny
    // message bucket with several rounded-up shares never goes negative.
    shares[largest] = Math.max(0, shares[largest] + messages - assigned)
  } else {
    for (const cat of MESSAGE_CATS) shares[cat] = 0
  }
  return CATS.map(c => ({
    key: c.key,
    color: c.color,
    /* v8 ignore next 1 -- `shares` is initialized with system/tools and both
       foldSurface arms assign every MESSAGE_CATS key, so each key is always
       defined; the fallback is defensive. */
    value: shares[c.key] ?? 0,
  }))
}

/**
 * Reproportion heuristic parts so they sum to a provider-anchored target —
 * the same trick the official ContextMeter uses: the heuristic breakdown
 * supplies the composition RATIOS, the provider sample the total. The
 * anchored figure rides `value` (bar widths); the heuristic count stays on
 * `raw` for the legend and tooltips. Returns the parts unchanged when no
 * anchor applies.
 */
export function anchoredParts(parts: PartsPart[], target: number | null): PartsPart[] {
  const sourced = parts.map(p => ({ ...p, raw: p.raw ?? p.value }))
  if (target === null || target <= 0) return sourced
  let total = 0
  for (const p of sourced) total += p.raw
  if (total <= 0) return sourced
  if (total === target) return sourced.map(p => ({ ...p, value: p.raw }))
  const scale = target / total
  return sourced.map(p => ({ ...p, value: Math.round(p.raw * scale) }))
}

/**
 * The Token card's billed split, by WHAT the tokens are rather than by how
 * the provider cached them: the six composition categories share the
 * provider-reported prompt-side total (uncached + cache read + cache write —
 * the chat stats line's billed input) by the composition card's own
 * estimated ratios, and the provider's exact output count closes the ring as
 * the seventh part. Only the per-category split is estimated — every
 * category's sum and the output figure are provider-reported, so the parts
 * total equals the chat line's whole-session token count by construction. A
 * zero/negative prompt total (or a hostile negative output) never invents a
 * split: the prompt parts zero out / the output clamps at 0.
 */
export function billedParts(
  current: Snapshot['current'],
  breakdown: ContextBreakdown | null,
  usage: TokenUsage,
): PartsPart[] {
  const input = usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  const estimated = officialParts(current, breakdown)
  const prompt = input > 0
    ? anchoredParts(estimated, input)
    : estimated.map(p => ({ ...p, value: 0 }))
  return [...prompt, { key: 'output', color: 'var(--color-pink-500)', value: Math.max(0, usage.outputTokens) }]
}
