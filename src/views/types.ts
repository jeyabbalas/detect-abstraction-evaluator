import type { Analysis } from '../core/analysis';
import type { State, StateKey, Store, ViewName } from '../state';

export interface ViewContext {
  store: Store;
  analysis: Analysis;
  /** Navigate to a view (updates the URL hash). */
  navigate: (view: ViewName, path?: (string | number)[], query?: Record<string, string | undefined>) => void;
}

export interface ViewInstance {
  el: HTMLElement;
  /**
   * Called once after mounting (with every key in `changed`) and then whenever
   * state changes while the view is visible. Changes that happen while the view
   * is hidden are delivered together when it is shown again.
   */
  update(state: State, changed: Set<StateKey>): void;
  destroy?(): void;
}

export type ViewFactory = (ctx: ViewContext) => ViewInstance;
