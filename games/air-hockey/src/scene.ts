import * as Phaser from 'phaser';
import {
  PALETTE,
  PLAY_AREA,
  addSheetFrames,
  matchChrome,
  text,
  usePixelCamera,
  type MatchChrome,
  type SheetSpec,
} from '@games/kit';
import {
  cancelMatch,
  cancelWhenLeft,
  createdMatch,
  gameOverWithRematch,
  joinMatch,
  resign,
  watchMatch,
  type Connection,
  type MatchView,
  type Seat,
} from '@games/turn-net';
import type { Database } from 'firebase/database';
import {
  airHockey,
  forfeitMetaOp,
  frameOp,
  malletOp,
  resignMetaOp,
  resultMatchesLive,
  startLiveOp,
  startMetaOp,
  type AirHockeyDoc,
  type AirHockeyFields,
  type LiveFrame,
  type LiveMatch,
} from './logic.ts';
import { applyLive, joinPresence, liveDatabase, recordFinish, recordForfeit, watchLive } from './net.ts';
import {
  GOAL_LEFT,
  GOAL_RIGHT,
  STEP,
  TABLE,
  clampMallet,
  initialWorld,
  malletHome,
  moveMallet,
  otherSide,
  step,
  plausibleGoal,
  plausibleMove,
  winner,
  type Side,
  type Vec,
  type World,
} from './physics.ts';

export const SHEET: SheetSpec = {
  key: 'sheet-airhockey',
  url: '',
  frames: { puck: [32, 56, 8, 8], 'mallet-host': [40, 56, 8, 8], 'mallet-guest': [40, 64, 8, 8] },
};

/** The table's top-left corner in logical pixels. */
const TX = PLAY_AREA.x + (PLAY_AREA.width - TABLE.width) / 2;
const TY = PLAY_AREA.y;
/** The host writes a frame every WRITE_TICKS steps (20 a second), and the guest its mallet as often. */
const WRITE_TICKS = 3;
const WRITE_MS = WRITE_TICKS * STEP * 1000;
/** How long a player's presence stays gone before the other claims the match. */
const FORFEIT_AFTER_MS = 3000;

interface Received {
  frame: LiveFrame;
  at: number;
}

export class AirHockeyScene extends Phaser.Scene {
  private chrome!: MatchChrome;
  private matchId = '';
  private view: MatchView<AirHockeyFields> | null = null;
  private live: LiveMatch | null = null;
  private db!: Database;
  private stops: Array<() => void> = [];
  private stopRematch: (() => void) | null = null;
  private puck!: Phaser.GameObjects.Image;
  private mallets!: Record<Side, Phaser.GameObjects.Image>;
  private hint!: Phaser.GameObjects.Text;
  /** Where this player's pointer puts its mallet, in table coordinates. */
  private aimed: Vec | null = null;
  /** The host's simulation; null on the guest. */
  private world: World | null = null;
  private accumulator = 0;
  private scoredSinceWrite = false;
  /** The guest's own mallet, moved locally toward the pointer. */
  private ownMallet: Vec = malletHome('guest');
  private lastMalletWrite = 0;
  private lastMalletSent = '';
  private frames: Received[] = [];
  private flags: string[] = [];
  private lastChecked: { frame: LiveFrame; score: string } | null = null;
  private starting = false;
  private presenceJoined = false;
  private goneSince = 0;
  private claiming = false;
  private finishing = false;
  private announced = '';

  constructor() {
    super('airhockey');
  }

  init(data: { matchId: string }): void {
    this.matchId = data.matchId;
    this.view = null;
    this.live = null;
    this.stops = [];
    this.world = null;
    this.accumulator = 0;
    this.scoredSinceWrite = false;
    this.ownMallet = malletHome('guest');
    this.lastMalletWrite = 0;
    this.lastMalletSent = '';
    this.frames = [];
    this.flags = [];
    this.lastChecked = null;
    this.starting = false;
    this.presenceJoined = false;
    this.goneSince = 0;
    this.claiming = false;
    this.finishing = false;
    this.announced = '';
  }

