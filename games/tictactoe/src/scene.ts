import * as Phaser from 'phaser';
import {
  addSheetFrames,
  cellCenter,
  drawGrid,
  pixelText,
  preloadSheet,
  usePixelCamera,
  type GridLayout,
  type SheetSpec,
} from '@games/kit';
import type { MatchView } from '@games/turn-net';
import sheetUrl from '../../../MASFunPack/AllGames/TicTacToeSpriteSheet.png?url';
import { logic, type Board } from './logic.ts';

export const SHEET: SheetSpec = {
  key: 'tictactoe',
  url: sheetUrl,
  frames: {
    o: [17, 17, 14, 14],
    x: [33, 17, 14, 14],
  },
};

/** Colors from the sheet's palette strip. */
export const PALETTE = {
  background: '#8a8fc4',
  panel: 0xf9f5ef,
  line: 0x8a8fc4,
  hover: 0xe8e2f0,
  ink: '#1c1618',
};

const LAYOUT: GridLayout = { originX: 26, originY: 32, cols: 3, rows: 3, cell: 24, gap: 2 };

/** The host plays X and moves first. */
const FRAME_FOR = { host: 'x', guest: 'o' } as const;

export const PICK_EVENT = 'pick';

export class TicTacToeScene extends Phaser.Scene {
  private marks: Phaser.GameObjects.Image[] = [];
  private status?: Phaser.GameObjects.Text;
  private view: MatchView<Board> | null = null;

  constructor() {
    super('tictactoe');
  }

  preload(): void {
    preloadSheet(this, SHEET);
  }

  create(): void {
    usePixelCamera(this);
    addSheetFrames(this, SHEET);
    this.status = pixelText(this, 64, 14, '', PALETTE.ink);
    drawGrid(this, LAYOUT, PALETTE, (index) => this.pick(index));
    this.render();
  }

  /** Show a match; null shows an empty board. */
  show(view: MatchView<Board> | null): void {
    this.view = view;
    if (this.status) this.render();
  }

  private pick(index: number): void {
    const view = this.view;
    if (!view || view.doc.status !== 'playing' || view.seat !== view.doc.currentTurn) return;
    if (!logic.legalMoves(view.state, view.seat).includes(index)) return;
    this.events.emit(PICK_EVENT, index);
  }

  private render(): void {
    for (const mark of this.marks) mark.destroy();
    this.marks = [];
    const view = this.view;
    const board = view?.state ?? logic.initial();
    board.forEach((cell, i) => {
      if (cell === '') return;
      const { x, y } = cellCenter(LAYOUT, i);
      this.marks.push(this.add.image(x, y, SHEET.key, FRAME_FOR[cell]));
    });
    this.status?.setText(statusLine(view));
  }
}

function statusLine(view: MatchView<Board> | null): string {
  if (!view) return 'Tic-Tac-Toe';
  const { doc, seat } = view;
  const you = (s: string) => (seat === null ? `${s === 'host' ? 'X' : 'O'}` : s === seat ? 'You' : 'They');
  switch (doc.status) {
    case 'waiting':
      return 'Waiting for O';
    case 'playing':
      if (seat === null) return `${doc.currentTurn === 'host' ? 'X' : 'O'} to play`;
      return doc.currentTurn === seat ? 'Your move' : 'Their move';
    case 'won':
      return `${you(doc.winner)} won`;
    case 'resigned':
      return `${you(doc.winner)} won by resign`;
    case 'draw':
      return 'Draw';
  }
}
