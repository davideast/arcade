import * as Phaser from 'phaser';
import {
  PALETTE,
  PLAY_AREA,
  addSheetFrames,
  matchChrome,
  usePixelCamera,
  type MatchChrome,
  type SheetSpec,
} from '@games/kit';
import { cancelMatch, cancelWhenLeft, createdMatch, gameOverWithRematch, joinMatch, resign, watchMatch, type Connection, type MatchView, type Seat } from '@games/turn-net';
import { isPlayable, legalMoves, squareName, squareOf, type Move } from './checkers.ts';
import { checkers, positionOf, sideOfSeat, verifyMove, type CheckersDoc, type CheckersFields } from './logic.ts';
import { moveCheckers } from './net.ts';

export const SHEET: SheetSpec = {
  key: 'sheet-checkers',
  url: '',
  frames: { l: [24, 16, 8, 8], d: [32, 16, 8, 8] },
};

const SQUARE = 16;

export class CheckersScene extends Phaser.Scene {
  private chrome!: MatchChrome;
  private matchId = '';
  private view: MatchView<CheckersFields> | null = null;
  private stop: (() => void) | null = null;
  private stopRematch: (() => void) | null = null;
  private layer: Phaser.GameObjects.GameObject[] = [];
  private cursor = squareOf('c3');
  private selected = -1;
  private busy = false;
  private forged = new Map<number, string>();
  private checked = -1;
  private announced = '';

  constructor() {
    super('checkers');
  }

  init(data: { matchId: string }): void {
    this.matchId = data.matchId;
    this.view = null;
    this.layer = [];
    this.cursor = squareOf('c3');
    this.selected = -1;
    this.busy = false;
    this.forged = new Map();
    this.checked = -1;
    this.announced = '';
  }

