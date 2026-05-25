// Shared file-extension → Monaco language-id mapping. Used by the
// editor (to set the model language) and the status bar (to display
// the language mode). Kept narrow on purpose: we only return ids that
// Monaco's standalone bundle actually ships with, so callers can pass
// the result straight to `monaco.editor.setModelLanguage(...)`.

export function languageFor(path: string | null): string | undefined {
  if (!path) return undefined;
  const ext = path.toLowerCase().split(".").pop();
  switch (ext) {
    case "py":
      return "python";
    case "r":
      return "r";
    case "ipynb":
    case "json":
      return "json";
    case "md":
    case "markdown":
      return "markdown";
    case "yaml":
    case "yml":
      return "yaml";
    case "toml":
      return "ini"; // monaco doesn't ship toml; ini is the closest grammar
    case "sql":
      return "sql";
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "html":
      return "html";
    case "css":
      return "css";
    case "sh":
    case "bash":
      return "shell";
    default:
      return undefined;
  }
}
