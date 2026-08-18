import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
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

    async function bootstrapLoginSession() {
      const session = loadSession() || await restoreSession();
      if (cancelled) return;
      if (session?.role && session?.token) {
        router.replace('/dashboard');
        return;
      }
      setReady(true);
    }

    bootstrapLoginSession();

    return () => {
      cancelled = true;
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
      if (code.includes('role_missing')) {
        setError('This account is authenticated but has no usable role mapping yet.');
      } else if (code.includes('insufficient_role')) {
        setError('This account role is not allowed for this app.');
      } else if (code.includes('invalid_credentials')) {
        setError('Email or password is incorrect.');
      } else if (code.includes('network_unavailable')) {
        setError('Network error: cannot reach sign-in services. Check connection and retry.');
      } else if (code.includes('role_lookup_timeout')) {
        setError('Sign-in timed out while contacting role services. Please retry.');
      } else if (code.includes('role_lookup_failed')) {
        setError('Sign-in succeeded but role verification failed. Please retry shortly.');
      } else {
        setError('Sign-in failed due to a backend/service error. Please retry.');
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