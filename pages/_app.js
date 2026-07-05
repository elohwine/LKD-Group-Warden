import Head from 'next/head';
import ErrorBoundary from '../../components/ErrorBoundary.js';
import '../styles/globals.css';

export default function WardenApp({ Component, pageProps }) {
  return (
    <>
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#0d1b2a" />
        <link rel="manifest" href="/manifest.json" />
        <link rel="icon" href="/warden-logo.svg" />
        <title>LDK Warden</title>
      </Head>
      <ErrorBoundary>
        <Component {...pageProps} />
      </ErrorBoundary>
    </>
  );
}