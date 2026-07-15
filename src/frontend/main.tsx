/**
 * This file is the entry point for the React app, it sets up the root
 * element and renders the App component to the DOM.
 *
 * It is included in `src/index.html`.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { registerServiceWorker } from "./register-sw";

// Keeps the tab alive (offline fallback + auto-reconnect) across the
// supervisor's stop/start release handoff. See sw.js for details.
registerServiceWorker();

const elem = document.getElementById("root")!;
const app = (
  <StrictMode>
    <App />
  </StrictMode>
);

// https://bun.com/docs/bundler/hot-reloading#import-meta-hot-data
// import.meta.hot only exists when running with `bun --hot` (the `dev`
// script). `bun start` has no --hot flag, so this must not assume it's
// there - referencing it unconditionally throws before the root ever
// mounts, which is what a blank white screen under `bun start` looks like.
if (import.meta.hot) {
  (import.meta.hot.data.root ??= createRoot(elem)).render(app);
} else {
  createRoot(elem).render(app);
}
