// Viewer registry — picks the rich (non-Monaco) view for a given
// file extension. Two layout flavours :
//
//   * "alt"     full-pane replacement (CSV table, .ipynb notebook)
//   * "preview" split-pane next to Monaco (Markdown preview)
//
// Adding a new viewer : write the component, add a case below.
// Components receive `{ path, buffer }`; Monaco continues to own the
// buffer + save/dirty state, so toggling view modes is loss-less.

import { lazy, Suspense, type ComponentType } from "react";

const CsvTable = lazy(() => import("./CsvTable"));
const MarkdownPreview = lazy(() => import("./MarkdownPreview"));
const IpynbView = lazy(() => import("./IpynbView"));

export interface ViewerProps {
  path: string;
  buffer: string;
}

export interface ViewerDescriptor {
  kind: "alt" | "preview";
  /** Short label for the toggle button when the viewer is OFF
   *  (clicking enables it). */
  enableLabel: string;
  /** Short label when the viewer is ON (clicking flips back to source). */
  disableLabel: string;
  Component: ComponentType<ViewerProps>;
}

export function viewerFor(path: string | null): ViewerDescriptor | null {
  if (!path) return null;
  const l = path.toLowerCase();
  if (l.endsWith(".csv") || l.endsWith(".tsv")) {
    return {
      kind: "alt",
      enableLabel: "Table",
      disableLabel: "Source",
      Component: wrapLazy(CsvTable),
    };
  }
  if (l.endsWith(".md") || l.endsWith(".markdown")) {
    return {
      kind: "preview",
      enableLabel: "Preview",
      disableLabel: "Hide preview",
      Component: wrapLazy(MarkdownPreview),
    };
  }
  if (l.endsWith(".ipynb")) {
    return {
      kind: "alt",
      enableLabel: "Notebook",
      disableLabel: "Source",
      Component: wrapLazy(IpynbView),
    };
  }
  return null;
}

/** React.lazy needs a Suspense boundary; we use a tiny fallback so
 *  the viewer module's first load doesn't flash an empty pane. */
function wrapLazy(C: ComponentType<ViewerProps>): ComponentType<ViewerProps> {
  return function Lazy(props) {
    return (
      <Suspense
        fallback={
          <div className="p-4 text-xs text-fg-mute">Loading viewer…</div>
        }
      >
        <C {...props} />
      </Suspense>
    );
  };
}
