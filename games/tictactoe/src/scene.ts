import * as Phaser from 'phaser';
import {
  PALETTE,
  PLAY_AREA,
  addSheetFrames,
  drawGrid,
  matchChrome,
  panel,
  usePixelCamera,
  type GridBoard,
  type GridLayout,
  type MatchChrome,
  type SheetSpec,
} from '@games/kit';
import {
  cancelMatch,
  cancelWhenLeft,
  createdMatch,
  gameOverWithRematch,
  joinMatch,
  playMove,
  resign,
  watchMatch,
  type Connection,
  type MatchView,
} from '@games/turn-net';
import { logic, ticTacToe, type Board } from './logic.ts';

/** The game's sheet is loaded by the arcade; this registers its frames. */
export const SHEET: SheetSpec = {
  key: 'sheet-tictactoe',
  url: '',
  frames: {
    o: [17, 17, 14, 14],
    x: [33, 17, 14, 14],
  },
};

const CELL = 36;
const GAP = 4;
const LAYOUT: GridLayout = {
  originX: PLAY_AREA.x + (PLAY_AREA.width - (3 * CELL + 2 * GAP)) / 2,
  originY: PLAY_AREA.y + (PLAY_AREA.height - (3 * CELL + 2 * GAP)) / 2,
  cols: 3,
  rows: 3,
  cell: CELL,
  gap: GAP,
};

/** The host plays X and moves first. */
const MARK = { host: 'x', guest: 'o' } as const;

export class TicTacToeScene extends Phaser.Scene {
  private chrome!: MatchChrome;
  private board!: GridBoard;
  private marks: Phaser.GameObjects.Image[] = [];
  private view: MatchView<Board> | null = null;
  private matchId = '';
  private stop: (() => void) | null = null;
  private stopRematch: (() => void) | null = null;
  private announced = '';
  private lastAnimatedMove = -1;

  constructor() {
    super('tictactoe');
  }

  init(data: { matchId: string }): void {
    this.matchId = data.matchId;
    this.view = null;
    this.announced = '';
    this.lastAnimatedMove = -1;
    this.marks = [];
  }

