import Head from 'next/head';
import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import ErrorBoundary from '../components/ErrorBoundary.js';
import '../styles/globals.css';

const DARK_THEME_COLOR = '#0d1b2a';
const LIGHT_THEME_COLOR = '#f6f9fd';

export default function WardenApp({ Component, pageProps }) {
  useEffect(() => {
    async function configureNativeStatusBar() {
      if (!Capacitor.isNativePlatform() || typeof document === 'undefined') return undefined;

      try {
        const { StatusBar, Style } = await import('@capacitor/status-bar');
        const root = document.documentElement;
        const themeMeta = document.querySelector('meta[name="theme-color"]');

        const syncNativeBars = async () => {
          const lightTheme = root.classList.contains('theme-light');
          if (themeMeta) {
            themeMeta.setAttribute('content', lightTheme ? LIGHT_THEME_COLOR : DARK_THEME_COLOR);
          }

          await StatusBar.setStyle({
            style: lightTheme ? Style.Light : Style.Dark,
          });
        };

        await StatusBar.setOverlaysWebView({ overlay: false });
        await syncNativeBars();

        const observer = new MutationObserver(() => {
          syncNativeBars().catch((error) => {
            console.warn('[status-bar] Native status bar theme sync failed', error);
          });
        });
        observer.observe(root, { attributes: true, attributeFilter: ['class'] });
        return () => observer.disconnect();
      } catch (error) {
        console.warn('[status-bar] Native status bar setup failed', error);
        return undefined;
      }
    }

    let cleanup = null;
    configureNativeStatusBar().then((dispose) => {
      cleanup = typeof dispose === 'function' ? dispose : null;
    });

    return () => {
      if (cleanup) cleanup();
    };
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