import type { Config } from "tailwindcss";

// Colour tokens are exposed as CSS variables containing a "R G B" triplet.
// The `rgb(var(--rgb-x) / <alpha-value>)` form lets Tailwind alpha modifiers
// (e.g. `bg-primary/20`) work naturally while the underlying palette swaps
// between light and dark via `[data-theme]` on <html>. See styles/theme.css
// for the actual values.
function token(name: string): string {
  return `rgb(var(--rgb-${name}) / <alpha-value>)`;
}

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  // We control dark/light entirely via the `data-theme` attribute set by
  // lib/theme.ts; Tailwind's class-strategy `dark:` variant therefore keys
  // off that attribute too.
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: token("bg"),
        "bg-1": token("bg-1"),
        "bg-2": token("bg-2"),
        border: token("border"),
        fg: token("fg"),
        "fg-brand": token("fg-brand"),
        "fg-mute": token("fg-mute"),
        "fg-dim": token("fg-dim"),
        dim: token("dim"),
        primary: token("primary"),
        warn: token("warn"),
        error: token("error"),
        "accent-2": token("accent-2"),
        "accent-3": token("accent-3"),
      },
      fontFamily: {
        // Aligned with website_v2 — editorial serif for displays, Inter
        // sans for body, JetBrains Mono for mono labels/eyebrows.
        display: ["'Fraunces'", "'Cormorant Garamond'", "ui-serif", "Georgia", "serif"],
        sans: ["'SN Pro'", "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["'JetBrains Mono'", "ui-monospace", "monospace"],
      },
      borderRadius: {
        DEFAULT: "4px",
        none: "0",
      },
    },
  },
  plugins: [],
} satisfies Config;
