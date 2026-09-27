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
import { legalMoves, squareName, squareOfName } from './reversi.ts';
import { mustPass, positionOf, reversi, squareKey, squareOfKey, verifyMove, type ReversiDoc, type ReversiFields } from './logic.ts';
import { moveReversi, passReversi } from './net.ts';

export const SHEET: SheetSpec = {
  key: 'sheet-reversi',
  url: '',
  frames: { d: [24, 16, 8, 8], l: [32, 16, 8, 8], tile: [40, 16, 8, 8] },
};

const SQUARE = 16;

export class ReversiScene extends Phaser.Scene {
  private chrome!: MatchChrome;
  private matchId = '';
  private view: MatchView<ReversiFields> | null = null;
  private stop: (() => void) | null = null;
  private stopRematch: (() => void) | null = null;
  private layer: Phaser.GameObjects.GameObject[] = [];
  private cursor = squareOfName('d3');
  private busy = false;
  private forged = new Map<number, string>();
  private checked = -1;
  private announced = '';

  constructor() {
    super('reversi');
  }

  init(data: { matchId: string }): void {
    this.matchId = data.matchId;
    this.view = null;
    this.layer = [];
    this.cursor = squareOfName('d3');
    this.busy = false;
    this.forged = new Map();
    this.checked = -1;
    this.announced = '';
  }

