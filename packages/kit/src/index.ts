/**
 * Phaser helpers shared by every game: a pixel-art game config at the pack's
 * 128x128 logical size, and frames cut from the pack's sprite sheets.
 */
import * as Phaser from 'phaser';

export const LOGICAL_WIDTH = 128;
export const LOGICAL_HEIGHT = 128;
/**
 * The canvas renders at this multiple of the logical size, and each scene's
 * camera zooms by the same factor. Sprites stay crisp under nearest-neighbor
 * scaling, and text gets enough pixels to be legible.
 */
export const RENDER_SCALE = 4;

/** A frame on a sheet: x, y, width, height in sheet pixels. */
export type FrameRect = readonly [number, number, number, number];

export interface SheetSpec {
  key: string;
  url: string;
  frames: Record<string, FrameRect>;
}

export function createPixelGame(parent: HTMLElement, scenes: Phaser.Types.Scenes.SceneType[], background: string): Phaser.Game {
  return new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: LOGICAL_WIDTH * RENDER_SCALE,
    height: LOGICAL_HEIGHT * RENDER_SCALE,
    backgroundColor: background,
    pixelArt: true,
    roundPixels: true,
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    scene: scenes,
  });
}

/** Point the scene's camera at the 128x128 logical space. Call first in `create`. */
export function usePixelCamera(scene: Phaser.Scene): void {
  scene.cameras.main.setZoom(RENDER_SCALE).centerOn(LOGICAL_WIDTH / 2, LOGICAL_HEIGHT / 2);
}

export function preloadSheet(scene: Phaser.Scene, sheet: SheetSpec): void {
  scene.load.image(sheet.key, sheet.url);
}

/** Register a sheet's named frames on its loaded texture. Call from `create`. */
export function addSheetFrames(scene: Phaser.Scene, sheet: SheetSpec): void {
  const texture = scene.textures.get(sheet.key);
  for (const [name, [x, y, w, h]] of Object.entries(sheet.frames)) {
    if (!texture.has(name)) texture.add(name, 0, x, y, w, h);
  }
}

/** Crisp small text: rendered at a high resolution, then scaled with the canvas. */
export function pixelText(
  scene: Phaser.Scene,
  x: number,
  y: number,
  text: string,
  color: string,
): Phaser.GameObjects.Text {
  return scene.add
    .text(x, y, text, { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '8px', fontStyle: 'bold', color })
    .setResolution(RENDER_SCALE)
    .setOrigin(0.5, 0.5);
}

/** Cell geometry for a square grid board. */
export interface GridLayout {
  originX: number;
  originY: number;
  cols: number;
  rows: number;
  cell: number;
  gap: number;
}

export function cellCenter(layout: GridLayout, index: number): { x: number; y: number } {
  const col = index % layout.cols;
  const row = Math.floor(index / layout.cols);
  const pitch = layout.cell + layout.gap;
  return {
    x: layout.originX + col * pitch + layout.cell / 2,
    y: layout.originY + row * pitch + layout.cell / 2,
  };
}

/** Draw the grid and make each cell clickable; `onPick` receives the cell index. */
export function drawGrid(
  scene: Phaser.Scene,
  layout: GridLayout,
  colors: { panel: number; line: number; hover: number },
  onPick: (index: number) => void,
): Phaser.GameObjects.Rectangle[] {
  const pitch = layout.cell + layout.gap;
  const width = layout.cols * pitch - layout.gap;
  const height = layout.rows * pitch - layout.gap;
  scene.add.rectangle(layout.originX - 5, layout.originY - 5, width + 10, height + 10, colors.panel).setOrigin(0, 0);
  scene.add.rectangle(layout.originX, layout.originY, width, height, colors.line).setOrigin(0, 0);
  const cells: Phaser.GameObjects.Rectangle[] = [];
  for (let i = 0; i < layout.cols * layout.rows; i++) {
    const { x, y } = cellCenter(layout, i);
    const cell = scene.add.rectangle(x, y, layout.cell, layout.cell, colors.panel).setInteractive({ useHandCursor: true });
    cell.on('pointerover', () => cell.setFillStyle(colors.hover));
    cell.on('pointerout', () => cell.setFillStyle(colors.panel));
    cell.on('pointerdown', () => onPick(i));
    cells.push(cell);
  }
  return cells;
}
