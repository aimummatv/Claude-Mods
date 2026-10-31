// Shared look: colours, number formats, SVG rings and bars (desktop), block characters (terminal).
import type { Elements } from 'claude-code'

/** The element table of whichever surface draws. */
export type Els = Elements[keyof Elements]
export const svgOf = (E: Els) => ('Svg' in E ? E.Svg : null)
export const inputOf = (E: Els) => ('Input' in E ? E.Input : null)

/**
 * The SVG XML namespace identifier. SVGs drawn as images need it. It is a fixed
 * name, not an address: nothing is ever fetched from it.
 */
export const SVG_NS = 'http://www.w3.org/2000/svg'

export const C = {
  bg: '#0F0E14',
  card: '#16141C',
  border: '#2A2733',
  borderSoft: '#24212D',
  text: '#EDEAF5',
  muted: '#A9A3B8',
  purple: '#8B5CF6',
  purpleDeep: '#6D28D9',
  purpleSoft: '#C4B5FD',
  amber: '#F59E0B',
  cyan: '#22D3EE',
  green: '#22C55E',
  pink: '#EC4899',
  red: '#EF4444',
  orange: '#F97316',
  grey: '#8A8499',
  blue: '#60A5FA',
} as const

/** Missing metrics are shown as a dash, never invented. */
export const DASH = '—'

export const fmtTokens = (n: number | null | undefined): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

export const fmtDuration = (ms: number | null | undefined): string => {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return DASH
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, '0')}m`
}

export const fmtClock = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`
}

export const fmtAgo = (ms: number | null | undefined): string => {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return DASH
  if (ms < 5000) return 'now'
  return `${fmtDuration(ms)} ago`
}

export const fmtRate = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? DASH : `${n >= 100 ? Math.round(n) : n.toFixed(1)} tok/s`

export const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0)

/** A terminal bar of block characters, `width` cells wide. */
export const blockBar = (fraction: number, width: number): string => {
  const w = Math.max(1, Math.floor(width))
  const cells = clamp01(fraction) * w
  const full = Math.floor(cells)
  const parts = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
  const rest = parts[Math.floor((cells - full) * 8)] ?? ''
  const used = full + (rest ? 1 : 0)
  return '█'.repeat(full) + rest + '░'.repeat(Math.max(0, w - used))
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** A rounded progress bar as SVG markup. */
export const svgBar = (fraction: number, color: string, width = 240, height = 8): string => {
  const w = Math.round(clamp01(fraction) * width)
  return (
    `<svg xmlns="${SVG_NS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" rx="${height / 2}" fill="${C.borderSoft}"/>` +
    (w > 0 ? `<rect width="${w}" height="${height}" rx="${height / 2}" fill="${color}"/>` : '') +
    `</svg>`
  )
}

/** A ring gauge with a label in the middle, as SVG markup. */
export const svgRing = (fraction: number, color: string, label: string, size = 64, stroke = 7): string => {
  const r = (size - stroke) / 2
  const circ = 2 * Math.PI * r
  const dash = (clamp01(fraction) * circ).toFixed(2)
  const c = size / 2
  return (
    `<svg xmlns="${SVG_NS}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${C.borderSoft}" stroke-width="${stroke}"/>` +
    `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" ` +
    `stroke-dasharray="${dash} ${circ.toFixed(2)}" transform="rotate(-90 ${c} ${c})"/>` +
    `<text x="${c}" y="${c + 4}" text-anchor="middle" font-family="JetBrains Mono, ui-monospace, monospace" font-size="${Math.round(size / 5)}" fill="${C.text}">${esc(label)}</text>` +
    `</svg>`
  )
}

/** Gauge colour for a used fraction: green, then amber, then red. */
export const levelColor = (pct: number, amberAt: number, redAt: number): string =>
  pct >= redAt ? C.red : pct >= amberAt ? C.amber : C.green

/** Words in a text, for thresholds. */
export const words = (text: string): string[] => text.trim().split(/\s+/).filter(w => w.length > 0)

export const truncate = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`)
