import { h } from '../ui/dom';
import type { ViewFactory } from './types';

/** Placeholder — implemented separately. */
const createFieldsView: ViewFactory = () => {
  const el = h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('h1', null, 'Fields')));
  return { el, update() {} };
};

export default createFieldsView;
