/** Project resources: APIs, the Hosting site, and a dedicated database, RTDB instance and bucket. */
import { api, exec, firebaseJson, succeeds } from '../cli.ts';
import type { Step } from '../pipeline.ts';

const APIS = [
  'firebase.googleapis.com',
  'firebasehosting.googleapis.com',
  'firestore.googleapis.com',
  'firebaserules.googleapis.com',
  'firebasedatabase.googleapis.com',
  'firebasestorage.googleapis.com',
  'storage.googleapis.com',
  'identitytoolkit.googleapis.com',
];

export const enableApis: Step = {
  name: 'enable APIs',
  async done({ settings }) {
    const enabled = await exec(['gcloud', 'services', 'list', '--enabled', '--project', settings.project, '--format=value(config.name)']);
    return APIS.every((a) => enabled.includes(a));
  },
  async apply({ settings }) {
    await exec(['gcloud', 'services', 'enable', ...APIS, '--project', settings.project]);
  },
};

export const hostingSite: Step = {
  name: 'Hosting site',
  done: ({ settings }) => succeeds(['firebase', 'hosting:sites:get', settings.site, '--project', settings.project]),
  async apply({ settings, log }) {
    await exec(['firebase', 'hosting:sites:create', settings.site, '--project', settings.project]);
    log(`https://${settings.site}.web.app`);
  },
};

export const firestoreDatabase: Step = {
  name: 'Firestore database',
  done: ({ settings }) =>
    succeeds(['gcloud', 'firestore', 'databases', 'describe', `--database=${settings.database}`, '--project', settings.project]),
  async apply({ settings }) {
    await exec([
      'gcloud', 'firestore', 'databases', 'create',
      `--database=${settings.database}`, `--location=${settings.firestoreLocation}`, '--type=firestore-native',
      '--project', settings.project,
    ]);
  },
};

export const rtdbInstance: Step = {
  name: 'Realtime Database instance',
  async done({ settings }) {
    const instances = await firebaseJson<Array<{ name: string }>>(['database:instances:list'], settings.project);
    return instances.some((i) => i.name.endsWith(`/instances/${settings.rtdbInstance}`));
  },
  async apply({ settings }) {
    await exec([
      'firebase', 'database:instances:create', settings.rtdbInstance,
      '--location', settings.rtdbLocation, '--project', settings.project,
    ]);
  },
};

export const storageBucket: Step = {
  name: 'Storage bucket',
  done: ({ settings }) => succeeds(['gcloud', 'storage', 'buckets', 'describe', `gs://${settings.bucket}`, '--project', settings.project]),
  async apply({ settings }) {
    await exec([
      'gcloud', 'storage', 'buckets', 'create', `gs://${settings.bucket}`,
      `--location=${settings.bucketLocation}`, '--uniform-bucket-level-access', '--project', settings.project,
    ]);
  },
};

const storageUrl = (project: string, bucket: string) =>
  `https://firebasestorage.googleapis.com/v1beta/projects/${project}/buckets/${bucket}`;

/** Link the bucket to Firebase so the Storage SDK and rules can use it. */
export const storageFirebaseLink: Step = {
  name: 'Storage bucket linked to Firebase',
  done: async ({ settings }) => (await api(settings.project, 'GET', storageUrl(settings.project, settings.bucket))) !== null,
  async apply({ settings }) {
    await api(settings.project, 'POST', `${storageUrl(settings.project, settings.bucket)}:addFirebase`, {});
  },
};
