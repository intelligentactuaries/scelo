// Fly a summary line's pet back to its permanent seat in the rail.
//
// The rail is where a surface lives; the summary list is a temporary place
// the same animal appears. Cutting between the two makes the icon look like
// two different things — a FLIP makes it read as one object returning home,
// which is also the clearest possible explanation of what the rail is FOR.
//
// The destination is measured AFTER React has re-rendered, because selecting
// a surface enlarges its rail icon (28px → 54px). Measuring first would land
// the flight on the old, smaller rect and pop at the end.

import type { TabId } from '../components/ViewTabs';

const FLIGHT_MS = 420;

function reduceMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

/** Wait for the browser to have laid out the render React just queued. */
function afterNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/**
 * @param from The icon in the summary line that was clicked. Its rect is read
 *             immediately, before the click's state change removes it.
 * @param id   Which rail seat to fly to.
 */
export async function flyPetToRail(from: HTMLElement | null, id: TabId): Promise<void> {
  if (!from || reduceMotion()) return;
  const a = from.getBoundingClientRect();
  if (a.width === 0) return;

  await afterNextPaint();
  const target = document.querySelector<HTMLElement>(`.pet-icon[data-pet="${id}"]`);
  if (!target) return;
  const b = target.getBoundingClientRect();
  if (b.width === 0) return;

  const clone = from.cloneNode(true) as HTMLElement;
  clone.className = 'pet-flight';
  clone.style.left = `${a.left}px`;
  clone.style.top = `${a.top}px`;
  clone.style.width = `${a.width}px`;
  clone.style.height = `${a.height}px`;
  document.body.appendChild(clone);

  // The seat is already occupied by the real icon; hide it for the flight so
  // the same animal is not in two places at once.
  const prior = target.style.opacity;
  target.style.opacity = '0';

  const scale = b.width / a.width;
  requestAnimationFrame(() => {
    clone.style.transform = `translate(${b.left - a.left}px, ${b.top - a.top}px) scale(${scale})`;
  });

  await new Promise((r) => setTimeout(r, FLIGHT_MS));
  clone.remove();
  target.style.opacity = prior;
}
