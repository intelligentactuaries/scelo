import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { registerIATheme } from "./lib/echarts/theme";
import { initTheme } from "./lib/theme";

// Self-host every webfont so the app works fully offline inside the Scelo
// IDE desktop shell — no Google Fonts CDN at runtime.
//
// SN Pro is the IDE's one typeface: body, labels, headlines and figures
// (tailwind.config.ts maps sans / mono / display to it, and theme.css adds
// its arrows). Inter only backs up scripts SN Pro doesn't cover, such as
// Greek. JetBrains Mono is for the code editor and terminal alone, where
// columns must line up.

// SN Pro — 300-700 with italics.
import "@fontsource/sn-pro/300.css";
import "@fontsource/sn-pro/300-italic.css";
import "@fontsource/sn-pro/400.css";
import "@fontsource/sn-pro/400-italic.css";
import "@fontsource/sn-pro/500.css";
import "@fontsource/sn-pro/500-italic.css";
import "@fontsource/sn-pro/600.css";
import "@fontsource/sn-pro/600-italic.css";
import "@fontsource/sn-pro/700.css";
import "@fontsource/sn-pro/700-italic.css";

// Inter (fallback for scripts SN Pro lacks).
import "@fontsource/inter/300.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";

// JetBrains Mono (code editor + terminal only).
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";

import "./styles/theme.css";

initTheme();
registerIATheme();

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root in index.html");

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);

// The desktop launch intro (index.html) holds until the app has painted its
// first frame, fonts included, so its reveal never uncovers a half-drawn
// window. A no-op wherever the intro is not showing.
void document.fonts.ready.then(() =>
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      (window as Window & { __iaIntroReady?: () => void }).__iaIntroReady?.(),
    ),
  ),
);
