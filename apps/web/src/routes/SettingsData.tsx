// /settings/data — opt-in reference-data downloads for Scelo IDE.
//
// Registry is owned by main (apps/scelo-ide/src/main.ts DATASETS). This
// page lists every entry, shows current status (downloaded? size?), and
// drives the streaming download / cancel cycle. Each Scelo Tool checks
// whether its dataset is present and switches from the synthetic
// substitute to the canonical pipeline accordingly.

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  isDesktopIDE,
  type DatasetProgress,
  type DatasetSpec,
  type DatasetStatus,
} from "../lib/sceloIDE";
import { emitToast } from "../lib/toastBus";

export default function SettingsData() {
  const [specs, setSpecs] = useState<DatasetSpec[]>([]);
  const [status, setStatus] = useState<Record<string, DatasetStatus>>({});
  const [progress, setProgress] = useState<Record<string, DatasetProgress>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());
  // Per-dataset download start timestamps so the completion toast can
  // report elapsed wall-clock. Cleared when the download settles.
  // Indexed by dataset id; the IPC carries the same id back through
  // every progress event so we can attribute events correctly even when
  // two downloads overlap.
  const startTimesRef = useRef<Record<string, number>>({});
  // Mirror `specs` into a ref so the IPC subscription (registered once
  // on mount) can read the latest spec list without a stale closure.
  const specsRef = useRef<DatasetSpec[]>([]);
  useEffect(() => {
    specsRef.current = specs;
  }, [specs]);

  const reload = useCallback(async () => {
    if (!isDesktopIDE()) return;
    const r = await window.scelo!.data.list();
    setSpecs(r.datasets);
    const next: Record<string, DatasetStatus> = {};
    await Promise.all(
      r.datasets.map(async (d) => {
        next[d.id] = await window.scelo!.data.status(d.id);
      }),
    );
    setStatus(next);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!isDesktopIDE()) return;
    const off = window.scelo!.data.onProgress((p) => {
      setProgress((cur) => ({ ...cur, [p.id]: p }));
      if (p.done || p.error) {
        setBusy((cur) => {
          const next = new Set(cur);
          next.delete(p.id);
          return next;
        });
        reload();
        // Mirror progress terminal events into the global toast tray so
        // the user gets a notice even after they've navigated away from
        // /settings/data while a long download finishes.
        const labelOf = (id: string) =>
          specsRef.current.find((d) => d.id === id)?.label.split(" · ")[0] ?? id;
        if (p.done) {
          const started = startTimesRef.current[p.id];
          delete startTimesRef.current[p.id];
          const bytesText = formatBytes(p.receivedBytes);
          const elapsedText = started ? formatElapsed(Date.now() - started) : null;
          emitToast(
            `${labelOf(p.id)} downloaded · ${bytesText}${elapsedText ? ` in ${elapsedText}` : ""}.`,
            "success",
          );
        } else if (p.error && p.error !== "cancelled") {
          delete startTimesRef.current[p.id];
          emitToast(`${labelOf(p.id)}: ${p.error}`, "error");
        } else if (p.error === "cancelled") {
          delete startTimesRef.current[p.id];
        }
      }
    });
    return off;
  }, [reload]);

  if (!isDesktopIDE()) {
    return (
      <div className="mx-auto max-w-3xl p-8 font-sans text-fg">
        <h1 className="mb-2 text-xl font-medium">Data downloads</h1>
        <p className="text-fg-mute">Only meaningful inside Scelo IDE.</p>
        <Link
          to="/"
          className="ia-btn ia-btn-md ia-btn-secondary mt-4"
        >
          ← back
        </Link>
      </div>
    );
  }

  const onDownload = async (id: string) => {
    setBusy((cur) => new Set(cur).add(id));
    setProgress((cur) => ({ ...cur, [id]: { id, receivedBytes: 0, totalBytes: 0 } }));
    startTimesRef.current[id] = Date.now();
    await window.scelo!.data.download(id);
  };
  const onCancel = async (id: string) => {
    await window.scelo!.data.cancel(id);
    setBusy((cur) => {
      const next = new Set(cur);
      next.delete(id);
      return next;
    });
  };
  const onPurge = async (id: string) => {
    if (
      !window.confirm(
        "Delete the downloaded file (and any extracted artefacts under the cache dir)? This cannot be undone.",
      )
    ) {
      return;
    }
    const r = await window.scelo!.data.purge(id);
    const label = specsRef.current.find((d) => d.id === id)?.label.split(" · ")[0] ?? id;
    if (r.ok) {
      const freed = formatBytes(r.removedBytes ?? 0);
      emitToast(`${label} purged. Freed ${freed}.`, "success");
    } else {
      emitToast(`${label} purge failed: ${r.error ?? "unknown"}`, "error");
    }
    setProgress((cur) => {
      const next = { ...cur };
      delete next[id];
      return next;
    });
    await reload();
  };

  return (
    <div className="mx-auto max-w-3xl p-8 font-sans text-fg">
      <header className="mb-6">
        <div className="text-xs uppercase tracking-wider text-fg-mute">
          settings · data
        </div>
        <h1 className="text-2xl font-medium">Reference datasets</h1>
        <p className="mt-1 text-sm text-fg-mute">
          Optional datasets that, once downloaded, are used by Scelo's
          Tools instead of synthetic substitutes.
        </p>
      </header>

      <ul className="flex flex-col gap-3">
        {specs.map((d) => {
          const st = status[d.id];
          const pr = progress[d.id];
          const isBusy = busy.has(d.id);
          return (
            <li key={d.id} className="rounded-md border border-border bg-bg-2 p-4">
              <div className="mb-2 flex items-baseline justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">{d.label}</div>
                  <div className="text-xs text-fg-mute">
                    {formatBytes(d.approxBytes)} · used by {d.usedBy}
                  </div>
                  <div className="mt-1 text-xs text-fg-mute">{d.blurb}</div>
                </div>
                <span
                  className={`whitespace-nowrap text-xs ${
                    st?.available
                      ? "text-consensus"
                      : st && st.partialBytes > 0
                        ? "text-dissent"
                        : "text-fg-mute"
                  }`}
                >
                  {st?.available
                    ? `installed · ${formatBytes(st.sizeBytes)}`
                    : st && st.partialBytes > 0
                      ? `resumable · ${formatBytes(st.partialBytes)} on disk`
                      : "not installed"}
                </span>
              </div>

              {pr && !pr.done && !pr.error && (
                <div className="mb-2">
                  <div className="mb-1 text-[10px] text-fg-mute">
                    {formatBytes(pr.receivedBytes)}
                    {pr.totalBytes > 0
                      ? ` of ${formatBytes(pr.totalBytes)} (${(
                          (pr.receivedBytes / pr.totalBytes) *
                          100
                        ).toFixed(1)}%)`
                      : " (size unknown)"}
                  </div>
                  <div className="h-1.5 overflow-hidden rounded bg-bg">
                    <div
                      className="h-full bg-primary transition-all"
                      style={{
                        width:
                          pr.totalBytes > 0
                            ? `${(pr.receivedBytes / pr.totalBytes) * 100}%`
                            : "10%",
                      }}
                    />
                  </div>
                </div>
              )}
              {pr?.error && (
                <div className="mb-2 rounded border border-adversarial/40 bg-adversarial/10 px-2 py-1 text-[11px] text-adversarial">
                  error: {pr.error}
                </div>
              )}

              <div className="flex items-center gap-2">
                {!isBusy && !st?.available && (
                  <button
                    type="button"
                    onClick={() => onDownload(d.id)}
                    className="ia-btn ia-btn-md ia-btn-primary"
                  >
                    {st && st.partialBytes > 0
                      ? `▶ resume (${formatBytes(st.partialBytes)} done)`
                      : `▶ download (~${formatBytes(d.approxBytes)})`}
                  </button>
                )}
                {isBusy && (
                  <button
                    type="button"
                    onClick={() => onCancel(d.id)}
                    className="ia-btn ia-btn-md ia-btn-danger"
                  >
                    cancel
                  </button>
                )}
                {st?.available && !isBusy && (
                  <>
                    <button
                      type="button"
                      onClick={() => onDownload(d.id)}
                      className="ia-btn ia-btn-md ia-btn-secondary"
                    >
                      re-download
                    </button>
                    <button
                      type="button"
                      onClick={() => onPurge(d.id)}
                      className="ia-btn ia-btn-md ia-btn-danger"
                      title="delete the downloaded file + any extracted artefacts"
                    >
                      purge
                    </button>
                  </>
                )}
                {!st?.available && st && st.partialBytes > 0 && !isBusy && (
                  <button
                    type="button"
                    onClick={() => onPurge(d.id)}
                    className="ia-btn ia-btn-md ia-btn-danger"
                    title="discard the resumable partial download"
                  >
                    discard partial
                  </button>
                )}
                <a
                  href={d.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[10px] text-fg-mute hover:text-fg"
                >
                  source ↗
                </a>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="mt-8 flex gap-2">
        <Link
          to="/"
          className="ia-btn ia-btn-md ia-btn-secondary"
        >
          ← back to chat
        </Link>
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** Render an elapsed millis count into a human "Xm Ys" / "Ys" / "Yms"
 *  string. Short downloads (sub-second) show ms so the user can still
 *  tell the toast wasn't stuck. */
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}
