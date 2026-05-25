// Numbered list of regulatory or wiki citations.

type Citation = {
  // Display label, e.g. "FSCA Conduct Standard 1 of 2020 §3.4".
  label: string;
  // Optional href into a documentation surface.
  href?: string;
  // Optional applicability hint, used to colour the badge.
  applicability?: "directly_applicable" | "potentially_applicable" | "informational";
};

type Props = {
  citations: Citation[];
  title?: string;
};

const APPL_COLOR: Record<NonNullable<Citation["applicability"]>, string> = {
  directly_applicable: "border-primary text-primary",
  potentially_applicable: "border-warn text-warn",
  informational: "border-border text-fg-mute",
};

export function CitationsBlock({ citations, title = "References" }: Props) {
  if (citations.length === 0) return null;
  return (
    <section className="border-border border-t pt-3">
      <h4 className="mb-2 font-mono text-fg-dim text-[11px] uppercase tracking-wider">{title}</h4>
      <ol className="space-y-1.5 text-sm">
        {citations.map((c, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: numbered references are intrinsically ordered
          <li key={i} className="flex items-baseline gap-2">
            <span className="shrink-0 font-mono text-fg-dim text-xs">[{i + 1}]</span>
            {c.applicability && (
              <span
                className={`shrink-0 border px-1 font-mono text-[10px] uppercase ${APPL_COLOR[c.applicability]}`}
              >
                {c.applicability.replace("_", " ")}
              </span>
            )}
            {c.href ? (
              <a className="text-primary hover:underline" href={c.href}>
                {c.label}
              </a>
            ) : (
              <span className="text-fg">{c.label}</span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
