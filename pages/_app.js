import Head from 'next/head';
import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import ErrorBoundary from '../components/ErrorBoundary.js';
import '../styles/globals.css';

export default function WardenApp({ Component, pageProps }) {
  useEffect(() => {
    async function configureNativeStatusBar() {
      if (!Capacitor.isNativePlatform()) return;

      try {
        const { StatusBar } = await import('@capacitor/status-bar');
        await StatusBar.setOverlaysWebView({ overlay: false });
      } catch (error) {
        console.warn('[status-bar] Native status bar setup failed', error);
      }
    }

    configureNativeStatusBar();
  }, []);

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