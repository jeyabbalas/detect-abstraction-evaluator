/**
 * Chart colors as concrete hex values (Plot cannot interpolate CSS variables).
 * Values mirror tokens.css. The categorical slots were validated with the
 * dataviz palette checker in both modes (adjacent CVD ΔE ≥ 8, normal-vision
 * ΔE ≥ 15); light-mode slots 3–5 are below 3:1 contrast, so every chart that
 * uses them also carries direct labels or a table view.
 */

export type Mode = 'light' | 'dark';

export function currentMode(): Mode {
  const forced = document.documentElement.dataset.theme;
  if (forced === 'light' || forced === 'dark') return forced;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const SERIES: Record<Mode, readonly string[]> = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};

/** Neutral used past the eighth series (never a generated hue). */
const OVERFLOW: Record<Mode, string> = { light: '#898781', dark: '#898781' };

/** Pipeline identity color — follows the pipeline's fixed slot, never its rank. */
export function seriesColor(index: number, mode: Mode = currentMode()): string {
  return SERIES[mode][index] ?? OVERFLOW[mode];
}

/**
 * Theme-aware CSS color for a pipeline's identity in HTML (swatches, chips):
 * follows light/dark switches without re-rendering. Use `seriesColor` in Plot.
 */
export function seriesVar(index: number): string {
  return index >= 0 && index < 8 ? `var(--series-${index + 1})` : 'var(--ink-muted)';
}

export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
} as const;

export interface Chrome {
  surface: string;
  page: string;
  ink: string;
  ink2: string;
  ink3: string;
  muted: string;
  grid: string;
  axis: string;
  mark: string;
}

const CHROME: Record<Mode, Chrome> = {
  light: {
    surface: '#fcfcfb',
    page: '#f6f6f3',
    ink: '#0b0b0b',
    ink2: '#52514e',
    ink3: '#6f6e69',
    muted: '#898781',
    grid: '#e1e0d9',
    axis: '#c3c2b7',
    mark: '#fde3a7',
  },
  dark: {
    surface: '#1a1a19',
    page: '#0d0d0d',
    ink: '#ffffff',
    ink2: '#c3c2b7',
    ink3: '#a3a29a',
    muted: '#898781',
    grid: '#2c2c2a',
    axis: '#383835',
    mark: '#5c4a1e',
  },
};

export function chrome(mode: Mode = currentMode()): Chrome {
  return CHROME[mode];
}

/**
 * Single-hue (red) ordinal ramp for error counts, darkest = most errors on
 * light, brightest = most errors on dark. Validated with `--ordinal`: monotone
 * lightness, adjacent ΔL ≥ 0.06, first step ≥ 2:1 against the surface.
 */
const ERROR_RAMP: Record<Mode, readonly string[]> = {
  light: ['#f7857d', '#e8605b', '#cf4040', '#b02a2d', '#8d1a1e'],
  dark: ['#8c2d2b', '#af3433', '#cb4644', '#e3645e', '#f28881'],
};

export function errorRamp(mode: Mode = currentMode()): readonly string[] {
  return ERROR_RAMP[mode];
}

/** Fill for an error count (0 → none), binned onto the ordinal ramp. */
export function errorFill(count: number, max: number, mode: Mode = currentMode()): string | null {
  if (!count) return null;
  const ramp = ERROR_RAMP[mode];
  if (max <= ramp.length) return ramp[Math.min(ramp.length - 1, count - 1)]!;
  const t = (count - 1) / Math.max(1, max - 1);
  return ramp[Math.min(ramp.length - 1, Math.round(t * (ramp.length - 1)))]!;
}

/** Sequential blue ramp (light → dark on light mode; anchors flip on dark). */
const BLUE: Record<Mode, readonly string[]> = {
  light: ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'],
  dark: ['#104281', '#184f95', '#1c5cab', '#2a78d6', '#5598e7', '#86b6ef', '#b7d3f6'],
};

export function blueRamp(mode: Mode = currentMode()): readonly string[] {
  return BLUE[mode];
}

/** Text color (ink or white) that clears contrast on a filled cell. */
export function inkOn(fill: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(fill);
  if (!m) return '#0b0b0b';
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => {
    const c = Number.parseInt(x!, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const L = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  return L > 0.36 ? '#0b0b0b' : '#ffffff';
}
