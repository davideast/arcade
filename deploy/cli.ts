/**
 * Thin wrappers over the tools Cloud Shell provides: gcloud, the Firebase CLI,
 * and Google REST APIs called with the gcloud user's access token.
 */
import { $ } from 'bun';

/** Run a command; true when it exits 0. Output is discarded. */
export async function succeeds(cmd: string[]): Promise<boolean> {
  return (await $`${cmd}`.nothrow().quiet()).exitCode === 0;
}

/** Run a command and fail loudly when it exits non-zero. */
export async function exec(cmd: string[], env: Record<string, string> = {}, cwd?: string): Promise<string> {
  const out = await $`${cmd}`.env({ ...process.env, ...env }).cwd(cwd ?? process.cwd()).nothrow().quiet();
  if (out.exitCode !== 0) throw new Error(`${cmd.join(' ')} failed:\n${out.stderr.toString() || out.stdout.toString()}`);
  return out.stdout.toString();
}

/** The `result` of a Firebase CLI command run with --json. */
export async function firebaseJson<T>(args: string[], project: string): Promise<T> {
  const text = await exec(['firebase', ...args, '--project', project, '--json']);
  return (JSON.parse(text) as { result: T }).result;
}

let token: string | undefined;

/** Call a Google REST API as the gcloud user, billed to `project`. Returns null on 404. */
export async function api<T>(project: string, method: string, url: string, body?: unknown): Promise<T | null> {
  token ??= (await exec(['gcloud', 'auth', 'print-access-token'])).trim();
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'x-goog-user-project': project,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}
