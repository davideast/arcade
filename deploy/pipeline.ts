/**
 * A deploy pipeline is a list of steps. Each step says whether its work is
 * already done and how to do it; the runner skips done steps, so a rerun only
 * does what's missing. Steps share a context: the settings, and a `facts` map
 * where one step leaves what a later step needs (the web app id, the SDK
 * config). New work is a new step in the list, not a branch in the runner.
 */

export interface Settings {
  project: string;
  /** Hosting site name; the app serves at https://<site>.web.app. */
  site: string;
  /** Hosting deploy target name in firebase.json. */
  target: string;
  /** Named Firestore database. */
  database: string;
  /** Firestore location, for example nam5. */
  firestoreLocation: string;
  /** Realtime Database instance id (globally unique). */
  rtdbInstance: string;
  /** Realtime Database location, for example us-central1. */
  rtdbLocation: string;
  /** Cloud Storage bucket name (globally unique). */
  bucket: string;
  /** Bucket location, for example US. */
  bucketLocation: string;
  /** Display name of the registered web app. */
  appName: string;
  /** Identity Platform tenant display name, when auth is isolated per app. */
  tenant: string;
  /** Repository root: where firebase.json is written and the app is built. */
  root: string;
}

export interface Context {
  settings: Settings;
  facts: Map<string, unknown>;
  log(message: string): void;
}

export interface Step {
  name: string;
  /** Whether the step's work already exists. May record facts for later steps. */
  done(ctx: Context): Promise<boolean>;
  apply(ctx: Context): Promise<void>;
}

/** Run the steps in order, skipping the ones already done. */
export async function run(steps: readonly Step[], settings: Settings): Promise<Context> {
  const ctx: Context = { settings, facts: new Map(), log: (m) => console.log(`    ${m}`) };
  for (const step of steps) {
    if (await step.done(ctx)) {
      console.log(`- ${step.name}: already done`);
      continue;
    }
    console.log(`+ ${step.name}`);
    await step.apply(ctx);
  }
  return ctx;
}

/** A fact a previous step must have recorded. */
export function fact<T>(ctx: Context, key: string): T {
  if (!ctx.facts.has(key)) throw new Error(`Missing fact "${key}": run the step that provides it first.`);
  return ctx.facts.get(key) as T;
}
