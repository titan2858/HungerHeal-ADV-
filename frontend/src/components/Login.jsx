import { useState } from 'react';
import { api, auth } from '../api/client';

const FOOD_CATEGORIES = [
  'COOKED_PREPARED',
  'PERISHABLE_RAW',
  'BAKERY',
  'PACKAGED_NON_PERISHABLE',
  'BEVERAGES',
];

const VEHICLE_TYPES = ['BICYCLE', 'MOTORCYCLE', 'CAR', 'VAN'];

export default function Login({ onAuthenticated }) {
  const [mode, setMode] = useState('login');
  const [role, setRole] = useState('DONOR');
  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    password: '',
  });
  const [capabilities, setCapabilities] = useState({
    vehicleType: 'MOTORCYCLE',
    hasInsulatedTransport: false,
    hasRefrigeration: false,
    categoriesHandled: ['COOKED_PREPARED'],
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  function toggleCategory(category) {
    setCapabilities((c) => ({
      ...c,
      categoriesHandled: c.categoriesHandled.includes(category)
        ? c.categoriesHandled.filter((x) => x !== category)
        : [...c.categoriesHandled, category],
    }));
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const res =
        mode === 'login'
          ? await api.login({ email: form.email, password: form.password })
          : await api.signup({
              ...form,
              role,
              // Agents declare what they can carry at registration, because
              // assignment scoring depends on it from the first donation.
              ...(role === 'AGENT' ? { capabilities } : {}),
            });

      auth.save(res.token, res.user);
      onAuthenticated(res.user);
    } catch (err) {
      setError(
        err.details?.length
          ? err.details.map((d) => `${d.field}: ${d.message}`).join('\n')
          : err.message,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card auth-card">
      <div className="tabs">
        <button
          className={mode === 'login' ? 'active' : ''}
          onClick={() => setMode('login')}
          type="button"
        >
          Log in
        </button>
        <button
          className={mode === 'signup' ? 'active' : ''}
          onClick={() => setMode('signup')}
          type="button"
        >
          Sign up
        </button>
      </div>

      <form onSubmit={submit}>
        {mode === 'signup' && (
          <>
            <div className="role-toggle">
              {['DONOR', 'AGENT', 'ADMIN'].map((r) => (
                <label key={r} className={role === r ? 'selected' : ''}>
                  <input
                    type="radio"
                    name="role"
                    checked={role === r}
                    onChange={() => setRole(r)}
                  />
                  {r === 'DONOR' && 'I donate food'}
                  {r === 'AGENT' && 'I collect food'}
                  {/* Read-only. It grants no control over assignment. */}
                  {r === 'ADMIN' && 'Monitor'}
                </label>
              ))}
            </div>

            <label>
              Name
              <input value={form.name} onChange={set('name')} required />
            </label>
            <label>
              Phone
              <input value={form.phone} onChange={set('phone')} placeholder="+91 9876543210" required />
            </label>
          </>
        )}

        <label>
          Email
          <input type="email" value={form.email} onChange={set('email')} required />
        </label>
        <label>
          Password
          <input
            type="password"
            value={form.password}
            onChange={set('password')}
            placeholder="at least 8 characters, with a number"
            required
          />
        </label>

        {mode === 'signup' && role === 'AGENT' && (
          <fieldset className="capabilities">
            <legend>What can you carry?</legend>

            <label>
              Vehicle
              <select
                value={capabilities.vehicleType}
                onChange={(e) =>
                  setCapabilities({ ...capabilities, vehicleType: e.target.value })
                }
              >
                {VEHICLE_TYPES.map((v) => (
                  <option key={v} value={v}>
                    {v.toLowerCase()}
                  </option>
                ))}
              </select>
            </label>

            <label className="check">
              <input
                type="checkbox"
                checked={capabilities.hasInsulatedTransport}
                onChange={(e) =>
                  setCapabilities({ ...capabilities, hasInsulatedTransport: e.target.checked })
                }
              />
              Insulated bag or box (required for cooked food)
            </label>

            <label className="check">
              <input
                type="checkbox"
                checked={capabilities.hasRefrigeration}
                onChange={(e) =>
                  setCapabilities({ ...capabilities, hasRefrigeration: e.target.checked })
                }
              />
              Refrigeration (preferred for dairy and fresh produce)
            </label>

            <p className="hint">Categories you will handle:</p>
            <div className="chips">
              {FOOD_CATEGORIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={capabilities.categoriesHandled.includes(c) ? 'chip on' : 'chip'}
                  onClick={() => toggleCategory(c)}
                >
                  {c.replace(/_/g, ' ').toLowerCase()}
                </button>
              ))}
            </div>
          </fieldset>
        )}

        {error && <pre className="error">{error}</pre>}

        <button type="submit" disabled={busy}>
          {busy ? 'Working…' : mode === 'login' ? 'Log in' : 'Create account'}
        </button>
      </form>
    </div>
  );
}
