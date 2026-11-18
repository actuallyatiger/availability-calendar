import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as oidc from 'openid-client';
import { z } from 'zod';
import type { Config } from './config.js';
import type { DB } from './db/index.js';
import { toAuthUser, type AuthUser } from './access.js';
import { newId, nowIso, randomToken, sha256 } from './util.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

const SESSION_COOKIE = 'ac_session';
const LOGIN_COOKIE = 'ac_login';

interface LoginState {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
}

function safeReturnTo(value: unknown): string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

interface Identity {
  sub: string;
  username: string | null;
  name: string;
  email: string | null;
  groups: string[];
}

async function upsertUser(db: DB, identity: Identity): Promise<string> {
  const now = nowIso();
  const fields = {
    username: identity.username,
    name: identity.name,
    email: identity.email,
    groups: JSON.stringify(identity.groups),
    last_login_at: now,
  };
  const existing = await db.selectFrom('users').select('id').where('sub', '=', identity.sub).executeTakeFirst();
  if (existing) {
    await db.updateTable('users').set(fields).where('id', '=', existing.id).execute();
    return existing.id;
  }
  const id = newId(16);
  await db
    .insertInto('users')
    .values({ id, sub: identity.sub, created_at: now, ...fields })
    .execute();
  return id;
}

export async function registerAuth(app: FastifyInstance, config: Config, db: DB): Promise<void> {
  const secure = config.appUrl.startsWith('https://');
  let oidcConfig: oidc.Configuration | undefined;
  const ttlMs = config.sessionTtlDays * 24 * 60 * 60 * 1000;

  async function startSession(reply: FastifyReply, userId: string): Promise<void> {
    const token = randomToken();
    const now = new Date();
    await db
      .insertInto('sessions')
      .values({
        id: sha256(token),
        user_id: userId,
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + ttlMs).toISOString(),
      })
      .execute();
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure,
      maxAge: Math.floor(ttlMs / 1000),
    });
  }

  // Resolve the current user on every request.
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;
    const row = await db
      .selectFrom('sessions')
      .innerJoin('users', 'users.id', 'sessions.user_id')
      .selectAll('users')
      .select('sessions.expires_at')
      .where('sessions.id', '=', sha256(token))
      .executeTakeFirst();
    if (!row || row.expires_at < nowIso()) return;
    request.user = toAuthUser(row, config.adminGroup);
  });

  // Basic CSRF defence on top of SameSite=Lax cookies: reject cross-origin writes.
  const appOrigin = new URL(config.appUrl).origin;
  app.addHook('onRequest', async (request, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    const origin = request.headers.origin;
    if (origin && origin !== appOrigin) {
      return reply.code(403).send({ error: 'Cross-origin request rejected' });
    }
  });

  app.get('/api/session', async (request) => ({
    user: request.user,
    authMode: config.authMode,
  }));

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await db.deleteFrom('sessions').where('id', '=', sha256(token)).execute();
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    let redirect = '/';
    if (config.authMode === 'oidc' && oidcConfig) {
      const endSession = oidcConfig.serverMetadata().end_session_endpoint;
      if (endSession) {
        redirect = oidc
          .buildEndSessionUrl(oidcConfig, {
            client_id: config.oidc!.clientId,
            post_logout_redirect_uri: `${config.appUrl}/`,
          })
          .toString();
      }
    }
    return { redirect };
  });

  // Periodically clean up expired sessions.
  const cleanup = setInterval(() => {
    db.deleteFrom('sessions').where('expires_at', '<', nowIso()).execute().catch(() => {});
  }, 60 * 60 * 1000);
  cleanup.unref();
  app.addHook('onClose', async () => clearInterval(cleanup));

  // ---------------------------------------------------------------- dev mode
  if (config.authMode === 'dev') {
    app.log.warn('AUTH_MODE=dev: anyone can sign in as any user. Never expose this publicly.');
    const devQuery = z.object({
      username: z.string().trim().min(1).max(64).regex(/^[\w.-]+$/),
      name: z.string().trim().max(100).optional(),
      groups: z.string().optional(),
      returnTo: z.string().optional(),
    });
    app.get('/api/auth/dev-login', async (request, reply) => {
      const q = devQuery.safeParse(request.query);
      if (!q.success) return reply.code(400).send({ error: 'username is required' });
      const userId = await upsertUser(db, {
        sub: `dev:${q.data.username}`,
        username: q.data.username,
        name: q.data.name || q.data.username,
        email: null,
        groups: (q.data.groups ?? '').split(',').map((g) => g.trim()).filter(Boolean),
      });
      await startSession(reply, userId);
      return reply.redirect(safeReturnTo(q.data.returnTo));
    });
    return;
  }

  // ---------------------------------------------------------------- OIDC
  const settings = config.oidc!;
  let discovering: Promise<oidc.Configuration> | undefined;

  // Discovery is lazy (and retried) so the app can start while the IdP is down.
  async function getOidcConfig(): Promise<oidc.Configuration> {
    if (oidcConfig) return oidcConfig;
    discovering ??= oidc
      .discovery(
        new URL(settings.issuer),
        settings.clientId,
        undefined,
        settings.clientSecret ? oidc.ClientSecretPost(settings.clientSecret) : oidc.None(),
        { execute: settings.issuer.startsWith('http://') ? [oidc.allowInsecureRequests] : [] },
      )
      .then((c) => (oidcConfig = c))
      .finally(() => (discovering = undefined));
    return discovering;
  }
  getOidcConfig().catch((err) => app.log.warn({ err }, 'OIDC discovery failed; will retry on first login'));

  const callbackUrl = `${config.appUrl}/api/auth/callback`;

  app.get('/api/auth/login', async (request: FastifyRequest<{ Querystring: { returnTo?: string } }>, reply) => {
    const c = await getOidcConfig();
    const login: LoginState = {
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      verifier: oidc.randomPKCECodeVerifier(),
      returnTo: safeReturnTo(request.query.returnTo),
    };
    const url = oidc.buildAuthorizationUrl(c, {
      redirect_uri: callbackUrl,
      scope: settings.scopes,
      state: login.state,
      nonce: login.nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(login.verifier),
      code_challenge_method: 'S256',
    });
    reply.setCookie(LOGIN_COOKIE, JSON.stringify(login), {
      path: '/api/auth',
      httpOnly: true,
      sameSite: 'lax',
      secure,
      signed: true,
      maxAge: 600,
    });
    return reply.redirect(url.toString());
  });

  app.get('/api/auth/callback', async (request, reply) => {
    const raw = request.cookies[LOGIN_COOKIE];
    const unsigned = raw ? request.unsignCookie(raw) : undefined;
    reply.clearCookie(LOGIN_COOKIE, { path: '/api/auth' });
    if (!unsigned?.valid || !unsigned.value) {
      return reply.code(400).send({ error: 'Login session expired. Please try signing in again.' });
    }
    const login = JSON.parse(unsigned.value) as LoginState;
    const c = await getOidcConfig();

    let claims: Record<string, unknown>;
    try {
      const currentUrl = new URL(request.url, config.appUrl);
      const tokens = await oidc.authorizationCodeGrant(c, currentUrl, {
        pkceCodeVerifier: login.verifier,
        expectedState: login.state,
        expectedNonce: login.nonce,
        idTokenExpected: true,
      });
      const idClaims = tokens.claims()!;
      claims = { ...idClaims };
      // Some providers only put profile/groups in the userinfo response.
      if (c.serverMetadata().userinfo_endpoint) {
        try {
          const info = await oidc.fetchUserInfo(c, tokens.access_token, idClaims.sub);
          claims = { ...info, ...idClaims };
        } catch (err) {
          request.log.warn({ err }, 'userinfo request failed; using ID token claims only');
        }
      }
    } catch (err) {
      request.log.warn({ err }, 'OIDC callback failed');
      return reply.code(400).send({ error: 'Sign-in failed. Please try again.' });
    }

    const rawGroups = claims[settings.groupsClaim];
    const groups = Array.isArray(rawGroups) ? rawGroups.filter((g): g is string => typeof g === 'string') : [];
    if (settings.allowedGroups.length && !groups.some((g) => settings.allowedGroups.includes(g))) {
      return reply.code(403).send({ error: 'Your account is not permitted to use this app.' });
    }

    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const username = str(claims.preferred_username) ?? str(claims.nickname);
    const email = str(claims.email);
    const userId = await upsertUser(db, {
      sub: String(claims.sub),
      username,
      name: str(claims.name) ?? username ?? email ?? String(claims.sub),
      email,
      groups,
    });
    await startSession(reply, userId);
    return reply.redirect(login.returnTo);
  });
}

/** preHandler that rejects unauthenticated requests. */
export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.user) {
    await reply.code(401).send({ error: 'Not signed in' });
  }
}
