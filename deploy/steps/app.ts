/** The registered web app, its SDK config, the build, and the deploy. */
import { exec, firebaseJson } from '../cli.ts';
import { fact, type Step } from '../pipeline.ts';

interface WebApp {
  appId: string;
  displayName?: string;
}

/** The web app registration. Records `appId`. */
export const webApp: Step = {
  name: 'web app',
  async done(ctx) {
    const apps = await firebaseJson<WebApp[]>(['apps:list', 'WEB'], ctx.settings.project);
    const app = apps.find((a) => a.displayName === ctx.settings.appName);
    if (app) ctx.facts.set('appId', app.appId);
    return app !== undefined;
  },
  async apply(ctx) {
    const app = await firebaseJson<WebApp>(['apps:create', 'WEB', ctx.settings.appName], ctx.settings.project);
    ctx.facts.set('appId', app.appId);
  },
};

/** The web SDK config for the app. Records `sdkConfig`; always refreshed. */
export const sdkConfig: Step = {
  name: 'web SDK config',
  done: async () => false,
  async apply(ctx) {
    const result = await firebaseJson<{ sdkConfig?: object; fileContents?: string }>(
      ['apps:sdkconfig', 'WEB', fact<string>(ctx, 'appId')], ctx.settings.project);
    ctx.facts.set('sdkConfig', result.sdkConfig ?? JSON.parse(result.fileContents ?? '{}'));
  },
};

/** Resolve the modular rules into the plain ruleset Firestore deploys. */
export const resolveRules: Step = {
  name: 'resolve rules',
  done: async () => false,
  apply: async ({ settings }) => void (await exec(['bun', 'run', 'rules:resolve'], {}, settings.root)),
};

/**
 * Build the app for production. The app reads its Firebase config, database
 * and tenant from these VITE_ variables.
 */
export const build: Step = {
  name: 'build',
  done: async () => false,
  async apply(ctx) {
    const { settings } = ctx;
    await exec(['bun', 'install', '--frozen-lockfile'], {}, settings.root);
    await exec(['bun', 'run', '--cwd', 'app', 'build'], {
      VITE_FIREBASE_CONFIG: JSON.stringify(fact(ctx, 'sdkConfig')),
      VITE_FIRESTORE_DATABASE: settings.database,
      VITE_AUTH_TENANT_ID: ctx.facts.has('tenantId') ? fact<string>(ctx, 'tenantId') : '',
    }, settings.root);
  },
};

/** firebase.json and .firebaserc for this site and database, written to the repository root. */
export const firebaseConfig: Step = {
  name: 'firebase.json',
  done: async () => false,
  async apply({ settings }) {
    const config = {
      hosting: [{ target: settings.target, public: 'app/dist', ignore: ['**/.*'] }],
      firestore: [{ database: settings.database, rules: 'app/firestore.rules' }],
    };
    const rc = { projects: { default: settings.project }, targets: { [settings.project]: { hosting: { [settings.target]: [settings.site] } } } };
    await Bun.write(`${settings.root}/firebase.json`, `${JSON.stringify(config, null, 2)}\n`);
    await Bun.write(`${settings.root}/.firebaserc`, `${JSON.stringify(rc, null, 2)}\n`);
  },
};

export const deploy: Step = {
  name: 'deploy Hosting and Firestore rules',
  done: async () => false,
  async apply({ settings, log }) {
    await exec(['firebase', 'deploy', '--only', `hosting:${settings.target},firestore`, '--project', settings.project, '--non-interactive'],
      {}, settings.root);
    log(`https://${settings.site}.web.app`);
  },
};
