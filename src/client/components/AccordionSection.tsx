import { useEffect, useState, type ReactNode } from 'react';

type Props = {
  title: string;
  /** unique key for localStorage so each section remembers its state across reloads */
  storageKey: string;
  /** default expanded state when no stored value exists */
  defaultOpen?: boolean;
  /** optional small icon shown before the title — keeps section glanceable */
  icon?: ReactNode;
  /** small label rendered to the right of the title (e.g. "32", "200") */
  summary?: ReactNode;
  children: ReactNode;
};

const STORAGE_PREFIX = 'sc:accordion:';

export function AccordionSection({
  title,
  storageKey,
  defaultOpen = false,
  icon,
  summary,
  children,
}: Props) {
  const key = STORAGE_PREFIX + storageKey;
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(key);
      if (v === '1') return true;
      if (v === '0') return false;
    } catch {
      /* ignore */
    }
    return defaultOpen;
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, open ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [key, open]);

  return (
    <section className={`accordion-section ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="accordion-header"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="accordion-title">
          {icon != null && <span className="accordion-icon">{icon}</span>}
          <span>{title}</span>
        </span>
        <span className="accordion-meta">
          {summary != null && <span className="accordion-summary">{summary}</span>}
          <span className="accordion-caret" aria-hidden="true">
            {open ? '−' : '+'}
          </span>
        </span>
      </button>
      {open && <div className="accordion-body">{children}</div>}
    </section>
  );
}
