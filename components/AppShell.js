export default function AppShell({ profile, siteName, online, syncing, queueCount, onLogout, onSync, children }) {
  return (
    <div className="warden-app-shell">
      <header className="warden-topbar">
        <div>
          <div className="warden-brand">LDK Warden</div>
          <div className="warden-subtitle">Mobile enforcement, live validation, offline queue</div>
        </div>
        <div className="warden-topbar-actions">
          <span className={`status-pill ${online ? 'status-pill-online' : 'status-pill-offline'}`}>
            {online ? 'Online' : 'Offline'}
          </span>
          <button type="button" className="ghost-button" onClick={onSync} disabled={syncing}>
            {syncing ? 'Syncing…' : `Sync ${queueCount > 0 ? `(${queueCount})` : ''}`}
          </button>
          <button type="button" className="ghost-button ghost-button-logout" onClick={onLogout}>
            Logout
          </button>
        </div>
      </header>

      <main className="warden-main">
        <section className="hero-card">
          <div>
            <p className="eyebrow">Patrol session</p>
            <h1>Simple, defensible field enforcement.</h1>
            <p className="hero-copy">
              Capture plate evidence, validate authorisation in real time, and queue breaches safely when connectivity drops.
            </p>
          </div>
          <div className="hero-meta">
            <div>
              <span className="meta-label">Operative</span>
              <strong>{profile?.email || profile?.uid || 'Signed in'}</strong>
            </div>
            <div>
              <span className="meta-label">Role</span>
              <strong>{profile?.role || 'warden'}</strong>
            </div>
            <div>
              <span className="meta-label">Site</span>
              <strong>{siteName || 'No site selected'}</strong>
            </div>
          </div>
        </section>

        {children}
      </main>
    </div>
  );
}