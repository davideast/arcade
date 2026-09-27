/**
 * Sokoban: one player pushes every box onto a goal. The board is on the
 * left; the side panel holds the level's leaderboard. A solve is recorded as
 * a score in Firestore and a move list in Cloud Storage, and every entry on
 * the leaderboard is downloaded and replayed here; an entry whose moves don't
 * solve the level or don't match its counts is flagged.
 *
 * Keys: arrows or WASD to move, Z or U to undo, R to restart, [ and ] for
 * the previous and next level. The pointer steps toward the pressed cell.
 */
import * as Phaser from 'phaser';
import {
  PALETTE,
  Button,
  PLAY_AREA,
  addSheetFrames,
  matchChrome,
  panel,
  text,
  usePixelCamera,
  type MatchChrome,
  type SheetSpec,
} from '@games/kit';
import type { Connection } from '@games/turn-net';
import { LEVELS, levelSpec } from './levels.ts';
import { Play, type Dir } from './sokoban.ts';
import { levelById, rank, verifyEntry, type ScoreDoc, type Verdict } from './logic.ts';
import { fetchMoves, submitSolve, watchScores } from './net.ts';

export const SHEET: SheetSpec = {
  key: 'sheet-sokoban',
  url: '',
  frames: { wall: [24, 16, 8, 8], box: [32, 16, 8, 8], goal: [40, 16, 8, 8], player: [24, 24, 8, 8] },
};

/** How long a missing move list may take to arrive after its score before the entry is flagged. */
const UPLOAD_GRACE_MS = 3000;

const KEY_DIRS: Record<string, Dir> = { LEFT: 'l', RIGHT: 'r', UP: 'u', DOWN: 'd', A: 'l', D: 'r', W: 'u', S: 'd' };

export class SokobanScene extends Phaser.Scene {
  private chrome!: MatchChrome;
  private levelId = '1';
  private play!: Play;
  private layer: Phaser.GameObjects.GameObject[] = [];
  private counter!: Phaser.GameObjects.Text;
  private stop: (() => void) | null = null;
  private entries: ScoreDoc[] = [];
  /** Replay verdicts by object path; a pending check is absent. */
  private verdicts = new Map<string, Verdict>();
  private checking = new Set<string>();
  private announced = new Set<string>();
  private submitted = '';
  private saving = false;
  private cell = 8;
  private origin = { x: 0, y: 0 };

  constructor() {
    super('sokoban');
  }

  init(data: { matchId?: string }): void {
    this.levelId = data.matchId && levelSpec(data.matchId) ? data.matchId : LEVELS[0].id;
    this.layer = [];
    this.entries = [];
    this.verdicts = new Map();
    this.checking = new Set();
    this.announced = new Set();
    this.submitted = '';
    this.saving = false;
  }

