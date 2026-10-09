/** The data dictionary, rendered from the JSON Schema by json-schema-data-dictionary. */

import { renderDataDictionary } from 'json-schema-data-dictionary';
import { badge, downloadText, withTooltip } from '../ui/components';
import { h, render } from '../ui/dom';
import { fmtInt } from '../ui/format';
import { icon } from '../ui/icons';
import type { ViewFactory } from './types';

const createDictionaryView: ViewFactory = ({ analysis }) => {
  const { schema } = analysis.experiment;
  const host = h('div', { class: 'dictionary-host' });
  const rules = schema.dictionary.conditionalRules.length;
  // The dataset-level description is long; it lives in a disclosure above the table.
  const table = { ...schema.dictionary, title: undefined, description: undefined, comment: undefined };
  const about = [schema.dictionary.description, schema.dictionary.comment].filter(Boolean).join('\n\n');

  const downloadBtn = h(
    'button',
    { type: 'button', class: 'btn btn-sm', title: `Download ${schema.rootName}` },
    icon('download'),
    'Schema',
  );
  downloadBtn.addEventListener('click', () => downloadText(JSON.stringify(schema.root, null, 2), schema.rootName, 'application/json'));

  const el = h(
    'div',
    { class: 'page dictionary-page' },
    h(
      'div',
      { class: 'page-head' },
      h('div', null, h('h1', null, 'Data dictionary'), h('p', null, schema.title, ' — ', h('code', null, schema.rootName))),
      h(
        'div',
        { class: 'dictionary-meta' },
        badge(`${fmtInt(schema.fields.length)} variables`, 'outline'),
        withTooltip(badge(`${fmtInt(schema.categoricalFields.length)} categorical`, 'outline'), 'Scored in the headline metrics.'),
        withTooltip(
          badge(`${fmtInt(schema.textFields.length)} free text`, 'outline'),
          'Free-text variables (names ending in _text) are excluded from the headline metrics and reported as diagnostics only.',
        ),
        rules
          ? withTooltip(badge(`${fmtInt(rules)} cross-field rules`, 'outline'), 'Conditional (if/then) rules the schema enforces; predictions are validated against them.')
          : null,
        downloadBtn,
      ),
    ),
    about
      ? h(
          'details',
          { class: 'disclosure dictionary-about' },
          h('summary', null, icon('chevronRight'), 'About this dictionary'),
          h('div', { class: 'dictionary-about-body' }, about),
        )
      : null,
    host,
  );

  let renderedMode: string | null = null;
  return {
    el,
    update(state, changed) {
      if (!changed.has('mode') && renderedMode) return;
      renderedMode = state.mode;
      render(host);
      renderDataDictionary(host, table, {
        theme: state.mode,
        expandCategories: true,
        searchPlaceholder: 'Search variables, descriptions and values…  (press / to focus)',
      });
    },
  };
};

export default createDictionaryView;
