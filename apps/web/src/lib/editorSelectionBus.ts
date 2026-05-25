// "What's currently selected in the editor" cache. Single source so
// global shortcuts (Cmd-L "Send selection to AI") can read the
// active Monaco selection without the workspace shell having to
// thread a callback through every render.
//
// EditorPanel writes on every Monaco selection-change event; the
// value is `null` when there's no selection (just a caret).

export interface EditorSelection {
  text: string;
  /** Path the selection is from. */
  path: string;
  /** Monaco language id (python, r, markdown, ...). May be undefined
   *  for unknown extensions; callers should treat it as "unknown". */
  language: string | undefined;
}

let current: EditorSelection | null = null;

export function setEditorSelection(sel: EditorSelection | null): void {
  current = sel;
}

export function getEditorSelection(): EditorSelection | null {
  return current;
}