  create(): void {
    usePixelCamera(this);
    addSheetFrames(this, SHEET);
    const spec = levelSpec(this.levelId)!;
    const level = levelById(this.levelId)!;
    this.play = new Play(level);
    this.chrome = matchChrome(this, { title: 'Sokoban', background: 'maroon', onBack: () => (location.hash = '#/'), listLabel: 'BEST SOLVES' });
    this.chrome.setKeyboardFocus(false);

    // The board: 8-pixel tiles at the largest whole scale that fits the play area.
    const scale = Math.max(1, Math.floor(PLAY_AREA.width / (8 * Math.max(level.width, level.height))));
    this.cell = 8 * scale;
    this.origin = {
      x: PLAY_AREA.x + Math.floor((PLAY_AREA.width - level.width * this.cell) / 2),
      y: PLAY_AREA.y + Math.floor((PLAY_AREA.height - level.height * this.cell) / 2),
    };
    this.add.rectangle(PLAY_AREA.x - 2, PLAY_AREA.y - 2, PLAY_AREA.width + 4, PLAY_AREA.height + 4, PALETTE.red).setOrigin(0, 0);
    this.add.rectangle(PLAY_AREA.x, PLAY_AREA.y, PLAY_AREA.width, PLAY_AREA.height, PALETTE.black).setOrigin(0, 0);

    // Under the board, the counter; in the header, the level switch.
    panel(this, PLAY_AREA.x - 2, 162, PLAY_AREA.width + 4, 22, 'red', 'ink');
    this.counter = text(this, PLAY_AREA.x + PLAY_AREA.width / 2, 169, '', { align: 'center', color: 'cream' });
    const index = LEVELS.findIndex((l) => l.id === this.levelId);
    new Button(this, 104, 2, '<', () => this.goLevel(index - 1), { width: 16, fill: 'maroon', disabled: index === 0 });
    text(this, 150, 6, `LEVEL ${index + 1}/${LEVELS.length}`, { align: 'center', color: 'sand' });
    new Button(this, 180, 2, '>', () => this.goLevel(index + 1), { width: 16, fill: 'maroon', disabled: index === LEVELS.length - 1 });

    const keys = this.input.keyboard;
    if (keys) {
      for (const [name, d] of Object.entries(KEY_DIRS)) keys.addKey(name).on('down', () => this.move(d));
      keys.addKey('Z').on('down', () => this.undo());
      keys.addKey('U').on('down', () => this.undo());
      keys.addKey('R').on('down', () => this.restart());
      keys.addKey(Phaser.Input.Keyboard.KeyCodes.OPEN_BRACKET).on('down', () => this.goLevel(index - 1));
      keys.addKey(Phaser.Input.Keyboard.KeyCodes.CLOSED_BRACKET).on('down', () => this.goLevel(index + 1));
    }
    this.input.on(Phaser.Input.Events.POINTER_DOWN, (p: Phaser.Input.Pointer) => this.pointAt(p.worldX, p.worldY));

    const connection = this.connection();
    this.stop = watchScores(connection, this.levelId, (entries) => {
      this.entries = entries;
      for (const e of entries) this.check(e);
      this.renderPanel();
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.stop?.();
      this.stop = null;
    });
    this.render();
    this.renderPanel();
  }

  private connection(): Connection {
    return this.game.registry.get('connection') as Connection;
  }

  private uid(): string {
    return this.game.registry.get('uid') as string;
  }

  private goLevel(to: number): void {
    if (to < 0 || to >= LEVELS.length) return;
    location.hash = `#/play/sokoban/${LEVELS[to].id}`;
  }

  private move(d: Dir): void {
    if (this.play.go(d)) this.afterMove();
  }

  private undo(): void {
    if (this.play.undo()) this.afterMove();
  }

  private restart(): void {
    this.play.restart();
    this.afterMove();
  }

