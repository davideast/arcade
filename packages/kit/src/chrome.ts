/**
 * The screen every match shares: a top bar with the game's title and a back
 * button, a 128x128 play area on the left, and a side panel listing players,
 * the match status, and actions. Games draw their board inside `playArea`.
 */
import * as Phaser from 'phaser';
import { LOGICAL_HEIGHT, LOGICAL_WIDTH } from './index.ts';
import { PALETTE, type PaletteColor } from './palette.ts';
import { Button, FocusGroup, overlay, panel, text, toast, type OverlayAction } from './ui.ts';

export const PLAY_AREA = { x: 8, y: 28, width: 128, height: 128 } as const;
const SIDE = { x: 144, y: 28, width: 104, height: 156 } as const;

export interface PlayerLine {
  name: string;
  /** A short marker drawn before the name, such as X or O, or a color. */
  mark?: string;
  markColor?: PaletteColor;
  active?: boolean;
  you?: boolean;
  detail?: string;
}

export interface MatchChrome {
  setStatus(message: string, color?: PaletteColor): void;
  setPlayers(players: PlayerLine[]): void;
  setActions(actions: { label: string; onPress: () => void; enabled?: boolean }[]): void;
  denied(message?: string): void;
  notice(message: string): void;
  gameOver(title: string, body: string, actions: OverlayAction[]): void;
}

export function matchChrome(
  scene: Phaser.Scene,
  options: { title: string; background?: PaletteColor; onBack: () => void },
): MatchChrome {
  scene.add.rectangle(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT, PALETTE[options.background ?? 'lavender']).setOrigin(0, 0);
  scene.add.rectangle(0, 0, LOGICAL_WIDTH, 20, PALETTE.ink).setOrigin(0, 0);
  text(scene, 8, 6, options.title.toUpperCase(), { color: 'sand' });
  const back = new Button(scene, LOGICAL_WIDTH - 52, 2, 'Arcade', options.onBack, { width: 48, fill: 'maroon' });

  panel(scene, SIDE.x, SIDE.y, SIDE.width, SIDE.height, 'purple', 'ink');
  const status = text(scene, SIDE.x + 6, SIDE.y + 6, '', { color: 'sand', wrap: SIDE.width - 12 });
  text(scene, SIDE.x + 6, SIDE.y + 34, 'PLAYERS', { color: 'lavender' });
  let playerObjects: Phaser.GameObjects.GameObject[] = [];
  let actionButtons: Button[] = [];
  const focus = new FocusGroup(scene, [back]);

  let gameOverClose: (() => void) | null = null;
  return {
    setStatus(message, color = 'sand') {
      status.setText(message).setColor(`#${PALETTE[color].toString(16).padStart(6, '0')}`);
    },
    setPlayers(players) {
      for (const o of playerObjects) o.destroy();
      playerObjects = [];
      players.forEach((p, i) => {
        const y = SIDE.y + 46 + i * 12;
        if (p.active) {
          playerObjects.push(scene.add.rectangle(SIDE.x + 3, y - 2, SIDE.width - 6, 11, PALETTE.maroon).setOrigin(0, 0));
        }
        if (p.mark) playerObjects.push(text(scene, SIDE.x + 6, y, p.mark, { color: p.markColor ?? 'cream' }));
        const name = `${p.name}${p.you ? ' (you)' : ''}`;
        playerObjects.push(text(scene, SIDE.x + (p.mark ? 18 : 6), y, name, { color: p.active ? 'sand' : 'cream' }));
        if (p.detail) playerObjects.push(text(scene, SIDE.x + SIDE.width - 6, y, p.detail, { color: 'lavender', align: 'right' }));
      });
    },
    setActions(actions) {
      for (const b of actionButtons) b.destroy();
      actionButtons = actions.map((a, i) =>
        new Button(scene, SIDE.x + 6, SIDE.y + SIDE.height - 20 - (actions.length - 1 - i) * 18, a.label, a.onPress, {
          width: SIDE.width - 12,
          disabled: a.enabled === false,
        }),
      );
      focus.set([...actionButtons, back]);
    },
    denied(message = 'The rules denied that move') {
      toast(scene, message, 'error');
    },
    notice(message) {
      toast(scene, message, 'info');
    },
    gameOver(title, body, actions) {
      gameOverClose?.();
      gameOverClose = overlay(scene, title, body, actions.map((a) => ({
        label: a.label,
        onPress: () => {
          gameOverClose = null;
          a.onPress();
        },
      })));
    },
  };
}
