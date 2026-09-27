/**
 * The page element that owns the arcade's listeners. Pyric's listener tools
 * outline a listener's owner on the page; the arcade draws everything on one
 * canvas, so every listener names the element that holds it.
 */
import type { ListenOptions } from 'firebase/database';
import type { SnapshotListenOptions } from 'firebase/firestore';

let owner: Element | undefined;

/** Name the element that holds the game canvas. Call once, before any listener opens. */
export function setListenerOwner(element: Element): void {
  owner = element;
}

// `owner` is Pyric's listen option; Firebase ignores it, so it rides on each SDK's own options type.
function withOwner<T extends object>(): T {
  return (owner === undefined ? {} : { owner }) as T;
}

/** Options for Firestore's onSnapshot that name the owner. */
export function listenOptions(): SnapshotListenOptions {
  return withOwner<SnapshotListenOptions>();
}

/** Options for the Realtime Database's onValue that name the owner. */
export function valueListenOptions(): ListenOptions {
  return withOwner<ListenOptions>();
}
