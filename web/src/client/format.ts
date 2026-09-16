// Based on dsh-context (https://github.com/bowenliang123/dsh-context, Apache-2.0); modified for the Operit platform.
/** `fmt`: the k/M suffix style shared by bars/details/stats; `fmtTime`: local HH:MM:SS. */

export function fmt(n: number | null | undefined): string {
  if (n === undefined || n === null || isNaN(n)) return '—'
  const sign = n < 0 ? '-' : ''
  const a = Math.abs(n)
  if (a >= 1e6) return sign + (a / 1e6).toFixed(1) + 'M'
  if (a >= 1000) return sign + (a / 1000).toFixed(1) + 'k'
  return sign + String(Math.round(a))
}

/** Byte sizes for attachment metadata (1 kB = 1000 B, matching the k/M style of `fmt`). */
export function fmtBytes(n: number | null | undefined): string {
  if (n === undefined || n === null || isNaN(n) || n < 0) return '—'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB'
  if (n >= 1000) return (n / 1000).toFixed(1) + ' kB'
  return String(Math.round(n)) + ' B'
}

/**
 * Cache-hit share of billed prompt-side input (`reads` over `billed`),
 * TRUNCATED to `decimals` places (cut, not round) — same formula as the
 * harness chat stats line's '缓存命中' figure and the stats board's cell
 * (which shows two decimals). Null when nothing was billed. The 1e-9 epsilon
 * absorbs only float noise (integer token counts never sit that close to a
 * boundary).
 */
export function cacheHitPercent(reads: number, billed: number, decimals = 2): string | null {
  if (!(billed > 0)) return null
  const factor = 10 ** decimals
  const scaled = Math.trunc((reads / billed) * 100 * factor + 1e-9)
  return `${Math.floor(scaled / factor)}.${String(scaled % factor).padStart(decimals, '0')}`
}

export function fmtTime(t: number): string {
  // en-GB 24-hour clock zero-pads HH:MM:SS without a helper; invalid dates must show '—' (toLocaleTimeString throws RangeError).
  const d = new Date(t)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString('en-GB', { hour12: false })
}

/**
 * Share of a whole as a compact leading percentage for the slice rows:
 * '—' when nothing totals, '0.0%' for empty slices, '<0.1%' for non-zero
 * crumbs a 0.1%-precision figure would erase. One decimal everywhere; shares
 * cap at 100% (parallel tool time can over-run the wall it belongs to).
 */
export function fmtShare(part: number, total: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return '—'
  if (part <= 0) return '0.0%'
  const pct = Math.min(1, part / total) * 100
  if (pct < 0.1) return '<0.1%'
  return `${pct.toFixed(1)}%`
}

/**
 * Whole-session durations for the timing card, locale-free compact units: raw
 * ms under a second, one-decimal seconds under a minute, then m/s and h/m.
 * Non-finite or non-positive input shows the dash (callers render their empty
 * state anyway).
 */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (ms < 3_600_000) return `${m}m${s}s`
  return `${Math.floor(m / 60)}h${m % 60}m`
}

// ── Image token estimation（DeepSeek「图片 Token 计算器」移植；与宿主桥 index.ui.js 同公式同常量）──
const IMG_PATCH = 14
const IMG_DOWN = 3
const IMG_MAX_TOKENS = 384
const IMG_PAD = 4
const IMG_MIN_PIXELS = 147456
const IMG_MAX_RATIO = 8

type ImgResizeResult = { nLlmH: number; nLlmW: number; bestHeight: number; bestWidth: number; numTokens: number }

function imgGridTokens(rows: number, cols: number): number {
  let n = rows * (cols + 1) + 2
  if (rows % 2 === 1) n += cols + 1
  n += (Math.ceil(rows / 2) * (cols + 1) % 2) * 2
  return n
}

