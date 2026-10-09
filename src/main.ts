import '@jeyabbalas/data-table/styles';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/landing.css';
import './styles/views.css';
import { mountApp } from './app';
import { applyTheme, loadThemePref, parseHash, Store } from './state';

const theme = loadThemePref();
const store = new Store({
  analysis: null,
  population: 'unique',
  source: 'reported',
  theme,
  mode: applyTheme(theme),
  route: parseHash(location.hash),
});

mountApp(document.getElementById('app')!, store);
