// Based on dsh-context (https://github.com/bowenliang123/dsh-context, Apache-2.0); modified for the Operit platform.
/**
 * Pure geometry for the timeline chart: the bar-column grid, the virtual bar window the scroller renders
 * around the viewport, and the duration curve laid over the same columns. No React and no DOM — trendChart.tsx
 * owns the scroller and feeds measurements in, so every figure here is exercisable headlessly.
 */

/** Bar width and neighbour gap of the column grid; the turn strip and the window pads share the same pitch. */
export const BAR_W = 14
export const BAR_GAP = 2
export const BAR_PITCH = BAR_W + BAR_GAP
/** Logs at or under this many bars render in full: windowing a short log would only add bookkeeping. */
export const TIMELINE_WINDOW_MIN = 240
/** Columns rendered beyond each viewport edge, so a fling never outruns the committed window. */
export const WINDOW_OVERSCAN_BARS = 36
/** Growth padding applied when the window moves: re-windowing only once the desired range leaves the rendered one. */
export const WINDOW_HYSTERESIS_BARS = 8

export interface BarWindow {
  from: number
  to: number
}

/** One request's activity split: model wait (TTFT) and generation, both ms, as the bridge reports them. */
export interface DurationSample {
  waitMs: number
  outMs: number
}

/** A sample's sanitized parts; null when the pair carries no measurement (see durationPartsOf). */
export interface DurationParts {
  waitMs: number
  outMs: number
  totalMs: number
}

/** Polyline runs (SVG `points` strings) and lone samples drawn as dots; empty when nothing is plottable. */
export interface DurationCurveGeometry {
  runs: string[]
  dots: Array<[number, number]>
}

const EMPTY_GEOMETRY: DurationCurveGeometry = { runs: [], dots: [] }

/**
 * The window a freshly mounted chart opens on: short logs in full, longer ones anchored to the newest columns
 * (a few screens wide) so the "newest bars at the right edge" initial scroll has bars to show.
 */
export function initialBarWindow(n: number, overscan: number = WINDOW_OVERSCAN_BARS): BarWindow {
  return n <= TIMELINE_WINDOW_MIN ? { from: 0, to: Math.max(0, n - 1) } : { from: Math.max(0, n - 1 - 4 * overscan), to: n - 1 }
}

/** The columns covering the viewport plus overscan, in content coordinates. */
export function windowRangeFor(scrollLeft: number, clientWidth: number, n: number, overscan: number = WINDOW_OVERSCAN_BARS): BarWindow {
  if (n <= TIMELINE_WINDOW_MIN) return { from: 0, to: Math.max(0, n - 1) }
  const from = Math.min(n - 1, Math.max(0, Math.floor(scrollLeft / BAR_PITCH) - overscan))
  const to = Math.min(n - 1, Math.ceil((scrollLeft + clientWidth) / BAR_PITCH) + overscan)
  return { from, to: Math.max(from, to) }
}

/**
 * The window to commit for a desired range: unchanged (same object identity) while the desired range stays
 * contained, otherwise the desired range grown by the hysteresis margin so small scrolls never re-window.
 */
export function nextBarWindow(prev: BarWindow, desired: BarWindow, n: number, hysteresis: number = WINDOW_HYSTERESIS_BARS): BarWindow {
  if (n <= TIMELINE_WINDOW_MIN) return { from: 0, to: Math.max(0, n - 1) }
  if (desired.from >= prev.from && desired.to <= prev.to) return prev
  return {
    from: Math.max(0, desired.from - hysteresis),
    to: Math.min(n - 1, desired.to + hysteresis),
  }
}

/** Clamp a committed window to a log that may have shrunk (data refresh, granularity switch). */
export function clampBarWindow(win: BarWindow, n: number): BarWindow {
  if (n <= 0) return { from: 0, to: 0 }
  const from = Math.min(Math.max(win.from, 0), n - 1)
  return { from, to: Math.max(from, Math.min(win.to, n - 1)) }
}

/**
 * Spacer widths around the rendered bars, in content px: they hold the full column grid's scroll length so the
 * scrollbar thumb and the scroll positions stay identical to a complete render. Both slots collapse to 0 at the
 * ends, where the grid itself already provides the edge.
 */
export function windowPads(from: number, to: number, n: number): { left: number; right: number } {
  return {
    left: from > 0 ? from * BAR_PITCH - BAR_GAP : 0,
    right: to < n - 1 ? (n - 1 - to) * BAR_PITCH - BAR_GAP : 0,
  }
}

/**
 * A sample's activity split, sanitized for plotting: non-finite and negative parts read as 0. A pair totalling
 * 0 is NOT a measured zero — the bridge writes 0/0 when a request cannot be matched to its messages — so it
 * answers null and the curve breaks there instead of claiming an instant request.
 */
export function durationPartsOf(sample: DurationSample | null | undefined): DurationParts | null {
  if (sample === null || sample === undefined) return null
  const waitMs = Number.isFinite(sample.waitMs) ? Math.max(0, sample.waitMs) : 0
  const outMs = Number.isFinite(sample.outMs) ? Math.max(0, sample.outMs) : 0
  const totalMs = waitMs + outMs
  return totalMs > 0 ? { waitMs, outMs, totalMs } : null
}

/** Peak plottable activity across the samples — the duration axis' whole-log maximum. */
export function durationMaxMs(samples: ReadonlyArray<DurationSample | null | undefined>): number {
  let max = 0
  for (const sample of samples) {
    const parts = durationPartsOf(sample)
    if (parts !== null && parts.totalMs > max) max = parts.totalMs
  }
  return max
}

/**
 * The curve over the column grid: each sample sits at its column centre, its y is the sample's total mapped
 * onto the 0..height bar area (y grows downward) and clamped there, and unknown samples break the line. A run
 * of one is emitted as a dot instead of a zero-length polyline, so isolated samples stay visible.
 */
export function durationCurveOf(
  samples: ReadonlyArray<DurationSample | null | undefined>,
  height: number,
  maxMs: number,
): DurationCurveGeometry {
  if (samples.length === 0 || !(maxMs > 0) || !(height > 0)) return EMPTY_GEOMETRY
  const scale = height / maxMs
  const runs: string[] = []
  const dots: Array<[number, number]> = []
  let run: Array<[number, number]> = []
  const flush = (): void => {
    if (run.length >= 2) runs.push(run.map(p => `${p[0]},${p[1]}`).join(' '))
    else if (run.length === 1) dots.push(run[0])
    run = []
  }
  for (let i = 0; i < samples.length; i++) {
    const parts = durationPartsOf(samples[i])
    if (parts === null) {
      flush()
      continue
    }
    const y = Math.min(height, Math.max(0, height - parts.totalMs * scale))
    run.push([i * BAR_PITCH + BAR_W / 2, Math.round(y * 100) / 100])
  }
  flush()
  return runs.length === 0 && dots.length === 0 ? EMPTY_GEOMETRY : { runs, dots }
}
