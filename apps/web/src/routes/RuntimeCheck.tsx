// /runtime-check — Scelo IDE first-run stack validation screen.
//
// Renders the bundled-runtime status: Python interpreter present? Each IA
// package importable? Same for R. Outside the IDE (regular browser) the
// route is still reachable but renders a "not in Scelo IDE" notice.
//
// Designed so that an actuary downloading the IDE for the first time can,
// in one screen, verify that lifelib / chainladder / ChainLadder /
// climada / etc. all loaded cleanly — no terminal, no pip, no R prompt.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  isDesktopIDE,
  probeStack,
  type PackageProbe,
  type StackReport,
} from "../lib/sceloIDE";

type Status = "loading" | "ready" | "no-ide";

export default function RuntimeCheck() {
  const [status, setStatus] = useState<Status>("loading");
  const [report, setReport] = useState<StackReport | null>(null);

  useEffect(() => {
    if (!isDesktopIDE()) {
      setStatus("no-ide");
      return;
    }
    probeStack().then((r) => {
      setReport(r);
      setStatus("ready");
    });
  }, []);

  if (status === "no-ide") {
    return (
      <div className="mx-auto max-w-2xl p-8 font-sans text-fg">
        <h1 className="mb-2 text-xl font-medium">Runtime check</h1>
        <p className="text-fg-mute">
          This screen reports the status of the Python + R interpreters
          bundled with Scelo IDE. You're viewing the workbench in a regular
          browser, so there's nothing to check.
        </p>
        <Link
          to="/dashboards/scelo"
          className="mt-4 inline-block rounded border border-border bg-bg-2 px-3 py-1.5 text-sm hover:border-fg"
        >
          ← back to Scelo
        </Link>
      </div>
    );
  }

  if (status === "loading" || !report) {
    return (
      <div className="mx-auto max-w-2xl p-8 font-sans text-fg-mute">
        Probing bundled runtimes…
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl p-8 font-sans text-fg">
      <header className="mb-6">
        <div className="text-xs uppercase tracking-wider text-fg-mute">
          Scelo IDE · runtime check
        </div>
        <h1 className="text-2xl font-medium">Actuarial stack status</h1>
        <p className="mt-1 text-sm text-fg-mute">
          The bundled Python and R interpreters were probed for the
          packages Scelo's Tools delegate to.
        </p>
      </header>

      <StackSection
        title="Python"
        available={report.python.available}
        packages={report.python.packages}
        stderr={report.python.stderr}
      />
      <div className="h-6" />
      <StackSection
        title="R"
        available={report.r.available}
        packages={report.r.packages}
        stderr={report.r.stderr}
      />

      <div className="mt-8 flex gap-2">
        <Link
          to="/dashboards/scelo"
          className="rounded border border-fg bg-fg px-4 py-1.5 text-sm text-bg hover:opacity-90"
        >
          → open Scelo
        </Link>
        <button
          type="button"
          onClick={() => {
            setStatus("loading");
            probeStack().then((r) => {
              setReport(r);
              setStatus("ready");
            });
          }}
          className="rounded border border-border bg-bg-2 px-4 py-1.5 text-sm text-fg hover:border-fg"
        >
          re-probe
        </button>
      </div>
    </div>
  );
}

function StackSection({
  title,
  available,
  packages,
  stderr,
}: {
  title: string;
  available: boolean;
  packages: PackageProbe[] | null;
  stderr: string;
}) {
  return (
    <section className="rounded-md border border-border bg-bg-2 p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-medium uppercase tracking-wider">{title}</h2>
        <span
          className={`text-xs ${
            available ? "text-consensus" : "text-adversarial"
          }`}
        >
          {available ? "interpreter ok" : "interpreter missing"}
        </span>
      </div>
      {!available && (
        <p className="text-xs text-fg-mute">
          The {title} interpreter is not bundled with this Scelo IDE build.
          Tools that depend on it will fall back to the TypeScript port (or
          fail loudly). See <code>apps/scelo-ide/scripts/bundle-runtimes.sh</code>.
        </p>
      )}
      {packages && packages.length > 0 && (
        <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          {packages.map((p) => (
            <li key={p.pkg} className="flex items-baseline gap-2">
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${
                  p.ok ? "bg-consensus" : "bg-adversarial"
                }`}
                aria-hidden="true"
              />
              <span className="font-mono text-xs">{p.pkg}</span>
              {p.ok ? (
                <span className="text-xs text-fg-mute">{p.version ?? "?"}</span>
              ) : (
                <span className="text-xs text-adversarial">missing</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {stderr.trim() && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-fg-mute">stderr</summary>
          <pre className="mt-2 max-h-40 overflow-auto rounded bg-bg p-2 text-[10px] text-fg-mute">
            {stderr}
          </pre>
        </details>
      )}
    </section>
  );
}