  /** A press on the board steps one cell toward it, along the longer axis. */
  private pointAt(x: number, y: number): void {
    const level = this.play.level;
    const col = Math.floor((x - this.origin.x) / this.cell);
    const row = Math.floor((y - this.origin.y) / this.cell);
    if (col < 0 || row < 0 || col >= level.width || row >= level.height) return;
    const px = this.play.position.player % level.width;
    const py = Math.floor(this.play.position.player / level.width);
    const dx = col - px;
    const dy = row - py;
    if (dx === 0 && dy === 0) return;
    this.move(Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'r' : 'l') : dy > 0 ? 'd' : 'u');
  }

  private afterMove(): void {
    this.render();
    if (this.play.solved && this.submitted !== this.play.moves) void this.submit(this.play.moves);
    this.renderPanel();
  }

  private async submit(moves: string): Promise<void> {
    this.submitted = moves;
    this.saving = true;
    this.renderPanel();
    try {
      const result = await submitSolve(this.connection(), this.levelId, moves);
      if (result.saved) this.chrome.notice(`Saved: ${result.moves} moves, ${result.pushes} pushes`);
      else this.chrome.notice(`Your best stays ${result.best.moves} moves`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/denied|permission|unauthorized/i.test(message)) this.chrome.denied('The rules denied that solve');
      else this.chrome.notice(message.slice(0, 40));
    } finally {
      this.saving = false;
      this.renderPanel();
    }
  }

  /** Download an entry's moves and replay them, once per object. */
  private check(entry: ScoreDoc): void {
    const key = entry.object;
    if (this.verdicts.has(key) || this.checking.has(key)) return;
    this.checking.add(key);
    void (async () => {
      let found = await fetchMoves(key);
      // The score is written before its upload; give the move list a moment to arrive.
      for (let waited = 0; found.text === null && waited < UPLOAD_GRACE_MS; waited += 500) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        found = await fetchMoves(key);
      }
      const verdict = verifyEntry(entry, found.text, found.metadata);
      this.checking.delete(key);
      this.verdicts.set(key, verdict);
      if (!verdict.ok && !this.announced.has(key) && this.sys.isActive()) {
        this.announced.add(key);
        this.chrome.denied(`Flagged ${this.name(entry.uid)}: replay fails`);
      }
      if (this.sys.isActive()) this.renderPanel();
    })();
  }

  private name(uid: string): string {
    return `P-${uid.slice(-4).toUpperCase()}`;
  }

  private render(): void {
    for (const o of this.layer) o.destroy();
    this.layer = [];
    const level = this.play.level;
    const pos = this.play.position;
    const scale = this.cell / 8;
    const at = (i: number) => ({ x: this.origin.x + (i % level.width) * this.cell, y: this.origin.y + Math.floor(i / level.width) * this.cell });
    const image = (i: number, frame: string) => {
      const { x, y } = at(i);
      return this.add.image(x, y, SHEET.key, frame).setOrigin(0, 0).setScale(scale);
    };
    for (let i = 0; i < level.walls.length; i++) {
      if (level.floor[i]) {
        const { x, y } = at(i);
        this.layer.push(this.add.rectangle(x, y, this.cell, this.cell, PALETTE.ink).setOrigin(0, 0));
      }
      if (level.walls[i]) this.layer.push(image(i, 'wall'));
    }
    for (const g of level.goals) this.layer.push(image(g, 'goal'));
    for (const b of pos.boxes) {
      const box = image(b, 'box');
      // A box on a goal turns green.
      if (level.goals.includes(b)) box.setTint(PALETTE.green);
      this.layer.push(box);
    }
    this.layer.push(image(pos.player, 'player'));
    this.counter.setText(`MOVES ${String(this.play.moveCount).padStart(4, '0')}  PUSHES ${String(this.play.pushCount).padStart(3, '0')}`);
  }

  private renderPanel(): void {
    const spec = levelSpec(this.levelId)!;
    const flagged = this.entries.filter((e) => this.verdicts.get(e.object)?.ok === false);
    const status = this.play.solved
      ? `Solved in ${this.play.moveCount} moves, ${this.play.pushCount} pushes.${this.saving ? ' Saving...' : ''}`
      : `${spec.name} by D. W. Skinner.`;
    const flagNote = flagged.length > 0 ? ` ${flagged.length} flagged.` : '';
    this.chrome.setStatus(`${status}${flagNote}`, flagged.length > 0 ? 'red' : this.play.solved ? 'sand' : 'cream');

    const me = this.uid();
    this.chrome.setPlayers(rank(this.entries).slice(0, 5).map((e, i) => {
      const verdict = this.verdicts.get(e.object);
      const bad = verdict?.ok === false;
      return {
        name: this.name(e.uid),
        mark: bad ? 'X' : `${i + 1}`,
        markColor: bad ? 'red' : verdict ? 'green' : 'lavender',
        you: e.uid === me,
        active: e.uid === me,
        detail: bad ? 'FLAG' : `${e.moves}/${e.pushes}`,
      };
    }));
    if (this.entries.length === 0) this.chrome.setPlayers([{ name: 'No solves yet' }]);

    const index = LEVELS.findIndex((l) => l.id === this.levelId);
    const actions = this.play.solved && index + 1 < LEVELS.length
      ? [{ label: 'Next level', onPress: () => this.goLevel(index + 1) }]
      : [{ label: 'Undo', onPress: () => this.undo(), enabled: this.play.moveCount > 0 }];
    actions.push({ label: 'Restart', onPress: () => this.restart(), enabled: this.play.moveCount > 0 });
    this.chrome.setActions(actions);
  }
}
