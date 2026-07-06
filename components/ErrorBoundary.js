import React from 'react';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('[warden/ErrorBoundary]', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 24, color: '#f4f7fb', background: '#08111d', minHeight: '100vh' }}>
          <h1>Something went wrong</h1>
          <p>The warden app could not render correctly.</p>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{String(this.state.error || 'Unknown error')}</pre>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;