import { useCallback, useEffect, useState } from 'react';
import Login from './components/Login';
import DonationForm from './components/DonationForm';
import { api, auth } from './api/client';
import './App.css';

// A working harness for Phases 1-3, not the finished product. The donor and
// agent interfaces proper arrive in Phases 8 and 9; what matters here is that
// the map picker and the geocoding cache can be used and seen working.
export default function App() {
  const [user, setUser] = useState(auth.user);
  const [donations, setDonations] = useState([]);
  const [geoStats, setGeoStats] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    if (!auth.token) return;
    try {
      const [list, stats] = await Promise.all([
        api.listDonations(),
        api.geoStats().catch(() => null),
      ]);
      setDonations(list.donations);
      setGeoStats(stats);
    } catch (err) {
      // An expired or invalid token should log the user out rather than leave
      // the page stuck showing errors it cannot recover from.
      if (err.status === 401) {
        auth.clear();
        setUser(null);
      } else {
        setError(err.message);
      }
    }
  }, []);

  useEffect(() => {
    if (user) refresh();
  }, [user, refresh]);

  function logout() {
    auth.clear();
    setUser(null);
    setDonations([]);
  }

  if (!user) {
    return (
      <div className="shell">
        <header>
          <h1>HungerHeal</h1>
          <p className="tagline">Surplus food, matched to a collection agent automatically.</p>
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
        <button className="secondary" onClick={logout}>
          Log out
        </button>
      </header>

      {error && <pre className="error">{error}</pre>}

      {user.role === 'DONOR' && <DonationForm onCreated={refresh} />}

      <div className="card">
        <div className="card-head">
          <h2>{user.role === 'DONOR' ? 'Your donations' : 'Available donations'}</h2>
          <button className="secondary" onClick={refresh}>
            Refresh
          </button>
        </div>

        {donations.length === 0 ? (
          <p className="hint">Nothing here yet.</p>
        ) : (
          <ul className="donations">
            {donations.map((d) => (
              <li key={d.id}>
                <div className="donation-head">
                  <strong>{d.title}</strong>
                  <span className={`status-pill ${d.status.toLowerCase()}`}>
                    {d.status.replace(/_/g, ' ').toLowerCase()}
                  </span>
                </div>
                <p className="muted">
                  {d.category.replace(/_/g, ' ').toLowerCase()} · {d.quantity.amount}{' '}
                  {d.quantity.unit.toLowerCase()} · best before{' '}
                  {new Date(d.bestBefore).toLocaleString()}
                </p>
                <p className="muted">{d.pickupAddress}</p>
                {/* A donation with no coordinates cannot be matched to an
                    agent, so it is called out rather than shown as normal. */}
                {!d.location && <p className="warn">No coordinates — cannot be matched yet.</p>}
                {d.images?.length > 0 && (
                  <div className="thumbs">
                    {d.images.map((img) => (
                      <img key={img.filename} src={img.url} alt={d.title} />
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Makes the Redis cache visible. The hit rate is the entire
          justification for geocoding-service existing as its own service. */}
      {geoStats?.cache && (
        <div className="card stats">
          <h2>Geocoding cache</h2>
          <div className="stat-grid">
            <div>
              <span className="stat-value">{geoStats.cache.hitRate ?? '—'}%</span>
              <span className="stat-label">hit rate</span>
            </div>
            <div>
              <span className="stat-value">{geoStats.cache.hits}</span>
              <span className="stat-label">served from Redis</span>
            </div>
            <div>
              <span className="stat-value">{geoStats.cache.providerCalls}</span>
              <span className="stat-label">provider calls</span>
            </div>
            <div>
              <span className="stat-value">{geoStats.cache.quota?.remaining ?? '—'}</span>
              <span className="stat-label">daily quota left</span>
            </div>
          </div>
          <p className="hint">Provider: {geoStats.provider}</p>
        </div>
      )}
    </div>
  );
}
