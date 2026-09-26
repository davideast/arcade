/**
 * Uno cards as two-character strings: a color (r, o, p, g, or x for wilds)
 * followed by a value: 0-9, s (skip), r (reverse), d (draw two), w (wild),
 * + (wild draw four). The Security Rules parse the same encoding.
 */
export const COLORS = ['r', 'o', 'p', 'g'] as const;
export type Color = (typeof COLORS)[number];
export type Card = string;

export const COLOR_NAMES: Record<Color, string> = { r: 'Red', o: 'Orange', p: 'Purple', g: 'Green' };

export const DECK_SIZE = 108;
export const HAND_SIZE = 7;
export const MAX_PLAYERS = 4;

export function colorOf(card: Card): string {
  return card.slice(0, 1);
}

export function valueOf(card: Card): string {
  return card.slice(1);
}

export function isWild(card: Card): boolean {
  return colorOf(card) === 'x';
}

/** The 108-card deck, unshuffled. */
export function fullDeck(): Card[] {
  const deck: Card[] = [];
  for (const c of COLORS) {
    deck.push(`${c}0`);
    for (const v of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 's', 'r', 'd']) deck.push(`${c}${v}`, `${c}${v}`);
  }
  for (let i = 0; i < 4; i++) deck.push('xw', 'x+');
  return deck;
}

/** Fisher-Yates with a supplied random source; the first card after the hands is never wild. */
export function shuffledDeck(random: () => number, players: number): Card[] {
  for (;;) {
    const deck = fullDeck();
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    if (!isWild(deck[players * HAND_SIZE])) return deck;
  }
}

/** A card may be played on a top of `color`/`value` when it matches either, or is wild. */
export function canPlay(card: Card, color: string, value: string): boolean {
  return isWild(card) || colorOf(card) === color || valueOf(card) === value;
}

/** The sheet frame for a card face. */
export function frameFor(card: Card, chosen?: string): string {
  if (card === 'xw' && chosen) return `wild-${chosen}`;
  if (card === 'x+' && chosen) return `wild-${chosen}`;
  return `card-${card}`;
}

/** Frame rectangles on Uno.png: 16x24 cards on a grid starting at y=16. */
export function cardFrames(): Record<string, readonly [number, number, number, number]> {
  const at = (col: number, row: number) => [col * 16, 16 + row * 24, 16, 24] as const;
  const frames: Record<string, readonly [number, number, number, number]> = {};
  COLORS.forEach((c, i) => {
    for (let v = 0; v <= 5; v++) frames[`card-${c}${v}`] = at(v, i);
    for (let v = 6; v <= 9; v++) frames[`card-${c}${v}`] = at(v - 6, 4 + i);
    frames[`card-${c}s`] = at(5, 4 + i);
    frames[`card-${c}d`] = at(0, 8 + i);
    frames[`card-${c}r`] = at(3, 8 + i);
    frames[`wild-${c}`] = at(5, 8 + i);
  });
  frames['card-back'] = at(4, 4);
  frames['card-xw'] = at(4, 6);
  frames['card-x+'] = at(4, 7);
  return frames;
}
