import { h } from '../ui/dom';
import type { ViewFactory } from './types';

/** Placeholder — implemented separately. */
const createDataView: ViewFactory = () => {
  const el = h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('h1', null, 'Data')));
  return { el, update() {} };
};

export default createDataView;
