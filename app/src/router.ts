/**
 * Hash routes: `#/` is the arcade; `#/play/<game>/<match>` opens a match.
 * Scenes navigate with `go()`; the browser's back button works too.
 */
import type * as Phaser from 'phaser';

export type Route = { kind: 'arcade' } | { kind: 'play'; game: string; match: string };

export function parseRoute(hash: string): Route {
  const [, kind, game, match] = hash.replace(/^#/, '').split('/');
  if (kind === 'play' && game && match) return { kind: 'play', game, match };
  return { kind: 'arcade' };
}

export function go(route: Route): void {
  location.hash = route.kind === 'play' ? `#/play/${route.game}/${route.match}` : '#/';
}

/** Show the scene for the current route, stopping every other scene. */
export function showRoute(game: Phaser.Game, route: Route): void {
  for (const scene of game.scene.getScenes(true)) {
    if (scene.scene.key !== 'boot') game.scene.stop(scene.scene.key);
  }
  if (route.kind === 'play' && game.scene.getScene(route.game)) {
    game.scene.start(route.game, { matchId: route.match });
  } else {
    game.scene.start('arcade');
  }
}
