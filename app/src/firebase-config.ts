/**
 * Where the arcade connects. A production build gets its web app config,
 * named database and auth tenant from VITE_ variables (the deploy pipeline
 * sets them). Without them, as under `vite dev` where pyric() swaps Firebase
 * for the local sandbox, a demo config is enough.
 */
import type { FirebaseOptions } from 'firebase/app';
import type { ConnectOptions } from '@games/turn-net';

const DEMO: FirebaseOptions = { apiKey: 'demo', projectId: 'demo-pyric-games', appId: 'demo' };

const env = import.meta.env;

export const firebaseOptions: FirebaseOptions = env.VITE_FIREBASE_CONFIG ? JSON.parse(env.VITE_FIREBASE_CONFIG) : DEMO;

export const connectOptions: ConnectOptions = {
  database: env.VITE_FIRESTORE_DATABASE || undefined,
  tenantId: env.VITE_AUTH_TENANT_ID || undefined,
};
