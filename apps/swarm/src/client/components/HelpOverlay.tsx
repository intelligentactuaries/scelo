import { MOD_NAME } from '../lib/modKey';

type Props = {
  open: boolean;
  onClose: () => void;
};

const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: `${MOD_NAME} ↵`, label: 'run swarm (from anywhere)' },
  { keys: `${MOD_NAME} K`, label: 'toggle chatbot drawer' },
  { keys: `${MOD_NAME} ,`, label: 'toggle settings modal' },
  { keys: `${MOD_NAME} /`, label: 'show / hide this help' },
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
        </div>
      </div>
    </div>
  );
}
