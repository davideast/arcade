import * as Phaser from 'phaser';
import {
  Button,
  FocusGroup,
  PALETTE,
  PLAY_AREA,
  addSheetFrames,
  matchChrome,
  panel,
  text,
  usePixelCamera,
  type MatchChrome,
  type PaletteColor,
  type SheetSpec,
} from '@games/kit';
import { cancelWhenLeft, gameOverWithRematch, type Connection } from '@games/turn-net';
import { COLORS, COLOR_NAMES, canPlay, cardFrames, frameFor, isWild, valueOf, type Card, type Color } from './cards.ts';
import { COLLECTION, createdMatch } from './logic.ts';
import { cancelUno, drawUno, joinUno, playUno, startUno, watchUno, type UnoView } from './net.ts';

export const SHEET: SheetSpec = { key: 'sheet-uno', url: '', frames: cardFrames() };

const COLOR_PALETTE: Record<Color, PaletteColor> = { r: 'red', o: 'orange', p: 'purple', g: 'green' };
const HAND = { x: PLAY_AREA.x, y: 160, width: PLAY_AREA.width };

function describeCard(card: Card, chosen?: string): string {
  const v = valueOf(card);
  const name = v === 's' ? 'Skip' : v === 'r' ? 'Reverse' : v === 'd' ? 'Draw Two' : v === 'w' ? 'Wild' : v === '+' ? 'Wild Draw 4' : v;
  if (isWild(card)) return chosen ? `${name} (${COLOR_NAMES[chosen as Color]})` : name;
  return `${COLOR_NAMES[card[0] as Color]} ${name}`;
}

export class UnoScene extends Phaser.Scene {
  private chrome!: MatchChrome;
  private matchId = '';
  private view: UnoView | null = null;
  private stop: (() => void) | null = null;
  private stopRematch: (() => void) | null = null;
  private table: Phaser.GameObjects.GameObject[] = [];
  private handObjects: Phaser.GameObjects.GameObject[] = [];
  private busy = false;
  private announced = '';
  private closePicker: (() => void) | null = null;

  constructor() {
    super('uno');
  }

  init(data: { matchId: string }): void {
    this.matchId = data.matchId;
    this.view = null;
    this.announced = '';
    this.table = [];
    this.handObjects = [];
  }

