import * as Phaser from 'phaser';
import {
  PALETTE,
  PLAY_AREA,
  addSheetFrames,
  matchChrome,
  panel,
  text,
  usePixelCamera,
  type MatchChrome,
  type SheetSpec,
} from '@games/kit';
import { cancelWhenLeft, gameOverWithRematch, type Connection, type Seat } from '@games/turn-net';
import {
  COLLECTION,
  FLEET,
  FLEET_CELLS,
  SHIP_NAMES,
  SIZE,
  canPlace,
  createdMatch,
  randomFleet,
  shipCells,
  type BoardDoc,
  type Dir,
  type Placement,
} from './logic.ts';
import {
  cancelBattleship,
  fireBattleship,
  joinBattleship,
  readyBattleship,
  resignBattleship,
  watchBattleship,
  type BattleshipView,
} from './net.ts';

export const SHEET: SheetSpec = {
  key: 'sheet-battleship',
  url: '',
  frames: {
    water: [40, 16, 8, 8],
    fired: [40, 24, 8, 8],
    hit: [0, 24, 8, 8],
    miss: [8, 24, 8, 8],
    blast: [32, 16, 8, 8],
    bow: [16, 24, 8, 8],
    mid: [16, 32, 8, 8],
    stern: [16, 40, 8, 8],
    'sunk-bow': [24, 24, 8, 8],
    'sunk-mid': [24, 32, 8, 8],
    'sunk-stern': [24, 40, 8, 8],
  },
};

const CELL = 8;
/** The large grid: your waters while placing, theirs in battle. */
const BIG = { x: PLAY_AREA.x + 6, y: PLAY_AREA.y + 22 };
/** Your fleet in battle, at half size. */
const MINI = { x: PLAY_AREA.x + 90, y: PLAY_AREA.y + 22, cell: 3 };

export class BattleshipScene extends Phaser.Scene {
  private chrome!: MatchChrome;
  private matchId = '';
  private view: BattleshipView | null = null;
  private stop: (() => void) | null = null;
  private stopRematch: (() => void) | null = null;
  private layer: Phaser.GameObjects.GameObject[] = [];
  private caption!: Phaser.GameObjects.Text;
  private miniCaption!: Phaser.GameObjects.Text;
  private cursor = 0;
  private cursorBox!: Phaser.GameObjects.Rectangle;
  private placing: Placement[] = [];
  private dir: Dir = 'h';
  private busy = false;
  /** The last shot this tab has shown, so a new hit flashes once. */
  private shownShot = '';
  private announced = '';

  constructor() {
    super('battleship');
  }

  init(data: { matchId: string }): void {
    this.matchId = data.matchId;
    this.view = null;
    this.layer = [];
    this.placing = [];
    this.dir = 'h';
    this.cursor = 0;
    this.busy = false;
    this.shownShot = '';
    this.announced = '';
  }

