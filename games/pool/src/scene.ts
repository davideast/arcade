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
import { cancelMatch, createMatch, resign, watchMatch, type Connection, type MatchView, type Seat } from '@games/turn-net';
import { groupBalls, groupOf, pool, verifyShot, type PoolDoc, type PoolFields } from './logic.ts';
import { shootPool } from './net.ts';
import { BALL_COUNT, BALL_RADIUS, OFF_TABLE, POCKET_CENTERS, TABLE_HEIGHT, TABLE_WIDTH, type Shot } from './physics.ts';

const BALL_SPOTS: ReadonlyArray<readonly [number, number]> = [
  [1, 49], [9, 49], [17, 49], [25, 49], [33, 49], [41, 49],
  [1, 57], [9, 57], [17, 57], [25, 57], [33, 57], [41, 57],
  [1, 65], [9, 65], [17, 65], [25, 65],
];

export const SHEET: SheetSpec = {
  key: 'sheet-pool',
  url: '',
  frames: {
    pocket: [4, 20, 8, 8],
    ...Object.fromEntries(BALL_SPOTS.map(([x, y], n) => [`ball-${n}`, [x, y, 6, 6] as const])),
  },
};

/** Table-local (0, 0) in logical pixels. */
const TABLE = { x: PLAY_AREA.x + 8, y: PLAY_AREA.y + 30 };
const TRAY_Y = PLAY_AREA.y + 12;
const METER = { x: PLAY_AREA.x + 8, y: PLAY_AREA.y + 106, width: 112 };
/** Simulation steps drawn per rendered frame. */
const STEPS_PER_FRAME = 2;

export class PoolScene extends Phaser.Scene {
  private chrome!: MatchChrome;
  private matchId = '';
  private view: MatchView<PoolFields> | null = null;
  private stop: (() => void) | null = null;
  private balls: Phaser.GameObjects.Image[] = [];
  private tray: Phaser.GameObjects.GameObject[] = [];
  private aimDots: Phaser.GameObjects.Rectangle[] = [];
  private meterFill!: Phaser.GameObjects.Rectangle;
  private hint!: Phaser.GameObjects.Text;
  private aim = { angle: 0, power: 50 };
  private shownMove = -1;
  private playing: Float64Array[] | null = null;
  private frameIndex = 0;
  private busy = false;
  /** Shots whose stored result doesn't replay, with the shooter when this tab saw the table before the shot. */
  private forged = new Map<number, string>();
  private announced = '';

  constructor() {
    super('pool');
  }

  init(data: { matchId: string }): void {
    this.matchId = data.matchId;
    this.view = null;
    this.shownMove = -1;
    this.playing = null;
    this.busy = false;
    this.forged = new Map();
    this.announced = '';
    this.balls = [];
    this.tray = [];
    this.aimDots = [];
  }

