/** The pack's shared 12-color palette (the strip at the top-left of every sheet). */
export const PALETTE = {
  black: 0x040303,
  ink: 0x1c1618,
  purple: 0x47416b,
  green: 0x6c8c50,
  yellow: 0xe3d245,
  orange: 0xd88038,
  red: 0xa13d3b,
  maroon: 0x4e282e,
  magenta: 0x9a407e,
  sand: 0xf0d472,
  cream: 0xf9f5ef,
  lavender: 0x8a8fc4,
} as const;

export type PaletteColor = keyof typeof PALETTE;

/** CSS form of a palette color, for text styles. */
export function css(color: PaletteColor): string {
  return `#${PALETTE[color].toString(16).padStart(6, '0')}`;
}
