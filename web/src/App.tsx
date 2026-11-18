import { useEffect, useState } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import type { SessionResponse } from '../../shared/api';
import { api } from './api';
import { LiveProvider, SessionContext, useLiveConnected, useSession } from './session';
import { LoginPage } from './pages/LoginPage';
import { EventListPage } from './pages/EventListPage';
import { EventPage } from './pages/EventPage';
import { EventFormPage } from './pages/EventFormPage';

export function App() {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.session().then(setSession, (e: Error) => setError(e.message));
  }, []);

  if (error) return <div className="center-message">Could not reach the server: {error}</div>;
  if (!session) return <div className="center-message muted">Loading…</div>;
  if (!session.user) return <LoginPage authMode={session.authMode} />;

  return (
    <SessionContext.Provider value={{ user: session.user, authMode: session.authMode }}>
      <LiveProvider>
        <Shell />
      </LiveProvider>
    </SessionContext.Provider>
  );
}

function Shell() {
  const { user } = useSession();
  const connected = useLiveConnected();
  const location = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  async function logout() {
    const { redirect } = await api.logout();
    window.location.href = redirect;
  }

  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">
          <img src="/favicon.svg" alt="" width={22} height={22} />
          Availability
        </Link>
        <div className="topbar-right">
          <span
            className={`live-dot ${connected ? 'on' : ''}`}
            title={connected ? 'Live updates connected' : 'Live updates disconnected – reconnecting…'}
          />
          <span className="user-name" title={user.email ?? user.username ?? ''}>
            {user.name}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>
      <main className="container">
        <Routes>
          <Route path="/" element={<EventListPage />} />
          <Route path="/archived" element={<EventListPage archived />} />
          <Route path="/events/new" element={<EventFormPage />} />
          <Route path="/events/:id" element={<EventPage />} />
          <Route path="/events/:id/edit" element={<EventFormPage />} />
          <Route path="*" element={<div className="center-message">Page not found. <Link to="/">Go home</Link></div>} />
        </Routes>
      </main>
    </>
  );
}
