/**
 * The arcade's games. Each entry names its sheet (the right-hand 128x128 of
 * every sheet is a mockup of the game, used as its tile), how to read seats
 * from a match document, and how to create and join a match. Games without a
 * scene show as "Soon".
 */
import type * as Phaser from 'phaser';
import { createMatch, joinMatch, type Connection } from '@games/turn-net';
import { TicTacToeScene, ticTacToe } from '@games/tictactoe';
import { UnoScene, createUno, joinUno } from '@games/uno';
import { PoolScene, createPool, joinPool } from '@games/pool';
import tictactoeSheet from '../../MASFunPack/AllGames/TicTacToeSpriteSheet.png?url';
import unoSheet from '../../MASFunPack/AllGames/Uno.png?url';
import poolSheet from '../../MASFunPack/AllGames/PoolSpriteSheet.png?url';
import battleshipSheet from '../../MASFunPack/AllGames/BattleshipSpriteSheet.png?url';
import chessSheet from '../../MASFunPack/AllGames/ChessSpriteSheet.png?url';
import checkersSheet from '../../MASFunPack/AllGames/CheckersSpriteSheet.png?url';

export interface ArcadeGame {
  id: string;
  title: string;
  /** Texture key of the game's sheet; its mockup frame is `${key}-mockup`. */
  sheetKey: string;
  sheetUrl: string;
  players: string;
  scene?: Phaser.Types.Scenes.SceneType;
  seats(data: Record<string, unknown>): { filled: number; total: number };
  create?(connection: Connection): Promise<string>;
  join?(connection: Connection, id: string): Promise<void>;
}

const twoSeats = (data: Record<string, unknown>) => ({ filled: data.guest ? 2 : 1, total: 2 });

export const GAMES: ArcadeGame[] = [
  {
    id: 'tictactoe',
    title: 'Tic-Tac-Toe',
    sheetKey: 'sheet-tictactoe',
    sheetUrl: tictactoeSheet,
    players: '2',
    scene: TicTacToeScene,
    seats: twoSeats,
    create: (c) => createMatch(c, ticTacToe),
    join: (c, id) => joinMatch(c, ticTacToe, id),
  },
  {
    id: 'uno',
    title: 'Uno',
    sheetKey: 'sheet-uno',
    sheetUrl: unoSheet,
    players: '2-4',
    scene: UnoScene,
    seats: (data) => ({ filled: (data.players as string[] | undefined)?.length ?? 1, total: 4 }),
    create: (c) => createUno(c),
    join: (c, id) => joinUno(c, id),
  },
  {
    id: 'pool',
    title: 'Pool',
    sheetKey: 'sheet-pool',
    sheetUrl: poolSheet,
    players: '2',
    scene: PoolScene,
    seats: twoSeats,
    create: (c) => createPool(c),
    join: (c, id) => joinPool(c, id),
  },
  { id: 'battleship', title: 'Battleship', sheetKey: 'sheet-battleship', sheetUrl: battleshipSheet, players: '2', seats: twoSeats },
  { id: 'chess', title: 'Chess', sheetKey: 'sheet-chess', sheetUrl: chessSheet, players: '2', seats: twoSeats },
  { id: 'checkers', title: 'Checkers', sheetKey: 'sheet-checkers', sheetUrl: checkersSheet, players: '2', seats: twoSeats },
];

export function gameById(id: string): ArcadeGame | undefined {
  return GAMES.find((g) => g.id === id);
}