  create(): void {
    usePixelCamera(this);
    addSheetFrames(this, SHEET);
    this.chrome = matchChrome(this, { title: 'Air Hockey', background: 'purple', onBack: () => (location.hash = '#/') });
    this.drawTable();
    this.puck = this.add.image(0, 0, SHEET.key, 'puck').setVisible(false);
    this.mallets = {
      host: this.add.image(0, 0, SHEET.key, 'mallet-host').setVisible(false),
      guest: this.add.image(0, 0, SHEET.key, 'mallet-guest').setVisible(false),
    };
    this.hint = text(this, 150, 110, '', { color: 'lavender', wrap: 92 });
    this.chrome.setStatus('Loading table');

    const aim = (p: Phaser.Input.Pointer) => {
      const seat = this.seat();
      if (!seat) return;
      this.aimed = clampMallet(seat, this.toTable(p.worldX, p.worldY, seat));
    };
    this.input.on(Phaser.Input.Events.POINTER_MOVE, aim);
    this.input.on(Phaser.Input.Events.POINTER_DOWN, aim);

    const connection = this.connection();
    this.db = liveDatabase();
    const matchId = this.matchId;
    let waitingHost = false;
    let watching = '';
    this.stops.push(watchMatch(connection, airHockey, matchId, (view) => {
      this.view = view;
      waitingHost = view?.doc.status === 'waiting' && view.seat === 'host';
      // The live match lives under the host's uid, known once the match document loads.
      if (view && view.doc.status !== 'waiting' && watching !== view.doc.host) {
        watching = view.doc.host;
        this.stops.push(watchLive(this.db, matchId, view.doc.host, (live) => this.onLive(live)));
      }
      this.onMatch();
    }));
    const leave = cancelWhenLeft(() => waitingHost, () => cancelMatch(connection, airHockey, matchId));
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      for (const stop of this.stops) stop();
      this.stopRematch?.();
      this.stopRematch = null;
      leave();
    });
  }

  private connection(): Connection {
    return this.game.registry.get('connection') as Connection;
  }

  private seat(): Seat | null {
    return this.view?.seat ?? null;
  }

  private doc(): AirHockeyDoc | null {
    return (this.view?.doc as AirHockeyDoc | undefined) ?? null;
  }

  private target(seat: Side): Vec {
    return this.aimed ?? malletHome(seat);
  }

  /** Table coordinates to the screen. The guest sees the table turned around, its own goal at the bottom. */
  private toScreen(p: Vec): Vec {
    const flip = this.seat() === 'guest';
    return { x: TX + (flip ? TABLE.width - p.x : p.x), y: TY + (flip ? TABLE.height - p.y : p.y) };
  }

  private toTable(x: number, y: number, seat: Seat): Vec {
    const tx = x - TX;
    const ty = y - TY;
    return seat === 'guest' ? { x: TABLE.width - tx, y: TABLE.height - ty } : { x: tx, y: ty };
  }

  private drawTable(): void {
    const g = this.add.graphics();
    g.fillStyle(PALETTE.ink).fillRect(TX - 3, TY - 3, TABLE.width + 6, TABLE.height + 6);
    g.fillStyle(PALETTE.cream).fillRect(TX, TY, TABLE.width, TABLE.height);
    g.fillStyle(PALETTE.lavender).fillRect(TX, TY + TABLE.height / 2 - 0.5, TABLE.width, 1);
    g.lineStyle(1, PALETTE.lavender).strokeCircle(TX + TABLE.width / 2, TY + TABLE.height / 2, 10);
    // Goal creases and mouths: the viewer's own goal (bottom) and the opponent's (top).
    const mouth = GOAL_RIGHT - GOAL_LEFT;
    for (const [y, color, start, end] of [[TY, PALETTE.lavender, 0, Math.PI], [TY + TABLE.height, PALETTE.lavender, Math.PI, Math.PI * 2]] as const) {
      g.fillStyle(color, 0.35).slice(TX + TABLE.width / 2, y, mouth / 2, start, end, false).fillPath();
      g.fillStyle(PALETTE.black).fillRect(TX + GOAL_LEFT, y === TY ? TY - 3 : TY + TABLE.height, mouth, 3);
    }
  }

  private onMatch(): void {
    const doc = this.doc();
    const seat = this.seat();
    if (doc && seat === 'host' && doc.status === 'playing') void this.startLive();
    this.render();
  }

  /** The host opens the live match once the guest has joined. */
  private async startLive(): Promise<void> {
    const doc = this.doc();
    if (!doc || this.starting || this.live?.frame) return;
    this.starting = true;
    try {
      const world = initialWorld();
      if (!this.live?.meta) await applyLive(this.db, startMetaOp(this.matchId, doc.host, doc.guest));
      await applyLive(this.db, startLiveOp(this.matchId, doc.host, world));
    } catch (error) {
      this.report(error);
      this.starting = false;
    }
  }

  private onLive(live: LiveMatch | null): void {
    this.live = live;
    const seat = this.seat();
    const doc = this.doc();
    if (!live || !seat || !doc) return this.render();
    if (!this.presenceJoined && live.meta?.status === 'playing' && (seat === 'host' || live.meta.guest === doc.guest)) {
      this.presenceJoined = true;
      joinPresence(this.db, this.matchId, doc.host, seat).catch((error) => {
        this.presenceJoined = false;
        this.report(error);
      });
    }
    if (seat === 'host' && live.frame && !this.world) {
      // The host resumes from the stored frame (after a reload) or starts a new world.
      const f = live.frame;
      this.world = {
        puck: { x: f.puck.x, y: f.puck.y, vx: f.puck.vx, vy: f.puck.vy },
        host: f.host,
        guest: f.guest,
        score: live.score ?? { host: 0, guest: 0 },
        tick: f.puck.t,
      };
      this.aimed = f.host;
    }
    if (seat === 'guest' && live.frame) this.receiveFrame(live);
    this.checkResult();
    this.render();
  }

  /** The guest keeps the last two frames to draw between them, and checks each against the last. */
  private receiveFrame(live: LiveMatch): void {
    const frame = live.frame!;
    const last = this.frames.at(-1)?.frame;
    if (last && last.puck.t === frame.puck.t) return;
    const score = JSON.stringify(live.score ?? null);
    if (this.lastChecked && frame.puck.t > this.lastChecked.frame.puck.t) {
      const before = this.lastChecked;
      const ticks = frame.puck.t - before.frame.puck.t;
      const was = JSON.parse(before.score) as { host: number; guest: number } | null;
      const now = live.score;
      if (was && now && score !== before.score) {
        const scorer: Side = now.host > was.host ? 'host' : 'guest';
        if (!plausibleGoal(before.frame.puck, scorer, frame.puck, ticks)) this.flag(`Goal at tick ${frame.puck.t} is impossible`);
      } else if (!plausibleMove(before.frame.puck, frame.puck, ticks)) {
        this.flag(`Puck jumped at tick ${frame.puck.t}`);
      }
    }
    this.lastChecked = { frame, score };
    this.frames = [...this.frames.slice(-1), { frame, at: performance.now() }];
  }

  private flag(message: string): void {
    if (this.flags.length < 3) this.flags.push(message);
    this.chrome.denied(message.slice(0, 40));
  }

  /** Every client checks the Firestore result against the live match, which its rules verified. */
  private checkResult(): void {
    const doc = this.doc();
    if (!doc || doc.endedBy === '' || !this.live?.meta) return;
    if (!resultMatchesLive(doc, this.live) && !this.flags.some((f) => f.startsWith('Result'))) this.flag('Result does not match the live match');
  }

  update(_time: number, delta: number): void {
    const doc = this.doc();
    const seat = this.seat();
    const live = this.live;
    if (!doc || !seat || !live?.meta) return this.draw();
    const playing = doc.status === 'playing' && live.meta.status === 'playing';
    if (playing) {
      if (seat === 'host') this.hostStep(delta);
      else this.guestStep(delta);
      this.watchPresence(seat);
    }
    this.draw();
  }

  private hostStep(delta: number): void {
    const world = this.world;
    const doc = this.doc();
    if (!world || !doc || this.finishing) return;
    const guestTarget = this.live?.guestMallet ?? world.guest;
    this.accumulator = Math.min(this.accumulator + delta / 1000, STEP * 5);
    while (this.accumulator >= STEP) {
      this.accumulator -= STEP;
      const r = step(this.world!, this.target('host'), guestTarget);
      this.world = r.world;
      if (r.goal) this.scoredSinceWrite = true;
      if (this.world.tick % WRITE_TICKS === 0 || r.goal) {
        const scored = this.scoredSinceWrite;
        this.scoredSinceWrite = false;
        const snapshot = this.world;
        applyLive(this.db, frameOp(this.matchId, doc.host, snapshot, scored)).catch((error) => this.report(error));
        if (scored && winner(snapshot.score)) {
          this.finishing = true;
          recordFinish(this.connection(), this.matchId, snapshot.score).catch((error) => this.report(error));
          return;
        }
      }
    }
  }

  private guestStep(delta: number): void {
    const doc = this.doc();
    if (!doc) return;
    this.ownMallet = moveMallet('guest', this.ownMallet, this.target('guest'), delta / 1000);
    const now = performance.now();
    if (now - this.lastMalletWrite < WRITE_MS) return;
    const op = malletOp(this.matchId, doc.host, this.target('guest'));
    const key = JSON.stringify(op.value);
    if (key === this.lastMalletSent) return;
    this.lastMalletWrite = now;
    this.lastMalletSent = key;
    applyLive(this.db, op).catch((error) => this.report(error));
  }

  /** When the other player's presence has been gone for a while, claim the match. */
  private watchPresence(seat: Side): void {
    const other = otherSide(seat);
    const gone = this.live?.presence?.[other] === false;
    if (!gone) {
      this.goneSince = 0;
      return;
    }
    const now = performance.now();
    if (!this.goneSince) this.goneSince = now;
    if (this.claiming || now - this.goneSince < FORFEIT_AFTER_MS) return;
    this.claiming = true;
    const doc = this.doc()!;
    const score = this.live?.score ?? { host: 0, guest: 0 };
    void (async () => {
      try {
        await applyLive(this.db, forfeitMetaOp(this.matchId, doc.host, seat));
        await recordForfeit(this.connection(), this.matchId, seat, score);
      } catch (error) {
        this.report(error);
        this.claiming = false;
      }
    })();
  }

  /** Place the puck and mallets: the host draws its simulation; the guest draws between the last two frames. */
  private draw(): void {
    const seat = this.seat();
    let puck: Vec | null = null;
    let host: Vec | null = null;
    let guest: Vec | null = null;
    if (seat === 'host' && this.world) {
      puck = this.world.puck;
      host = this.world.host;
      guest = this.world.guest;
    } else if (this.frames.length > 0) {
      const [a, b] = this.frames.length === 2 ? this.frames : [this.frames[0], this.frames[0]];
      const k = Math.min(1, (performance.now() - b.at) / WRITE_MS);
      const lerp = (p: Vec, q: Vec) => ({ x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k });
      const jump = Math.abs(a.frame.puck.x - b.frame.puck.x) + Math.abs(a.frame.puck.y - b.frame.puck.y) > 20;
      puck = jump ? b.frame.puck : lerp(a.frame.puck, b.frame.puck);
      host = lerp(a.frame.host, b.frame.host);
      guest = seat === 'guest' ? this.ownMallet : lerp(a.frame.guest, b.frame.guest);
    }
    const place = (image: Phaser.GameObjects.Image, p: Vec | null) => {
      image.setVisible(!!p);
      if (p) {
        const s = this.toScreen(p);
        image.setPosition(Math.round(s.x), Math.round(s.y));
      }
    };
    place(this.puck, puck);
    place(this.mallets.host, host);
    place(this.mallets.guest, guest);
  }

  private report(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (/denied|permission/i.test(message)) this.chrome.denied();
    else this.chrome.notice(message.slice(0, 40));
  }

  private playerName(doc: AirHockeyDoc, seat: Seat): string {
    return doc[seat] ? `P-${String(doc[seat]).slice(-4).toUpperCase()}` : 'Waiting...';
  }

  private render(): void {
    const view = this.view;
    if (!view) {
      this.chrome.setStatus('This match no longer exists', 'red');
      this.chrome.setPlayers([]);
      this.chrome.setActions([]);
      return;
    }
    const doc = view.doc as AirHockeyDoc;
    const seat = view.seat;
    const live = this.live;
    const score = doc.status === 'playing' || doc.status === 'waiting' ? live?.score ?? doc.score : doc.score;
    const name = (s: Seat) => this.playerName(doc, s);
    this.chrome.setPlayers((['host', 'guest'] as const).map((s) => ({
      name: name(s),
      mark: s === 'host' ? 'B' : 'R',
      markColor: s === 'host' ? 'lavender' : 'red',
      you: seat === s,
      active: false,
      detail: doc.status === 'waiting' ? '' : `${score[s]}`,
    })));
    const flagged = this.flags.length === 0 ? '' : ` ${this.flags[0]}${this.flags.length > 1 ? ` (+${this.flags.length - 1} more)` : ''}.`;
    const connection = this.connection();
    if (doc.status === 'waiting') {
      this.chrome.setStatus(seat === 'host' ? 'Waiting for an opponent to join' : 'Waiting to start');
      this.chrome.setActions(seat === 'host'
        ? [{ label: 'Cancel match', onPress: () => void cancelMatch(connection, airHockey, this.matchId).then(() => (location.hash = '#/'), (e) => this.report(e)) }]
        : []);
      this.hint.setText('');
      return;
    }
    if (doc.status === 'playing') {
      const other: Side | null = seat ? otherSide(seat) : null;
      const away = other && live?.presence?.[other] === false ? ` ${name(other)} left.` : '';
      const lead = !live?.meta ? 'Opening the table.' : live.meta.status !== 'playing' ? 'Recording the result.' : 'First to 7.';
      this.chrome.setStatus(`${lead}${away}${flagged}`, this.flags.length > 0 ? 'red' : 'sand');
      this.chrome.setActions(seat ? [{
        label: 'Resign',
        onPress: () => void (async () => {
          try {
            await resign(connection, airHockey, this.matchId, seat);
            await applyLive(this.db, resignMetaOp(this.matchId, doc.host, seat));
          } catch (error) {
            this.report(error);
          }
        })(),
      }] : []);
      this.hint.setText(seat ? 'MOVE THE POINTER TO MOVE YOUR MALLET' : '');
      return;
    }
    this.chrome.setActions([]);
    this.hint.setText('');
    const result = seat === null ? `${name(doc.winner as Seat)} wins` : doc.winner === seat ? 'You win' : 'You lose';
    const how = doc.status === 'resigned' ? 'By resignation.'
      : doc.endedBy === 'forfeit' ? `${name(otherSide(doc.winner as Side))} left. ${score.host} to ${score.guest}.`
      : `${score.host} to ${score.guest}.`;
    this.chrome.setStatus(`${result}. ${how}${flagged}`, this.flags.length > 0 ? 'red' : 'sand');
    const key = `${this.matchId}-${doc.status}-${doc.endedBy}`;
    if (this.announced !== key) {
      this.announced = key;
      const arcade = { label: 'Arcade', onPress: () => (location.hash = '#/') };
      if (!seat) this.chrome.gameOver(result, `${how}${flagged}`, [arcade]);
      else this.stopRematch = gameOverWithRematch(connection, this.chrome, result, `${how}${flagged}`, {
        game: airHockey.id,
        matchId: this.matchId,
        fresh: (uid) => createdMatch(airHockey, uid),
        join: (c, id) => joinMatch(c, airHockey, id),
        open: (id) => (location.hash = `#/play/airhockey/${id}`),
        onError: (error) => this.report(error),
      }, [arcade]);
    }
  }
}
