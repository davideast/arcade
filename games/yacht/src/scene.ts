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
import { cancelWhenLeft, gameOverWithRematch, type Connection } from '@games/turn-net';
import { CATEGORIES, points, type Category } from './scoring.ts';
import { COLLECTION, NO_KEEP, ROLLS_PER_TURN, createdMatch, missingNonces, scoreKey, type YachtMatch } from './logic.ts';
import { cancelYacht, joinYacht, owed, payOwed, rollYacht, scoreYacht, startYacht, watchYacht } from './net.ts';

/** YachtSpriteSheet.png: 12x12 dice faces, one to six, in two columns. */
export const SHEET: SheetSpec = {
  key: 'sheet-yacht',
  url: '',
  frames: {
    die1: [18, 42, 12, 12],
    die2: [34, 42, 12, 12],
    die3: [18, 58, 12, 12],
    die4: [34, 58, 12, 12],
    die5: [18, 74, 12, 12],
    die6: [34, 74, 12, 12],
  },
};

const SHORT: Record<Category, string> = {
  ones: 'ONES',
  twos: 'TWOS',
  threes: 'THREES',
  fours: 'FOURS',
  fives: 'FIVES',
  sixes: 'SIXES',
  fullHouse: 'FULL H',
  fourKind: '4 KIND',
  littleStraight: 'L STR',
  bigStraight: 'B STR',
  choice: 'CHOICE',
  yacht: 'YACHT',
};

/** Dice across the top of the play area; the scorecard in two columns below. */
// Five 24px dice edge to edge fill the panel's 120px inside its frame.
const DIE = { x: PLAY_AREA.x + 4, y: PLAY_AREA.y + 4, pitch: 24, size: 24 };
const CARD = { x: PLAY_AREA.x + 4, y: PLAY_AREA.y + 52, colWidth: 59, rowHeight: 12 };

export class YachtScene extends Phaser.Scene {
  private chrome!: MatchChrome;
  private matchId = '';
  private match: YachtMatch | null = null;
  private stop: (() => void) | null = null;
  private stopRematch: (() => void) | null = null;
  private layer: Phaser.GameObjects.GameObject[] = [];
  private keep = NO_KEEP.slice();
  private keepFor = '';
  private busy = false;
  private paying = '';
  private announced = '';

  constructor() {
    super('yacht');
  }

  init(data: { matchId: string }): void {
    this.matchId = data.matchId;
    this.match = null;
    this.layer = [];
    this.keep = NO_KEEP.slice();
    this.keepFor = '';
    this.busy = false;
    this.paying = '';
    this.announced = '';
  }

  create(): void {
    usePixelCamera(this);
    addSheetFrames(this, SHEET);
    this.chrome = matchChrome(this, { title: 'Yacht', background: 'green', onBack: () => (location.hash = '#/') });
    panel(this, PLAY_AREA.x, PLAY_AREA.y, PLAY_AREA.width, PLAY_AREA.height, 'orange', 'purple');
    this.chrome.setStatus('Loading table');
    const connection = this.connection();
    const matchId = this.matchId;
    let waitingHost = false;
    this.stop = watchYacht(connection, matchId, (m) => {
      this.match = m;
      waitingHost = m?.status === 'waiting' && m.host === this.me();
      this.render();
      if (m) this.payWhatIsOwed(m);
    });
    const leave = cancelWhenLeft(() => waitingHost, () => cancelYacht(connection, matchId));
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

  private me(): string {
    return this.game.registry.get('uid') as string;
  }

  private name(uid: string): string {
    return `P-${uid.slice(-4).toUpperCase()}`;
  }

  private async attempt(action: () => Promise<unknown>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await action();
    } catch (error) {
      this.report(error);
    } finally {
      this.busy = false;
    }
  }

  private report(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (/denied|permission/i.test(message)) this.chrome.denied();
    else this.chrome.notice(message.slice(0, 40));
  }

