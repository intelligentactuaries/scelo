import { useEffect, useState } from 'react';

// Subscribe a component to a CSS media query. Returns `true` when the
// query currently matches. Uses the modern `matchMedia.addEventListener`
// API and falls back to the legacy `addListener` shape on Safari < 14.
export function useMediaQuery(query: string): boolean {
  const get = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false;
  const [matches, setMatches] = useState<boolean>(get);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    setMatches(mql.matches);
    if ('addEventListener' in mql) {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    // Legacy Safari
    (mql as MediaQueryList & { addListener: (l: () => void) => void }).addListener(onChange);
    return () => {
      (mql as MediaQueryList & { removeListener: (l: () => void) => void }).removeListener(
        onChange,
      );
    };
  }, [query]);

  return matches;
}

export const MOBILE_QUERY = '(max-width: 820px)';
