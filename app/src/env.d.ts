interface ImportMetaEnv {
  /** The web app's Firebase config as JSON. */
  readonly VITE_FIREBASE_CONFIG?: string;
  /** Named Firestore database id. */
  readonly VITE_FIRESTORE_DATABASE?: string;
  /** Identity Platform tenant id. */
  readonly VITE_AUTH_TENANT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
