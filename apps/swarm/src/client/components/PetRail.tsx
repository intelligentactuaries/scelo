// The pet rail — the app's whole navigation, in six icons.
//
// Replaces the text tab strip. Each surface gets one animal, and the animal
// is the only thing on screen that identifies it: the labels appear at rest,
// then step back once a surface is chosen so the rail stops competing with
// the content it opened.
//
// Icons are imported as URLs rather than inlined. They are multi-colour by
// design — the hue IS the identity — so there is nothing to recolour through
// `currentColor`, and keeping them as files means the SVGs on disk stay the
// single source of truth.

import bunnyUrl from '../assets/pets/bunny.svg';
import catUrl from '../assets/pets/cat.svg';
import chickUrl from '../assets/pets/chick.svg';
import dogUrl from '../assets/pets/dog.svg';
import hamsterUrl from '../assets/pets/hamster.svg';
import turtleUrl from '../assets/pets/turtle.svg';
import type React from 'react';
import type { TabId } from './ViewTabs';

export interface Pet {
  id: TabId;
  label: string;
  src: string;
  /** The icon's own colour, for the selected label and summary accents. */
  hue: string;
}

/**
 * Order and mapping are fixed. Canon sits last and slightly apart: it is
 * the corpus every other surface reads from rather than another view of the
 * run, and it is the face the empty state greets you with.
 */
export const PETS: Pet[] = [
  { id: 'forecast', label: 'Forecast', src: bunnyUrl, hue: '#F3C6D1' },
  { id: 'council', label: 'Council Reactions', src: dogUrl, hue: '#C89B6A' },
  { id: 'society', label: 'Society Pulse', src: hamsterUrl, hue: '#EBD9A6' },
  { id: 'synthesis', label: 'Readback', src: turtleUrl, hue: '#6CB04A' },
  { id: 'simulation', label: 'Simulation', src: chickUrl, hue: '#F7C948' },
  { id: 'canon', label: 'Canon', src: catUrl, hue: '#F4A03C' },
];

export const PET_BY_ID: Record<TabId, Pet> = Object.fromEntries(
  PETS.map((p) => [p.id, p]),
) as Record<TabId, Pet>;

export function PetRail({
  selected,
  expanded,
  onSelect,
  quiet = false,
  showPets = true,
  tools,
}: {
  /** null at rest — nothing chosen, every summary on show. */
  selected: TabId | null;
  /** Whether the chosen surface is open at full size. */
  expanded: boolean;
  onSelect: (id: TabId) => void;
  /**
   * Empty state. Slide 1 shows no rail at all, but Canon and Simulation
   * both work without a run and the rail is the only way to reach them — so
   * rather than stranding them, it stays as small dimmed icons and lets the
   * greeting have the screen.
   */
  quiet?: boolean;
  /**
   * At rest the summary list already names every surface beside the same
   * animal, so the pets are dropped and only the utilities remain — one rail
   * either way, never the same six items twice.
   */
  showPets?: boolean;
  /** Panel toggle and the setup group, rendered below the pets. */
  tools?: React.ReactNode;
}) {
  const resting = selected === null;
  return (
    <nav
      className={`pet-rail ${resting ? 'is-resting' : 'is-focused'} ${quiet ? 'is-quiet' : ''}`}
      aria-label="surfaces"
    >
      {showPets &&
        PETS.map((p) => {
        const active = p.id === selected;
        return (
          <button
            key={p.id}
            type="button"
            className={`pet-item ${active ? 'is-active' : ''} ${p.id === 'canon' ? 'is-canon' : ''}`}
            onClick={() => onSelect(p.id)}
            aria-pressed={active}
            // No `title`: the floating chip label already names the surface
            // on hover, so the browser's own tooltip was the same text a
            // second time, half a second later. Screen readers get the name
            // from aria-label (the label span is clipped to 0 width when the
            // rail is focused).
            aria-label={active && !expanded ? `Open ${p.label}` : p.label}
          >
            <img className="pet-icon" data-pet={p.id} src={p.src} alt="" aria-hidden />
            {/* The active label wears the surface's own colour — it is the
                one piece of text on screen naming where you are. Passed as a
                custom property rather than a literal `color` so the CSS can
                mix it toward --fg: the pale hues (hamster, bunny) vanish on
                the cream theme at full strength. */}
            <span
              className="pet-label"
              style={active ? ({ '--pet-hue': p.hue } as React.CSSProperties) : undefined}
            >
              {p.label}
            </span>
            </button>
          );
        })}
      {tools && <div className="pet-rail-tools">{tools}</div>}
    </nav>
  );
}