  create(): void {
    usePixelCamera(this);
    addSheetFrames(this, SHEET);
    this.chrome = matchChrome(this, { title: 'Battleship', background: 'lavender', onBack: () => (location.hash = '#/') });
    panel(this, PLAY_AREA.x, PLAY_AREA.y, PLAY_AREA.width, PLAY_AREA.height, 'purple', 'cream');
    this.caption = text(this, BIG.x, PLAY_AREA.y + 8, '', { color: 'ink' });
    this.miniCaption = text(this, MINI.x, PLAY_AREA.y + 8, '', { color: 'ink' });
    this.cursorBox = this.add.rectangle(0, 0, CELL, CELL).setOrigin(0, 0).setStrokeStyle(1, PALETTE.sand).setDepth(5).setVisible(false);
    this.chrome.setStatus('Loading');

    this.input.on(Phaser.Input.Events.POINTER_MOVE, (p: Phaser.Input.Pointer) => {
      const cell = this.cellAt(p.worldX, p.worldY);
      if (cell !== null) this.moveCursor(cell);
    });
    this.input.on(Phaser.Input.Events.POINTER_DOWN, (p: Phaser.Input.Pointer) => {
      const cell = this.cellAt(p.worldX, p.worldY);
      if (cell === null) return;
      this.moveCursor(cell);
      this.act();
    });
    const keys = this.input.keyboard?.addKeys('W,A,S,D,R,F') as Record<string, Phaser.Input.Keyboard.Key> | undefined;
    if (keys) {
      keys.W.on('down', () => this.moveCursor(this.cursor - SIZE));
      keys.S.on('down', () => this.moveCursor(this.cursor + SIZE));
      keys.A.on('down', () => this.moveCursor(this.cursor - 1));
      keys.D.on('down', () => this.moveCursor(this.cursor + 1));
      keys.R.on('down', () => this.rotate());
      keys.F.on('down', () => this.act());
    }

    const connection = this.connection();
    const matchId = this.matchId;
    let waitingHost = false;
    this.stop = watchBattleship(connection, matchId, (view) => {
      this.view = view;
      waitingHost = view.match?.status === 'waiting' && view.seat === 'host';
      this.render();
    });
    const leave = cancelWhenLeft(() => waitingHost, () => cancelBattleship(connection, matchId));
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

  private cellAt(x: number, y: number): number | null {
    const col = Math.floor((x - BIG.x) / CELL);
    const row = Math.floor((y - BIG.y) / CELL);
    return col >= 0 && col < SIZE && row >= 0 && row < SIZE ? row * SIZE + col : null;
  }

  private moveCursor(cell: number): void {
    if (cell < 0 || cell >= SIZE * SIZE) return;
    this.cursor = cell;
    this.render();
  }

  private phase(): 'waiting' | 'placing' | 'ready' | 'battle' | 'over' | 'none' {
    const m = this.view?.match;
    const seat = this.view?.seat;
    if (!m) return 'none';
    if (m.status === 'waiting') return 'waiting';
    if (m.status === 'placing') return seat && !m[`${seat}Ready`] ? 'placing' : 'ready';
    if (m.status === 'playing') return 'battle';
    return 'over';
  }

  private rotate(): void {
    if (this.phase() !== 'placing') return;
    this.dir = this.dir === 'h' ? 'v' : 'h';
    this.render();
  }

  /** Place the next ship at the cursor, or fire at it. */
  private act(): void {
    const phase = this.phase();
    if (phase === 'placing' && this.placing.length < FLEET.length) {
      const next: Placement = { start: this.cursor, dir: this.dir };
      if (canPlace(this.placing, this.placing.length, next)) this.placing.push(next);
      else this.chrome.notice("A ship can't go there");
      this.render();
    } else if (phase === 'battle') {
      this.fire(this.cursor);
    }
  }

  private fire(cell: number): void {
    const view = this.view;
    const m = view?.match;
    if (!m || !view.seat || m.currentTurn !== view.seat || this.busy) return;
    const mine = view.shots.filter((s) => s.by === m[view.seat!]);
    if (mine.some((s) => s.cell === cell)) return this.chrome.notice('Already fired there');
    this.busy = true;
    void this.attempt(async () => {
      const hit = await fireBattleship(this.connection(), this.matchId, m, cell);
      this.chrome.notice(hit ? 'Hit!' : 'Miss');
    }).finally(() => {
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

  private render(): void {
    for (const o of this.layer) o.destroy();
    this.layer = [];
    const view = this.view;
    const m = view?.match;
    if (!view || !m) {
      this.chrome.setStatus(view ? 'This match no longer exists' : 'Loading', view ? 'red' : 'sand');
      this.chrome.setPlayers([]);
      this.chrome.setActions([]);
      return;
    }
    const seat = view.seat;
    const other: Seat | null = seat ? (seat === 'host' ? 'guest' : 'host') : null;
    const name = (s: Seat) => (m[s] ? `P-${String(m[s]).slice(-4).toUpperCase()}` : 'Waiting...');
    const phase = this.phase();
    this.chrome.setPlayers((['host', 'guest'] as const).map((s) => ({
      name: name(s),
      you: seat === s,
      active: m.status === 'playing' && m.currentTurn === s,
      detail: m.status === 'placing' ? (m[`${s}Ready`] ? 'ready' : '') : m.status === 'waiting' ? '' : `${m[`${s}Hits`]}/${FLEET_CELLS}`,
    })));

    const connection = this.connection();
    if (phase === 'waiting') {
      this.caption.setText('');
      this.miniCaption.setText('');
      this.drawGrid(BIG.x, BIG.y, CELL, () => 'water');
      this.chrome.setStatus(seat === 'host' ? 'Waiting for an opponent to join' : 'Waiting to start');
      this.chrome.setActions(seat === 'host'
        ? [{ label: 'Cancel match', onPress: () => void this.attempt(async () => { await cancelBattleship(connection, this.matchId); location.hash = '#/'; }) }]
        : []);
      this.cursorBox.setVisible(false);
      return;
    }

    if (phase === 'placing' || phase === 'ready') {
      const placed = phase === 'ready' && view.mine ? placementsOf(view.mine) : this.placing;
      this.caption.setText('YOUR WATERS');
      this.miniCaption.setText('');
      this.drawGrid(BIG.x, BIG.y, CELL, () => 'water');
      placed.forEach((p, i) => this.drawShip(p, FLEET[i], false));
      const nextIndex = this.placing.length;
      if (phase === 'placing' && nextIndex < FLEET.length) {
        const ghost: Placement = { start: this.cursor, dir: this.dir };
        const ok = canPlace(this.placing, nextIndex, ghost);
        for (const c of shipCells(FLEET[nextIndex], ghost)) {
          if (c < 0 || c >= SIZE * SIZE || (ghost.dir === 'h' && Math.floor(c / SIZE) !== Math.floor(ghost.start / SIZE))) continue;
          this.layer.push(this.add.rectangle(BIG.x + (c % SIZE) * CELL, BIG.y + Math.floor(c / SIZE) * CELL, CELL, CELL, ok ? PALETTE.sand : PALETTE.red, 0.6).setOrigin(0, 0));
        }
        this.chrome.setStatus(`Place your ${SHIP_NAMES[nextIndex]} (${FLEET[nextIndex]}). R rotates.`);
      } else if (phase === 'placing') {
        this.chrome.setStatus('Fleet placed. Ready when you are.');
      } else {
        this.chrome.setStatus('Waiting for the other fleet', 'lavender');
      }
      this.cursorBox.setVisible(phase === 'placing').setPosition(BIG.x + (this.cursor % SIZE) * CELL, BIG.y + Math.floor(this.cursor / SIZE) * CELL);
      this.chrome.setActions(phase === 'placing' ? [
        { label: 'Random', onPress: () => { this.placing = randomFleet(Math.random); this.render(); } },
        { label: 'Clear', onPress: () => { this.placing = []; this.render(); }, enabled: this.placing.length > 0 },
        {
          label: 'Ready',
          enabled: this.placing.length === FLEET.length,
          onPress: () => void this.attempt(() => readyBattleship(connection, this.matchId, m, seat!, this.placing)),
        },
      ] : []);
      return;
    }

    // Battle and game over: their waters large, your fleet small.
    const myShots = view.shots.filter((s) => seat && s.by === m[seat]);
    const theirShots = view.shots.filter((s) => other && s.by === m[other]);
    const shotAt = new Map(myShots.map((s) => [s.cell, s.hit]));
    const theirs = view.theirs;
    this.caption.setText('THEIR WATERS');
    this.miniCaption.setText('YOURS');
    this.drawGrid(BIG.x, BIG.y, CELL, (c) => (shotAt.has(c) ? 'fired' : 'water'));
    if (theirs) placementsOf(theirs).forEach((p, i) => this.drawShip(p, FLEET[i], true));
    for (const [c, hit] of shotAt) {
      this.layer.push(this.add.image(BIG.x + (c % SIZE) * CELL + 4, BIG.y + Math.floor(c / SIZE) * CELL + 4, SHEET.key, hit ? 'hit' : 'miss').setDepth(3));
    }
    this.drawMini(view.mine, theirShots.map((s) => s.cell));

    if (m.lastShot !== this.shownShot) {
      const cell = Number(m.lastShot.slice(1));
      const mineHit = m.lastShot[0] === (seat === 'host' ? 'h' : 'g') && shotAt.get(cell) === true;
      if (this.shownShot !== '' && mineHit) this.blast(cell);
      this.shownShot = m.lastShot;
    }

    const myTurn = m.status === 'playing' && seat === m.currentTurn;
    this.cursorBox.setVisible(myTurn).setPosition(BIG.x + (this.cursor % SIZE) * CELL, BIG.y + Math.floor(this.cursor / SIZE) * CELL);
    if (m.status === 'playing') {
      this.chrome.setStatus(myTurn ? (this.busy ? 'Firing' : 'Your shot. WASD and F, or click.') : 'Their shot', myTurn ? 'sand' : 'lavender');
      this.chrome.setActions(seat ? [
        { label: 'Fire', onPress: () => this.fire(this.cursor), enabled: myTurn && !this.busy },
        { label: 'Resign', onPress: () => void this.attempt(() => resignBattleship(connection, this.matchId, seat)) },
      ] : []);
    } else {
      this.chrome.setActions([]);
      const result = seat === null ? `${name(m.winner as Seat)} wins` : m.winner === seat ? 'You win' : 'You lose';
      const how = m.status === 'resigned' ? 'By resignation.' : 'Every ship sunk.';
      this.chrome.setStatus(`${result}. ${how}`);
      const key = `${this.matchId}-${m.status}`;
      if (this.announced !== key) {
        this.announced = key;
        const arcade = { label: 'Arcade', onPress: () => (location.hash = '#/') };
        if (!seat) this.chrome.gameOver(result, how, [arcade]);
        else this.stopRematch = gameOverWithRematch(connection, this.chrome, result, how, {
          game: COLLECTION,
          matchId: this.matchId,
          fresh: (uid) => ({ ...createdMatch(uid), rematchOf: this.matchId }),
          join: joinBattleship,
          open: (id) => (location.hash = `#/play/battleship/${id}`),
          onError: (error) => this.report(error),
        }, [arcade]);
      }
    }
  }

  private drawGrid(x: number, y: number, cell: number, frame: (c: number) => string): void {
    for (let c = 0; c < SIZE * SIZE; c++) {
      this.layer.push(this.add.image(x + (c % SIZE) * cell, y + Math.floor(c / SIZE) * cell, SHEET.key, frame(c)).setOrigin(0, 0));
    }
  }

  /** A ship from its bow, middle and stern sprites; horizontal ships turn a quarter. */
  private drawShip(p: Placement, length: number, sunk: boolean): void {
    shipCells(length, p).forEach((c, k) => {
      const part = k === 0 ? 'bow' : k === length - 1 ? 'stern' : 'mid';
      const image = this.add.image(BIG.x + (c % SIZE) * CELL + 4, BIG.y + Math.floor(c / SIZE) * CELL + 4, SHEET.key, sunk ? `sunk-${part}` : part).setDepth(2);
      if (p.dir === 'h') image.setAngle(-90);
      this.layer.push(image);
    });
  }

  private drawMini(board: BoardDoc | null, incoming: number[]): void {
    const { x, y, cell } = MINI;
    this.layer.push(this.add.rectangle(x - 1, y - 1, SIZE * cell + 2, SIZE * cell + 2, PALETTE.purple).setOrigin(0, 0));
    const ships = new Set(board?.cells ?? []);
    const hitSet = new Set(incoming);
    for (let c = 0; c < SIZE * SIZE; c++) {
      const color = hitSet.has(c) ? (ships.has(c) ? PALETTE.red : PALETTE.ink) : ships.has(c) ? PALETTE.cream : PALETTE.lavender;
      this.layer.push(this.add.rectangle(x + (c % SIZE) * cell, y + Math.floor(c / SIZE) * cell, cell - 1, cell - 1, color).setOrigin(0, 0));
    }
    const left = board ? board.cells.filter((c) => !hitSet.has(c)).length : FLEET_CELLS;
    this.layer.push(text(this, x, y + SIZE * cell + 4, `${left}\nAFLOAT`, { color: 'ink' }));
  }

  private blast(cell: number): void {
    const flash = this.add.image(BIG.x + (cell % SIZE) * CELL + 4, BIG.y + Math.floor(cell / SIZE) * CELL + 4, SHEET.key, 'blast').setDepth(6).setScale(0.5);
    this.tweens.add({ targets: flash, scale: 2.5, alpha: 0, duration: 380, ease: 'Quad.easeOut', onComplete: () => flash.destroy() });
  }
}

function placementsOf(board: BoardDoc): Placement[] {
  return board.starts.map((start, i) => ({ start, dir: board.dirs[i] }));
}
