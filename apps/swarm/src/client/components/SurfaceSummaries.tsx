// The centre column at rest and when a surface is selected.
//
// At rest: one line per surface, so the whole run reads top-to-bottom without
// opening anything. Selected: that surface's three lines, and clicking any of
// them opens it — the line you were reading is the thing you wanted.

import { useRef } from 'react';
import type { Run } from '../../shared/types';
import { flyPetToRail } from '../lib/petFlight';
import { summariesFor } from '../lib/tabSummaries';
import { PETS, PET_BY_ID } from './PetRail';
import type { TabId } from './ViewTabs';

export interface SummaryExtras {
  canonWorks?: number;
  simRows?: number;
  simDone?: boolean;
  /** True while a swarm run is streaming — flips the empty lines to live ones. */
  busy?: boolean;
}

export function SurfaceSummaries({
  selected,
  run,
  extras,
  onOpen,
  onSelect,
}: {
  selected: TabId | null;
  run: Run | null;
  extras: SummaryExtras;
  /** Open the selected surface at full size. */
  onOpen: () => void;
  /** Choose a surface from the resting list. */
  onSelect: (id: TabId) => void;
}) {
  if (selected === null) {
    return (
      <div className="surface-summaries is-resting">
        {PETS.map((p) => (
          <SummaryRow
            key={p.id}
            pet={p}
            text={summariesFor(p.id, run, extras)[0] ?? ''}
            onSelect={onSelect}
          />
        ))}
      </div>
    );
  }

  const pet = PET_BY_ID[selected];
  return (
    <div className="surface-summaries is-selected">
      {summariesFor(selected, run, extras).map((line, i) => (
        <button
          key={`${selected}-${i}`}
          type="button"
          className="summary-line is-lead"
          onClick={onOpen}
        >
          {line}
        </button>
      ))}
      <button type="button" className="summary-open" onClick={onOpen}>
        open {pet.label.toLowerCase()} →
      </button>
    </div>
  );
}

function SummaryRow({
  pet,
  text,
  onSelect,
}: {
  pet: (typeof PETS)[number];
  text: string;
  onSelect: (id: TabId) => void;
}) {
  const iconRef = useRef<HTMLImageElement | null>(null);
  return (
    <button
      type="button"
      className="summary-line"
      onClick={() => {
        // Start the flight and change state in the same tick: the helper waits
        // for the re-render before measuring the rail seat, so the animal
        // lands on the enlarged icon rather than where it used to be.
        void flyPetToRail(iconRef.current, pet.id);
        onSelect(pet.id);
      }}
    >
      <img ref={iconRef} className="summary-pet" src={pet.src} alt="" aria-hidden />
      <span className="summary-name">{pet.label}</span>
      <span className="summary-text">{text}</span>
    </button>
  );
}
