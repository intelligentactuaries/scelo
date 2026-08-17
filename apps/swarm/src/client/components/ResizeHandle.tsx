import { useCallback, useRef, useState } from 'react';

type Props = {
  // 'right' means: dragging right grows the LEFT panel (sidebar handle).
  // 'left'  means: dragging left grows the RIGHT panel (inspector handle).
  side: 'right' | 'left';
  onResize: (delta: number) => void;
  onResizeEnd?: () => void;
};

export function ResizeHandle({ side, onResize, onResizeEnd }: Props) {
  const [active, setActive] = useState(false);
  const startX = useRef(0);
  const lastX = useRef(0);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      startX.current = e.clientX;
      lastX.current = e.clientX;
      setActive(true);
      document.body.classList.add('is-resizing');

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - lastX.current;
        lastX.current = ev.clientX;
        const delta = side === 'right' ? dx : -dx;
        if (delta !== 0) onResize(delta);
      };
      const onUp = () => {
        setActive(false);
        document.body.classList.remove('is-resizing');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        onResizeEnd?.();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [side, onResize, onResizeEnd],
  );

  return (
    <div
      className={`resize-handle ${active ? 'is-active' : ''}`}
      onPointerDown={handlePointerDown}
      role="separator"
      aria-orientation="vertical"
    />
  );
}