  create(): void {
    usePixelCamera(this);
    addSheetFrames(this, SHEET);
    this.chrome = matchChrome(this, { title: 'Pool', background: 'green', onBack: () => (location.hash = '#/') });
    panel(this, PLAY_AREA.x, PLAY_AREA.y, PLAY_AREA.width, PLAY_AREA.height, 'orange', 'ink');
    this.drawTable();
    for (let n = 0; n < BALL_COUNT; n++) this.balls.push(this.add.image(0, 0, SHEET.key, `ball-${n}`).setVisible(false));
    for (let k = 0; k < 14; k++) this.aimDots.push(this.add.rectangle(0, 0, 1, 1, PALETTE.cream).setVisible(false));

    text(this, METER.x, METER.y - 10, 'POWER', { color: 'lavender' });
    this.add.rectangle(METER.x, METER.y, METER.width, 5, PALETTE.maroon).setOrigin(0, 0).setStrokeStyle(1, PALETTE.orange);
    this.meterFill = this.add.rectangle(METER.x + 1, METER.y + 1, 0, 3, PALETTE.sand).setOrigin(0, 0);
    this.hint = text(this, METER.x, METER.y + 8, '', { color: 'lavender', wrap: METER.width });

    this.input.on(Phaser.Input.Events.POINTER_MOVE, (p: Phaser.Input.Pointer) => this.aimAt(p));
    this.input.on(Phaser.Input.Events.POINTER_DOWN, (p: Phaser.Input.Pointer) => {
      if (this.onTable(p)) {
        this.aimAt(p);
        this.shoot();
      }
    });
    const keys = this.input.keyboard?.addKeys('A,D,W,S') as Record<string, Phaser.Input.Keyboard.Key> | undefined;
    if (keys) {
      keys.A.on('down', () => this.nudge(-3, 0));
      keys.D.on('down', () => this.nudge(3, 0));
      keys.W.on('down', () => this.nudge(0, 5));
      keys.S.on('down', () => this.nudge(0, -5));
    }

    this.chrome.setStatus('Loading table');
    this.stop = watchMatch(this.connection(), pool, this.matchId, (view) => {
      const before = this.view?.doc as PoolDoc | undefined;
      this.view = view;
      this.onSnapshot(before);
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.stop?.());
  }

  update(): void {
    if (!this.playing) return;
    this.frameIndex = Math.min(this.frameIndex + STEPS_PER_FRAME, this.playing.length - 1);
    this.placeBalls(this.playing[this.frameIndex], 1);
    if (this.frameIndex >= this.playing.length - 1) {
      this.playing = null;
      this.render();
    }
  }

  private connection(): Connection {
    return this.game.registry.get('connection') as Connection;
  }

  private drawTable(): void {
    this.add.rectangle(TABLE.x - 4, TABLE.y - 4, TABLE_WIDTH + 8, TABLE_HEIGHT + 8, PALETTE.ink)
      .setOrigin(0, 0).setStrokeStyle(1, PALETTE.orange);
    this.add.rectangle(TABLE.x - 2, TABLE.y - 2, TABLE_WIDTH + 4, TABLE_HEIGHT + 4, PALETTE.ink)
      .setOrigin(0, 0).setStrokeStyle(1, PALETTE.orange);
    this.add.rectangle(TABLE.x, TABLE.y, TABLE_WIDTH, TABLE_HEIGHT, PALETTE.green).setOrigin(0, 0);
    for (const [x, y] of POCKET_CENTERS) {
      this.add.image(TABLE.x + Math.min(Math.max(x, 1), TABLE_WIDTH - 1), TABLE.y + Math.min(Math.max(y, 1), TABLE_HEIGHT - 1), SHEET.key, 'pocket');
    }
  }

  private placeBalls(positions: ArrayLike<number>, scale: number): void {
    for (let n = 0; n < BALL_COUNT; n++) {
      const x = positions[n * 2];
      const on = x !== OFF_TABLE;
      this.balls[n].setVisible(on);
      if (on) this.balls[n].setPosition(Math.round(TABLE.x + (x / scale)), Math.round(TABLE.y + positions[n * 2 + 1] / scale));
    }
  }

  private myTurn(): boolean {
    const view = this.view;
    return !!view && view.doc.status === 'playing' && view.seat === view.doc.currentTurn && !this.playing && !this.busy;
  }

  private cue(): { x: number; y: number } | null {
    const doc = this.view?.doc as PoolDoc | undefined;
    if (!doc) return null;
    return { x: TABLE.x + doc.balls[0] / 100, y: TABLE.y + doc.balls[1] / 100 };
  }

  private onTable(p: Phaser.Input.Pointer): boolean {
    const x = p.worldX;
    const y = p.worldY;
    return x >= TABLE.x - 4 && x <= TABLE.x + TABLE_WIDTH + 4 && y >= TABLE.y - 4 && y <= TABLE.y + TABLE_HEIGHT + 4;
  }

  private aimAt(p: Phaser.Input.Pointer): void {
    const cue = this.cue();
    if (!cue || !this.myTurn() || !this.onTable(p)) return;
    const dx = p.worldX - cue.x;
    const dy = p.worldY - cue.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < 2) return;
    this.aim = { angle: Math.atan2(dy, dx), power: Math.min(100, Math.max(5, Math.round((distance - 4) * 2.5))) };
    this.drawAim();
  }

  private nudge(degrees: number, power: number): void {
    if (!this.myTurn()) return;
    this.aim = {
      angle: this.aim.angle + (degrees * Math.PI) / 180,
      power: Math.min(100, Math.max(5, this.aim.power + power)),
    };
    this.drawAim();
  }

  private drawAim(): void {
    const cue = this.cue();
    const show = !!cue && this.myTurn();
    const count = show ? Math.round(3 + this.aim.power / 9) : 0;
    this.aimDots.forEach((dot, k) => {
      const r = BALL_RADIUS + 3 + k * 3;
      const x = cue ? Math.round(cue.x + Math.cos(this.aim.angle) * r) : 0;
      const y = cue ? Math.round(cue.y + Math.sin(this.aim.angle) * r) : 0;
      const onCloth = x >= TABLE.x && x < TABLE.x + TABLE_WIDTH && y >= TABLE.y && y < TABLE.y + TABLE_HEIGHT;
      dot.setVisible(k < count && onCloth).setPosition(x, y);
    });
    this.meterFill.width = show ? Math.round(((METER.width - 2) * this.aim.power) / 100) : 0;
  }

  private shotFromAim(): Shot {
    const cx = Math.cos(this.aim.angle);
    const cy = Math.sin(this.aim.angle);
    const scale = 1000 / Math.max(Math.abs(cx), Math.abs(cy));
    return { dx: Math.round(cx * scale), dy: Math.round(cy * scale), power: this.aim.power };
  }

  private shoot(): void {
    if (!this.myTurn()) return;
    this.busy = true;
    this.drawAim();
    void this.attempt(() => shootPool(this.connection(), this.matchId, this.shotFromAim())).finally(() => {
      this.busy = false;
      this.render();
    });
  }

