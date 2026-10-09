/** Application state, hash routing and theme preference. */

import type { Analysis, MetricSource } from './core/analysis';
import type { PopulationName } from './core/types';
import { currentMode, type Mode } from './ui/palette';

export type ViewName = 'overview' | 'fields' | 'records' | 'data' | 'dictionary';
export const VIEWS: readonly ViewName[] = ['overview', 'fields', 'records', 'data', 'dictionary'];
export type ThemePref = 'auto' | 'light' | 'dark';

export interface Route {
  view: ViewName;
  /** Path segments after the view, e.g. ['17'] for #/records/17. */
  path: string[];
  query: URLSearchParams;
}

export interface State {
  analysis: Analysis | null;
  population: PopulationName;
  source: MetricSource;
  theme: ThemePref;
  /** Resolved color mode (theme preference + OS setting). */
  mode: Mode;
  route: Route;
}

export type StateKey = keyof State;
export type Listener = (state: State, changed: Set<StateKey>) => void;

export class Store {
  private state: State;
  private listeners = new Set<Listener>();

  constructor(initial: State) {
    this.state = initial;
  }

  get(): State {
    return this.state;
  }

  set(patch: Partial<State>): void {
    const changed = new Set<StateKey>();
    for (const [k, v] of Object.entries(patch) as [StateKey, unknown][]) {
      if (this.state[k] !== v) changed.add(k);
    }
    if (!changed.size) return;
    this.state = { ...this.state, ...patch };
    for (const fn of [...this.listeners]) fn(this.state, changed);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const [pathPart = '', queryPart = ''] = raw.split('?');
  const segs = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  const view = (VIEWS as readonly string[]).includes(segs[0] ?? '') ? (segs[0] as ViewName) : 'overview';
  return { view, path: segs.slice(1), query: new URLSearchParams(queryPart) };
}

export function buildHash(view: ViewName, path: (string | number)[] = [], query: Record<string, string | undefined> = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') q.set(k, v);
  const qs = q.toString();
  return `#/${[view, ...path.map((p) => encodeURIComponent(String(p)))].join('/')}${qs ? `?${qs}` : ''}`;
}

const THEME_KEY = 'abstraction-evaluator:theme';

export function loadThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark' || v === 'auto') return v;
  } catch {
    /* storage unavailable */
  }
  return 'auto';
}

export function applyTheme(pref: ThemePref): Mode {
  if (pref === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = pref;
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* storage unavailable */
  }
  return currentMode();
}
