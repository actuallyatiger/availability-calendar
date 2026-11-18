import { useState, type FormEvent } from 'react';
import type { Poll, PollOption } from '../../../shared/api';
import { api } from '../api';

interface PollsProps {
  eventId: string;
  polls: Poll[];
  userId: string;
  organizerId: string;
  canManage: boolean;
  /** Archived events: show results only. */
  readOnly: boolean;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}

export function Polls({ eventId, polls, userId, organizerId, canManage, readOnly, onChanged, onError }: PollsProps) {
  const [creating, setCreating] = useState(false);
  if (!polls.length && (!canManage || readOnly)) return null;

  return (
    <section className="polls">
      <div className="section-head">
        <h2>Polls</h2>
        {canManage && !readOnly && !creating && (
          <button className="btn btn-sm" onClick={() => setCreating(true)}>
            + New poll
          </button>
        )}
      </div>
      {creating && (
        <NewPollForm
          eventId={eventId}
          onDone={async (created) => {
            if (created) await onChanged();
            setCreating(false);
          }}
          onError={onError}
        />
      )}
      {!polls.length && !creating && (
        <p className="muted small">
          Add a poll to let people vote on things like where to eat, or what to play. Others can suggest options too.
        </p>
      )}
      <div className="poll-grid">
        {polls.map((p) => (
          <PollCard
            key={p.id}
            poll={p}
            userId={userId}
            organizerId={organizerId}
            canManage={canManage}
            readOnly={readOnly}
            onChanged={onChanged}
            onError={onError}
          />
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ create */

function NewPollForm({
  eventId,
  onDone,
  onError,
}: {
  eventId: string;
  onDone: (created: boolean) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [multiple, setMultiple] = useState(true);
  const [allowSuggestions, setAllowSuggestions] = useState(true);
  const [saving, setSaving] = useState(false);

  function setOption(i: number, value: string) {
    const next = options.map((o, j) => (j === i ? value : o));
    // Always keep one empty field at the end to type the next option into.
    if (i === next.length - 1 && value.trim()) next.push('');
    setOptions(next);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.createPoll(eventId, {
        question,
        multiple,
        allowSuggestions,
        options: options.map((o) => o.trim()).filter(Boolean),
      });
      await onDone(true);
    } catch (err) {
      onError((err as Error).message);
      setSaving(false);
    }
  }

  return (
    <form className="card poll-card poll-new" onSubmit={submit}>
      <label>
        Question
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. Where should we eat?"
          maxLength={300}
          required
          autoFocus
        />
      </label>
      <div className="poll-new-options">
        <span className="label-text">Options</span>
        {options.map((o, i) => (
          <input
            key={i}
            value={o}
            onChange={(e) => setOption(i, e.target.value)}
            placeholder={i === 0 ? 'e.g. Pizza Palace' : 'Add another option'}
            maxLength={200}
          />
        ))}
        <p className="hint">You can leave this empty and let people suggest options.</p>
      </div>
      <label className="check">
        <input type="checkbox" checked={multiple} onChange={(e) => setMultiple(e.target.checked)} />
        People can vote for more than one option
      </label>
      <label className="check">
        <input type="checkbox" checked={allowSuggestions} onChange={(e) => setAllowSuggestions(e.target.checked)} />
        People can add their own suggestions
      </label>
      <div className="actions">
        <button type="button" className="btn btn-ghost" onClick={() => void onDone(false)}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={saving}>
          {saving ? 'Creating…' : 'Create poll'}
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ poll */

function PollCard({
  poll,
  userId,
  organizerId,
  canManage,
  readOnly,
  onChanged,
  onError,
}: {
  poll: Poll;
  userId: string;
  organizerId: string;
  canManage: boolean;
  readOnly: boolean;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  // Optimistic copy of my votes while a save is in flight.
  const [pendingVotes, setPendingVotes] = useState<string[] | null>(null);
  const [suggestion, setSuggestion] = useState('');
  const [adding, setAdding] = useState(false);

  const serverVotes = poll.options.filter((o) => o.voters.some((v) => v.id === userId)).map((o) => o.id);
  const myVotes = pendingVotes ?? serverVotes;
  const locked = readOnly || poll.closed;

  const countFor = (o: PollOption) => {
    const others = o.voters.filter((v) => v.id !== userId).length;
    return others + (myVotes.includes(o.id) ? 1 : 0);
  };
  const counts = new Map(poll.options.map((o) => [o.id, countFor(o)]));
  const max = Math.max(0, ...counts.values());
  const tied = max > 0 && [...counts.values()].filter((c) => c === max).length > 1;
  const topLabel = tied ? 'Tied' : locked ? 'Winner' : 'Top pick';
  const voterCount = new Set([
    ...poll.options.flatMap((o) => o.voters.map((v) => v.id)).filter((id) => id !== userId),
    ...(myVotes.length ? [userId] : []),
  ]).size;

  async function run(fn: () => Promise<unknown>) {
    try {
      await fn();
      await onChanged();
    } catch (err) {
      onError((err as Error).message);
      await onChanged();
    }
  }

  async function vote(optionId: string) {
    if (locked) return;
    const next = poll.multiple
      ? myVotes.includes(optionId)
        ? myVotes.filter((id) => id !== optionId)
        : [...myVotes, optionId]
      : myVotes.includes(optionId)
        ? []
        : [optionId];
    setPendingVotes(next);
    await run(() => api.setVotes(poll.id, next));
    setPendingVotes(null);
  }

  async function addSuggestion(e: FormEvent) {
    e.preventDefault();
    const label = suggestion.trim();
    if (!label) return;
    setAdding(true);
    try {
      const { id } = await api.addOption(poll.id, label);
      setSuggestion('');
      // Suggesting something counts as a vote for it (single-choice polls keep your existing vote).
      if (poll.multiple || !myVotes.length) await api.setVotes(poll.id, poll.multiple ? [...myVotes, id] : [id]);
      await onChanged();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setAdding(false);
    }
  }

  const canSuggest = !locked && (poll.allowSuggestions || canManage);

  return (
    <article className={`card poll-card ${locked ? 'locked' : ''}`}>
      <header className="poll-head">
        <div>
          <h3>{poll.question}</h3>
          <div className="meta small">
            <span>{poll.multiple ? 'Pick any' : 'Pick one'}</span>
            <span>·</span>
            <span>
              {voterCount} {voterCount === 1 ? 'voter' : 'voters'}
            </span>
            {poll.closed && <span className="badge">Closed</span>}
          </div>
        </div>
        {canManage && !readOnly && (
          <div className="poll-manage">
            <button className="btn btn-ghost btn-sm" onClick={() => run(() => api.updatePoll(poll.id, { closed: !poll.closed }))}>
              {poll.closed ? 'Reopen' : 'Close'}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                if (confirm(`Delete the poll "${poll.question}" and all its votes?`)) void run(() => api.deletePoll(poll.id));
              }}
            >
              Delete
            </button>
          </div>
        )}
      </header>

      {!poll.options.length && <p className="muted small">No options yet{canSuggest ? ' — add the first one below.' : '.'}</p>}

      <ul className="poll-options" role={poll.multiple ? 'group' : 'radiogroup'} aria-label={poll.question}>
        {poll.options.map((o) => {
          const count = counts.get(o.id) ?? 0;
          const mine = myVotes.includes(o.id);
          const top = count > 0 && count === max;
          const voters = [
            ...o.voters.filter((v) => v.id !== userId).map((v) => v.name),
            ...(mine ? ['you'] : []),
          ];
          return (
            <li key={o.id} className={`poll-option ${mine ? 'mine' : ''} ${top ? 'top' : ''}`}>
              <button
                type="button"
                className="poll-option-main"
                onClick={() => void vote(o.id)}
                disabled={locked}
                role={poll.multiple ? 'checkbox' : 'radio'}
                aria-checked={mine}
              >
                {/* Bar = share of voters who picked this option. */}
                <span className="poll-bar" style={{ width: `${voterCount ? (count / voterCount) * 100 : 0}%` }} />
                <span className={`poll-check ${poll.multiple ? 'square' : 'round'}`} aria-hidden>
                  {mine ? '✓' : ''}
                </span>
                <span className="poll-label">
                  <span className="poll-label-text">{o.label}</span>
                  <span className="poll-voters">
                    {voters.length ? voters.join(', ') : 'No votes yet'}
                    {o.createdBy.id !== organizerId && (
                      <span className="poll-by">
                        {' '}
                        · suggested by {o.createdBy.id === userId ? 'you' : o.createdBy.name}
                      </span>
                    )}
                  </span>
                </span>
                {top && <span className="badge badge-free">{topLabel}</span>}
                <span className="poll-count">{count}</span>
              </button>
              {o.canDelete && !locked && (
                <button
                  type="button"
                  className="poll-remove"
                  title="Remove option"
                  aria-label={`Remove ${o.label}`}
                  onClick={() => void run(() => api.deleteOption(poll.id, o.id))}
                >
                  ×
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {canSuggest && (
        <form className="poll-suggest" onSubmit={addSuggestion}>
          <input
            value={suggestion}
            onChange={(e) => setSuggestion(e.target.value)}
            placeholder={canManage && !poll.allowSuggestions ? 'Add an option' : 'Suggest something else…'}
            maxLength={200}
          />
          <button className="btn" disabled={adding || !suggestion.trim()}>
            Add
          </button>
        </form>
      )}
      {!locked && !poll.allowSuggestions && !canManage && (
        <p className="hint">Only the organiser can add options to this poll.</p>
      )}
    </article>
  );
}
