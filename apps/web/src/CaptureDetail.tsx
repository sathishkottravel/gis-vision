import type { Capture, Detection } from '@gis-vision/schemas';
import { useCallback, useEffect, useState, type SubmitEvent } from 'react';
import type { ApiClient } from './api.js';
import { ErrorMessage } from './ErrorMessage.js';

interface Size {
  width: number;
  height: number;
}

/** The image with each detection's bounding box drawn over it. */
function AnnotatedImage({ src, detections }: { src: string; detections: Detection[] }) {
  const [size, setSize] = useState<Size>();
  const percent = (value: number, total: number) => `${String((value / total) * 100)}%`;
  return (
    <div className="annotated">
      <img
        src={src}
        alt="Capture"
        onLoad={(event) => {
          const img = event.currentTarget;
          setSize({ width: img.naturalWidth, height: img.naturalHeight });
        }}
      />
      {size &&
        detections.map(({ id, label, bbox }) => (
          <div
            key={id}
            className="bbox"
            title={label}
            style={{
              left: percent(bbox.x, size.width),
              top: percent(bbox.y, size.height),
              width: percent(bbox.w, size.width),
              height: percent(bbox.h, size.height),
            }}
          >
            <span>{label}</span>
          </div>
        ))}
    </div>
  );
}

const EMPTY_FORM = { label: '', x: '0', y: '0', w: '', h: '', confidence: '', attributes: '{}' };

type FormField = keyof typeof EMPTY_FORM;

/** Posts a `manual` detection; the API's validation errors are shown as returned. */
function DetectionForm({
  api,
  captureId,
  onCreated,
}: {
  api: ApiClient;
  captureId: string;
  onCreated: () => void;
}) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState<unknown>();
  const field = (name: FormField) => ({
    value: form[name],
    onChange: (event: { target: { value: string } }) => {
      setForm({ ...form, [name]: event.target.value });
    },
  });

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    try {
      let attributes: unknown;
      try {
        attributes = JSON.parse(form.attributes);
      } catch {
        throw new Error('Attributes must be valid JSON, e.g. {"note": "faded"}');
      }
      await api.createDetection(captureId, {
        detectorId: 'manual',
        label: form.label,
        bbox: { x: Number(form.x), y: Number(form.y), w: Number(form.w), h: Number(form.h) },
        ...(form.confidence.trim() === '' ? {} : { confidence: Number(form.confidence) }),
        attributes,
      });
      setForm(EMPTY_FORM);
      onCreated();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <form className="card" onSubmit={(event) => void submit(event)}>
      <h2>Add a manual detection</h2>
      <label>
        Label
        <input placeholder="stop-sign" {...field('label')} />
      </label>
      <div className="row">
        {(['x', 'y', 'w', 'h'] as const).map((name) => (
          <label key={name}>
            {name} (px)
            <input type="number" step="any" {...field(name)} />
          </label>
        ))}
        <label>
          Confidence
          <input type="number" step="any" placeholder="0-1" {...field('confidence')} />
        </label>
      </div>
      <label>
        Attributes (JSON)
        <textarea rows={3} {...field('attributes')} />
      </label>
      <button type="submit">Add detection</button>
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

export function CaptureDetail({ api, captureId }: { api: ApiClient; captureId: string }) {
  const [capture, setCapture] = useState<Capture>();
  const [detections, setDetections] = useState<Detection[]>([]);
  const [error, setError] = useState<unknown>();

  const loadDetections = useCallback(() => {
    api.listDetections(captureId).then(setDetections, setError);
  }, [api, captureId]);
  useEffect(() => {
    api.getCapture(captureId).then(setCapture, setError);
    loadDetections();
  }, [api, captureId, loadDetections]);

  if (!capture) {
    return error === undefined ? <p>Loading…</p> : <ErrorMessage error={error} />;
  }
  return (
    <>
      <p>
        <a href="#/">← All captures</a>
      </p>
      <h2>Capture {capture.id}</h2>
      <p className="muted">
        {capture.status} · {new Date(capture.capturedAt).toLocaleString()} ·{' '}
        {formatLocation(capture)}
      </p>
      {capture.imageUrl && <AnnotatedImage src={capture.imageUrl} detections={detections} />}
      <ErrorMessage error={error} />
      <section>
        <h2>Detections ({detections.length})</h2>
        {detections.length === 0 ? (
          <p>No detections yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Label</th>
                <th>Detector</th>
                <th>Confidence</th>
                <th>Bounding box (x, y, w, h)</th>
                <th>Observed</th>
                <th>Attributes</th>
              </tr>
            </thead>
            <tbody>
              {detections.map((detection) => (
                <tr key={detection.id}>
                  <td>{detection.label}</td>
                  <td>{detection.detectorId}</td>
                  <td>{detection.confidence ?? '–'}</td>
                  <td>
                    {[detection.bbox.x, detection.bbox.y, detection.bbox.w, detection.bbox.h].join(
                      ', ',
                    )}
                  </td>
                  <td>{new Date(detection.observedAt).toLocaleString()}</td>
                  <td>
                    <code>{JSON.stringify(detection.attributes)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {capture.status === 'ready' ? (
        <DetectionForm api={api} captureId={capture.id} onCreated={loadDetections} />
      ) : (
        <p>Detections can be added once the upload is complete.</p>
      )}
    </>
  );
}
