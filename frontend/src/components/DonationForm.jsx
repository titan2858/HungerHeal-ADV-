import { motion } from 'framer-motion';
import { CheckCircle2, ImagePlus, MapPin, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import LocationPicker from './LocationPicker';
import Button from './ui/Button';
import Card from './ui/Card';
import { Field } from './ui/Field';
import AuthError from './auth/AuthError';
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

// Thumbnails for the selected files. Object URLs must be revoked or the page
// leaks a blob per preview for as long as it is open.
function ImagePreviews({ files, onRemove }) {
  const [urls, setUrls] = useState([]);

  useEffect(() => {
    const next = files.map((f) => URL.createObjectURL(f));
    setUrls(next);
    return () => next.forEach(URL.revokeObjectURL);
  }, [files]);

  if (files.length === 0) return null;

  return (
    <ul className="mt-3 flex flex-wrap gap-3">
      {files.map((file, i) => (
        <li key={`${file.name}-${i}`} className="relative">
          <img
            src={urls[i]}
            alt={`Selected photo ${i + 1}: ${file.name}`}
            className="size-20 rounded-xl object-cover ring-1 ring-cream-300"
          />
          <button
            type="button"
            onClick={() => onRemove(i)}
            aria-label={`Remove photo ${i + 1}`}
            className="absolute -right-1.5 -top-1.5 rounded-full bg-ink-900 p-1 text-white transition hover:bg-red-600"
          >
            <X className="size-3" />
          </button>
        </li>
      ))}
    </ul>
  );
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
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const selected = CATEGORIES.find((c) => c.value === form.category);

  return (
    <Card className="p-6 sm:p-8">
      <form onSubmit={submit} className="space-y-6" noValidate>
        <Field label="What is it?" required>
          {(props) => (
            <input
              {...props}
              value={form.title}
              onChange={set('title')}
              placeholder="Leftover biryani from a wedding"
              required
            />
          )}
        </Field>

        <Field label="Notes" hint="Optional — anything a collector should know before arriving.">
          {(props) => (
            <textarea
              {...props}
              rows={2}
              value={form.description}
              onChange={set('description')}
              placeholder="Freshly cooked this evening, packed in trays"
            />
          )}
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Category" required>
            {(props) => (
              <select {...props} value={form.category} onChange={set('category')}>
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field label="Quantity" required>
            {(props) => (
              <div className="flex gap-2">
                <input
                  {...props}
                  type="number"
                  min="0.1"
                  step="0.1"
                  value={form.quantityAmount}
                  onChange={set('quantityAmount')}
                  className={`${props.className} flex-1`}
                  required
                />
                <select
                  value={form.quantityUnit}
                  onChange={set('quantityUnit')}
                  aria-label="Quantity unit"
                  className="rounded-xl border border-cream-300 bg-white px-3 py-2.5 text-sm text-ink-800 transition-colors focus:border-leaf-500"
                >
                  {UNITS.map((u) => (
                    <option key={u} value={u}>
                      {u.toLowerCase()}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </Field>
        </div>

        {/* The category is not cosmetic: it decides which agents are eligible
            and how long they get to respond before the offer is reassigned. */}
        <div className="flex items-start gap-2 rounded-xl bg-warm-50 px-4 py-3 text-xs text-warm-800">
          <span className="font-semibold">This category:</span>
          <span>{selected?.note}</span>
        </div>

        <Field label="Best before" hint="When the food stops being safe to serve." required>
          {(props) => (
            <input
              {...props}
              type="datetime-local"
              value={form.bestBefore}
              onChange={set('bestBefore')}
              required
            />
          )}
        </Field>

        <div>
          <p className="text-sm font-semibold text-ink-700">Photos</p>
          <p className="mt-1 text-xs text-ink-400">Optional, up to 5. A photo helps a collector recognise the pickup.</p>

          <label className="mt-2 flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-cream-300 bg-cream-50 px-4 py-6 text-sm font-medium text-ink-500 transition-colors hover:border-leaf-400 hover:text-leaf-700">
            <ImagePlus className="size-5" aria-hidden="true" />
            Choose photos
            <input
              type="file"
              accept="image/*"
              multiple
              className="sr-only"
              onChange={(e) => setImages([...e.target.files].slice(0, 5))}
            />
          </label>

          <ImagePreviews
            files={images}
            onRemove={(i) => setImages(images.filter((_, idx) => idx !== i))}
          />
        </div>

        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <MapPin className="size-4 text-leaf-600" aria-hidden="true" />
            Where should it be collected?
          </h3>
          <div className="mt-3">
            <LocationPicker value={location} onChange={setLocation} />
          </div>
        </div>

        <AuthError error={error} />

        {result && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-xl2 border border-leaf-200 bg-leaf-50 p-5"
            role="status"
          >
            <p className="flex items-center gap-2 font-semibold text-leaf-800">
              <CheckCircle2 className="size-5" aria-hidden="true" />
              Donation posted.
            </p>
            <p className="mt-1.5 text-sm text-leaf-700">
              {result.assignmentQueued
                ? 'Finding a collection agent now — this usually takes a few seconds.'
                : 'Saved — it will be matched as soon as the system catches up.'}
            </p>
            {result.notice && <p className="mt-2 text-sm text-warm-700">{result.notice}</p>}
            {result.geocoding?.derivedFromAddress && (
              <p className="mt-2 text-xs text-ink-400">
                Coordinates derived from the address you typed.
              </p>
            )}
          </motion.div>
        )}

        <div>
          <Button type="submit" size="lg" loading={busy} disabled={busy || !location} className="w-full">
            {busy ? 'Posting…' : 'Post donation'}
          </Button>
          {!location && (
            <p className="mt-2 text-center text-xs text-ink-400">
              Set a pickup location to continue.
            </p>
          )}
        </div>
      </form>
    </Card>
  );
}
