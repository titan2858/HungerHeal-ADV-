import { useState } from 'react';
import LocationPicker from './LocationPicker';
import { api } from '../api/client';

const CATEGORIES = [
  { value: 'COOKED_PREPARED', label: 'Cooked / prepared meals', note: 'needs insulated transport · high urgency' },
  { value: 'PERISHABLE_RAW', label: 'Perishable raw', note: 'dairy, produce, meat · cooling preferred' },
  { value: 'BAKERY', label: 'Bakery', note: 'bread, pastries · medium urgency' },
  { value: 'PACKAGED_NON_PERISHABLE', label: 'Packaged / non-perishable', note: 'canned goods, grains · low urgency' },
  { value: 'BEVERAGES', label: 'Beverages', note: 'juices, bottled water' },
];

const UNITS = ['SERVINGS', 'KG', 'ITEMS', 'LITRES'];

// Default best-before: 6 hours out, which is a realistic window for cooked food
// and saves the donor typing a date for the common case.
function defaultBestBefore() {
  const d = new Date(Date.now() + 6 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function DonationForm({ onCreated }) {
  const [form, setForm] = useState({
    title: '',
    description: '',
    category: 'COOKED_PREPARED',
    quantityAmount: '',
    quantityUnit: 'SERVINGS',
    bestBefore: defaultBestBefore(),
  });
  const [location, setLocation] = useState(null);
  const [images, setImages] = useState([]);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);

    try {
      // multipart, because images may be attached. Every value goes across as
      // a string; the backend schema coerces them back to numbers and dates.
      const fd = new FormData();
      fd.append('title', form.title);
      if (form.description) fd.append('description', form.description);
      fd.append('category', form.category);
      fd.append('quantityAmount', form.quantityAmount);
      fd.append('quantityUnit', form.quantityUnit);
      fd.append('pickupAddress', location?.address ?? '');
      fd.append('bestBefore', new Date(form.bestBefore).toISOString());

      // Coordinates from the pin the donor actually placed. Sending them means
      // donation-service does not have to geocode the typed address, which is
      // both less precise and spends provider quota.
      if (location?.lat != null) {
        fd.append('lat', String(location.lat));
        fd.append('lng', String(location.lng));
      }

      for (const file of images) fd.append('images', file);

      const res = await api.createDonation(fd);
      setResult(res);
      onCreated?.(res.donation);

      setForm({ ...form, title: '', description: '', quantityAmount: '' });
      setImages([]);
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

  const selected = CATEGORIES.find((c) => c.value === form.category);

  return (
    <div className="card">
      <h2>Offer food</h2>

      <form onSubmit={submit}>
        <label>
          What is it?
          <input
            value={form.title}
            onChange={set('title')}
            placeholder="Leftover biryani from a wedding"
            required
          />
        </label>

        <label>
          Notes (optional)
          <textarea
            value={form.description}
            onChange={set('description')}
            rows={2}
            placeholder="Freshly cooked this evening, packed in trays"
          />
        </label>

        <div className="row">
          <label>
            Category
            <select value={form.category} onChange={set('category')}>
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          <label className="qty">
            Quantity
            <div className="qty-row">
              <input
                type="number"
                min="0.1"
                step="0.1"
                value={form.quantityAmount}
                onChange={set('quantityAmount')}
                required
              />
              <select value={form.quantityUnit} onChange={set('quantityUnit')}>
                {UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u.toLowerCase()}
                  </option>
                ))}
              </select>
            </div>
          </label>
        </div>

        {/* The category is not cosmetic: it decides which agents are eligible
            and how long they get to respond before the offer is reassigned. */}
        <p className="hint category-note">{selected?.note}</p>

        <label>
          Best before
          <input type="datetime-local" value={form.bestBefore} onChange={set('bestBefore')} required />
        </label>

        <label>
          Photos (optional, up to 5)
          <input
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => setImages([...e.target.files].slice(0, 5))}
          />
        </label>

        <h3>Where should it be collected?</h3>
        <LocationPicker value={location} onChange={setLocation} />

        {error && <pre className="error">{error}</pre>}

        {result && (
          <div className="success">
            <strong>Donation posted.</strong>{' '}
            {result.assignmentQueued
              ? 'Finding a collection agent now.'
              : 'Saved — it will be matched as soon as the system catches up.'}
            {result.notice && <p className="warn">{result.notice}</p>}
            {result.geocoding?.derivedFromAddress && (
              <p className="muted">Coordinates derived from the address you typed.</p>
            )}
          </div>
        )}

        <button type="submit" disabled={busy || !location}>
          {busy ? 'Posting…' : 'Post donation'}
        </button>
        {!location && <p className="hint">Set a pickup location to continue.</p>}
      </form>
    </div>
  );
}
