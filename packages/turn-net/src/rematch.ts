/**
 * Rematches and leaving the lobby, shared by every game in the arcade.
 *
 * A rematch is `rematches/{game}/matches/{matchId}`, written once per
 * finished match: the game, the new match, and who proposed it. The proposer
 * creates the new match and the rematch document in one batch, so the rules
 * can check that the named match is new and theirs; the other players join it
 * through the game's normal join.
 */
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  writeBatch,
  type Firestore,
  type Unsubscribe,
} from 'firebase/firestore';
import type { Connection } from './index.ts';

/** The rematch document of the finished match `matchId` in `game`. */
function rematchRef(db: Firestore, game: string, matchId: string) {
  return doc(db, 'rematches', game, 'matches', matchId);
}

export interface Rematch {
  /** The collection of both matches. */
  game: string;
  /** The new match's id. */
  match: string;
  /** The uid of the player who proposed it, the new match's host. */
  by: string;
}

export interface RematchSpec {
  /** The collection that holds this game's matches. */
  game: string;
  /** The finished match. */
  matchId: string;
  /** A new match document hosted by `uid`; `createdAt` is added here. */
  fresh(uid: string): Record<string, unknown>;
  join(connection: Connection, id: string): Promise<void>;
}

function uidOf(connection: Connection): string {
  const uid = connection.auth.currentUser?.uid;
  if (!uid) throw new Error('Sign in first.');
  return uid;
}

/** Create a new match and name it the rematch of the finished match, in one batch. */
export async function proposeRematch(connection: Connection, spec: RematchSpec): Promise<string> {
  const uid = uidOf(connection);
  const next = doc(collection(connection.db, spec.game));
  const batch = writeBatch(connection.db);
  batch.set(next, { ...spec.fresh(uid), createdAt: serverTimestamp() });
  batch.set(rematchRef(connection.db, spec.game, spec.matchId), { game: spec.game, match: next.id, by: uid } satisfies Rematch);
  await batch.commit();
  return next.id;
}

export async function readRematch({ db }: Connection, game: string, matchId: string): Promise<Rematch | null> {
  const snap = await getDoc(rematchRef(db, game, matchId));
  return snap.exists() ? (snap.data() as Rematch) : null;
}

export function watchRematch(
  { db }: Connection,
  game: string,
  matchId: string,
  onChange: (rematch: Rematch | null) => void,
): Unsubscribe {
  return onSnapshot(rematchRef(db, game, matchId), (snap) => onChange(snap.exists() ? (snap.data() as Rematch) : null));
}

/**
 * Take a seat in the rematch: join the one already proposed, or propose it.
 * When two players propose at once the rules store one; the other joins it.
 * Returns the id of the match to open.
 */
export async function playRematch(connection: Connection, spec: RematchSpec, known: Rematch | null): Promise<string> {
  let rematch = known ?? (await readRematch(connection, spec.game, spec.matchId));
  if (!rematch) {
    try {
      return await proposeRematch(connection, spec);
    } catch (error) {
      rematch = await readRematch(connection, spec.game, spec.matchId);
      if (!rematch) throw error;
    }
  }
  if (rematch.by !== uidOf(connection)) await spec.join(connection, rematch.match);
  return rematch.match;
}

export interface RematchAction {
  label: string;
  onPress: () => void;
}

/**
 * Keep the game-over screen's rematch action current. `show` gets "Rematch"
 * until someone proposes one, then "Join rematch" (or "Open rematch" for its
 * proposer), with the rematch; it is not called again while a press is in
 * flight. Pressing the action opens the new match with `open`.
 */
export function offerRematch(
  connection: Connection,
  spec: RematchSpec & { open(id: string): void; onError(error: unknown): void },
  show: (action: RematchAction, rematch: Rematch | null) => void,
): Unsubscribe {
  let current: Rematch | null = null;
  let pressing = false;
  let shown = '';
  const emit = () => {
    const label = !current ? 'Rematch' : current.by === connection.auth.currentUser?.uid ? 'Open rematch' : 'Join rematch';
    if (pressing || label === shown) return;
    shown = label;
    show({ label, onPress: press }, current);
  };
  const press = () => {
    pressing = true;
    playRematch(connection, spec, current).then(
      (id) => spec.open(id),
      (error) => {
        pressing = false;
        shown = '';
        spec.onError(error);
        emit();
      },
    );
  };
  emit();
  return watchRematch(connection, spec.game, spec.matchId, (rematch) => {
    current = rematch;
    emit();
  });
}

/** The part of a match screen the game-over offer draws on. */
export interface GameOverScreen {
  gameOver(title: string, body: string, actions: RematchAction[]): void;
  notice(message: string): void;
}

/**
 * Show the game-over screen with the rematch action first, then `rest`, and
 * redraw it when another player proposes the rematch. Stop it when the scene
 * shuts down.
 */
export function gameOverWithRematch(
  connection: Connection,
  screen: GameOverScreen,
  title: string,
  body: string,
  spec: RematchSpec & { open(id: string): void; onError(error: unknown): void },
  rest: RematchAction[],
): Unsubscribe {
  return offerRematch(connection, spec, (action, rematch) => {
    if (rematch && rematch.by !== connection.auth.currentUser?.uid) screen.notice('Rematch offered');
    screen.gameOver(title, body, [action, ...rest]);
  });
}

/**
 * Cancel a waiting match when its host leaves it: call the returned function
 * when the scene shuts down; the page hiding cancels it too, best effort.
 * `waitingHost` reads the latest match, so a match that has started (or one a
 * guest joined) is never cancelled; the rules only allow cancelling while
 * waiting either way.
 */
export function cancelWhenLeft(waitingHost: () => boolean, cancel: () => Promise<void>): () => void {
  const leave = () => {
    if (waitingHost()) cancel().catch(() => {});
  };
  addEventListener('pagehide', leave);
  return () => {
    removeEventListener('pagehide', leave);
    leave();
  };
}
