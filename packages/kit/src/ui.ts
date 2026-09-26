/**
 * Game UI drawn in Phaser: panels framed with the pack's 9-slice frames, pixel
 * text, buttons with hover, focus and keyboard states, a focus group for arrow
 * and Tab navigation, toasts, and modal overlays for pause and game over.
 */
import * as Phaser from 'phaser';
import sheetUrl from '../../../MASFunPack/SpriteSheet.png?url';
import { PALETTE, css, type PaletteColor } from './palette.ts';

export const UI_SHEET = 'ui-sheet';
export const FONT = 'Silkscreen';

/** The double-line frames on the combined sheet: 16x16, 3px borders. */
const FRAMES = {
  purple: [4, 20],
  red: [28, 20],
  cream: [4, 44],
  orange: [28, 44],
} as const;
export type FrameColor = keyof typeof FRAMES;

/** Load the UI sheet and the pixel font. Call from a boot scene's preload. */
export function preloadUi(scene: Phaser.Scene): void {
  scene.load.image(UI_SHEET, sheetUrl);
}

/** Register the UI frames and wait for the font. Call from the boot scene's create. */
export async function readyUi(scene: Phaser.Scene): Promise<void> {
  const texture = scene.textures.get(UI_SHEET);
  for (const [name, [x, y]] of Object.entries(FRAMES)) {
    if (!texture.has(`frame-${name}`)) texture.add(`frame-${name}`, 0, x, y, 16, 16);
  }
  await document.fonts.load(`8px ${FONT}`);
}

export interface TextOptions {
  color?: PaletteColor;
  size?: 8 | 16;
  align?: 'left' | 'center' | 'right';
  wrap?: number;
}

/** Pixel text: the font's native 8px grid, rendered at the canvas scale so it stays crisp. */
export function text(scene: Phaser.Scene, x: number, y: number, value: string, options: TextOptions = {}): Phaser.GameObjects.Text {
  const align = options.align ?? 'left';
  const t = scene.add.text(Math.round(x), Math.round(y), value, {
    fontFamily: FONT,
    fontSize: `${options.size ?? 8}px`,
    color: css(options.color ?? 'cream'),
    align,
    wordWrap: options.wrap ? { width: options.wrap } : undefined,
    lineSpacing: 2,
  });
  t.setResolution(scene.game.registry.get('renderScale') ?? 4);
  t.setOrigin(align === 'center' ? 0.5 : align === 'right' ? 1 : 0, 0);
  return t;
}

/** A framed panel: a fill with one of the pack's double-line frames drawn over it. */
export function panel(
  scene: Phaser.Scene,
  x: number,
  y: number,
  width: number,
  height: number,
  frame: FrameColor = 'purple',
  fill: PaletteColor = 'ink',
): Phaser.GameObjects.Container {
  const background = scene.add.rectangle(0, 0, width - 4, height - 4, PALETTE[fill]).setOrigin(0, 0).setPosition(2, 2);
  const border = scene.add.nineslice(0, 0, UI_SHEET, `frame-${frame}`, width, height, 3, 3, 3, 3).setOrigin(0, 0);
  return scene.add.container(Math.round(x), Math.round(y), [background, border]);
}

export interface ButtonOptions {
  width?: number;
  frame?: FrameColor;
  fill?: PaletteColor;
  color?: PaletteColor;
  disabled?: boolean;
}

/** A framed button. Hover and keyboard focus share one highlighted state. */
export class Button {
  readonly container: Phaser.GameObjects.Container;
  private readonly background: Phaser.GameObjects.Rectangle;
  private readonly label: Phaser.GameObjects.Text;
  private readonly frameImage: Phaser.GameObjects.NineSlice;
  private focused = false;
  private enabled: boolean;
  private destroyed = false;

  constructor(
    private readonly scene: Phaser.Scene,
    x: number,
    y: number,
    caption: string,
    private readonly onPress: () => void,
    private readonly options: ButtonOptions = {},
  ) {
    const width = options.width ?? Math.max(40, caption.length * 6 + 14);
    const height = 16;
    this.background = scene.add.rectangle(2, 2, width - 4, height - 4, PALETTE[options.fill ?? 'purple']).setOrigin(0, 0);
    this.frameImage = scene.add.nineslice(0, 0, UI_SHEET, `frame-${options.frame ?? 'cream'}`, width, height, 3, 3, 3, 3).setOrigin(0, 0);
    this.label = text(scene, width / 2, 4, caption, { color: options.color ?? 'cream', align: 'center' });
    this.container = scene.add.container(Math.round(x), Math.round(y), [this.background, this.frameImage, this.label]);
    this.container.setSize(width, height);
    this.container.setInteractive(new Phaser.Geom.Rectangle(width / 2, height / 2, width, height), Phaser.Geom.Rectangle.Contains);
    this.container.on('pointerover', () => this.setFocus(true));
    this.container.on('pointerout', () => this.setFocus(false));
    this.container.on('pointerdown', () => this.press());
    this.enabled = !options.disabled;
    this.render();
  }

  get width(): number {
    return this.container.width;
  }

  setEnabled(enabled: boolean): this {
    this.enabled = enabled;
    this.render();
    return this;
  }

  setCaption(caption: string): this {
    this.label.setText(caption);
    return this;
  }

  setFocus(focused: boolean): this {
    this.focused = focused;
    this.render();
    return this;
  }

  press(): void {
    if (!this.enabled || this.destroyed) return;
    this.scene.tweens.add({ targets: this.container, y: this.container.y + 1, duration: 40, yoyo: true });
    this.onPress();
  }

  destroy(): void {
    this.destroyed = true;
    this.container.destroy();
  }

