// Tests sidebar tab. MVP : list pytest + testthat tests in the
// active workspace + let the user run them via the long-lived
// terminal. We do NOT track per-test status (passed / failed)
// here : the terminal output is the source of truth, and the
// user is going to read it anyway.
//
// Discovery runs once on mount + on click of "rescan." Running a
// test composes the right invocation and pushes it onto the
// terminalBus (same plumbing as Run: Current File / F5).

import { useEffect, useState } from "react";
import {
  isDesktopIDE,
  type DiscoveredTest,
  type DiscoverTestsResult,
} from "../../lib/sceloIDE";
import { enqueueTerminalCommand, shellQuote } from "../../lib/terminalBus";
import { emitToast } from "../../lib/toastBus";

interface Props {
  workspacePath: string | null;
}

export default function TestsPanel({ workspacePath }: Props) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DiscoverTestsResult | null>(null);

  const discover = async () => {
    if (!isDesktopIDE() || !workspacePath) return;
    setBusy(true);
    const r = await window.scelo!.tests.discover();
    setResult(r);
    setBusy(false);
  };

  useEffect(() => {
    if (workspacePath) void discover();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath]);

  if (!isDesktopIDE()) {
    return (
      <div className="p-3 text-xs text-fg-mute">
        Tests are only available inside Scelo IDE.
      </div>
    );
  }
  if (!workspacePath) {
    return (
      <div className="p-3 text-xs text-fg-mute">
        Open a workspace to discover its tests.
      </div>
    );
  }

  const tests = result?.tests ?? [];
  const pytest = tests.filter((t) => t.framework === "pytest");
  const testthat = tests.filter((t) => t.framework === "testthat");

  return (
    <div className="flex h-full flex-col bg-bg-2 text-fg">
      <div className="flex items-baseline justify-between border-b border-border px-3 py-1">
        <span className="text-[10px] uppercase tracking-wider text-fg-mute">
          tests
        </span>
        <button
          type="button"
          onClick={() => void discover()}
          disabled={busy}
          className="text-[10px] text-fg-mute hover:text-fg disabled:opacity-50"
        >
          {busy ? "discovering…" : "rescan"}
        </button>
      </div>

      <div className="flex-1 overflow-auto px-3 py-2 text-xs">
        {result?.errors?.map((e, i) => (
          <p key={i} className="mb-2 text-[10px] text-fg-mute">
            {e.framework}: {e.message}
          </p>
        ))}

        <Section
          title="pytest"
          tests={pytest}
          onRunAll={() => runAllPytest()}
          onRunOne={(t) => runOnePytest(t)}
          onRunFile={(file) => runPytestFile(file)}
        />
        <Section
          title="testthat"
          tests={testthat}
          onRunAll={() => runAllTestthat()}
          onRunOne={(t) => runOneTestthat(t)}
          onRunFile={(file) => runOneTestthat({ id: file, file, framework: "testthat" })}
        />
        {pytest.length === 0 && testthat.length === 0 && !busy && (
          <p className="text-[11px] text-fg-mute">
            No tests discovered. pytest looks for tests/ + conftest.py /
            pyproject.toml; testthat looks for tests/testthat/test-*.R.
          </p>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  tests,
  onRunAll,
  onRunOne,
  onRunFile,
}: {
  title: string;
  tests: DiscoveredTest[];
  onRunAll: () => void;
  onRunOne: (t: DiscoveredTest) => void;
  onRunFile: (file: string) => void;
}) {
  if (tests.length === 0) return null;
  const byFile = new Map<string, DiscoveredTest[]>();
  for (const t of tests) {
    const arr = byFile.get(t.file) ?? [];
    arr.push(t);
    byFile.set(t.file, arr);
  }
  return (
    <div className="mb-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wider text-fg-mute">
          {title} <span className="ml-1 text-fg-dim">({tests.length})</span>
        </span>
        <button
          type="button"
          onClick={onRunAll}
          className="text-[10px] text-fg-mute hover:text-fg"
        >
          run all
        </button>
      </div>
      <ul className="m-0 mt-1 list-none p-0">
        {Array.from(byFile, ([file, ts]) => (
          <li key={file} className="mb-1">
            <button
              type="button"
              onClick={() => onRunFile(file)}
              className="flex w-full items-baseline justify-between gap-2 rounded px-1 py-0.5 text-left font-mono text-[11px] text-fg hover:bg-bg"
              title={`Run all ${title} tests in ${file}`}
            >
              <span className="truncate">{file}</span>
              <span className="text-[10px] text-fg-mute">({ts.length})</span>
            </button>
            <ul className="m-0 list-none p-0">
              {ts.map((t) => (
                <li
                  key={t.id}
                  className="flex items-baseline justify-between gap-2 pl-3"
                >
                  <button
                    type="button"
                    onClick={() => onRunOne(t)}
                    className="min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left font-mono text-[10px] text-fg-mute hover:bg-bg hover:text-fg"
                    title={`Run ${t.id}`}
                  >
                    {/* For pytest the id is `file::test_name`; strip the file
                        prefix here so the per-test row stays scannable. */}
                    {t.id.startsWith(`${t.file}::`)
                      ? t.id.slice(t.file.length + 2)
                      : t.id}
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

function runAllPytest(): void {
  enqueueTerminalCommand("pytest");
  emitToast("Pytest queued in the terminal.", "info");
}

function runPytestFile(file: string): void {
  enqueueTerminalCommand(`pytest ${shellQuote(file)}`);
}

function runOnePytest(t: DiscoveredTest): void {
  enqueueTerminalCommand(`pytest ${shellQuote(t.id)}`);
}

function runAllTestthat(): void {
  enqueueTerminalCommand(`Rscript -e ${shellQuote("testthat::test_dir('tests/testthat')")}`);
  emitToast("testthat queued in the terminal.", "info");
}

function runOneTestthat(t: DiscoveredTest): void {
  enqueueTerminalCommand(
    `Rscript -e ${shellQuote(`testthat::test_file('${t.id}')`)}`,
  );
}
