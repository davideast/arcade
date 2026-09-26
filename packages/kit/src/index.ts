/**
 * Phaser helpers shared by every game: the arcade canvas, frames cut from the
 * pack's sheets, grid boards, and the UI components in ./ui.ts.
 */
import * as Phaser from 'phaser';

export * from './palette.ts';
export * from './ui.ts';

/** The arcade's logical canvas: room for a 128x128 board beside a side panel. */
export const LOGICAL_WIDTH = 256;
export const LOGICAL_HEIGHT = 192;
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
  const game = new Phaser.Game({
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
  game.registry.set('renderScale', RENDER_SCALE);
  return game;
}

/** Point the scene's camera at the logical space. Call first in `create`. */
export function usePixelCamera(scene: Phaser.Scene): void {
  scene.cameras.main.setZoom(RENDER_SCALE).centerOn(LOGICAL_WIDTH / 2, LOGICAL_HEIGHT / 2);
}

export function preloadSheet(scene: Phaser.Scene, sheet: SheetSpec): void {
  if (!scene.textures.exists(sheet.key)) scene.load.image(sheet.key, sheet.url);
}

/** Register a sheet's named frames on its loaded texture. Call from `create`. */
export function addSheetFrames(scene: Phaser.Scene, sheet: SheetSpec): void {
  const texture = scene.textures.get(sheet.key);
  for (const [name, [x, y, w, h]] of Object.entries(sheet.frames)) {
    if (!texture.has(name)) texture.add(name, 0, x, y, w, h);
  }
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

export interface GridBoard {
  cells: Phaser.GameObjects.Rectangle[];
  /** Enable or disable hover and clicks per cell; disabled cells show no hover. */
  setPlayable(playable: (index: number) => boolean): void;
}

/**
 * Draw a grid board: a panel, then cells separated by gap lines drawn as one
 * filled rectangle behind the cells, so lines have no seams. `onPick`
 * receives the cell index of a playable cell.
 */
export function drawGrid(
  scene: Phaser.Scene,
  layout: GridLayout,
  colors: { panel: number; line: number; hover: number },
  onPick: (index: number) => void,
): GridBoard {
  const pitch = layout.cell + layout.gap;
  const width = layout.cols * pitch - layout.gap;
  const height = layout.rows * pitch - layout.gap;
  scene.add.rectangle(layout.originX - 5, layout.originY - 5, width + 10, height + 10, colors.panel).setOrigin(0, 0);
  scene.add.rectangle(layout.originX, layout.originY, width, height, colors.line).setOrigin(0, 0);
  let playable: (index: number) => boolean = () => false;
  const cells: Phaser.GameObjects.Rectangle[] = [];
  for (let i = 0; i < layout.cols * layout.rows; i++) {
    const col = i % layout.cols;
    const row = Math.floor(i / layout.cols);
    const cell = scene.add
      .rectangle(layout.originX + col * pitch, layout.originY + row * pitch, layout.cell, layout.cell, colors.panel)
      .setOrigin(0, 0)
      .setInteractive();
    cell.on('pointerover', () => {
      if (playable(i)) cell.setFillStyle(colors.hover);
    });
    cell.on('pointerout', () => cell.setFillStyle(colors.panel));
    cell.on('pointerdown', () => {
      if (playable(i)) onPick(i);
    });
    cells.push(cell);
  }
  return {
    cells,
    setPlayable(next) {
      playable = next;
      for (const [i, cell] of cells.entries()) {
        cell.setFillStyle(colors.panel);
        if (cell.input) cell.input.cursor = next(i) ? 'pointer' : 'default';
      }
    },
  };
}
export * from './chrome.ts';
