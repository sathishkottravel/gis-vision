import { lazy, Suspense, useEffect, useState } from 'react';
import { ApiClient } from './api.js';
import { CaptureDetail } from './CaptureDetail.js';
import { Home } from './Home.js';

const api = new ApiClient();

// MapLibre is large, so the map page loads only when it is opened.
const MapPage = lazy(async () => ({ default: (await import('./MapPage.js')).MapPage }));

type Route = { page: 'home' } | { page: 'map' } | { page: 'capture'; captureId: string };

/** `#/captures/<id>` shows one capture, `#/map` the map; anything else the upload page and list. */
function readRoute(): Route {
  const { hash } = window.location;
  if (hash === '#/map') {
    return { page: 'map' };
  }
  const captureId = /^#\/captures\/([^/]+)$/.exec(hash)?.[1];
  return captureId ? { page: 'capture', captureId } : { page: 'home' };
}

function useHashRoute(): Route {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const onChange = () => {
      setRoute(readRoute());
    };
    window.addEventListener('hashchange', onChange);
    return () => {
      window.removeEventListener('hashchange', onChange);
    };
  }, []);
  return route;
}

function HealthBadge() {
  const [status, setStatus] = useState('checking');
  useEffect(() => {
    api.health().then(
      (report) => {
        setStatus(report.status);
      },
      () => {
        setStatus('unreachable');
      },
    );
  }, []);
  return (
    <span className={`badge badge-${status}`} data-testid="health">
      API: {status}
    </span>
  );
}

export function App() {
  const route = useHashRoute();
  return (
    <>
      <header>
        <h1>
          <a href="#/">gis-vision</a>
        </h1>
        <nav>
          <a href="#/" aria-current={route.page === 'home' ? 'page' : undefined}>
            Captures
          </a>
          <a href="#/map" aria-current={route.page === 'map' ? 'page' : undefined}>
            Map
          </a>
        </nav>
        <HealthBadge />
      </header>
      <main>
        {route.page === 'capture' && <CaptureDetail api={api} captureId={route.captureId} />}
        {route.page === 'map' && (
          <Suspense fallback={<p>Loading map…</p>}>
            <MapPage />
          </Suspense>
        )}
        {route.page === 'home' && <Home api={api} />}
      </main>
    </>
  );
}