  /** Add this player's nonce, or reveal their roll, once per pending commitment. */
  private payWhatIsOwed(m: YachtMatch): void {
    const due = owed(m, this.me());
    if (!due) return;
    const key = `${m.commit}:${due}`;
    if (this.paying === key) return;
    this.paying = key;
    payOwed(this.connection(), this.matchId).catch((error) => {
      this.paying = '';
      this.report(error);
    });
  }

  private render(): void {
    for (const o of this.layer) o.destroy();
    this.layer = [];
    const m = this.match;
    if (!m) {
      this.chrome.setStatus('This table no longer exists', 'red');
      this.chrome.setPlayers([]);
      this.chrome.setActions([]);
      return;
    }
    const me = this.me();
    const seat = m.players.indexOf(me);
    const myTurn = m.status === 'playing' && m.turn === seat;
    const pending = m.commit !== '';
    // Kept dice reset at the start of each turn.
    const turnKey = `${m.turn}:${m.moveCount}`;
    if (this.keepFor !== turnKey) {
      this.keepFor = turnKey;
      this.keep = NO_KEEP.slice();
    }
    const canKeep = myTurn && !pending && m.rolls > 0 && m.rolls < ROLLS_PER_TURN;

    this.chrome.setPlayers(m.players.map((p, i) => ({
      name: this.name(p),
      you: p === me,
      active: m.status === 'playing' && i === m.turn,
      detail: m.status === 'waiting' ? '' : String(m.totals[i] ?? 0),
    })));

    if (m.status === 'waiting') {
      this.layer.push(text(this, PLAY_AREA.x + 64, PLAY_AREA.y + 50, `${m.players.length}/4 SEATED`, { align: 'center', color: 'cream' }));
    } else {
      this.drawDice(m, canKeep);
      this.drawCard(m, myTurn && !pending && m.rolls > 0);
    }

    const connection = this.connection();
    if (m.status === 'waiting') {
      const host = m.host === me;
      this.chrome.setStatus(host ? (m.players.length < 2 ? 'Waiting for players (2 to 4)' : 'Start when everyone is seated') : 'Waiting for the host to start');
      this.chrome.setActions(host ? [{ label: 'Start', enabled: m.players.length >= 2, onPress: () => void this.attempt(() => startYacht(connection, this.matchId)) }] : []);
    } else if (m.status === 'playing') {
      const who = this.name(m.players[m.turn]);
      const waiting = missingNonces(m).map((i) => this.name(m.players[i]));
      let status: string;
      if (pending) status = waiting.length > 0 ? `Rolling: waiting for ${waiting.join(', ')}` : 'Rolling: revealing';
      else if (myTurn) status = m.rolls === 0 ? 'Your turn: roll' : m.rolls < ROLLS_PER_TURN ? 'Tap dice to keep, roll or score' : 'Score a category';
      else status = `${who} to play`;
      this.chrome.setStatus(status, myTurn ? 'sand' : 'lavender');
      const left = ROLLS_PER_TURN - m.rolls;
      this.chrome.setActions(myTurn && !pending && left > 0
        ? [{ label: `Roll (${left} left)`, onPress: () => void this.attempt(() => rollYacht(connection, this.matchId, m.rolls === 0 ? NO_KEEP : this.keep)) }]
        : []);
    } else {
      this.chrome.setActions([]);
      const top = m.totals[m.winner];
      const result = m.status === 'draw' ? 'Draw' : m.players[m.winner] === me ? 'You win' : `${this.name(m.players[m.winner])} wins`;
      this.chrome.setStatus(`${result} with ${top}.`);
      const key = `${this.matchId}-${m.status}`;
      if (this.announced !== key) {
        this.announced = key;
        const body = m.players.map((p, i) => `${this.name(p)} ${m.totals[i]}`).join('  ');
        const arcade = { label: 'Arcade', onPress: () => (location.hash = '#/') };
        if (seat < 0) this.chrome.gameOver(result, body, [arcade]);
        else this.stopRematch = gameOverWithRematch(connection, this.chrome, result, body, {
          game: COLLECTION,
          matchId: this.matchId,
          fresh: (uid) => ({ ...createdMatch(uid) }),
          join: joinYacht,
          open: (id) => (location.hash = `#/play/yacht/${id}`),
          onError: (error) => this.report(error),
        }, [arcade]);
      }
    }
  }