  private render(): void {
    if (this.destroyed) return;
    const fill = this.options.fill ?? 'purple';
    this.background.setFillStyle(PALETTE[this.focused && this.enabled ? 'orange' : fill]);
    this.label.setColor(css(this.enabled ? (this.focused ? 'ink' : this.options.color ?? 'cream') : 'lavender'));
    this.container.setAlpha(this.enabled ? 1 : 0.6);
  }
}

/** Anything keyboard navigation can focus and press. */
export interface Focusable {
  setFocus(focused: boolean): unknown;
  press(): void;
}

/**
 * Keyboard navigation over a set of buttons: arrows and Tab move focus,
 * Enter and Space press. Pointer hover moves focus too, so the two agree.
 */
export class FocusGroup {
  private index = -1;
  private readonly bindings: Array<[Phaser.Input.Keyboard.Key, () => void]> = [];
  private suspended = false;

  constructor(
    private readonly scene: Phaser.Scene,
    private buttons: Focusable[] = [],
    private readonly modal = false,
  ) {
    const keyboard = scene.input.keyboard;
    if (!keyboard) return;
    const on = (code: number, handler: () => void) => {
      const key = keyboard.addKey(code, true);
      const guarded = () => {
        const modalOpen = (this.scene.data.get('modalCount') ?? 0) > 0;
        if (!this.suspended && (this.modal || !modalOpen)) handler();
      };
      key.on('down', guarded);
      this.bindings.push([key, guarded]);
    };
    on(Phaser.Input.Keyboard.KeyCodes.DOWN, () => this.move(1));
    on(Phaser.Input.Keyboard.KeyCodes.RIGHT, () => this.move(1));
    on(Phaser.Input.Keyboard.KeyCodes.TAB, () => this.move(1));
    on(Phaser.Input.Keyboard.KeyCodes.UP, () => this.move(-1));
    on(Phaser.Input.Keyboard.KeyCodes.LEFT, () => this.move(-1));
    on(Phaser.Input.Keyboard.KeyCodes.ENTER, () => this.current()?.press());
    on(Phaser.Input.Keyboard.KeyCodes.SPACE, () => this.current()?.press());
  }

  /** Replace the items. The old items are not touched; their owner may have destroyed them. */
  set(buttons: Focusable[]): void {
    this.buttons = buttons;
    this.index = -1;
  }

  /** Ignore keys while another group (an overlay) has them. */
  suspend(suspended: boolean): void {
    this.suspended = suspended;
  }

  destroy(): void {
    for (const [key, handler] of this.bindings) key.off('down', handler);
  }

  private current(): Focusable | undefined {
    return this.index >= 0 ? this.buttons[this.index] : undefined;
  }

  private move(step: number): void {
    if (this.buttons.length === 0) return;
    this.current()?.setFocus(false);
    this.index = (this.index + step + this.buttons.length) % this.buttons.length;
    this.current()?.setFocus(true);
  }
}

/** A short message that slides in at the bottom and fades, for denied moves and errors. */
export function toast(scene: Phaser.Scene, message: string, tone: 'info' | 'error' = 'info'): void {
  const width = scene.scale.gameSize.width / (scene.game.registry.get('renderScale') ?? 4);
  const height = scene.scale.gameSize.height / (scene.game.registry.get('renderScale') ?? 4);
  const boxWidth = Math.min(width - 16, message.length * 6 + 16);
  const box = panel(scene, (width - boxWidth) / 2, height, boxWidth, 16, tone === 'error' ? 'red' : 'cream', tone === 'error' ? 'maroon' : 'purple');
  box.add(text(scene, boxWidth / 2, 4, message, { align: 'center' }));
  box.setDepth(1000);
  scene.tweens.add({
    targets: box,
    y: height - 22,
    duration: 150,
    ease: 'Quad.easeOut',
    hold: 1800,
    yoyo: true,
    onComplete: () => box.destroy(),
  });
}

export interface OverlayAction {
  label: string;
  onPress: () => void;
}

/** A modal panel over a dimmed scene, for pause and game over. Returns a close function. */
export function overlay(
  scene: Phaser.Scene,
  title: string,
  body: string,
  actions: OverlayAction[],
  frame: FrameColor = 'orange',
): () => void {
  const scale = scene.game.registry.get('renderScale') ?? 4;
  const width = scene.scale.gameSize.width / scale;
  const height = scene.scale.gameSize.height / scale;
  const dim = scene.add.rectangle(0, 0, width, height, PALETTE.black, 0.6).setOrigin(0, 0).setDepth(900).setInteractive();
  const boxWidth = 160;
  const boxHeight = 44 + (body ? 20 : 0) + actions.length * 20;
  const box = panel(scene, (width - boxWidth) / 2, (height - boxHeight) / 2, boxWidth, boxHeight, frame, 'ink').setDepth(901);
  box.add(text(scene, boxWidth / 2, 10, title.toUpperCase(), { align: 'center', color: 'sand', size: 16 }));
  if (body) box.add(text(scene, boxWidth / 2, 32, body, { align: 'center', color: 'cream', wrap: boxWidth - 16 }));
  const buttons = actions.map((action, i) => {
    const b = new Button(scene, 0, 0, action.label, () => {
      close();
      action.onPress();
    }, { width: 100 });
    b.container.setPosition((width - 100) / 2, (height - boxHeight) / 2 + 40 + (body ? 20 : 0) + i * 20).setDepth(902);
    return b;
  });
  scene.data.set('modalCount', (scene.data.get('modalCount') ?? 0) + 1);
  const focus = new FocusGroup(scene, buttons, true);
  const close = () => {
    scene.data.set('modalCount', Math.max(0, (scene.data.get('modalCount') ?? 1) - 1));
    focus.destroy();
    for (const b of buttons) b.destroy();
    box.destroy();
    dim.destroy();
  };
  return close;
}
