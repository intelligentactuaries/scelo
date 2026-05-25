import { DONE_WORDS, PROCESSING_WORDS, ROTATION_MS } from "@/lib/uiIndicators";
import { useEffect, useMemo, useState } from "react";

type Mode = "processing" | "done";

export function StatusPip({ mode }: { mode: Mode }) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (mode !== "processing") return;
    const id = window.setInterval(() => {
      setIndex((i) => (i + 1) % PROCESSING_WORDS.length);
    }, ROTATION_MS);
    return () => window.clearInterval(id);
  }, [mode]);

  const doneWord = useMemo(() => DONE_WORDS[Math.floor(Math.random() * DONE_WORDS.length)], []);

  const word = mode === "processing" ? PROCESSING_WORDS[index] : doneWord;
  const suffix = mode === "processing" ? "…" : "";

  return (
    <div className="flex items-center gap-2 font-mono text-fg-dim text-xs italic">
      <span aria-hidden className={mode === "processing" ? "ia-pip ia-pip-pulse" : "ia-pip"} />
      <span>
        {word}
        {suffix}
      </span>
    </div>
  );
}
