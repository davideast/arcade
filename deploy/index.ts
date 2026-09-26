/**
 * Provision a Firebase project for the arcade and deploy it. Made for Cloud
 * Shell, where gcloud and the Firebase CLI are installed and signed in (run
 * `firebase login --no-localhost` once). Every step checks before it creates,
 * so reruns only do what's missing.
 *
 *   curl -fsSL https://bun.sh/install | bash       # once per Cloud Shell VM
 *   bun deploy/index.ts --project my-project
 *   bun deploy/index.ts --project my-project --tenant pyric-arcade
 *   bun deploy/index.ts --project my-project --stages app
 *   bun deploy/index.ts --project my-project --plan
 */
import { parseArgs } from 'node:util';
import { run, type Settings, type Step } from './pipeline.ts';
import { build, deploy, firebaseConfig, resolveRules, sdkConfig, webApp } from './steps/app.ts';
import { allowTenants, anonymousSignIn, appTenant, authorizedDomain, identityPlatform } from './steps/auth.ts';
import {
  enableApis, firestoreDatabase, hostingSite, rtdbInstance, storageBucket, storageFirebaseLink,
} from './steps/resources.ts';

/** Stages in run order. A stage is a named list of steps; add a stage or a step without touching the runner. */
const STAGES: Record<string, Step[]> = {
  resources: [enableApis, hostingSite, firestoreDatabase, rtdbInstance, storageBucket, storageFirebaseLink],
  auth: [anonymousSignIn, authorizedDomain],
  tenant: [identityPlatform, allowTenants, appTenant],
  app: [webApp, sdkConfig, resolveRules, build, firebaseConfig, deploy],
};

const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    site: { type: 'string', default: 'pyric-arcade' },
    database: { type: 'string' },
    'firestore-location': { type: 'string', default: 'nam5' },
    'rtdb-instance': { type: 'string' },
    'rtdb-location': { type: 'string', default: 'us-central1' },
    bucket: { type: 'string' },
    'bucket-location': { type: 'string', default: 'US' },
    'app-name': { type: 'string' },
    tenant: { type: 'string' },
    stages: { type: 'string' },
    plan: { type: 'boolean', default: false },
  },
});

const project = values.project ?? process.env.GOOGLE_CLOUD_PROJECT;
if (!project) throw new Error('Pass --project <id>, or set GOOGLE_CLOUD_PROJECT.');
const site = values.site!;

const settings: Settings = {
  project,
  site,
  target: 'arcade',
  database: values.database ?? site,
  firestoreLocation: values['firestore-location']!,
  rtdbInstance: values['rtdb-instance'] ?? `${site}-rtdb`,
  rtdbLocation: values['rtdb-location']!,
  bucket: values.bucket ?? `${project}-${site}`,
  bucketLocation: values['bucket-location']!,
  appName: values['app-name'] ?? site,
  tenant: values.tenant ?? '',
  root: new URL('..', import.meta.url).pathname,
};

// Stages to run: --stages picks by name; otherwise all of them, with the tenant stage only when --tenant is given.
const wanted = values.stages?.split(',') ?? Object.keys(STAGES).filter((s) => s !== 'tenant' || settings.tenant !== '');
const unknown = wanted.filter((s) => !(s in STAGES));
if (unknown.length > 0) throw new Error(`Unknown stage: ${unknown.join(', ')}. Stages: ${Object.keys(STAGES).join(', ')}.`);
const steps = Object.entries(STAGES).filter(([name]) => wanted.includes(name)).flatMap(([, list]) => list);

if (values.plan) {
  console.log(settings);
  for (const [name, list] of Object.entries(STAGES)) {
    if (wanted.includes(name)) console.log(`${name}: ${list.map((s) => s.name).join(', ')}`);
  }
} else {
  await run(steps, settings);
}
