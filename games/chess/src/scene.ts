import * as Phaser from 'phaser';
import {
  PALETTE,
  PLAY_AREA,
  addSheetFrames,
  matchChrome,
  overlay,
  usePixelCamera,
  type MatchChrome,
  type SheetSpec,
} from '@games/kit';
import { cancelMatch, cancelWhenLeft, createdMatch, gameOverWithRematch, joinMatch, resign, watchMatch, type Connection, type MatchView, type Seat } from '@games/turn-net';
import { inCheck, legalMoves, squareName, squareOf, type Kind, type Move } from './chess.ts';
import { chess, colorOf, positionOf, verifyMove, type ChessDoc, type ChessFields } from './logic.ts';
import { moveChess } from './net.ts';

const KINDS: Kind[] = ['p', 'r', 'n', 'b', 'q', 'k'];

export const SHEET: SheetSpec = {
  key: 'sheet-chess',
  url: '',
  frames: Object.fromEntries(
    (['b', 'w'] as const).flatMap((color, c) =>
      KINDS.map((kind, i) => [`${color}${kind}`, [40 + (i % 3) * 8, 16 + c * 16 + Math.floor(i / 3) * 8, 8, 8] as const]),
    ),
  ),
};

const SQUARE = 16;
const PIECE_NAMES: Record<string, string> = { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' };

export class ChessScene extends Phaser.Scene {
  private chrome!: MatchChrome;
  private matchId = '';
  private view: MatchView<ChessFields> | null = null;
  private stop: (() => void) | null = null;
  private stopRematch: (() => void) | null = null;
  private layer: Phaser.GameObjects.GameObject[] = [];
  private cursor = squareOf('e2');
  private selected = -1;
  private busy = false;
  private forged = new Map<number, string>();
  private checked = -1;
  private announced = '';
  private closePicker: (() => void) | null = null;

  constructor() {
    super('chess');
  }

  init(data: { matchId: string }): void {
    this.matchId = data.matchId;
    this.view = null;
    this.layer = [];
    this.cursor = squareOf('e2');
    this.selected = -1;
    this.busy = false;
    this.forged = new Map();
    this.checked = -1;
    this.announced = '';
  }

  create(): void {
    usePixelCamera(this);
    addSheetFrames(this, SHEET);
    this.chrome = matchChrome(this, { title: 'Chess', background: 'ink', onBack: () => (location.hash = '#/') });
    this.add.rectangle(PLAY_AREA.x - 2, PLAY_AREA.y - 2, PLAY_AREA.width + 4, PLAY_AREA.height + 4, PALETTE.purple).setOrigin(0, 0);
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
    this.stop = watchMatch(connection, chess, matchId, (view) => {
      const before = this.view?.doc as ChessDoc | undefined;
      this.view = view;
      waitingHost = view?.doc.status === 'waiting' && view.seat === 'host';
      this.onSnapshot(before);
    });
    const leave = cancelWhenLeft(() => waitingHost, () => cancelMatch(connection, chess, matchId));
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

  /** Screen position of a square; black sees the board from their side. */
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

  private movesFrom(sq: number): Move[] {
    const doc = this.view?.doc as ChessDoc | undefined;
    if (!doc) return [];
    return legalMoves(positionOf(doc)).filter((m) => m.from === sq);
  }

  /** Select one of your pieces, or move the selected piece here. */
  private pick(sq: number): void {
    if (!this.myTurn()) return;
    const doc = this.view!.doc as ChessDoc;
    const piece = doc.board[squareName(sq)];
    if (piece && piece[0] === colorOf(this.view!.seat!)) {
      this.selected = sq;
      return this.render();
    }
    if (this.selected < 0) return;
    const moves = this.movesFrom(this.selected).filter((m) => m.to === sq);
    if (moves.length === 0) {
      this.selected = -1;
      return this.render();
    }
    if (moves.length > 1) return this.pickPromotion(moves);
    this.play(moves[0]);
  }

  private pickPromotion(moves: Move[]): void {
    this.closePicker?.();
    this.closePicker = overlay(this, 'Promote to', 'Choose a piece.', moves.map((m) => ({
      label: PIECE_NAMES[m.promotion!],
      onPress: () => {
        this.closePicker = null;
        this.play(m);
      },
    })));
  }

  private play(move: Move): void {
    this.selected = -1;
    this.busy = true;
    this.render();
    void this.attempt(() => moveChess(this.connection(), this.matchId, move)).finally(() => {
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

  private onSnapshot(before: ChessDoc | undefined): void {
    const doc = this.view?.doc as ChessDoc | undefined;
    if (doc && doc.moveCount > 0 && doc.moveCount !== this.checked) {
      if (!verifyMove(doc)) {
        const mover: Seat = doc.currentTurn === 'host' ? 'guest' : 'host';
        const who = before && before.moveCount === doc.moveCount - 1 ? this.playerName(doc, mover) : '';
        this.forged.set(doc.moveCount, who);
        this.chrome.denied(`Move ${doc.moveCount} is not legal chess`);
      }
      this.checked = doc.moveCount;
    }
    this.render();
  }

  private playerName(doc: ChessDoc, seat: Seat): string {
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
    const doc = view.doc as ChessDoc;
    const seat = view.seat;
    const targets = new Set(this.selected >= 0 ? this.movesFrom(this.selected).map((m) => m.to) : []);
    const last = new Set([doc.lastMove.from, doc.lastMove.to].filter(Boolean).map(squareOf));
    const position = positionOf(doc);
    const checkedKing = doc.status === 'playing' && inCheck(position) ? position.board.indexOf(`${position.turn}k`) : -1;

    for (let sq = 0; sq < 64; sq++) {
      const { x, y } = this.screen(sq);
      const light = (Math.floor(sq / 8) + (sq % 8)) % 2 === 0;
      let color: number = light ? PALETTE.cream : PALETTE.lavender;
      if (last.has(sq)) color = light ? PALETTE.sand : PALETTE.orange;
      if (sq === checkedKing) color = PALETTE.red;
      if (sq === this.selected) color = PALETTE.green;
      this.layer.push(this.add.rectangle(x, y, SQUARE, SQUARE, color).setOrigin(0, 0));
      const piece = doc.board[squareName(sq)];
      if (piece) this.layer.push(this.add.image(x + SQUARE / 2, y + SQUARE / 2, SHEET.key, piece).setScale(2));
      if (targets.has(sq)) {
        this.layer.push(piece
          ? this.add.rectangle(x + 1, y + 1, SQUARE - 2, SQUARE - 2).setOrigin(0, 0).setStrokeStyle(1, PALETTE.green)
          : this.add.rectangle(x + SQUARE / 2 - 2, y + SQUARE / 2 - 2, 4, 4, PALETTE.green).setOrigin(0, 0));
      }
    }
    if (this.myTurn()) {
      const { x, y } = this.screen(this.cursor);
      this.layer.push(this.add.rectangle(x, y, SQUARE, SQUARE).setOrigin(0, 0).setStrokeStyle(1, PALETTE.magenta));
    }

    const name = (s: Seat) => this.playerName(doc, s);
    this.chrome.setPlayers((['host', 'guest'] as const).map((s) => ({
      mark: s === 'host' ? 'W' : 'B',
      markColor: s === 'host' ? 'cream' : 'red',
      name: name(s),
      you: seat === s,
      active: doc.status === 'playing' && doc.currentTurn === s,
    })));

    const connection = this.connection();
    const forgedNote = [...this.forged].map(([n, who]) => ` Illegal: move ${n}${who ? ` (${who})` : ''}.`).join('');
    const lastText = doc.lastMove.from ? `${doc.lastMove.from}-${doc.lastMove.to}. ` : '';
    if (doc.status === 'waiting') {
      this.chrome.setStatus(seat === 'host' ? 'Waiting for an opponent to join' : 'Waiting to start');
      this.chrome.setActions(seat === 'host'
        ? [{ label: 'Cancel match', onPress: () => void this.attempt(async () => { await cancelMatch(connection, chess, this.matchId); location.hash = '#/'; }) }]
        : []);
    } else if (doc.status === 'playing') {
      const myTurn = seat === doc.currentTurn;
      const check = checkedKing >= 0 ? 'Check! ' : '';
      this.chrome.setStatus(`${lastText}${check}${myTurn ? 'Your move.' : 'Their move.'}${forgedNote}`, this.forged.size > 0 ? 'red' : myTurn ? 'sand' : 'lavender');
      this.chrome.setActions(seat ? [{ label: 'Resign', onPress: () => void this.attempt(() => resign(connection, chess, this.matchId, seat)) }] : []);
    } else {
      this.chrome.setActions([]);
      const result = doc.status === 'draw' ? 'Draw' : seat === null ? `${name(doc.winner as Seat)} wins` : doc.winner === seat ? 'You win' : 'You lose';
      const how = doc.status === 'resigned' ? 'By resignation.' : doc.status === 'draw' ? 'Stalemate.' : 'Checkmate.';
      this.chrome.setStatus(`${result}. ${how}${forgedNote}`, this.forged.size > 0 ? 'red' : 'sand');
      const key = `${this.matchId}-${doc.status}`;
      if (this.announced !== key) {
        this.announced = key;
        const arcade = { label: 'Arcade', onPress: () => (location.hash = '#/') };
        if (!seat) this.chrome.gameOver(result, `${how}${forgedNote}`, [arcade]);
        else this.stopRematch = gameOverWithRematch(connection, this.chrome, result, `${how}${forgedNote}`, {
          game: chess.id,
          matchId: this.matchId,
          fresh: (uid) => createdMatch(chess, uid),
          join: (c, id) => joinMatch(c, chess, id),
          open: (id) => (location.hash = `#/play/chess/${id}`),
          onError: (error) => this.report(error),
        }, [arcade]);
      }
    }
  }
}
