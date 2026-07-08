import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { signInToWardenApp } from '../lib/auth';
import { loadSession } from '../lib/session';
import LoadingSpinner from '../components/LoadingSpinner.js';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const session = loadSession();
    if (session?.role && session?.token) {
      router.replace('/dashboard');
      return;
    }
    setReady(true);
  }, [router]);

  const passwordHint = useMemo(() => 'Use your warden account email and password.', []);

  function formatLoginError(signinError) {
    const code = String(signinError?.message || signinError?.code || '').toLowerCase();
    if (code.includes('insufficient_role')) return 'This account does not have warden access.';
    if (code.includes('invalid_credentials') || code.includes('wrong_password') || code.includes('unauthorized')) {
      return 'Invalid email or password.';
    }
    if (code.includes('email_and_password_required')) {
      return 'Enter both email and password.';
    }
    return signinError?.message || 'Sign in failed. Check your credentials and try again.';
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setLoading(true);
    setError('');

    try {
      await signInToWardenApp(email.trim(), password);
      router.replace('/dashboard');
    } catch (signinError) {
      setError(formatLoginError(signinError));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-backdrop" />
      <div className="auth-grid auth-login-grid">
        <section className="auth-card auth-login-card">
          <div className="auth-card-header">
            <p className="eyebrow">LDK Warden</p>
            <h2>Sign in</h2>
            <p>{passwordHint}</p>
          </div>

          {!ready ? (
            <div className="auth-loading">
              <LoadingSpinner />
              <span>Preparing secure session…</span>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="auth-form">
              <label>
                Email
                <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" placeholder="name@ldkgroup.co.uk" required autoComplete="email" />
              </label>

              <label>
                Password
                <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder="Enter your password" required autoComplete="current-password" />
              </label>

              {error ? <div className="notice notice-error">{error}</div> : null}

              <button type="submit" className="primary-button" disabled={loading}>
                {loading ? 'Signing in…' : 'Continue'}
              </button>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}