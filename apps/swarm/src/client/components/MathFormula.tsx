import { useEffect, useRef } from 'react';
import katex from 'katex';
import { ACTUARIAL_MACROS } from '../lib/actuarialMacros';

type Props = {
  latex: string;
  block?: boolean;
};

export function MathFormula({ latex, block = true }: Props) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    try {
      katex.render(latex, ref.current, {
        throwOnError: false,
        displayMode: block,
        strict: 'ignore',
        output: 'html',
        // KaTeX 0.16 mutates the macros object during rendering (to hold
        // user-defined runtime macros). We pass a fresh shallow clone each
        // render so our library stays pristine.
        macros: { ...ACTUARIAL_MACROS },
      });
    } catch {
      if (ref.current) {
        ref.current.textContent = latex;
      }
    }
  }, [latex, block]);

  return <span ref={ref} className={block ? 'math-block' : 'math-inline'} />;
}
