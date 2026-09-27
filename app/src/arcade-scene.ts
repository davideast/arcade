/**
 * Pyric Arcade: a tile per game, each showing the game's own mockup and how
 * many matches are open, updated live. Selecting a tile opens that game's
 * lobby: open matches with their seats, join, and new match.
 */
import * as Phaser from 'phaser';
import {
  Button,
  FocusGroup,
  PALETTE,
  panel,
  text,
  toast,
  usePixelCamera,
  type Focusable,
} from '@games/kit';
import { watchOpenMatches, type Connection, type OpenMatch } from '@games/turn-net';
import { GAMES, type ArcadeGame } from './catalog.ts';
import { go } from './router.ts';

const TILE = { width: 76, height: 80, gap: 4, top: 24 };
/** The header's height; the tile grid scrolls in the area below it. */
const HEADER = 20;
/** Pointer travel, in logical pixels, that turns a press into a drag. */
const DRAG_THRESHOLD = 3;

class Tile implements Focusable {
  private readonly frame: Phaser.GameObjects.Container;
  private readonly badge: Phaser.GameObjects.Text;
  private readonly badgeBox: Phaser.GameObjects.Rectangle;
  private readonly root: Phaser.GameObjects.Container;
  private focused = false;
  private readonly baseY: number;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    readonly game: ArcadeGame,
    private readonly onPress: () => void,
    private readonly onFocus: (tile: Tile) => void,
    private readonly dragged: () => boolean,
  ) {
    this.baseY = y;
    const available = game.scene !== undefined;
    this.frame = panel(scene, 0, 0, TILE.width, TILE.height, 'purple', 'ink');
    const thumb = scene.add.image(TILE.width / 2, 36, game.sheetKey, 'mockup').setScale(0.5);
    if (!available) thumb.setAlpha(0.35);
    const name = text(scene, TILE.width / 2, 69, game.title.toUpperCase(), { align: 'center', color: available ? 'cream' : 'lavender' });
    this.badgeBox = scene.add.rectangle(TILE.width - 6, 6, 30, 10, PALETTE.orange).setOrigin(1, 0);
    this.badge = text(scene, TILE.width - 21, 7, '', { align: 'center', color: 'ink' });
    this.root = scene.add.container(x, y, [this.frame, thumb, name, this.badgeBox, this.badge]);
    this.root.setSize(TILE.width, TILE.height);
    this.root.setInteractive(new Phaser.Geom.Rectangle(TILE.width / 2, TILE.height / 2, TILE.width, TILE.height), Phaser.Geom.Rectangle.Contains);
    this.root.on('pointerover', () => this.highlight(true));
    this.root.on('pointerout', () => this.highlight(false));
    // Press on release, so a drag that starts on a tile scrolls instead.
    this.root.on('pointerup', () => {
      if (!this.dragged()) this.press();
    });
    this.setOpen(available ? 0 : null);
  }

  /** Open match count; null shows the game as coming soon. */
  setOpen(count: number | null): void {
    if (count === null) {
      this.badge.setText('SOON');
      this.badgeBox.setFillStyle(PALETTE.lavender);
    } else {
      this.badge.setText(count === 0 ? 'NEW' : `${count} OPEN`);
      this.badgeBox.setFillStyle(count === 0 ? PALETTE.green : PALETTE.orange);
      this.badgeBox.width = count === 0 ? 24 : 38;
      this.badge.setX(TILE.width - 6 - this.badgeBox.width / 2);
    }
  }

  get container(): Phaser.GameObjects.Container {
    return this.root;
  }

  /** The tile's top and bottom in grid coordinates. */
  get span(): { top: number; bottom: number } {
    return { top: this.baseY, bottom: this.baseY + TILE.height };
  }

  /** Keyboard focus: highlight, and scroll the tile into view. */
  setFocus(focused: boolean): void {
    this.highlight(focused);
    if (focused) this.onFocus(this);
  }

  private highlight(focused: boolean): void {
    this.focused = focused;
    const border = this.frame.list[1] as Phaser.GameObjects.NineSlice;
    border.setFrame(focused ? 'frame-orange' : 'frame-purple');
    this.root.setY(this.baseY - (focused ? 2 : 0));
  }

  press(): void {
    if (this.game.scene) this.onPress();
  }
}

