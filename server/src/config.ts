import path from 'node:path';

export type AuthMode = 'oidc' | 'dev';

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string | undefined;
  scopes: string;
  groupsClaim: string;
  /** If non-empty, only users in at least one of these groups may sign in. */
  allowedGroups: string[];
}

export interface Config {
  port: number;
  host: string;
  /** Public URL the browser uses to reach the app (no trailing slash). */
  appUrl: string;
  databaseUrl: string;
  sessionSecret: string;
  sessionTtlDays: number;
  authMode: AuthMode;
  oidc: OidcConfig | undefined;
  /** Members of this group can manage every event. */
  adminGroup: string | undefined;
  webDir: string;
  logLevel: string;
  trustProxy: boolean;
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const authMode = (env.AUTH_MODE ?? 'oidc') as AuthMode;
  if (authMode !== 'oidc' && authMode !== 'dev') {
    throw new Error(`AUTH_MODE must be "oidc" or "dev", got "${authMode}"`);
  }

  const port = Number(env.PORT ?? 3000);
  const appUrl = (env.APP_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');

  const sessionSecret = env.SESSION_SECRET ?? '';
  if (sessionSecret.length < 32) {
    if (authMode === 'dev' && !sessionSecret) {
      // Convenience for local hacking only.
    } else {
      throw new Error('SESSION_SECRET must be set to at least 32 characters (e.g. `openssl rand -hex 32`)');
    }
  }

  let oidc: OidcConfig | undefined;
  if (authMode === 'oidc') {
    const issuer = env.OIDC_ISSUER;
    const clientId = env.OIDC_CLIENT_ID;
    if (!issuer || !clientId) {
      throw new Error('OIDC_ISSUER and OIDC_CLIENT_ID are required when AUTH_MODE=oidc');
    }
    oidc = {
      issuer,
      clientId,
      clientSecret: env.OIDC_CLIENT_SECRET || undefined,
      scopes: env.OIDC_SCOPES ?? 'openid profile email',
      groupsClaim: env.OIDC_GROUPS_CLAIM ?? 'groups',
      allowedGroups: list(env.OIDC_ALLOWED_GROUPS),
    };
  }

  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    appUrl,
    databaseUrl: env.DATABASE_URL ?? 'sqlite:./data/app.db',
    sessionSecret: sessionSecret || 'dev-only-insecure-session-secret-change-me!!',
    sessionTtlDays: Number(env.SESSION_TTL_DAYS ?? 30),
    authMode,
    oidc,
    adminGroup: env.ADMIN_GROUP || undefined,
    webDir: env.WEB_DIR ?? path.resolve(import.meta.dirname, '../../web'),
    logLevel: env.LOG_LEVEL ?? 'info',
    trustProxy: (env.TRUST_PROXY ?? 'true') !== 'false',
  };
}
