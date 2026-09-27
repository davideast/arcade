/**
 * The arcade's Sokoban levels: levels 1, 2, 3, 4, 5 and 7 of Microban by
 * David W. Skinner (2000), a collection he released for free use with
 * credit. They run from a single box to four boxes on four goals.
 *
 * Standard notation: `#` wall, `.` goal, `$` box, `*` box on a goal, `@` the
 * player, `+` the player on a goal, and a space for floor.
 *
 * `minMoves` and `minPushes` are the fewest moves and the fewest pushes that
 * solve each level, found by breadth-first search (logic.test.ts searches
 * again and checks them). The Firestore rules repeat them as lower bounds on
 * a claimed score, so a claim below what any solution can reach is denied.
 */
export interface LevelSpec {
  id: string;
  name: string;
  rows: string[];
  minMoves: number;
  minPushes: number;
}

export const CREDIT = 'Levels: Microban by David W. Skinner';

export const LEVELS: LevelSpec[] = [
  {
    id: '1',
    name: 'Microban 1',
    rows: [
      '####',
      '# .#',
      '#  ###',
      '#*@  #',
      '#  $ #',
      '#  ###',
      '####',
    ],
    minMoves: 33,
    minPushes: 8,
  },
  {
    id: '2',
    name: 'Microban 2',
    rows: [
      '######',
      '#    #',
      '# #@ #',
      '# $* #',
      '# .* #',
      '#    #',
      '######',
    ],
    minMoves: 16,
    minPushes: 3,
  },
  {
    id: '3',
    name: 'Microban 3',
    rows: [
      '  ####',
      '###  ####',
      '#     $ #',
      '# #  #$ #',
      '# . .#@ #',
      '#########',
    ],
    minMoves: 41,
    minPushes: 13,
  },
  {
    id: '4',
    name: 'Microban 4',
    rows: [
      '########',
      '#      #',
      '# .**$@#',
      '#      #',
      '#####  #',
      '    ####',
    ],
    minMoves: 23,
    minPushes: 7,
  },
  {
    id: '5',
    name: 'Microban 5',
    rows: [
      ' #######',
      ' #     #',
      ' # .$. #',
      '## $@$ #',
      '#  .$. #',
      '#      #',
      '########',
    ],
    minMoves: 25,
    minPushes: 6,
  },
  {
    id: '7',
    name: 'Microban 7',
    rows: [
      '#######',
      '#     #',
      '# .$. #',
      '# $.$ #',
      '# .$. #',
      '# $.$ #',
      '#  @  #',
      '#######',
    ],
    minMoves: 26,
    minPushes: 6,
  },
];

export function levelSpec(id: string): LevelSpec | undefined {
  return LEVELS.find((l) => l.id === id);
}
