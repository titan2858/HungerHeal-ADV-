import { useCallback, useEffect, useState } from 'react';
import Login from './components/Login';
import DonationForm from './components/DonationForm';
import AgentDashboard from './components/AgentDashboard';
import { api, auth } from './api/client';
import './App.css';

export default function App() {
  const [user, setUser] = useState(auth.user);

  if (!user) {
    return (
      <div className="shell">
        <header>
          <div>
            <h1>HungerHeal</h1>
            <p className="tagline">Surplus food, matched to a collection agent automatically.</p>
          </div>
        </header>
        <Login onAuthenticated={setUser} />
      </div>
    );
  }

  return (
    <div className="shell">
      <header>
        <div>
          <h1>HungerHeal</h1>
          <p className="tagline">
            {user.name} · {user.role.toLowerCase()}
          </p>
        </div>
        <button
          className="secondary"
          onClick={() => {
            auth.clear();
            setUser(null);
          }}
        >
          Log out
        </button>
      </header>

      {user.role === 'AGENT' ? <AgentDashboard user={user} /> : <DonorView />}
    </div>
  );
}

function DonorView() {
  const [tracking, setTracking] = useState([]);
  const [error, setError] = useState(null);

  // Read from tracking-service, not donation-service.
  //
  // donation-service sets PENDING_ASSIGNMENT once at creation and never hears
  // about the rest, so its status field goes stale the moment an agent is
  // offered the donation. tracking-service is the single owner of the status
  // and the only place that knows the current answer.
  const refresh = useCallback(async () => {
    if (!auth.token) return;
    try {
      const res = await api.listTracking('?limit=20');
      setTracking(res.tracking ?? []);
      setError(null);
    } catch (err) {
      if (err.status === 401) {
        auth.clear();
        window.location.reload();
      } else {
        setError(err.message);
      }
    }
  }, []);

  useEffect(() => {
    refresh();
    // A donation can go from offered to accepted within seconds, so the donor's
    // view refreshes on its own rather than needing a reload.
    const timer = setInterval(refresh, 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <>
      <DonationForm onCreated={() => setTimeout(refresh, 2000)} />

      {error && <pre className="error">{error}</pre>}

      <div className="card">
        <div className="card-head">
          <h2>Your donations</h2>
          <button className="secondary" onClick={refresh}>
            Refresh
          </button>
        </div>

        {tracking.length === 0 ? (
          <p className="hint">Nothing yet. Post a donation above.</p>
        ) : (
          <ul className="donations">
            {tracking.map((t) => (
              <li key={t.id}>
                <div className="donation-head">
                  <strong>{t.category?.replace(/_/g, ' ').toLowerCase() ?? 'donation'}</strong>
                  <span className={`status-pill ${t.status.toLowerCase()}`}>
                    {t.status.replace(/_/g, ' ').toLowerCase()}
                  </span>
                </div>

                {/* The donor gets a sentence, not an enum. */}
                <p>{t.message}</p>

                {t.assignedAgentName && (
                  <p className="muted">
                    {t.assignedAgentName}
                    {t.assignedAgentPhone && ` · ${t.assignedAgentPhone}`}
                  </p>
                )}

                {t.offerRounds > 1 && (
                  // Worth surfacing: a donation on its third round is a very
                  // different situation from one just posted, and the donor
                  // can see it is still being worked rather than forgotten.
                  <p className="muted">Offer round {t.offerRounds}</p>
                )}

                {t.timeline?.length > 0 && (
                  <details>
                    <summary className="muted">History</summary>
                    <ul className="timeline">
                      {t.timeline.map((entry, i) => (
                        <li key={i}>
                          <span className="muted">
                            {new Date(entry.at).toLocaleTimeString()}
                          </span>{' '}
                          {entry.summary}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