  private async attempt(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/denied|permission/i.test(message)) this.chrome.denied();
      else this.chrome.notice(message.slice(0, 40));
    }
  }

  /** Replay each new shot; animate it when the stored result matches, flag it when it doesn't. */
  private onSnapshot(before: PoolDoc | undefined): void {
    const view = this.view;
    if (!view) return this.render();
    const doc = view.doc as PoolDoc;
    if (doc.moveCount !== this.shownMove && doc.moveCount > 0) {
      const { ok, result } = verifyShot(doc);
      if (!ok) {
        const shooter = before && before.moveCount === doc.moveCount - 1 ? this.playerName(before, before.currentTurn) : '';
        this.forged.set(doc.moveCount, shooter);
        this.chrome.denied(`Shot ${doc.moveCount} does not replay`);
      } else if (this.shownMove >= 0 && result && result.frames.length > 0) {
        this.playing = result.frames;
        this.frameIndex = 0;
      }
    }
    this.shownMove = doc.moveCount;
    this.render();
  }

  private render(): void {
    for (const o of this.tray) o.destroy();
    this.tray = [];
    const view = this.view;
    if (!view) {
      this.chrome.setStatus('This match no longer exists', 'red');
      this.chrome.setPlayers([]);
      this.chrome.setActions([]);
      return;
    }
    const doc = view.doc as PoolDoc;
    const seat = view.seat;
    if (!this.playing) this.placeBalls(doc.balls, 100);

    doc.potted.forEach((n, k) => {
      this.tray.push(this.add.image(TABLE.x + 3 + k * 7, TRAY_Y, SHEET.key, `ball-${n}`));
    });
    if (doc.potted.length === 0) this.tray.push(text(this, TABLE.x, TRAY_Y - 4, 'NONE POCKETED', { color: 'purple' }));

    const name = (s: Seat) => this.playerName(doc, s);
    const detail = (s: Seat) => {
      const group = groupOf(s, doc.hostGroup);
      if (group === '') return '';
      const left = groupBalls(group).filter((n) => !doc.potted.includes(n)).length;
      return `${group === 'solids' ? 'sol' : 'str'} ${left}`;
    };
    this.chrome.setPlayers((['host', 'guest'] as const).map((s) => ({
      name: name(s),
      you: seat === s,
      active: doc.status === 'playing' && doc.currentTurn === s,
      detail: doc.status === 'waiting' ? '' : detail(s),
    })));

    const connection = this.connection();
    const forgedNote = [...this.forged].map(([n, who]) => ` Shot ${n}${who ? ` by ${who}` : ''} was forged.`).join('');
    if (doc.status === 'waiting') {
      this.chrome.setStatus(seat === 'host' ? 'Waiting for an opponent to join' : 'Waiting to start');
      this.chrome.setActions(seat === 'host'
        ? [{ label: 'Cancel match', onPress: () => void this.attempt(async () => { await cancelMatch(connection, pool, this.matchId); location.hash = '#/'; }) }]
        : []);
      this.hint.setText('');
    } else if (doc.status === 'playing') {
      const myTurn = this.myTurn();
      const lead = this.playing ? 'Balls rolling' : myTurn ? (doc.scratch ? 'Scratch. Your shot' : 'Your shot') : 'Their shot';
      this.chrome.setStatus(`${lead}.${forgedNote}`, this.forged.size > 0 ? 'red' : myTurn ? 'sand' : 'lavender');
      this.chrome.setActions(seat ? [
        { label: 'Shoot', onPress: () => this.shoot(), enabled: myTurn },
        { label: 'Resign', onPress: () => void this.attempt(() => resign(connection, pool, this.matchId, seat)) },
      ] : []);
      this.hint.setText(myTurn ? 'A/D AIM   W/S POWER' : '');
    } else {
      this.chrome.setActions([]);
      this.hint.setText('');
      if (this.playing) return;
      const result = seat === null ? `${doc.winner === 'host' ? name('host') : name('guest')} wins` : doc.winner === seat ? 'You win' : 'You lose';
      const how = doc.status === 'resigned' ? 'By resignation.' : this.eightStory(doc);
      this.chrome.setStatus(`${result}.${forgedNote}`, this.forged.size > 0 ? 'red' : 'sand');
      const key = `${this.matchId}-${doc.status}`;
      if (this.announced !== key) {
        this.announced = key;
        this.chrome.gameOver(result, `${how}${forgedNote}`, [
          { label: 'New match', onPress: () => void this.attempt(async () => { const id = await createMatch(connection, pool); location.hash = `#/play/pool/${id}`; }) },
          { label: 'Arcade', onPress: () => (location.hash = '#/') },
        ]);
      }
    }
    this.drawAim();
  }

  private playerName(doc: PoolDoc, seat: Seat): string {
    return doc[seat] ? `P-${String(doc[seat]).slice(-4).toUpperCase()}` : 'Waiting...';
  }

  private eightStory(doc: PoolDoc): string {
    const shooter = doc.currentTurn === 'host' ? 'guest' : 'host';
    return doc.winner === shooter ? 'The 8 went down last.' : doc.scratch ? 'Scratched on the 8.' : 'The 8 went down early.';
  }
}