function imgSolveResize(height: number, width: number, budget: number): ImgResizeResult {
  const ratio = height / width
  const gridW = Math.sqrt((budget - 2) / ratio + 0.25) - 0.5
  const gridH = gridW * ratio
  const unit = IMG_PATCH * IMG_DOWN
  let bestHeight: number, bestWidth: number
  if (gridW < 1) {
    let rows0 = Math.floor((budget - 2) / 2)
    if (rows0 % 2 === 1) rows0 -= 1
    bestWidth = unit
    bestHeight = rows0 * unit
  } else if (gridH < 2) {
    const cols0 = Math.floor((budget - 2) / 2) - 1
    bestHeight = 2 * unit
    bestWidth = cols0 * unit
  } else {
    const cols = Math.trunc(gridW)
    let rows = Math.trunc(gridH)
    if (rows % 2 === 1) rows -= 1
    const scale = Math.min(cols * unit / width, rows * unit / height)
    bestWidth = Math.trunc(width * scale / IMG_PATCH) * IMG_PATCH
    bestHeight = Math.trunc(height * scale / IMG_PATCH) * IMG_PATCH
  }
  const nH = Math.ceil(Math.floor(bestHeight / IMG_PATCH) / IMG_DOWN)
  const nW = Math.ceil(Math.floor(bestWidth / IMG_PATCH) / IMG_DOWN)
  return { nLlmH: nH, nLlmW: nW, bestHeight, bestWidth, numTokens: imgGridTokens(nH, nW) }
}

function imgSafeResize(height: number, width: number, paddedHeight: number, paddedWidth: number): ImgResizeResult {
  const nH = Math.ceil(Math.floor(paddedHeight / IMG_PATCH) / IMG_DOWN)
  const nW = Math.ceil(Math.floor(paddedWidth / IMG_PATCH) / IMG_DOWN)
  const pad = IMG_PAD - 1
  const budget = IMG_MAX_TOKENS - pad
  let result: ImgResizeResult = { nLlmH: nH, nLlmW: nW, bestHeight: paddedHeight, bestWidth: paddedWidth, numTokens: imgGridTokens(nH, nW) }
  if (result.numTokens > budget) {
    result = imgSolveResize(height, width, budget)
    let nextBudget = budget
    while (result.numTokens > budget) {
      nextBudget -= 1
      result = imgSolveResize(height, width, nextBudget)
    }
  }
  result.numTokens += pad
  return result
}

function imgCalcResizeInner(width: number, height: number): ImgResizeResult {
  let w = width
  let h = height
  if (w > h * IMG_MAX_RATIO) w = h * IMG_MAX_RATIO
  const pixels = w * h
  if (pixels < IMG_MIN_PIXELS && pixels > 0) {
    const scale = Math.sqrt(IMG_MIN_PIXELS / pixels)
    w = Math.trunc(w * scale)
    h = Math.trunc(h * scale)
  }
  const paddedWidth = Math.ceil(w / IMG_PATCH) * IMG_PATCH
  const paddedHeight = Math.ceil(h / IMG_PATCH) * IMG_PATCH
  return imgSafeResize(h, w, paddedHeight, paddedWidth)
}

/**
 * 按图片原始宽高估算 provider 计费 token（官方计算器公式：尺寸上限 → 网格化取整 →
 * 迭代收敛；单图 ≤384）。用于图片附件卡的 ≈token 行。非法输入返回 null。
 */
export function estimateImageTokens(width: number | null | undefined, height: number | null | undefined): number | null {
  if (width == null || height == null || !isFinite(width) || !isFinite(height) || width <= 0 || height <= 0) return null
  try {
    let result = imgCalcResizeInner(width, height)
    for (let i = 1; i < 10; i++) {
      const next = imgCalcResizeInner(result.bestWidth, result.bestHeight)
      if (next.nLlmH === result.nLlmH && next.nLlmW === result.nLlmW && next.bestHeight === result.bestHeight && next.bestWidth === result.bestWidth && next.numTokens === result.numTokens) return result.numTokens
      result = next
    }
    return null
  } catch (e) {
    return null
  }
}
