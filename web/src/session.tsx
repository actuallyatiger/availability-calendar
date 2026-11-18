import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChangeNotification, SessionResponse, SessionUser } from '../../shared/api';
import { api } from './api';

interface SessionState {
  user: SessionUser;
  authMode: SessionResponse['authMode'];
}

const SessionContext = createContext<SessionState | null>(null);

export function useSession(): SessionState {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession outside provider');
  return s;
}

export { SessionContext };

/* ------------------------------------------------------------------ live updates */

/** `reconnect` is emitted after the stream drops and comes back, so listeners can refetch. */
export type LiveMessage = ChangeNotification | { kind: 'reconnect'; eventId: null };
type Listener = (msg: LiveMessage) => void;

const LiveContext = createContext<{ subscribe: (l: Listener) => () => void; connected: boolean } | null>(null);

export function LiveProvider({ children }: { children: ReactNode }) {
  const listeners = useRef(new Set<Listener>());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const source = new EventSource('/api/stream');
    let hadError = false;
    const emit = (msg: LiveMessage) => listeners.current.forEach((l) => l(msg));
    source.onopen = () => {
      setConnected(true);
      if (hadError) emit({ kind: 'reconnect', eventId: null });
      hadError = false;
    };
    source.onerror = () => {
      hadError = true;
      setConnected(false);
    };
    source.addEventListener('change', (e) => {
      try {
        emit(JSON.parse((e as MessageEvent).data) as ChangeNotification);
      } catch {
        /* ignore malformed */
      }
    });
    return () => source.close();
  }, []);

  const subscribe = useCallback((l: Listener) => {
    listeners.current.add(l);
    return () => void listeners.current.delete(l);
  }, []);

  return <LiveContext.Provider value={{ subscribe, connected }}>{children}</LiveContext.Provider>;
}

export function useLiveConnected(): boolean {
  return useContext(LiveContext)?.connected ?? false;
}

/** Calls `onChange` for live messages matching `filter` (latest callback is always used). */
export function useLive(filter: (msg: LiveMessage) => boolean, onChange: () => void): void {
  const ctx = useContext(LiveContext);
  const ref = useRef({ filter, onChange });
  ref.current = { filter, onChange };
  useEffect(() => {
    if (!ctx) return;
    return ctx.subscribe((msg) => {
      if (ref.current.filter(msg)) ref.current.onChange();
    });
  }, [ctx]);
}