export class ArcadeScene extends Phaser.Scene {
  /** How far the grid can scroll: its last row's bottom edge meets the screen's. */
  private maxScroll(): number {
    const rows = Math.ceil(GAMES.length / 3);
    const bottom = TILE.top + rows * (TILE.height + TILE.gap);
    return Math.max(0, bottom - 192);
  }

  private setScroll(value: number): void {
    this.scroll = Math.round(Math.min(this.maxScroll(), Math.max(0, value)));
    this.grid.setY(-this.scroll);
  }

  /** Scroll just enough to show the whole tile below the header. */
  private scrollIntoView(tile: Tile): void {
    const { top, bottom } = tile.span;
    if (top - TILE.top < this.scroll) this.setScroll(top - TILE.top);
    else if (bottom + TILE.gap > this.scroll + 192) this.setScroll(bottom + TILE.gap - 192);
  }

  private stops: Array<() => void> = [];
  private open = new Map<string, OpenMatch[]>();
  private tiles: Tile[] = [];
  private grid!: Phaser.GameObjects.Container;
  private scroll = 0;
  private closeLobby: (() => void) | null = null;
  private refreshLobby: (() => void) | null = null;

  constructor() {
    super('arcade');
  }

  create(): void {
    usePixelCamera(this);
    const connection = this.game.registry.get('connection') as Connection;
    const uid = this.game.registry.get('uid') as string;

    this.add.rectangle(0, 0, 256, 192, PALETTE.maroon).setOrigin(0, 0);
    for (let y = 0; y < 192; y += 8) this.add.rectangle(0, y, 256, 1, PALETTE.ink, 0.25).setOrigin(0, 0);
    // Every game in one grid, three per row, scrolled vertically under a fixed header.
    const left = (256 - (3 * TILE.width + 2 * TILE.gap)) / 2;
    let dragging = false;
    this.grid = this.add.container(0, 0);
    this.tiles = GAMES.map((game, i) => {
      const x = left + (i % 3) * (TILE.width + TILE.gap);
      const y = TILE.top + Math.floor(i / 3) * (TILE.height + TILE.gap);
      const tile = new Tile(this, x, y, game, () => this.openLobby(game), (t) => this.scrollIntoView(t), () => dragging);
      this.grid.add(tile.container);
      return tile;
    });
    // Clip the grid to the area below the header.
    const clip = new Phaser.GameObjects.Rectangle(this, 0, HEADER, 256, 192 - HEADER, 0xffffff).setOrigin(0, 0);
    this.grid.enableFilters();
    this.grid.filters?.external.addMask(clip, false, this.cameras.main);

    // The header draws over the grid and takes the pointer, so a tile scrolled
    // under it can't be pressed.
    this.add.rectangle(0, 0, 256, HEADER, PALETTE.ink).setOrigin(0, 0).setInteractive();
    text(this, 8, 2, 'PYRIC ARCADE', { size: 16, color: 'sand' });
    text(this, 248, 7, `PLAYER ${uid.slice(-6).toUpperCase()}`, { align: 'right', color: 'lavender' });

    const focus = new FocusGroup(this, this.tiles);
    this.setScroll(this.scroll);

    // Scrolling: the wheel, a pointer or touch drag, and Page Up / Page Down.
    // Arrow keys move the focus, which scrolls the focused tile into view.
    const modalOpen = () => (this.data.get('modalCount') ?? 0) > 0;
    this.input.on('wheel', (_p: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) => {
      if (!modalOpen()) this.setScroll(this.scroll + dy / 4);
    });
    let pressY: number | null = null;
    let pressScroll = 0;
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      dragging = false;
      pressY = modalOpen() || pointer.worldY < HEADER ? null : pointer.worldY;
      pressScroll = this.scroll;
    });
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (pressY === null || !pointer.isDown) return;
      if (Math.abs(pointer.worldY - pressY) > DRAG_THRESHOLD) dragging = true;
      if (dragging) this.setScroll(pressScroll + (pressY - pointer.worldY));
    });
    this.input.on('pointerup', () => {
      pressY = null;
      // Tiles read the flag on this same release; clear it after they have.
      this.time.delayedCall(0, () => (dragging = false));
    });
    const page = 192 - HEADER - TILE.gap;
    this.input.keyboard?.on('keydown-PAGE_DOWN', () => {
      if (!modalOpen()) this.setScroll(this.scroll + page);
    });
    this.input.keyboard?.on('keydown-PAGE_UP', () => {
      if (!modalOpen()) this.setScroll(this.scroll - page);
    });

    for (const game of GAMES.filter((g) => g.scene)) {
      this.stops.push(
        watchOpenMatches(connection, game.id, (matches) => {
          this.open.set(game.id, matches);
          this.tiles.find((t) => t.game.id === game.id)?.setOpen(matches.length);
          this.refreshLobby?.();
        }),
      );
    }
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      focus.destroy();
      this.closeLobby?.();
      for (const stop of this.stops) stop();
      this.stops = [];
    });
  }

  private openLobby(game: ArcadeGame): void {
    this.closeLobby?.();
    const connection = this.game.registry.get('connection') as Connection;
    const uid = this.game.registry.get('uid') as string;
    const width = 200;
    const height = 150;
    const x = (256 - width) / 2;
    const y = 28;
    const dim = this.add.rectangle(0, 0, 256, 192, PALETTE.black, 0.6).setOrigin(0, 0).setInteractive().setDepth(900);
    const box = panel(this, x, y, width, height, 'orange', 'ink').setDepth(901);
    box.add(text(this, width / 2, 8, `${game.title.toUpperCase()} LOBBY`, { align: 'center', color: 'sand', size: 16 }));
    box.add(text(this, width / 2, 26, `${game.players} PLAYERS`, { align: 'center', color: 'lavender' }));
    this.data.set('modalCount', (this.data.get('modalCount') ?? 0) + 1);
    const focus = new FocusGroup(this, [], true);
    let rows: Array<Phaser.GameObjects.GameObject | Button> = [];

    const act = async (label: string, action: () => Promise<string | void>) => {
      try {
        const id = await action();
        close();
        if (typeof id === 'string') go({ kind: 'play', game: game.id, match: id });
      } catch (error) {
        toast(this, error instanceof Error && /permission/i.test(error.message) ? `${label}: denied by the rules` : `${label} failed`, 'error');
      }
    };

    const newMatch = new Button(this, x + 12, y + height - 22, 'New match', () =>
      void act('New match', () => game.create!(connection)), { width: 84, fill: 'green' });
    const closeButton = new Button(this, x + width - 12 - 60, y + height - 22, 'Close', () => close(), { width: 60, fill: 'maroon' });
    newMatch.container.setDepth(902);
    closeButton.container.setDepth(902);

    const render = () => {
      for (const r of rows) (r instanceof Button ? r.destroy() : r.destroy());
      rows = [];
      const matches = (this.open.get(game.id) ?? []).slice(0, 4);
      if (matches.length === 0) {
        rows.push(text(this, 128, y + 60, 'NO OPEN MATCHES. START ONE!', { align: 'center', color: 'cream' }).setDepth(902));
      }
      matches.forEach((m, i) => {
        const rowY = y + 40 + i * 20;
        const seats = game.seats(m.data);
        const mine = m.host === uid;
        rows.push(this.add.rectangle(x + 8, rowY - 2, width - 16, 18, PALETTE.purple).setOrigin(0, 0).setDepth(902));
        rows.push(text(this, x + 14, rowY + 3, `${mine ? 'YOUR MATCH' : `HOST ${m.host.slice(-6).toUpperCase()}`}`, { color: 'cream' }).setDepth(903));
        rows.push(text(this, x + 124, rowY + 3, `${seats.filled}/${seats.total}`, { color: 'sand' }).setDepth(903));
        const b = new Button(this, x + width - 56, rowY, mine ? 'Open' : 'Join', () =>
          void act(mine ? 'Open' : 'Join', async () => {
            if (!mine) await game.join!(connection, m.id);
            return m.id;
          }), { width: 44, fill: mine ? 'purple' : 'green' });
        b.container.setDepth(903);
        rows.push(b);
      });
      focus.set([...rows.filter((r): r is Button => r instanceof Button), newMatch, closeButton]);
    };
    render();
    this.refreshLobby = render;

    const close = () => {
      this.refreshLobby = null;
      this.closeLobby = null;
      this.data.set('modalCount', Math.max(0, (this.data.get('modalCount') ?? 1) - 1));
      focus.destroy();
      for (const r of rows) r.destroy();
      newMatch.destroy();
      closeButton.destroy();
      box.destroy();
      dim.destroy();
    };
    this.closeLobby = close;
    this.input.keyboard?.once('keydown-ESC', () => close());
  }
}
