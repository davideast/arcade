import { otherSeat, type GameDefinition, type MatchMeta, type Seat } from './types.ts';

/**
 * Document transitions shared by every turn game. The client proposes these
 * documents and the Security Rules verify them, so they must match the rules'
 * expectations exactly. The rules test harness builds its cases from the same
 * functions.
 */

export type MatchDoc = MatchMeta & Record<string, unknown>;

export function createdMatch<S, M>(def: GameDefinition<S, M>, hostUid: string): MatchDoc {
  return {
    host: hostUid,
    guest: '',
    currentTurn: 'host',
    status: 'waiting',
    winner: '',
    moveCount: 0,
    ...def.toFields(def.logic.initial(), null),
  };
}

export function joinedMatch(before: MatchDoc, guestUid: string): MatchDoc {
  return { ...before, guest: guestUid, status: 'playing' };
}

/** The document after `seat` plays `move`, with the outcome the move produces. */
export function movedMatch<S, M>(def: GameDefinition<S, M>, before: MatchDoc, move: M): MatchDoc {
  const seat: Seat = before.currentTurn;
  const next = def.logic.apply(def.fromFields(before), move, seat);
  const outcome = def.logic.outcome(next);
  return {
    ...before,
    ...def.toFields(next, move),
    currentTurn: otherSeat(seat),
    moveCount: before.moveCount + 1,
    status: outcome.status,
    winner: outcome.status === 'won' ? outcome.winner : '',
  };
}

export function resignedMatch(before: MatchDoc, resigning: Seat): MatchDoc {
  return { ...before, status: 'resigned', winner: otherSeat(resigning) };
}

export function seatOf(doc: MatchMeta, uid: string): Seat | null {
  if (doc.host === uid) return 'host';
  if (doc.guest === uid) return 'guest';
  return null;
}
