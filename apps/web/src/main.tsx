import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { registerIATheme } from "./lib/echarts/theme";
import { initTheme } from "./lib/theme";

// Self-host every webfont so the app works fully offline inside the Scelo
// IDE desktop shell — no Google Fonts CDN at runtime.
//
// SN Pro covers the proportional body + the JetBrains-Mono-named "mono"
// surfaces (theme.css points --mono back at --font). Fraunces is reserved
// for the display serif on the landing artefacts. Inter and JetBrains Mono
// are bundled in case other surfaces opt in.

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

// Fraunces (display serif used on the public-site headlines).
import "@fontsource/fraunces/400.css";
import "@fontsource/fraunces/500.css";
import "@fontsource/fraunces/600.css";

// Inter (sans body fallback).
import "@fontsource/inter/300.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";

// JetBrains Mono (eyebrow labels + code chips).
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
