import { useEffect, useState } from 'react';
import { ApiClient } from './api.js';
import { CaptureDetail } from './CaptureDetail.js';
import { Home } from './Home.js';

const api = new ApiClient();

/** `#/captures/<id>` shows one capture; anything else shows the upload page and list. */
function useHashRoute(): string | undefined {
  const read = () => /^#\/captures\/([^/]+)$/.exec(window.location.hash)?.[1];
  const [captureId, setCaptureId] = useState(read);
  useEffect(() => {
    const onChange = () => {
      setCaptureId(read());
    };
    window.addEventListener('hashchange', onChange);
    return () => {
      window.removeEventListener('hashchange', onChange);
    };
  }, []);
  return captureId;
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
  const captureId = useHashRoute();
  return (
    <>
      <header>
        <h1>
          <a href="#/">gis-vision</a>
        </h1>
        <HealthBadge />
      </header>
      <main>
        {captureId ? <CaptureDetail api={api} captureId={captureId} /> : <Home api={api} />}
      </main>
    </>
  );
}