  create(): void {
    usePixelCamera(this);
    addSheetFrames(this, SHEET);
    this.chrome = matchChrome(this, { title: 'Reversi', background: 'maroon', onBack: () => (location.hash = '#/') });
    this.add.rectangle(PLAY_AREA.x - 2, PLAY_AREA.y - 2, PLAY_AREA.width + 4, PLAY_AREA.height + 4, PALETTE.red).setOrigin(0, 0);
    this.chrome.setStatus('Loading');

    this.input.on(Phaser.Input.Events.POINTER_DOWN, (p: Phaser.Input.Pointer) => {
      const sq = this.squareAt(p.worldX, p.worldY);
      if (sq !== null) {
        this.cursor = sq;
        this.place(sq);
      }
    });
    const keys = this.input.keyboard?.addKeys('W,A,S,D,F') as Record<string, Phaser.Input.Keyboard.Key> | undefined;
    if (keys) {
      const flip = () => (this.view?.seat === 'guest' ? -1 : 1);
      keys.W.on('down', () => this.nudge(-8 * flip()));
      keys.S.on('down', () => this.nudge(8 * flip()));
      keys.A.on('down', () => this.nudge(-1 * flip()));
      keys.D.on('down', () => this.nudge(1 * flip()));
      keys.F.on('down', () => this.place(this.cursor));
    }

    const connection = this.connection();
    const matchId = this.matchId;
    let waitingHost = false;
    this.stop = watchMatch(connection, reversi, matchId, (view) => {
      const before = this.view?.doc as ReversiDoc | undefined;
      this.view = view;
      waitingHost = view?.doc.status === 'waiting' && view.seat === 'host';
      this.onSnapshot(before);
    });
    const leave = cancelWhenLeft(() => waitingHost, () => cancelMatch(connection, reversi, matchId));
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

  /** The guest sees the board turned around, light discs' home at the bottom. */
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

  private moves(): number[] {
    const doc = this.view?.doc as ReversiDoc | undefined;
    return doc ? legalMoves(positionOf(doc.board, doc.currentTurn)) : [];
  }

  private place(sq: number): void {
    if (!this.myTurn()) return;
    if (!this.moves().includes(sq)) {
      this.chrome.notice(`${squareName(sq).toUpperCase()} flips nothing`);
      return;
    }
    this.act(() => moveReversi(this.connection(), this.matchId, sq));
  }

  private act(action: () => Promise<unknown>): void {
    this.busy = true;
    this.render();
    void this.attempt(action).finally(() => {
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

  private onSnapshot(before: ReversiDoc | undefined): void {
    const doc = this.view?.doc as ReversiDoc | undefined;
    if (doc && doc.moveCount > 0 && doc.moveCount !== this.checked) {
      if (!verifyMove(doc)) {
        const mover: Seat = doc.currentTurn === 'host' ? 'guest' : 'host';
        const who = before && before.moveCount === doc.moveCount - 1 ? this.playerName(doc, mover) : '';
        this.forged.set(doc.moveCount, who);
        const what = doc.lastMove.at === '' ? 'pass' : doc.status === 'playing' ? 'move' : 'end';
        this.chrome.denied(`Move ${doc.moveCount} is not a legal ${what}`);
      }
      this.checked = doc.moveCount;
    }
    this.render();
  }

  private playerName(doc: ReversiDoc, seat: Seat): string {
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
    const doc = view.doc as ReversiDoc;
    const seat = view.seat;
    const myTurn = this.myTurn();
    const targets = new Set(myTurn ? this.moves() : []);
    const last = doc.lastMove.at ? squareOfKey(doc.lastMove.at) : -1;

    for (let sq = 0; sq < 64; sq++) {
      const { x, y } = this.screen(sq);
      this.layer.push(this.add.image(x, y, SHEET.key, 'tile').setOrigin(0, 0).setScale(2));
      const disc = doc.board[squareKey(sq)];
      if (disc) this.layer.push(this.add.image(x + SQUARE / 2, y + SQUARE / 2, SHEET.key, disc).setScale(2));
      else if (targets.has(sq)) this.layer.push(this.add.rectangle(x + SQUARE / 2 - 2, y + SQUARE / 2 - 2, 3, 3, PALETTE.sand).setOrigin(0, 0));
      if (sq === last) this.layer.push(this.add.rectangle(x + 1, y + 1, SQUARE - 3, SQUARE - 3).setOrigin(0, 0).setStrokeStyle(1, PALETTE.orange));
    }
    if (myTurn) {
      const { x, y } = this.screen(this.cursor);
      this.layer.push(this.add.rectangle(x, y, SQUARE, SQUARE).setOrigin(0, 0).setStrokeStyle(1, PALETTE.magenta));
    }

    const name = (s: Seat) => this.playerName(doc, s);
    this.chrome.setPlayers((['host', 'guest'] as const).map((s) => ({
      name: name(s),
      mark: s === 'host' ? 'D' : 'L',
      markColor: s === 'host' ? 'lavender' : 'cream',
      you: seat === s,
      active: doc.status === 'playing' && doc.currentTurn === s,
      detail: doc.status === 'waiting' ? '' : `${doc.counts[s === 'host' ? 'd' : 'l']}`,
    })));

    const connection = this.connection();
    const forgedNote = [...this.forged].map(([n, who]) => ` Illegal: move ${n}${who ? ` (${who})` : ''}.`).join('');
    if (doc.status === 'waiting') {
      this.chrome.setStatus(seat === 'host' ? 'Waiting for an opponent to join' : 'Waiting to start');
      this.chrome.setActions(seat === 'host'
        ? [{ label: 'Cancel match', onPress: () => void this.attempt(async () => { await cancelMatch(connection, reversi, this.matchId); location.hash = '#/'; }) }]
        : []);
    } else if (doc.status === 'playing') {
      const mine = seat === doc.currentTurn;
      const pass = mine && mustPass(doc);
      // The pass notice gives way to a flagged move, so the status keeps to three lines.
      const passed = doc.lastMove.at === '' && doc.moveCount > 0 && this.forged.size === 0
        ? `${name(doc.currentTurn === 'host' ? 'guest' : 'host')} passed. ` : '';
      const line = pass ? 'No move: pass.' : mine ? 'Your move.' : 'Their move.';
      this.chrome.setStatus(`${passed}${line}${forgedNote}`, this.forged.size > 0 ? 'red' : mine ? 'sand' : 'lavender');
      const actions = [];
      if (pass) actions.push({ label: 'Pass', onPress: () => this.act(() => passReversi(connection, this.matchId)), enabled: !this.busy });
      if (seat) actions.push({ label: 'Resign', onPress: () => void this.attempt(() => resign(connection, reversi, this.matchId, seat)) });
      this.chrome.setActions(actions);
    } else {
      this.chrome.setActions([]);
      const score = `${doc.counts.d} to ${doc.counts.l}`;
      const result = doc.status === 'draw' ? 'Draw' : seat === null ? `${name(doc.winner as Seat)} wins` : doc.winner === seat ? 'You win' : 'You lose';
      const how = doc.status === 'resigned' ? 'By resignation.' : doc.counts.d + doc.counts.l === 64 ? `Board full, ${score}.` : `No moves left, ${score}.`;
      this.chrome.setStatus(`${result}. ${how}${forgedNote}`, this.forged.size > 0 ? 'red' : 'sand');
      const key = `${this.matchId}-${doc.status}`;
      if (this.announced !== key) {
        this.announced = key;
        const arcade = { label: 'Arcade', onPress: () => (location.hash = '#/') };
        if (!seat) this.chrome.gameOver(result, `${how}${forgedNote}`, [arcade]);
        else this.stopRematch = gameOverWithRematch(connection, this.chrome, result, `${how}${forgedNote}`, {
          game: reversi.id,
          matchId: this.matchId,
          fresh: (uid) => createdMatch(reversi, uid),
          join: (c, id) => joinMatch(c, reversi, id),
          open: (id) => (location.hash = `#/play/reversi/${id}`),
          onError: (error) => this.report(error),
        }, [arcade]);
      }
    }
  }
}
