import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initTheme } from './lib/theme';
// SN Pro, self-hosted like the IDE's renderer so the council screen keeps
// its typeface offline. styles.css adds SN Pro's arrows.
import '@fontsource/sn-pro/300.css';
import '@fontsource/sn-pro/400.css';
import '@fontsource/sn-pro/500.css';
import '@fontsource/sn-pro/600.css';
import '@fontsource/sn-pro/700.css';
import 'katex/dist/katex.min.css';
import './styles.css';

// Resolve and paint the theme before React renders so the cream / charcoal
// background is correct on first paint and there's no light→dark flash.
initTheme();

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