  create(): void {
    usePixelCamera(this);
    addSheetFrames(this, SHEET);
    this.chrome = matchChrome(this, { title: 'Checkers', background: 'maroon', onBack: () => (location.hash = '#/') });
    this.add.rectangle(PLAY_AREA.x - 2, PLAY_AREA.y - 2, PLAY_AREA.width + 4, PLAY_AREA.height + 4, PALETTE.red).setOrigin(0, 0);
    this.chrome.setStatus('Loading');

    this.input.on(Phaser.Input.Events.POINTER_DOWN, (p: Phaser.Input.Pointer) => {
      const sq = this.squareAt(p.worldX, p.worldY);
      if (sq !== null) {
        this.cursor = sq;
        this.pick(sq);
      }
    });
    const keys = this.input.keyboard?.addKeys('W,A,S,D,F') as Record<string, Phaser.Input.Keyboard.Key> | undefined;
    if (keys) {
      const flip = () => (this.view?.seat === 'guest' ? -1 : 1);
      keys.W.on('down', () => this.nudge(-8 * flip()));
      keys.S.on('down', () => this.nudge(8 * flip()));
      keys.A.on('down', () => this.nudge(-1 * flip()));
      keys.D.on('down', () => this.nudge(1 * flip()));
      keys.F.on('down', () => this.pick(this.cursor));
    }

    const connection = this.connection();
    const matchId = this.matchId;
    let waitingHost = false;
    this.stop = watchMatch(connection, checkers, matchId, (view) => {
      const before = this.view?.doc as CheckersDoc | undefined;
      this.view = view;
      waitingHost = view?.doc.status === 'waiting' && view.seat === 'host';
      this.onSnapshot(before);
    });
    const leave = cancelWhenLeft(() => waitingHost, () => cancelMatch(connection, checkers, matchId));
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

  private screen(sq: number): { x: number; y: number } {
    const flipped = this.view?.seat === 'guest';
    const r = flipped ? 7 - Math.floor(sq / 8) : Math.floor(sq / 8);
    const c = flipped ? 7 - (sq % 8) : sq % 8;
    return { x: PLAY_AREA.x + c * SQUARE, y: PLAY_AREA.y + r * SQUARE };
  }

  private squareAt(x: number, y: number): number | null {
    const c = Math.floor((x - PLAY_AREA.x) / SQUARE);
    const r = Math.floor((y - PLAY_AREA.y) / SQUARE);
    if (c < 0 || c > 7 || r < 0 || r > 7) return null;
    return this.view?.seat === 'guest' ? (7 - r) * 8 + (7 - c) : r * 8 + c;
  }

  private nudge(delta: number): void {
    const next = this.cursor + delta;
    if (next < 0 || next > 63 || (Math.abs(delta) === 1 && Math.floor(next / 8) !== Math.floor(this.cursor / 8))) return;
    this.cursor = next;
    this.render();
  }

  private myTurn(): boolean {
    const v = this.view;
    return !!v && v.doc.status === 'playing' && v.seat === v.doc.currentTurn && !this.busy;
  }

  private moves(): Move[] {
    const doc = this.view?.doc as CheckersDoc | undefined;
    return doc ? legalMoves(positionOf(doc.board, doc.currentTurn)) : [];
  }

  /** Select a piece that can move, or finish a move on its landing square. */
  private pick(sq: number): void {
    if (!this.myTurn()) return;
    const moves = this.moves();
    if (moves.some((m) => m.path[0] === sq)) {
      this.selected = sq;
      return this.render();
    }
    const move = moves.find((m) => m.path[0] === this.selected && m.path[m.path.length - 1] === sq);
    if (!move) {
      if (this.selected >= 0 && moves.some((m) => m.captures.length > 0)) this.chrome.notice('A capture is required');
      this.selected = -1;
      return this.render();
    }
    this.selected = -1;
    this.busy = true;
    this.render();
    void this.attempt(() => moveCheckers(this.connection(), this.matchId, move)).finally(() => {
      this.busy = false;
      this.render();
    });
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

  private onSnapshot(before: CheckersDoc | undefined): void {
    const doc = this.view?.doc as CheckersDoc | undefined;
    if (doc && doc.moveCount > 0 && doc.moveCount !== this.checked) {
      if (!verifyMove(doc)) {
        const mover: Seat = doc.currentTurn === 'host' ? 'guest' : 'host';
        const who = before && before.moveCount === doc.moveCount - 1 ? this.playerName(doc, mover) : '';
        this.forged.set(doc.moveCount, who);
        this.chrome.denied(`Move ${doc.moveCount} is not legal checkers`);
      }
      this.checked = doc.moveCount;
    }
    this.render();
  }

  private playerName(doc: CheckersDoc, seat: Seat): string {
    return doc[seat] ? `P-${String(doc[seat]).slice(-4).toUpperCase()}` : 'Waiting...';
  }

  private render(): void {
    for (const o of this.layer) o.destroy();
    this.layer = [];
    const view = this.view;
    if (!view) {
      this.chrome.setStatus('This match no longer exists', 'red');
      this.chrome.setPlayers([]);
      this.chrome.setActions([]);
      return;
    }
    const doc = view.doc as CheckersDoc;
    const seat = view.seat;
    const myTurn = this.myTurn();
    const moves = myTurn ? this.moves() : [];
    const movable = new Set(moves.map((m) => m.path[0]));
    const targets = new Set(moves.filter((m) => m.path[0] === this.selected).map((m) => m.path[m.path.length - 1]));
    const last = new Set([...doc.lastMove.path, ...doc.lastMove.captures].map(squareOf));

    for (let sq = 0; sq < 64; sq++) {
      const { x, y } = this.screen(sq);
      let color: number = isPlayable(sq) ? PALETTE.lavender : PALETTE.cream;
      if (last.has(sq)) color = PALETTE.sand;
      if (sq === this.selected) color = PALETTE.green;
      this.layer.push(this.add.rectangle(x, y, SQUARE, SQUARE, color).setOrigin(0, 0));
      const piece = isPlayable(sq) ? doc.board[squareName(sq)] : '';
      if (piece) {
        this.layer.push(this.add.image(x + SQUARE / 2, y + SQUARE / 2, SHEET.key, piece.toLowerCase()).setScale(2));
        if (piece === 'D' || piece === 'L') {
          // Kings wear a crown: three sand points on the piece's top edge.
          for (const dx of [-3, 0, 3]) this.layer.push(this.add.rectangle(x + SQUARE / 2 + dx - 1, y + 3, 2, 3, PALETTE.yellow).setOrigin(0, 0));
        }
        if (movable.has(sq) && sq !== this.selected) {
          this.layer.push(this.add.rectangle(x + 1, y + 1, SQUARE - 2, SQUARE - 2).setOrigin(0, 0).setStrokeStyle(1, PALETTE.green));
        }
      }
      if (targets.has(sq)) this.layer.push(this.add.rectangle(x + SQUARE / 2 - 2, y + SQUARE / 2 - 2, 4, 4, PALETTE.green).setOrigin(0, 0));
    }
    if (myTurn) {
      const { x, y } = this.screen(this.cursor);
      this.layer.push(this.add.rectangle(x, y, SQUARE, SQUARE).setOrigin(0, 0).setStrokeStyle(1, PALETTE.magenta));
    }

    const count = (side: 'd' | 'l') => Object.values(doc.board).filter((p) => p.toLowerCase() === side).length;
    const name = (s: Seat) => this.playerName(doc, s);
    this.chrome.setPlayers((['host', 'guest'] as const).map((s) => ({
      name: name(s),
      you: seat === s,
      active: doc.status === 'playing' && doc.currentTurn === s,
      detail: doc.status === 'waiting' ? '' : `${count(sideOfSeat(s))}`,
    })));

    const connection = this.connection();
    const forgedNote = [...this.forged].map(([n, who]) => ` Illegal: move ${n}${who ? ` (${who})` : ''}.`).join('');
    if (doc.status === 'waiting') {
      this.chrome.setStatus(seat === 'host' ? 'Waiting for an opponent to join' : 'Waiting to start');
      this.chrome.setActions(seat === 'host'
        ? [{ label: 'Cancel match', onPress: () => void this.attempt(async () => { await cancelMatch(connection, checkers, this.matchId); location.hash = '#/'; }) }]
        : []);
    } else if (doc.status === 'playing') {
      const mine = seat === doc.currentTurn;
      const jump = mine && moves.some((m) => m.captures.length > 0) ? 'You must jump. ' : '';
      this.chrome.setStatus(`${jump}${mine ? 'Your move.' : 'Their move.'}${forgedNote}`, this.forged.size > 0 ? 'red' : mine ? 'sand' : 'lavender');
      this.chrome.setActions(seat ? [{ label: 'Resign', onPress: () => void this.attempt(() => resign(connection, checkers, this.matchId, seat)) }] : []);
    } else {
      this.chrome.setActions([]);
      const result = seat === null ? `${name(doc.winner as Seat)} wins` : doc.winner === seat ? 'You win' : 'You lose';
      const how = doc.status === 'resigned' ? 'By resignation.' : 'No moves left.';
      this.chrome.setStatus(`${result}. ${how}${forgedNote}`, this.forged.size > 0 ? 'red' : 'sand');
      const key = `${this.matchId}-${doc.status}`;
      if (this.announced !== key) {
        this.announced = key;
        const arcade = { label: 'Arcade', onPress: () => (location.hash = '#/') };
        if (!seat) this.chrome.gameOver(result, `${how}${forgedNote}`, [arcade]);
        else this.stopRematch = gameOverWithRematch(connection, this.chrome, result, `${how}${forgedNote}`, {
          game: checkers.id,
          matchId: this.matchId,
          fresh: (uid) => ({ ...createdMatch(checkers, uid), rematchOf: this.matchId }),
          join: (c, id) => joinMatch(c, checkers, id),
          open: (id) => (location.hash = `#/play/checkers/${id}`),
          onError: (error) => this.report(error),
        }, [arcade]);
      }
    }
  }
}
