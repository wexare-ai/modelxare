import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// weXare's typefaces, bundled so the app keeps its look offline.
import '@fontsource-variable/bricolage-grotesque/opsz.css';
import '@fontsource-variable/outfit/wght.css';
import '@fontsource/kalam/latin-400.css';
import '@fontsource/kalam/latin-700.css';
import '@fontsource/caveat-brush/latin-400.css';
import { App } from './App.tsx';
import './styles.css';

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('service worker registration failed', e));
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
