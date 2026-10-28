import type { Capture, GeoJsonPoint } from '@gis-vision/schemas';
import { useCallback, useEffect, useState, type SubmitEvent } from 'react';
import type { ApiClient } from './api.js';
import { ErrorMessage } from './ErrorMessage.js';

/** Both fields empty means no location; one without the other is a mistake. */
function parseLocation(lat: string, lon: string): GeoJsonPoint | undefined {
  if (lat.trim() === '' && lon.trim() === '') {
    return undefined;
  }
  if (lat.trim() === '' || lon.trim() === '') {
    throw new Error('Enter both latitude and longitude, or neither');
  }
  return { type: 'Point', coordinates: [Number(lon), Number(lat)] };
}

function UploadForm({ api, onUploaded }: { api: ApiClient; onUploaded: () => void }) {
  const [file, setFile] = useState<File>();
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    // React clears `currentTarget` once the handler yields, so keep the form for the reset.
    const form = event.currentTarget;
    if (!file) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api.uploadCapture(file, parseLocation(lat, lon));
      setFile(undefined);
      form.reset();
      onUploaded();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={(event) => void submit(event)}>
      <h2>Upload a capture</h2>
      <label>
        Image (JPEG, PNG or WebP)
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          required
          onChange={(event) => {
            setFile(event.target.files?.[0]);
          }}
        />
      </label>
      <div className="row">
        <label>
          Latitude
          <input
            inputMode="decimal"
            placeholder="52.5"
            onChange={(event) => {
              setLat(event.target.value);
            }}
          />
        </label>
        <label>
          Longitude
          <input
            inputMode="decimal"
            placeholder="13.4"
            onChange={(event) => {
              setLon(event.target.value);
            }}
          />
        </label>
      </div>
      <button type="submit" disabled={!file || busy}>
        {busy ? 'Uploading…' : 'Upload'}
      </button>
      <ErrorMessage error={error} />
    </form>
  );
}

function formatLocation(capture: Capture): string {
  if (!capture.location) {
    return 'no location';
  }
  const [lon, lat] = capture.location.coordinates;
  return `${String(lat)}, ${String(lon)}`;
}

export function Home({ api }: { api: ApiClient }) {
  const [captures, setCaptures] = useState<Capture[]>();
  const [error, setError] = useState<unknown>();

  const load = useCallback(() => {
    api.listCaptures().then(setCaptures, setError);
  }, [api]);
  useEffect(load, [load]);

  return (
    <>
      <UploadForm api={api} onUploaded={load} />
      <section>
        <h2>Captures</h2>
        <ErrorMessage error={error} />
        {captures?.length === 0 && <p>No captures yet.</p>}
        <ul className="captures">
          {captures?.map((capture) => (
            <li key={capture.id}>
              <a href={`#/captures/${capture.id}`}>
                {capture.imageUrl ? (
                  <img src={capture.imageUrl} alt="" />
                ) : (
                  <span className="placeholder">{capture.status}</span>
                )}
                <span>{new Date(capture.capturedAt).toLocaleString()}</span>
                <span className="muted">{formatLocation(capture)}</span>
              </a>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
