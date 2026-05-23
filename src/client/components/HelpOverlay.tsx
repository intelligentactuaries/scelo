type Props = {
  open: boolean;
  onClose: () => void;
};

const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: '⌘ ↵', label: 'run swarm (from anywhere)' },
  { keys: '⌘ K', label: 'toggle chatbot drawer' },
  { keys: '⌘ ,', label: 'toggle settings modal' },
  { keys: '⌘ /', label: 'show / hide this help' },
  { keys: 'esc', label: 'close drawer / modal / overlay' },
];

export function HelpOverlay({ open, onClose }: Props) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal help-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="panel-label">keyboard shortcuts</div>
          <button className="ghost-btn" onClick={onClose}>
            close
          </button>
        </div>
        <div className="modal-body">
          <table className="shortcuts-table">
            <tbody>
              {SHORTCUTS.map((s) => (
                <tr key={s.keys}>
                  <td className="shortcut-key">{s.keys}</td>
                  <td>{s.label}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted small">
            on linux/windows, substitute <code>ctrl</code> for <code>⌘</code>.
          </div>
        </div>
      </div>
    </div>
  );
}