  private drawDice(m: YachtMatch, canKeep: boolean): void {
    // The dice belong to this turn once it has a roll; before that the slots are empty.
    const rolled = m.rolls > 0;
    m.dice.forEach((face, i) => {
      const x = DIE.x + i * DIE.pitch;
      const held = canKeep ? this.keep[i] : m.commit !== '' && m.rolls > 0 && m.keep[i];
      if (!rolled) {
        this.layer.push(this.add.rectangle(x + 1, DIE.y + 1, DIE.size - 2, DIE.size - 2, PALETTE.lavender, 0.4).setOrigin(0, 0));
        return;
      }
      const die = this.add.image(x, DIE.y, SHEET.key, `die${face}`).setOrigin(0, 0).setScale(2);
      if (m.commit !== '' && !held) die.setAlpha(0.4);
      this.layer.push(die);
      if (held) {
        this.layer.push(this.add.rectangle(x, DIE.y + DIE.size + 1, DIE.size, 2, PALETTE.sand).setOrigin(0, 0));
        this.layer.push(text(this, x + DIE.size / 2, DIE.y + DIE.size + 4, 'KEEP', { align: 'center', color: 'sand' }));
      }
      if (canKeep) {
        die.setInteractive({ useHandCursor: true });
        die.on('pointerdown', () => {
          this.keep[i] = !this.keep[i];
          // Redraw after Phaser finishes this pointer event: destroying the
          // pressed die inside its own handler drops the next press.
          this.time.delayedCall(0, () => this.render());
        });
      }
    });
    if (m.status === 'playing') {
      if (!rolled) this.layer.push(text(this, PLAY_AREA.x + 64, DIE.y + DIE.size + 4, m.commit === '' ? 'ROLL TO START' : 'ROLLING', { align: 'center', color: 'lavender' }));
    }
  }

  /** The card of the player on turn (or the winner's when the game is over). */
  private drawCard(m: YachtMatch, canScore: boolean): void {
    const seat = m.status === 'playing' ? m.turn : Math.max(0, m.players.indexOf(this.me()));
    const card = m.scores[scoreKey(seat)];
    if (!card) return;
    this.layer.push(text(this, PLAY_AREA.x + 64, CARD.y - 9, `${this.name(m.players[seat])} CARD`, { align: 'center', color: 'lavender' }));
    CATEGORIES.forEach((category, i) => {
      const col = Math.floor(i / 6);
      const row = i % 6;
      const x = CARD.x + col * (CARD.colWidth + 2);
      const y = CARD.y + row * CARD.rowHeight;
      const used = card[category] !== -1;
      const potential = points(category, m.dice);
      const open = canScore && !used;
      const box = this.add.rectangle(x, y, CARD.colWidth, CARD.rowHeight - 1, open ? PALETTE.maroon : PALETTE.ink).setOrigin(0, 0);
      this.layer.push(box);
      this.layer.push(text(this, x + 2, y + 2, SHORT[category], { color: used ? 'lavender' : 'cream' }));
      const value = used ? String(card[category]) : open ? String(potential) : '';
      this.layer.push(text(this, x + CARD.colWidth - 2, y + 2, value, { align: 'right', color: used ? 'cream' : potential > 0 ? 'sand' : 'lavender' }));
      if (open) {
        box.setInteractive({ useHandCursor: true });
        box.on('pointerover', () => box.setFillStyle(PALETTE.red));
        box.on('pointerout', () => box.setFillStyle(PALETTE.maroon));
        box.on('pointerdown', () => void this.attempt(() => scoreYacht(this.connection(), this.matchId, category)));
      }
    });
  }
}
