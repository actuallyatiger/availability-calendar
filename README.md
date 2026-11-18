# Availability Calendar

A small self-hosted app for finding a time that works for a group. Sign in with
your OIDC provider (Authentik, Keycloak, Authelia, …), create an event, and
everyone paints the days/times they're **free**, **maybe** or **busy**. The
group view shows a live heatmap and the best time slots.

- **Events being scheduled**: a name, optional description, a date range and
  (optionally) daily hours split into 15/30/60‑minute slots. Without hours,
  people mark whole days.
- **Visibility**: open to everyone who can sign in, or restricted to chosen
  people and/or groups (from the OIDC `groups` claim).
- **Archive**: the creator marks an event as *happened* or *didn't happen*,
  which moves it to the archive (it can be reopened).
- **Live updates** over Server-Sent Events. Lists and grids refresh as others
  respond.
- **SQLite by default, PostgreSQL optional**: same code and migrations for both.

## Quick start (Docker Compose)

```sh
cp .env.example .env
# edit .env: APP_URL, SESSION_SECRET (openssl rand -hex 32), OIDC_* settings
docker compose up -d
```

The app listens on port 3000. Data lives in the `app-data` volume (`/data/app.db`).

### With PostgreSQL

```sh
# in .env: POSTGRES_PASSWORD=something-long
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d
```

Or point at an existing server with
`DATABASE_URL=postgres://user:pass@host:5432/dbname`. Tables are created and
migrated automatically on start-up.

### Trying it without an identity provider

Set `AUTH_MODE=dev` to get a login form where you can type any username (and
optional groups). **Never expose dev mode publicly**; anyone can sign in as anyone.

## Setting up Authentik

1. **Applications → Providers → Create → OAuth2/OpenID Provider**
   - Client type: *Confidential*
   - Redirect URIs: `https://<your APP_URL>/api/auth/callback` (strict)
   - Signing key: pick a certificate (e.g. the self-signed one) so ID tokens are RS256
   - Scopes: keep `openid`, `email`, `profile` (Authentik's `profile` mapping includes `groups`)
2. **Applications → Create**, link it to the provider, note the slug.
3. In `.env`:
   ```
   APP_URL=https://cal.example.com
   OIDC_ISSUER=https://authentik.example.com/application/o/<slug>/
   OIDC_CLIENT_ID=<client id>
   OIDC_CLIENT_SECRET=<client secret>
   ```
4. Optional: bind users/groups to the application in Authentik to control who
   can sign in, or set `OIDC_ALLOWED_GROUPS` here. Set `ADMIN_GROUP` to let a
   group manage every event.

Other providers work the same way: register the redirect URI
`<APP_URL>/api/auth/callback` and make sure a groups claim is present (rename
it with `OIDC_GROUPS_CLAIM` if your provider uses a different one).

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `APP_URL` | `http://localhost:3000` | Public URL used in browsers; also builds the OIDC redirect URI. |
| `SESSION_SECRET` | *(required)* | ≥ 32 random characters. |
| `AUTH_MODE` | `oidc` | `oidc` or `dev`. |
| `OIDC_ISSUER` | | Issuer URL (discovery via `/.well-known/openid-configuration`). |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | | Client credentials. Leave the secret empty for public clients (PKCE is always used). |
| `OIDC_SCOPES` | `openid profile email` | |
| `OIDC_GROUPS_CLAIM` | `groups` | Claim containing group names. |
| `OIDC_ALLOWED_GROUPS` | | Comma-separated; if set, only members can sign in. |
| `ADMIN_GROUP` | | Members can edit/archive/delete any event and see all events. |
| `DATABASE_URL` | `sqlite:./data/app.db` (`sqlite:///data/app.db` in Docker) | `sqlite:<path>` or `postgres://…`. |
| `SESSION_TTL_DAYS` | `30` | |
| `TRUST_PROXY` | `true` | Trust `X-Forwarded-*` from a reverse proxy. |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | |
| `LOG_LEVEL` | `info` | |

### Prebuilt image

On the default branch and on tags, GitLab CI builds the image and pushes it
to this project's container registry (`$CI_REGISTRY_IMAGE:latest` and
`:<short sha>`, or `:<tag>`). To use it instead of building locally, replace
`build: .` in `docker-compose.yml` with
`image: <your registry>/<group>/availability-calendar:latest`.

The `docker` job needs the container registry enabled and a runner that
allows Docker-in-Docker (`privileged = true`).

### Reverse proxies

Live updates use a long-lived SSE response at `/api/stream`. The app sends
`X-Accel-Buffering: no` and a heartbeat every 25 s, which covers nginx and most
proxies. If you set aggressive read timeouts, allow at least 60 s.

## Development

```sh
npm install
cp .env.example .env   # set AUTH_MODE=dev for local hacking, APP_URL=http://localhost:5173
npm run dev            # API on :3000 (tsx watch) + Vite on :5173 (proxies /api)
npm test               # API integration tests (in-memory SQLite); CI also runs them on Postgres
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/scratch npm test   # same suite on Postgres (wipes that DB!)
npm run typecheck
npm run build && npm start
```

### Layout

```
server/src/
  index.ts          entry point (config → DB → migrations → HTTP)
  app.ts            Fastify app: plugins, routes, static SPA
  auth.ts           OIDC (openid-client) + dev login, DB-backed sessions, CSRF origin check
  access.ts         who can view/manage an event
  bus.ts            in-process change bus feeding SSE
  routes/           events, availability, users/groups, SSE stream
  db/               Kysely setup (SQLite/Postgres), schema types, migrations
shared/             types + date/slot helpers used by both server and web
web/src/            React SPA (Vite)
```

### Design notes

- **Database portability**: queries go through [Kysely](https://kysely.dev);
  the schema only uses `text`/`integer` columns (ISO timestamps, `YYYY-MM-DD`
  dates, JSON as text), so the same migrations run on both engines. Add new
  migrations to `server/src/db/migrations.ts`; never edit shipped ones.
- **Time model**: availability cells are `(date, slot)` where `slot` is minutes
  from midnight in the event's timezone (or `-1` for whole-day events). The grid
  is always shown in the event's timezone. Editing an event's dates or hours
  deletes responses that fall outside the new grid.
- **Real-time**: every write publishes `{kind, eventId}` on an in-process bus;
  each SSE connection forwards it only if that user can see the event, and the
  client refetches. This assumes a **single app instance**. To run several
  replicas against Postgres, implement `ChangeBus` with `LISTEN/NOTIFY`.
- **Sessions** are random tokens stored hashed in the DB (revocable on logout),
  in an `HttpOnly`, `SameSite=Lax` cookie. Cross-origin writes are rejected.
- **Inviting people**: only users who have signed in at least once appear in
  the people picker. Groups work for people who haven't signed in yet.
