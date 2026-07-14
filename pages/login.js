import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from '../lib/firebase-client.js';
import { signInToWardenApp } from '../lib/auth';
import { loadSession, restoreSession } from '../lib/session';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const unsubscribe = onAuthStateChanged(auth, async () => {
      const session = loadSession() || await restoreSession();
      if (cancelled) return;
      if (session?.role) {
        router.replace('/dashboard');
        return;
      }
      setReady(true);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [router]);

  async function handleSubmit(event) {
    event.preventDefault();
    setLoading(true);
    setError('');

    try {
      await signInToWardenApp(email.trim(), password);
      router.replace('/dashboard');
    } catch (signinError) {
      const code = String(signinError?.message || signinError?.code || '');
      if (code.includes('insufficient_role')) {
        setError('This account does not have warden access.');
      } else {
        setError('Sign in failed. Check your credentials and try again.');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-backdrop" />
      <div className="auth-grid auth-login-grid">
        <section className="auth-card auth-login-card">
          <div className="auth-brand-row">
            <img src="/brand/ldk-logo-color.png" alt="LDK Group" className="auth-brand-logo auth-brand-logo-login" />
          </div>

          {!ready ? (
            <div className="auth-loading">
              <span>Preparing secure session…</span>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="auth-form">
              <label>
                Email
                <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" placeholder="warden@ldkgroup.co.uk" required />
              </label>

              <label>
                Password
                <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder="••••••••" required />
              </label>

              {error ? <div className="notice notice-error">{error}</div> : null}

              <button type="submit" className="primary-button" disabled={loading}>
                {loading ? 'Signing in…' : 'Enter Warden Mode'}
              </button>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}