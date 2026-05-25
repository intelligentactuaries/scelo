import { useEffect, useState } from "react";

const COMMANDS = [
  { name: "/agent", desc: "pin to a specialist" },
  { name: "/run", desc: "run a scenario" },
  { name: "/explain", desc: "explain last output" },
  { name: "/cite", desc: "show citations" },
  { name: "/chart", desc: "render a saved chart" },
  { name: "/export", desc: "export the session" },
  { name: "/regulatory", desc: "force-route to regulatory" },
  { name: "/help", desc: "show this list" },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (!open) return null;

  const filtered = COMMANDS.filter((c) => c.name.includes(query));

  return (
    <div
      aria-label="Command palette"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-32"
    >
      <button
        type="button"
        aria-label="close palette"
        className="absolute inset-0 cursor-default"
        onClick={() => setOpen(false)}
      />
      <div className="relative w-[480px] panel">
        <input
          ref={(el) => el?.focus()}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="type a command…"
          className="w-full bg-bg-2 px-3 py-2 text-sm outline-none placeholder:text-fg-dim"
        />
        <ul className="max-h-72 overflow-auto">
          {filtered.map((c) => (
            <li
              key={c.name}
              className="flex items-center justify-between px-3 py-1 text-sm hover:bg-bg-2"
            >
              <span className="text-primary">{c.name}</span>
              <span className="text-fg-mute">{c.desc}</span>
            </li>
          ))}
          {filtered.length === 0 && <li className="px-3 py-2 text-sm text-fg-dim">no matches</li>}
        </ul>
      </div>
    </div>
  );
}
