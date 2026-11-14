// The home page's own entry (`<base>/`, the world list): index.html's loader (phased-entry.ts) runs this instead of
// main.tsx there, so a visit to the list downloads React, the list and its sign-in, never the world engine, the Shell or
// the early world layer. Its style is main.css, the stylesheet index.html already links in <head> (so it is in before
// the first paint); this entry imports no CSS of its own.
import './client-errors.ts';   // lane ERR: first, so errors from here on are reported
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BASE } from './base-path.ts';
import { countPage } from './visitor-counts.ts';
import { WorldList } from './launcher-page.tsx';

countPage(BASE);  // lane t4-analytics: GoatCounter (visitor-counts.ts), off locally and under automation
createRoot(document.getElementById('root')!).render(<StrictMode><WorldList /></StrictMode>);
