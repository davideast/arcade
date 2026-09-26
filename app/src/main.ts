import * as Phaser from 'phaser';
import { createPixelGame } from '@games/kit';
import {
  cancelMatch,
  connect,
  createMatch,
  joinMatch,
  playMove,
  resign,
  signIn,
  watchMatch,
  watchOpenMatches,
  type MatchView,
} from '@games/turn-net';
import { PALETTE, PICK_EVENT, TicTacToeScene, ticTacToe, type Board } from '@games/tictactoe';

const connection = connect({ apiKey: 'demo', projectId: 'demo-pyric-games', appId: 'demo' });

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const who = $('who');
const controls = $('match-controls');
const openList = $<HTMLUListElement>('open-matches');
const errorLine = $('error');

const game = createPixelGame($('stage'), [TicTacToeScene], PALETTE.background);

let uid = '';
let current: MatchView<Board> | null = null;
let stopMatch: (() => void) | null = null;

function report(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  errorLine.textContent = /permission/i.test(message) ? 'The rules denied that move.' : message;
}

async function attempt(action: () => Promise<unknown>): Promise<void> {
  errorLine.textContent = '';
  try {
    await action();
  } catch (error) {
    report(error);
  }
}

function scene(): TicTacToeScene | null {
  return (game.scene.getScene('tictactoe') as TicTacToeScene | null) ?? null;
}

function openMatch(id: string | null): void {
  stopMatch?.();
  stopMatch = null;
  current = null;
  history.replaceState(null, '', id ? `#match=${id}` : '#');
  if (id) {
    stopMatch = watchMatch(connection, ticTacToe, id, (view) => {
      current = view;
      scene()?.show(view);
      renderControls();
    });
  } else {
    scene()?.show(null);
  }
  renderControls();
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement('button');
  el.textContent = label;
  el.addEventListener('click', onClick);
  return el;
}

function renderControls(): void {
  controls.replaceChildren();
  const view = current;
  if (!view) {
    controls.append(button('New match', () => attempt(async () => openMatch(await createMatch(connection, ticTacToe)))));
    return;
  }
  const { doc, seat, id } = view;
  if (doc.status === 'waiting' && seat === 'host') {
    controls.append(button('Cancel match', () => attempt(async () => {
      await cancelMatch(connection, ticTacToe, id);
      openMatch(null);
    })));
  }
  if (doc.status === 'playing' && seat) {
    controls.append(button('Resign', () => attempt(() => resign(connection, ticTacToe, id, seat))));
  }
  if (doc.status !== 'playing' && doc.status !== 'waiting') {
    controls.append(button('Back to lobby', () => openMatch(null)));
  }
}

function renderOpenMatches(matches: { id: string; host: string }[]): void {
  openList.replaceChildren(
    ...matches.map((m) => {
      const item = document.createElement('li');
      const label = document.createElement('span');
      const mine = m.host === uid;
      label.textContent = mine ? `${m.id.slice(0, 6)} (yours)` : m.id.slice(0, 6);
      item.append(label);
      item.append(
        mine
          ? button('Open', () => openMatch(m.id))
          : button('Join', () => attempt(async () => {
              await joinMatch(connection, ticTacToe, m.id);
              openMatch(m.id);
            })),
      );
      return item;
    }),
  );
  if (matches.length === 0) openList.innerHTML = '<li class="hint">None yet</li>';
}

game.events.once(Phaser.Core.Events.READY, () => {
  scene()?.events.on(PICK_EVENT, (index: number) => {
    const id = current?.id;
    if (id) void attempt(() => playMove(connection, ticTacToe, id, index));
  });
});

const user = await signIn(connection.auth);
uid = user.uid;
who.textContent = `Signed in as ${uid.slice(-6)}`;
watchOpenMatches(connection, ticTacToe, renderOpenMatches);
openMatch(new URLSearchParams(location.hash.slice(1)).get('match'));
