/** The two seats of a match. Field values in the match document use these names. */
export type Seat = 'host' | 'guest';

export type MatchStatus = 'waiting' | 'playing' | 'won' | 'draw' | 'resigned';

export type Outcome =
  | { status: 'playing' }
  | { status: 'won'; winner: Seat }
  | { status: 'draw' };

/**
 * Fields every match document carries, shared by all two-player turn games.
 * They follow the rules standard library convention (`lobby`, `turns`, `state`).
 */
export interface MatchMeta {
  host: string;
  guest: string;
  currentTurn: Seat;
  status: MatchStatus;
  winner: '' | Seat;
  moveCount: number;
}

/** Pure game rules, shared by the client and the rules test harness. */
export interface GameLogic<State, Move> {
  initial(): State;
  legalMoves(state: State, seat: Seat): Move[];
  apply(state: State, move: Move, seat: Seat): State;
  outcome(state: State): Outcome;
}

export interface GameDefinition<State, Move> {
  /** Stable id; also the Firestore collection that holds this game's matches. */
  id: string;
  title: string;
  logic: GameLogic<State, Move>;
  /** Game-specific document fields for a state, and the move that produced it (null at creation). */
  toFields(state: State, move: Move | null): Record<string, unknown>;
  fromFields(data: Record<string, unknown>): State;
}

export function otherSeat(seat: Seat): Seat {
  return seat === 'host' ? 'guest' : 'host';
}