  create(): void {
    usePixelCamera(this);
    addSheetFrames(this, SHEET);
    this.chrome = matchChrome(this, { title: 'Uno', background: 'maroon', onBack: () => (location.hash = '#/') });
    panel(this, PLAY_AREA.x, PLAY_AREA.y, PLAY_AREA.width, PLAY_AREA.height, 'orange', 'green');
    this.chrome.setStatus('Loading table');
    const connection = this.connection();
    const matchId = this.matchId;
    let waitingHost = false;
    this.stop = watchUno(connection, matchId, (view) => {
      this.view = view;
      waitingHost = view?.match.status === 'waiting' && view.match.host === this.me();
      this.render();
    });
    const leave = cancelWhenLeft(() => waitingHost, () => cancelUno(connection, matchId));
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.stop?.();
      this.stopRematch?.();
      this.stopRematch = null;
      this.closePicker?.();
      leave();
    });
  }

  private connection(): Connection {
    return this.game.registry.get('connection') as Connection;
  }

  private me(): string {
    return this.game.registry.get('uid') as string;
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

  private name(uid: string): string {
    return `P-${uid.slice(-4).toUpperCase()}`;
  }

  private render(): void {
    for (const o of this.table) o.destroy();
    for (const o of this.handObjects) o.destroy();
    this.table = [];
    this.handObjects = [];
    const view = this.view;
    if (!view) {
      this.chrome.setStatus('This table no longer exists', 'red');
      this.chrome.setPlayers([]);
      this.chrome.setActions([]);
      return;
    }
    const { match: m, hand, top } = view;
    const me = this.me();
    const seat = m.players.indexOf(me);
    const myTurn = m.status === 'playing' && m.players[m.turn] === me;

    this.chrome.setPlayers(m.players.map((p, i) => ({
      name: this.name(p),
      you: p === me,
      active: m.status === 'playing' && i === m.turn,
      detail: m.status === 'waiting' ? '' : `${m.counts[i]}`,
    })));

    const cx = PLAY_AREA.x + PLAY_AREA.width / 2;
    const cy = PLAY_AREA.y + 56;
    if (m.status === 'waiting' || m.status === 'dealing') {
      this.table.push(text(this, cx, cy - 6, m.status === 'dealing' ? 'DEALING...' : `${m.players.length}/4 SEATED`, { align: 'center', color: 'cream' }));
      this.table.push(this.add.image(cx, cy + 30, SHEET.key, 'card-back').setScale(2));
    } else {
      // Discard pile, with the color in play drawn as a band under it.
      if (top) this.table.push(this.add.image(cx - 22, cy, SHEET.key, frameFor(top, isWild(top) ? m.color : undefined)).setScale(2));
      const inPlay = COLOR_PALETTE[m.color as Color];
      if (inPlay) {
        this.table.push(this.add.rectangle(cx - 38, cy + 28, 32, 6, PALETTE[inPlay]).setOrigin(0, 0));
        this.table.push(text(this, cx - 22, cy + 38, COLOR_NAMES[m.color as Color].toUpperCase(), { align: 'center', color: 'cream' }));
      }
      // Draw pile.
      const pile = this.add.image(cx + 26, cy, SHEET.key, 'card-back').setScale(2);
      this.table.push(pile);
      this.table.push(text(this, cx + 26, cy + 28, m.pending > 0 ? `+${m.pending}` : `${108 - m.drawIndex}`, { align: 'center', color: m.pending > 0 ? 'sand' : 'cream' }));
      if (myTurn) {
        pile.setInteractive({ useHandCursor: true });
        pile.on('pointerover', () => pile.setTint(0xfff3c0));
        pile.on('pointerout', () => pile.clearTint());
        pile.on('pointerdown', () => void this.attempt(() => drawUno(this.connection(), this.matchId)));
      }
      this.table.push(text(this, cx, PLAY_AREA.y + 6, m.direction === 1 ? 'ORDER >>' : '<< ORDER', { align: 'center', color: 'sand' }));
    }

    // The hand, spread across the strip under the table; playable cards stand up.
    const n = hand.length;
    const spacing = n > 1 ? Math.min(18, (HAND.width - 16) / (n - 1)) : 0;
    const start = HAND.x + (HAND.width - (spacing * (n - 1) + 16)) / 2;
    hand.forEach(({ index, card }, i) => {
      const playable = myTurn && m.pending === 0 && canPlay(card, m.color, m.value);
      const baseY = HAND.y + (playable ? 0 : 4);
      const img = this.add.image(Math.round(start + i * spacing), baseY, SHEET.key, frameFor(card)).setOrigin(0, 0);
      if (!playable && myTurn) img.setAlpha(0.55);
      if (playable) {
        img.setInteractive({ useHandCursor: true });
        img.on('pointerover', () => img.setY(baseY - 3).setDepth(10));
        img.on('pointerout', () => img.setY(baseY).setDepth(0));
        img.on('pointerdown', () => this.choose(index, card));
      }
      this.handObjects.push(img);
    });

    // Status and actions.
    const connection = this.connection();
    if (m.status === 'waiting') {
      const host = m.host === me;
      this.chrome.setStatus(host ? (m.players.length < 2 ? 'Waiting for players (2 to 4)' : 'Start when everyone is seated') : 'Waiting for the host to start');
      this.chrome.setActions(host ? [{ label: 'Start', enabled: m.players.length >= 2, onPress: () => void this.attempt(() => startUno(connection, this.matchId)) }] : []);
    } else if (m.status === 'dealing') {
      this.chrome.setStatus('Dealing');
      this.chrome.setActions([]);
    } else if (m.status === 'playing') {
      const who = this.name(m.players[m.turn]);
      this.chrome.setStatus(myTurn
        ? m.pending > 0 ? `Draw ${m.pending}: tap the pile` : 'Your turn: play or draw'
        : `${who} to play`, myTurn ? 'sand' : 'lavender');
      this.chrome.setActions(myTurn ? [{ label: m.pending > 0 ? `Draw ${m.pending}` : 'Draw', onPress: () => void this.attempt(() => drawUno(connection, this.matchId)) }] : []);
    } else {
      this.chrome.setActions([]);
      const result = m.winner === me ? 'You win' : `${this.name(m.winner)} wins`;
      this.chrome.setStatus(`${result}. Last card played.`);
      const key = `${this.matchId}-won`;
      if (this.announced !== key) {
        this.announced = key;
        const arcade = { label: 'Arcade', onPress: () => (location.hash = '#/') };
        if (seat < 0) this.chrome.gameOver(result, '', [arcade]);
        else this.stopRematch = gameOverWithRematch(connection, this.chrome, result, `${m.moveCount} turns`, {
          game: COLLECTION,
          matchId: this.matchId,
          fresh: (uid) => ({ ...createdMatch(uid) }),
          join: joinUno,
          open: (id) => (location.hash = `#/play/uno/${id}`),
          onError: (error) => this.report(error),
        }, [arcade]);
      }
    }
  }

  /** Play a card; a wild first asks for a color. */
  private choose(index: number, card: Card): void {
    if (!isWild(card)) {
      void this.attempt(() => playUno(this.connection(), this.matchId, index, card));
      return;
    }
    this.closePicker?.();
    const dim = this.add.rectangle(0, 0, 256, 192, PALETTE.black, 0.6).setOrigin(0, 0).setInteractive().setDepth(900);
    const box = panel(this, 48, 58, 160, 76, 'orange', 'ink').setDepth(901);
    box.add(text(this, 80, 8, 'CHOOSE A COLOR', { align: 'center', color: 'sand' }));
    this.data.set('modalCount', (this.data.get('modalCount') ?? 0) + 1);
    const buttons = COLORS.map((c, i) => {
      const b = new Button(this, 56 + (i % 2) * 74, 80 + Math.floor(i / 2) * 20, COLOR_NAMES[c], () => {
        close();
        void this.attempt(() => playUno(this.connection(), this.matchId, index, card, c));
      }, { width: 70, fill: COLOR_PALETTE[c] });
      b.container.setDepth(902);
      return b;
    });
    const focus = new FocusGroup(this, buttons, true);
    const close = () => {
      this.closePicker = null;
      this.data.set('modalCount', Math.max(0, (this.data.get('modalCount') ?? 1) - 1));
      focus.destroy();
      for (const b of buttons) b.destroy();
      box.destroy();
      dim.destroy();
    };
    this.closePicker = close;
    dim.on('pointerdown', close);
  }
}

export { describeCard };
