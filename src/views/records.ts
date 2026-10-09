import { h } from '../ui/dom';
import type { ViewFactory } from './types';

/** Placeholder — implemented separately. */
const createRecordsView: ViewFactory = () => {
  const el = h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('h1', null, 'Records')));
  return { el, update() {} };
};

export default createRecordsView;
