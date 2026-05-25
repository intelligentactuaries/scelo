// Theme manager for the web workbench.
//
// Three states: "system" (follow OS), "light", "dark". The user's choice is
// persisted in localStorage; in "system" mode we mirror prefers-color-scheme
// and re-react when the OS toggles. The pre-paint script in index.html
// resolves the same logic before React mounts so there is no FOUC.
//
// Charts (ECharts) and any other theme-aware integrations subscribe via the
// `ia:theme-change` window event.

import { useCallback, useEffect, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "ia.theme";

export function getThemeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* storage unavailable */
  }
  return "system";
}

export function resolveTheme(choice: ThemeChoice = getThemeChoice()): ResolvedTheme {
  if (choice !== "system") return choice;
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function paint(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", resolved);
  root.classList.toggle("dark", resolved === "dark");
  root.classList.toggle("light", resolved === "light");
}

export function setThemeChoice(choice: ThemeChoice): void {
  try {
    if (choice === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    /* storage unavailable */
  }
  paint(resolveTheme(choice));
  window.dispatchEvent(new CustomEvent("ia:theme-change"));
}

export function initTheme(): void {
  if (typeof window === "undefined") return;
  paint(resolveTheme());
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => {
    if (getThemeChoice() === "system") {
      paint(resolveTheme());
      window.dispatchEvent(new CustomEvent("ia:theme-change"));
    }
  };
  if (typeof mq.addEventListener === "function") {
    mq.addEventListener("change", handler);
  } else {
    // biome-ignore lint/suspicious/noExplicitAny: legacy MediaQueryList API.
    (mq as any).addListener(handler);
  }
}

export function useTheme(): {
  choice: ThemeChoice;
  resolved: ResolvedTheme;
  setChoice: (c: ThemeChoice) => void;
  cycle: () => void;
} {
  const [choice, setChoiceState] = useState<ThemeChoice>(getThemeChoice);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme());

  useEffect(() => {
    const onChange = () => {
      setChoiceState(getThemeChoice());
      setResolved(resolveTheme());
    };
    window.addEventListener("ia:theme-change", onChange);
    return () => window.removeEventListener("ia:theme-change", onChange);
  }, []);

  const setChoice = useCallback((c: ThemeChoice) => {
    setThemeChoice(c);
  }, []);

  const cycle = useCallback(() => {
    const order: ThemeChoice[] = ["system", "light", "dark"];
    const i = order.indexOf(getThemeChoice());
    setThemeChoice(order[(i + 1) % order.length]);
  }, []);

  return { choice, resolved, setChoice, cycle };
}
