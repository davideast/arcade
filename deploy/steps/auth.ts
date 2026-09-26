/**
 * Firebase Auth settings through the Identity Toolkit admin API: anonymous
 * sign-in, the site's domain, and optionally a per-app Identity Platform
 * tenant, which the app's rules can require through request.auth.token.firebase.tenant.
 */
import { api } from '../cli.ts';
import type { Context, Step } from '../pipeline.ts';

interface AuthConfig {
  subtype?: string;
  signIn?: { anonymous?: { enabled?: boolean } };
  authorizedDomains?: string[];
  multiTenant?: { allowTenants?: boolean };
}

interface Tenant {
  name: string;
  displayName: string;
}

const admin = (project: string) => `https://identitytoolkit.googleapis.com/admin/v2/projects/${project}`;
const readConfig = async ({ settings }: Context) =>
  (await api<AuthConfig>(settings.project, 'GET', `${admin(settings.project)}/config`)) ?? {};
const patchConfig = (ctx: Context, mask: string, body: AuthConfig) =>
  api(ctx.settings.project, 'PATCH', `${admin(ctx.settings.project)}/config?updateMask=${mask}`, body);
const siteDomain = (ctx: Context) => `${ctx.settings.site}.web.app`;

export const anonymousSignIn: Step = {
  name: 'anonymous sign-in',
  done: async (ctx) => (await readConfig(ctx)).signIn?.anonymous?.enabled === true,
  apply: async (ctx) => void (await patchConfig(ctx, 'signIn.anonymous.enabled', { signIn: { anonymous: { enabled: true } } })),
};

export const authorizedDomain: Step = {
  name: 'authorized domain',
  done: async (ctx) => ((await readConfig(ctx)).authorizedDomains ?? []).includes(siteDomain(ctx)),
  async apply(ctx) {
    // The mask replaces the whole list, so send the current domains plus this site.
    const current = (await readConfig(ctx)).authorizedDomains ?? [];
    await patchConfig(ctx, 'authorizedDomains', { authorizedDomains: [...current, siteDomain(ctx)] });
  },
};

export const identityPlatform: Step = {
  name: 'Identity Platform',
  done: async (ctx) => (await readConfig(ctx)).subtype === 'IDENTITY_PLATFORM',
  async apply({ settings }) {
    await api(settings.project, 'POST',
      `https://identitytoolkit.googleapis.com/v2/projects/${settings.project}/identityPlatform:initializeAuth`, {});
  },
};

export const allowTenants: Step = {
  name: 'multi-tenancy',
  done: async (ctx) => (await readConfig(ctx)).multiTenant?.allowTenants === true,
  apply: async (ctx) => void (await patchConfig(ctx, 'multiTenant.allowTenants', { multiTenant: { allowTenants: true } })),
};

/** The app's tenant, created with anonymous sign-in. Records `tenantId`. */
export const appTenant: Step = {
  name: 'app tenant',
  async done(ctx) {
    const { settings } = ctx;
    const list = await api<{ tenants?: Tenant[] }>(settings.project, 'GET', `${admin(settings.project)}/tenants`);
    const tenant = list?.tenants?.find((t) => t.displayName === settings.tenant);
    if (tenant) ctx.facts.set('tenantId', tenant.name.split('/').pop());
    return tenant !== undefined;
  },
  async apply(ctx) {
    const { settings, log } = ctx;
    const tenant = await api<Tenant>(settings.project, 'POST', `${admin(settings.project)}/tenants`, {
      displayName: settings.tenant,
      enableAnonymousUser: true,
    });
    const id = tenant!.name.split('/').pop();
    ctx.facts.set('tenantId', id);
    log(`tenant ${id}`);
  },
};