  create(): void {
    usePixelCamera(this);
    addSheetFrames(this, SHEET);
    const connection = this.game.registry.get('connection') as Connection;
    this.chrome = matchChrome(this, { title: 'Tic-Tac-Toe', onBack: () => (location.hash = '#/') });
    panel(this, PLAY_AREA.x, PLAY_AREA.y, PLAY_AREA.width, PLAY_AREA.height, 'purple', 'cream');
    this.board = drawGrid(this, LAYOUT, { panel: PALETTE.cream, line: PALETTE.lavender, hover: 0xe8e2f0 }, (i) => this.play(i));
    this.chrome.setStatus('Loading match');

    const matchId = this.matchId;
    let waitingHost = false;
    this.stop = watchMatch(connection, ticTacToe, matchId, (view) => {
      this.view = view;
      waitingHost = view?.doc.status === 'waiting' && view.seat === 'host';
      this.render();
    });
    const leave = cancelWhenLeft(() => waitingHost, () => cancelMatch(connection, ticTacToe, matchId));
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.stop?.();
      this.stopRematch?.();
      this.stopRematch = null;
      leave();
    });
  }

  private connection(): Connection {
    return this.game.registry.get('connection') as Connection;
  }

  private async attempt(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.report(error);
    }
  }

  private report(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (/denied|permission/i.test(message)) this.chrome.denied();
    else this.chrome.notice(message.slice(0, 40));
  }

  private play(index: number): void {
    const view = this.view;
    if (!view || view.doc.status !== 'playing' || view.seat !== view.doc.currentTurn) return;
    void this.attempt(() => playMove(this.connection(), ticTacToe, this.matchId, index));
  }

  private render(): void {
    for (const m of this.marks) m.destroy();
    this.marks = [];
    const view = this.view;
    if (!view) {
      this.chrome.setStatus('This match no longer exists', 'red');
      this.chrome.setPlayers([]);
      this.chrome.setActions([]);
      this.board.setPlayable(() => false);
      return;
    }
    const { doc, seat, state } = view;
    state.forEach((cell, i) => {
      if (cell === '') return;
      const col = i % 3;
      const row = Math.floor(i / 3);
      const x = LAYOUT.originX + col * (CELL + GAP) + CELL / 2;
      const y = LAYOUT.originY + row * (CELL + GAP) + CELL / 2;
      const mark = this.add.image(x, y, SHEET.key, MARK[cell]).setScale(2);
      const isNew = doc.lastMove === `c${col}r${row}` && doc.moveCount > this.lastAnimatedMove && this.lastAnimatedMove >= 0;
      if (isNew) {
        mark.setScale(0.5);
        this.tweens.add({ targets: mark, scale: 2, duration: 120, ease: 'Back.easeOut' });
      }
      this.marks.push(mark);
    });

    const myTurn = doc.status === 'playing' && seat === doc.currentTurn;
    const legal = new Set(myTurn && seat ? logic.legalMoves(state, seat) : []);
    this.board.setPlayable((i) => legal.has(i));

    const name = (s: 'host' | 'guest') => (doc[s] ? `P-${String(doc[s]).slice(-4).toUpperCase()}` : 'Waiting...');
    this.chrome.setPlayers([
      { mark: 'X', markColor: 'red', name: name('host'), you: seat === 'host', active: doc.status === 'playing' && doc.currentTurn === 'host' },
      { mark: 'O', markColor: 'lavender', name: name('guest'), you: seat === 'guest', active: doc.status === 'playing' && doc.currentTurn === 'guest' },
    ]);

    const connection = this.connection();
    if (doc.status === 'waiting') {
      this.chrome.setStatus(seat === 'host' ? 'Waiting for an opponent to join' : 'Waiting to start');
      this.chrome.setActions(seat === 'host'
        ? [{ label: 'Cancel match', onPress: () => void this.attempt(async () => { await cancelMatch(connection, ticTacToe, this.matchId); location.hash = '#/'; }) }]
        : []);
    } else if (doc.status === 'playing') {
      this.chrome.setStatus(seat === null ? `${doc.currentTurn === 'host' ? 'X' : 'O'} to play` : myTurn ? 'Your move' : 'Their move', myTurn ? 'sand' : 'lavender');
      this.chrome.setActions(seat ? [{ label: 'Resign', onPress: () => void this.attempt(() => resign(connection, ticTacToe, this.matchId, seat)) }] : []);
    } else {
      this.chrome.setActions([]);
      const result = doc.status === 'draw'
        ? 'Draw'
        : seat === null ? `${doc.winner === 'host' ? 'X' : 'O'} wins` : doc.winner === seat ? 'You win' : 'You lose';
      const how = doc.status === 'resigned' ? 'by resignation' : doc.status === 'draw' ? 'The board is full' : 'Three in a row';
      this.chrome.setStatus(`${result}. ${how}.`);
      const key = `${this.matchId}-${doc.status}`;
      if (this.announced !== key) {
        this.announced = key;
        const arcade = { label: 'Arcade', onPress: () => (location.hash = '#/') };
        if (!seat) this.chrome.gameOver(result, how, [arcade]);
        else this.stopRematch = gameOverWithRematch(connection, this.chrome, result, how, {
          game: ticTacToe.id,
          matchId: this.matchId,
          fresh: (uid) => ({ ...createdMatch(ticTacToe, uid), rematchOf: this.matchId }),
          join: (c, id) => joinMatch(c, ticTacToe, id),
          open: (id) => (location.hash = `#/play/tictactoe/${id}`),
          onError: (error) => this.report(error),
        }, [arcade]);
      }
    }
    this.lastAnimatedMove = doc.moveCount;
  }
}
