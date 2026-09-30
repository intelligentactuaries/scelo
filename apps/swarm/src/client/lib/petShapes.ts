// The six pets as drawable parts rather than flat images, so each can move on
// its own: the body breathes and sways, the ears lag a little behind the head,
// the face (eyes, beak) turns toward whatever the pet is looking at, and the
// eyes blink. Geometry is the SVGs in ../assets/pets/, with each file's group
// translate folded in — same 168-unit box, same colours, so a still pet is
// pixel-identical to the icon it replaces.

export type PetKind = 'bunny' | 'dog' | 'hamster' | 'turtle' | 'chick' | 'cat';

export type PetPart =
  | { shape: 'circle'; cx: number; cy: number; r: number; fill: string }
  | {
      shape: 'ellipse';
      cx: number;
      cy: number;
      rx: number;
      ry: number;
      fill: string;
      /** Degrees, about the ellipse's own centre. */
      rotate?: number;
    }
  | { shape: 'path'; d: string; fill: string };

export interface PetShape {
  /** Behind the body; they trail the head's turn for a little depth. */
  ears: PetPart[];
  /** The body — the one part that never moves relative to the pet. */
  body: PetPart[];
  /** Eye centres (left, right) and radius. Eyes are drawn as dots. */
  eyes: { l: [number, number]; r: [number, number]; radius: number; fill: string };
  /** Beak / nose — rides with the eyes when the face turns. */
  face: PetPart[];
  /** Where the body pivots when it leans — near its visual centre. */
  pivot: [number, number];
  /** Lowest point of the body: squashes and stretches keep it planted. */
  feet: number;
}

const EYE = '#3B3229';

export const PET_SHAPES: Record<PetKind, PetShape> = {
  bunny: {
    ears: [
      { shape: 'ellipse', cx: 66, cy: 47, rx: 13, ry: 36, fill: '#F3C6D1', rotate: -8 },
      { shape: 'ellipse', cx: 102, cy: 47, rx: 13, ry: 36, fill: '#F3C6D1', rotate: 8 },
    ],
    body: [{ shape: 'circle', cx: 84, cy: 101, r: 56, fill: '#F3C6D1' }],
    eyes: { l: [63, 97], r: [105, 97], radius: 9, fill: EYE },
    face: [],
    pivot: [84, 101],
    feet: 157,
  },
  cat: {
    ears: [
      { shape: 'path', d: 'M42 64L50 18L88 46Z', fill: '#F4A03C' },
      { shape: 'path', d: 'M126 64L118 18L80 46Z', fill: '#F4A03C' },
    ],
    body: [{ shape: 'circle', cx: 84, cy: 94, r: 56, fill: '#F4A03C' }],
    eyes: { l: [63, 90], r: [105, 90], radius: 9, fill: EYE },
    face: [],
    pivot: [84, 94],
    feet: 150,
  },
  chick: {
    ears: [],
    body: [{ shape: 'circle', cx: 84, cy: 84, r: 56, fill: '#FFC93D' }],
    eyes: { l: [63, 80], r: [105, 80], radius: 9, fill: EYE },
    face: [{ shape: 'path', d: 'M68 94L100 94L84 110Z', fill: '#F0932B' }],
    pivot: [84, 84],
    feet: 140,
  },
  dog: {
    ears: [
      { shape: 'ellipse', cx: 32, cy: 86, rx: 20, ry: 36, fill: '#A5754A', rotate: -12 },
      { shape: 'ellipse', cx: 136, cy: 86, rx: 20, ry: 36, fill: '#A5754A', rotate: 12 },
    ],
    body: [{ shape: 'circle', cx: 84, cy: 84, r: 56, fill: '#CE9662' }],
    eyes: { l: [63, 80], r: [105, 80], radius: 9, fill: EYE },
    face: [],
    pivot: [84, 84],
    feet: 140,
  },
  hamster: {
    ears: [
      { shape: 'circle', cx: 46, cy: 46, r: 19, fill: '#C9A05C' },
      { shape: 'circle', cx: 122, cy: 46, r: 19, fill: '#C9A05C' },
    ],
    body: [{ shape: 'circle', cx: 84, cy: 84, r: 56, fill: '#E7C382' }],
    eyes: { l: [63, 80], r: [105, 80], radius: 9, fill: EYE },
    face: [],
    pivot: [84, 84],
    feet: 140,
  },
  turtle: {
    // The shell sits under the head: it moves with the body, not the face.
    ears: [],
    body: [
      { shape: 'ellipse', cx: 84, cy: 120, rx: 60, ry: 23, fill: '#4C8A3E' },
      { shape: 'circle', cx: 84, cy: 82, r: 56, fill: '#74B95A' },
    ],
    eyes: { l: [63, 78], r: [105, 78], radius: 9, fill: EYE },
    face: [],
    pivot: [84, 96],
    feet: 143,
  },
};
