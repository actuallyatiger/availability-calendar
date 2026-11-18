import { useState } from 'react';
import type { AuthMode } from '../../../shared/api';

export function LoginPage({ authMode }: { authMode: AuthMode }) {
  const returnTo = window.location.pathname + window.location.search;
  const [username, setUsername] = useState('');
  const [groups, setGroups] = useState('');

  return (
    <div className="login">
      <div className="card login-card">
        <img src="/favicon.svg" alt="" width={48} height={48} />
        <h1>Availability</h1>
        <p className="muted">Find a time that works for everyone.</p>

        {authMode === 'oidc' ? (
          <a className="btn btn-primary btn-block" href={`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`}>
            Sign in
          </a>
        ) : (
          <form action="/api/auth/dev-login" method="get" className="stack">
            <p className="notice">Development sign-in: no password, pick any username.</p>
            <input type="hidden" name="returnTo" value={returnTo} />
            <label>
              Username
              <input name="username" value={username} onChange={(e) => setUsername(e.target.value)} required pattern="[\w.\-]+" autoFocus />
            </label>
            <label>
              Groups <span className="muted">(comma separated, optional)</span>
              <input name="groups" value={groups} onChange={(e) => setGroups(e.target.value)} />
            </label>
            <button className="btn btn-primary btn-block">Sign in</button>
          </form>
        )}
      </div>
    </div>
  );
}
