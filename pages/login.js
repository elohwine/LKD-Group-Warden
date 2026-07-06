import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from '../lib/firebase-client.js';
import { signInToWardenApp } from '../lib/auth';
import { loadSession } from '../lib/session';
import LoadingSpinner from '../components/LoadingSpinner.js';
import LicensePlate from '../components/LicensePlate.js';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, () => {
      const session = loadSession();
      if (session?.role) {
        router.replace('/dashboard');
        return;
      }
      setReady(true);
    });

    return unsubscribe;
  }, [router]);

  const passwordHint = useMemo(() => 'Use your LDK workstation or mobile credentials.', []);

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
      <div className="auth-grid">
        <section className="auth-hero">
          <div className="auth-brand-row">
            <LicensePlate number="LDK" size="large" />
          </div>
          <p className="eyebrow">Warden Mode Application</p>
          <h1>Field enforcement that survives the real world.</h1>
          <p className="hero-copy">
            Capture evidence, process VRMs, validate permits, and queue a defensible breach record from the roadside.
          </p>
          <ul className="auth-points">
            <li>Mobile-first capture with camera upload support</li>
            <li>Real-time authorisation checks against the existing permit pipeline</li>
            <li>Offline queue with automatic sync when connectivity returns</li>
          </ul>
        </section>

        <section className="auth-card">
          <div className="auth-card-header">
            <p className="eyebrow">Secure sign in</p>
            <h2>Start patrol session</h2>
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