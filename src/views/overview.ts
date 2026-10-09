/**
 * Overview: every pipeline on the headline metrics — the page a researcher
 * screenshots for a paper. Leaderboard, metrics with bootstrap intervals,
 * error profile, cost vs. accuracy, pairwise differences, run configuration.
 */

import { getBootstrap } from '../core/analysis';
import type { BootstrapResult } from '../core/bootstrap';
import type { PopulationName } from '../core/types';
import { buildHash, type ViewName } from '../state';
import type { ChartCard } from '../ui/chart';
import { hideTooltip } from '../ui/components';
import { h } from '../ui/dom';
import { fmtInt, plural } from '../ui/format';
import { icon } from '../ui/icons';
import { ciCard, costCard, errorCard, pairCard, type ChartSnapshot } from './overview/charts';
import { afterPaint } from './overview/dom';
import { leaderboardCard, type BootView } from './overview/leaderboard';
import { availableCosts, buildSnapshot, type Snapshot } from './overview/model';
import { methodsSection, notesSection, runConfigSection } from './overview/sections';
import { scopeBar } from './shared';
import type { ViewFactory } from './types';

/** Returned when a bootstrap is skipped because the user moved on before it started. */
const SKIPPED = Symbol('skipped');

const createOverviewView: ViewFactory = (ctx) => {
  const { analysis, store } = ctx;
  const { experiment } = analysis;
  const { schema } = experiment;
  const P = analysis.pipelines.length;

  const initial = store.get();
  let latest: Snapshot = buildSnapshot(analysis, initial.source, initial.population);
  let chart: ChartSnapshot = { ...latest, boot: null, bootState: 'pending' };
  let chartsDrawn = false;
  let destroyed = false;
  const boots = new Map<PopulationName, BootstrapResult | null>();
  const inflight = new Map<PopulationName, Promise<BootstrapResult | null | typeof SKIPPED>>();
  const src = { latest: () => latest, chart: () => chart };

  // ---------------------------------------------------------------- head
  const nRecords = experiment.goldIds.length;
  const nUnique = experiment.uniqueIds.length;
  const summary = [
    plural(P, 'pipeline'),
    `${plural(nRecords, 'record')}${nUnique && nUnique < nRecords ? ` (${fmtInt(nUnique)} unique report texts)` : ''}`,
    `${plural(schema.categoricalFields.length, 'categorical variable')} scored`,
    schema.textFields.length ? `${plural(schema.textFields.length, 'free-text variable')} excluded` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const link = (label: string, view: ViewName, hint: string) =>
    h('a', { class: 'btn btn-sm btn-ghost', href: buildHash(view), title: hint }, label, icon('arrowRight'));

  // --------------------------------------------------------------- cards
  const bar = scopeBar(ctx);
  const leaderboard = leaderboardCard();
  const ci = ciCard(src);
  const errors = errorCard(src);
  const cost = costCard(src, availableCosts(latest.rows.map((r) => r.cost)));
  const pairs = P >= 2 ? pairCard(src) : null;
  const bootCards: ChartCard[] = [ci.card, cost.card, ...(pairs ? [pairs.card] : [])];
  const allCards: ChartCard[] = [...bootCards, errors.card];

  const el = h(
    'div',
    { class: 'page ov-page' },
    h(
      'div',
      { class: 'page-head' },
      h('div', null, h('h1', null, 'Pipeline comparison'), h('p', null, summary)),
      h(
        'nav',
        { class: 'ov-head-links', 'aria-label': 'Related views' },
        link('Where the errors are', 'fields', 'Categories and variables, ranked by errors'),
        link('Browse records', 'records', 'One report at a time, gold vs. pipelines'),
      ),
    ),
    bar.el,
    notesSection(analysis),
    leaderboard.el,
    ci.card.el,
    h('div', { class: 'grid-2 ov-row' }, errors.card.el, cost.card.el),
    pairs?.card.el ?? null,
    runConfigSection(analysis),
    methodsSection(analysis),
  );

  // -------------------------------------------------------------- redraw
  // chartCard replays a redraw requested while the view is hidden once it is shown.
  const redraw = (card: ChartCard) => card.redraw();

  function setLoading(on: boolean) {
    for (const card of bootCards) card.el.querySelector('.chart')?.classList.toggle('loading', on);
    ci.setBusy(on);
  }

  function bootView(): BootView {
    if (!boots.has(latest.population)) return { result: null, state: 'pending' };
    const result = boots.get(latest.population)!;
    return { result, state: result ? 'ready' : 'none' };
  }

  function drawBootCharts() {
    chartsDrawn = true;
    ci.sync();
    cost.sync();
    pairs?.sync();
    for (const card of bootCards) redraw(card);
  }

  function applyBoot(result: BootstrapResult | null) {
    chart = { ...latest, boot: result, bootState: result ? 'ready' : 'none' };
    setLoading(false);
    drawBootCharts();
    leaderboard.update(latest, bootView());
  }

  function requestBoot(population: PopulationName) {
    if (inflight.has(population)) return;
    const job = (async () => {
      await afterPaint(); // let the loading state paint before the (synchronous) resampling
      if (destroyed || latest.population !== population) return SKIPPED;
      try {
        return await getBootstrap(analysis, population);
      } catch (err) {
        console.error(err);
        return null;
      }
    })();
    inflight.set(population, job);
    void job.then((result) => {
      inflight.delete(population);
      if (destroyed) return;
      if (result === SKIPPED) {
        // The user came back to this population before it was computed.
        if (latest.population === population && !boots.has(population)) requestBoot(population);
        return;
      }
      boots.set(population, result);
      if (latest.population === population) applyBoot(result); // stale results stay cached only
    });
  }

  /** Pair the latest numbers with their intervals, or show progress while they compute. */
  function syncCharts(): boolean {
    const population = latest.population;
    if (boots.has(population)) {
      applyBoot(boots.get(population)!);
      return true;
    }
    let drawn = false;
    if (!chartsDrawn) {
      // First paint: points without whiskers and a "computing" note.
      chart = { ...latest, boot: null, bootState: 'pending' };
      drawBootCharts();
      drawn = true;
      ci.setBusy(true);
    } else {
      // Keep the previous render, dimmed, until the new intervals arrive.
      setLoading(true);
    }
    requestBoot(population);
    return drawn;
  }

  return {
    el,
    update(state, changed) {
      bar.update(state, changed);
      const dataChanged = changed.has('population') || changed.has('source') || changed.has('analysis');
      let bootDrawn = false;
      if (dataChanged) {
        latest = buildSnapshot(analysis, state.source, state.population);
        leaderboard.update(latest, bootView());
        errors.sync();
        redraw(errors.card);
        bootDrawn = syncCharts();
      }
      if (changed.has('mode')) {
        if (!dataChanged) redraw(errors.card);
        if (!bootDrawn) for (const card of bootCards) redraw(card);
      }
    },
    destroy() {
      destroyed = true;
      for (const card of allCards) card.destroy();
      hideTooltip();
    },
  };
};

export default createOverviewView;
