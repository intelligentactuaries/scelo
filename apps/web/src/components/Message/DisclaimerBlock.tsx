// Mandatory not-legal-advice disclaimer for regulatory tool output.
// Always rendered; never collapses.

type Props = {
  text: string;
};

export function DisclaimerBlock({ text }: Props) {
  return (
    <div className="border-l-2 border-warn bg-warn/5 px-3 py-2 text-fg-mute text-xs italic">
      <span className="mr-1 font-mono text-warn uppercase">notice</span>
      {text}
    </div>
  );
}
