import * as Phaser from 'phaser';
import '@fontsource/silkscreen/400.css';
import { createPixelGame, css } from '@games/kit';
import { connect, setListenerOwner, signIn } from '@games/turn-net';
import { ArcadeScene } from './arcade-scene.ts';
import { BootScene } from './boot-scene.ts';
import { connectOptions, firebaseOptions } from './firebase-config.ts';
import { GAMES } from './catalog.ts';
import { parseRoute, showRoute } from './router.ts';

const connection = connect(firebaseOptions, connectOptions);
const user = await signIn(connection.auth);

const scenes: Phaser.Types.Scenes.SceneType[] = [
  BootScene,
  ArcadeScene,
  ...GAMES.flatMap((g) => (g.scene ? [g.scene] : [])),
];
const stage = document.getElementById('stage')!;
// Pyric outlines each listener's owner; every listener in the arcade draws into this element's canvas.
setListenerOwner(stage);
const game = createPixelGame(stage, scenes, css('ink'));
game.registry.set('connection', connection);
game.registry.set('uid', user.uid);

game.events.once('arcade-ready', () => {
  showRoute(game, parseRoute(location.hash));
  addEventListener('hashchange', () => showRoute(game, parseRoute(location.hash)));
});
