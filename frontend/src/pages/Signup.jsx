import { motion } from 'framer-motion';
import { Eye, HandHeart, PackageCheck } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import AuthShell from '../components/auth/AuthShell';
import AuthError from '../components/auth/AuthError';
import Button from '../components/ui/Button';
import { Field } from '../components/ui/Field';
import { IMAGES } from '../lib/images';
import { prettyCategory } from '../lib/format';

// These values are the API's enums, not display strings. They are sent exactly
// as written; only the labels beside them are for humans.
const FOOD_CATEGORIES = [
  'COOKED_PREPARED',
  'PERISHABLE_RAW',
  'BAKERY',
  'PACKAGED_NON_PERISHABLE',
  'BEVERAGES',
];

const VEHICLE_TYPES = ['BICYCLE', 'MOTORCYCLE', 'CAR', 'VAN'];

const ROLES = [
  {
    value: 'DONOR',
    label: 'I donate food',
    description: 'Restaurants, canteens, event caterers, households with surplus.',
    icon: HandHeart,
  },
  {
    value: 'AGENT',
    label: 'I collect food',
    description: 'Volunteers and riders who pick up donations and deliver them.',
    icon: PackageCheck,
  },
  {
    value: 'ADMIN',
    label: 'I want to observe',
    description: 'A read-only view of matching decisions. No control over assignment.',
    icon: Eye,
  },
];

export default function Signup() {
  const [role, setRole] = useState('DONOR');
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '' });
  const [capabilities, setCapabilities] = useState({
    vehicleType: 'MOTORCYCLE',
    hasInsulatedTransport: false,
    hasRefrigeration: false,
    categoriesHandled: ['COOKED_PREPARED'],
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const { signIn } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

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
      const res = await api.signup({
        ...form,
        role,
        // Agents declare what they can carry at registration, because
        // assignment scoring depends on it from the very first donation.
        ...(role === 'AGENT' ? { capabilities } : {}),
      });

      signIn(res.token, res.user);
      toast.success('Account created. Welcome to HungerHeal.');
      navigate(role === 'DONOR' ? '/donate' : '/dashboard', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Join HungerHeal"
      subtitle="Two minutes to set up. Choose how you want to take part."
      image={IMAGES.kitchen}
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="font-semibold text-leaf-700 hover:underline">
            Log in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-6" noValidate>
        <fieldset>
          <legend className="text-sm font-semibold text-ink-700">How will you take part?</legend>
          <div className="mt-3 space-y-2.5">
            {ROLES.map(({ value, label, description, icon: Icon }) => {
              const selected = role === value;
              return (
                <label
                  key={value}
                  className={[
                    'flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors',
                    selected
                      ? 'border-leaf-500 bg-leaf-50'
                      : 'border-cream-300 bg-white hover:border-leaf-300',
                  ].join(' ')}
                >
                  <input
                    type="radio"
                    name="role"
                    className="sr-only"
                    checked={selected}
                    onChange={() => setRole(value)}
                  />
                  <span
                    className={[
                      'mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg',
                      selected ? 'bg-leaf-600 text-white' : 'bg-cream-200 text-ink-500',
                    ].join(' ')}
                  >
                    <Icon className="size-4" aria-hidden="true" />
                  </span>
                  <span>
                    <span className="block text-sm font-semibold text-ink-800">{label}</span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-ink-500">
                      {description}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <Field label="Full name" required>
          {(props) => (
            <input
              {...props}
              autoComplete="name"
              value={form.name}
              onChange={set('name')}
              placeholder="Asha Menon"
              required
            />
          )}
        </Field>

        <Field label="Phone" hint="Shared with the other party once a pickup is agreed." required>
          {(props) => (
            <input
              {...props}
              type="tel"
              autoComplete="tel"
              value={form.phone}
              onChange={set('phone')}
              placeholder="+91 9876543210"
              required
            />
          )}
        </Field>

        <Field label="Email" required>
          {(props) => (
            <input
              {...props}
              type="email"
              autoComplete="email"
              value={form.email}
              onChange={set('email')}
              placeholder="you@example.com"
              required
            />
          )}
        </Field>

        <Field label="Password" hint="At least 8 characters, including a number." required>
          {(props) => (
            <input
              {...props}
              type="password"
              autoComplete="new-password"
              value={form.password}
              onChange={set('password')}
              required
            />
          )}
        </Field>

        {role === 'AGENT' && (
          <motion.fieldset
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            className="overflow-hidden rounded-xl2 border border-warm-200 bg-warm-50 p-5"
          >
            <legend className="px-2 text-sm font-semibold text-warm-800">
              What can you carry?
            </legend>
            <p className="text-xs leading-relaxed text-warm-700">
              This is not profile decoration — it decides which donations you are eligible for
              and how highly you score for them.
            </p>

            <div className="mt-4 space-y-4">
              <Field label="Vehicle">
                {(props) => (
                  <select
                    {...props}
                    value={capabilities.vehicleType}
                    onChange={(e) =>
                      setCapabilities({ ...capabilities, vehicleType: e.target.value })
                    }
                  >
                    {VEHICLE_TYPES.map((v) => (
                      <option key={v} value={v}>
                        {v.charAt(0) + v.slice(1).toLowerCase()}
                      </option>
                    ))}
                  </select>
                )}
              </Field>

              <label className="flex items-start gap-3 text-sm text-ink-700">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 rounded border-cream-300 text-leaf-600"
                  checked={capabilities.hasInsulatedTransport}
                  onChange={(e) =>
                    setCapabilities({ ...capabilities, hasInsulatedTransport: e.target.checked })
                  }
                />
                <span>
                  Insulated bag or box
                  <span className="block text-xs text-ink-500">Required for cooked food.</span>
                </span>
              </label>

              <label className="flex items-start gap-3 text-sm text-ink-700">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 rounded border-cream-300 text-leaf-600"
                  checked={capabilities.hasRefrigeration}
                  onChange={(e) =>
                    setCapabilities({ ...capabilities, hasRefrigeration: e.target.checked })
                  }
                />
                <span>
                  Refrigeration
                  <span className="block text-xs text-ink-500">
                    Preferred for dairy and fresh produce.
                  </span>
                </span>
              </label>

              <div>
                <p className="text-sm font-semibold text-ink-700">Categories you will handle</p>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {FOOD_CATEGORIES.map((c) => {
                    const on = capabilities.categoriesHandled.includes(c);
                    return (
                      <button
                        key={c}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleCategory(c)}
                        className={[
                          'rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors',
                          on
                            ? 'bg-leaf-600 text-white'
                            : 'bg-white text-ink-500 ring-1 ring-cream-300 hover:ring-leaf-300',
                        ].join(' ')}
                      >
                        {prettyCategory(c)}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </motion.fieldset>
        )}

        <AuthError error={error} />

        <Button type="submit" size="lg" loading={busy} className="w-full">
          {busy ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
    </AuthShell>
  );
}
