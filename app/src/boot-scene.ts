import * as Phaser from 'phaser';
import { preloadUi, readyUi, text, usePixelCamera } from '@games/kit';
import { GAMES } from './catalog.ts';

/** Loads every sheet and the UI, registers each sheet's mockup frame, then hands off. */
export class BootScene extends Phaser.Scene {
  constructor() {
    super('boot');
  }

  preload(): void {
    preloadUi(this);
    for (const g of GAMES) this.load.image(g.sheetKey, g.sheetUrl);
  }

  async create(): Promise<void> {
    usePixelCamera(this);
    await readyUi(this);
    for (const g of GAMES) {
      const texture = this.textures.get(g.sheetKey);
      const source = texture.getSourceImage() as HTMLImageElement;
      if (!texture.has('mockup')) texture.add('mockup', 0, source.width - 128, 0, 128, 128);
    }
    text(this, 128, 90, 'LOADING', { align: 'center', color: 'lavender' });
    this.game.events.emit('arcade-ready');
  }
}
