import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import AuthShell from '../components/auth/AuthShell';
import AuthError from '../components/auth/AuthError';
import Button from '../components/ui/Button';
import { Field } from '../components/ui/Field';

export default function Login() {
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const { signIn } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();

  // Where the user was heading before being bounced to the login page.
  const redirectTo = location.state?.from ?? '/dashboard';

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const res = await api.login({ email: form.email, password: form.password });
      signIn(res.token, res.user);
      toast.success(`Welcome back, ${res.user.name.split(' ')[0]}.`);
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Log in to post a donation, answer a collection request, or watch the matching engine work."
      footer={
        <>
          New here?{' '}
          <Link to="/signup" className="font-semibold text-leaf-700 hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-5" noValidate>
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

        <Field label="Password" required>
          {(props) => (
            <input
              {...props}
              type="password"
              autoComplete="current-password"
              value={form.password}
              onChange={set('password')}
              placeholder="Your password"
              required
            />
          )}
        </Field>

        <AuthError error={error} />

        <Button type="submit" size="lg" loading={busy} className="w-full">
          {busy ? 'Logging in…' : 'Log in'}
        </Button>
      </form>
    </AuthShell>
  );
}
