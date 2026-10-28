import type { FeatureCollection } from 'geojson';
import {
  Map as MapLibreMap,
  NavigationControl,
  Popup,
  setWorkerUrl,
  type GeoJSONSource,
  type MapLayerMouseEvent,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchMapDetections, MAP_POINT_LIMIT, type MapDetection } from './graphql.js';
import { normalizeBounds } from './map-bounds.js';
import { observedRange, TIME_PRESETS, type TimeRange } from './time-range.js';

// MapLibre derives its worker URL from its own module URL, which Vite's pre-bundling (dev)
// and chunking (build) move; give it the worker file that Vite serves and emits instead.
setWorkerUrl(workerUrl);

// OpenFreeMap: OSM data, no API key (design D11). Points still render if the tiles fail.
const STYLE_URL =
  (import.meta.env.VITE_MAP_STYLE_URL as string | undefined) ??
  'https://tiles.openfreemap.org/styles/liberty';

const DEBOUNCE_MS = 300;
const SOURCE_ID = 'detections';
const LAYER_ID = 'detections';
const OWN_COLOR = '#d81b60';
const CAPTURE_COLOR = '#1e88e5';

type Status =
  | { state: 'loading' }
  | { state: 'ready'; count: number; truncated: boolean }
  | { state: 'error'; message: string };

/** Detections with a location as GeoJSON features; the popup reads their properties. */
function toFeatureCollection(detections: MapDetection[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: detections.flatMap((d) =>
      d.location
        ? [
            {
              type: 'Feature' as const,
              geometry: d.location,
              properties: {
                label: d.label,
                detector: d.detector.name,
                observedAt: d.observedAt,
                captureId: d.capture.id,
                locationSource: d.locationSource,
              },
            },
          ]
        : [],
    ),
  };
}

/** Popup body built from DOM nodes, never HTML strings: labels are user input. */
function popupContent(properties: Record<string, unknown>): HTMLElement {
  const text = (key: string) => {
    const value = properties[key];
    return typeof value === 'string' ? value : '';
  };
  const root = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = text('label');
  const meta = document.createElement('div');
  meta.textContent = `${text('detector')} · ${new Date(text('observedAt')).toLocaleString()}`;
  const source = document.createElement('div');
  source.className = 'muted';
  source.textContent =
    text('locationSource') === 'DETECTION' ? 'Own location' : "Capture's location";
  const link = document.createElement('a');
  link.href = `#/captures/${encodeURIComponent(text('captureId'))}`;
  link.textContent = 'Open capture';
  root.append(title, meta, source, link);
  return root;
}

export function MapPage() {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [range, setRange] = useState<TimeRange>({ preset: '30d', from: '', to: '' });
  const [status, setStatus] = useState<Status>({ state: 'loading' });
  const [moves, setMoves] = useState(0);
  // Only the validity of the range is derived here; preset bounds are resolved at fetch time.
  const rangeError = useMemo(() => {
    const observed = observedRange(range, new Date());
    return 'error' in observed ? observed.error : undefined;
  }, [range]);

  useEffect(() => {
    if (!container.current) {
      return;
    }
    const map = new MapLibreMap({
      container: container.current,
      style: STYLE_URL,
      center: [13.405, 52.52],
      zoom: 10,
    });
    mapRef.current = map;
    map.addControl(new NavigationControl(), 'top-right');
    map.on('load', () => {
      map.addSource(SOURCE_ID, { type: 'geojson', data: toFeatureCollection([]) });
      map.addLayer({
        id: LAYER_ID,
        type: 'circle',
        source: SOURCE_ID,
        paint: {
          'circle-radius': 6,
          'circle-color': [
            'match',
            ['get', 'locationSource'],
            'DETECTION',
            OWN_COLOR,
            CAPTURE_COLOR,
          ],
          'circle-stroke-width': 1,
          'circle-stroke-color': '#fff',
        },
      });
      setMapReady(true);
    });
    map.on('moveend', () => {
      setMoves((n) => n + 1);
    });
    map.on('click', LAYER_ID, (event: MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      if (feature?.geometry.type !== 'Point') {
        return;
      }
      new Popup()
        .setLngLat(feature.geometry.coordinates as [number, number])
        .setDOMContent(popupContent(feature.properties))
        .addTo(map);
    });
    map.on('mouseenter', LAYER_ID, () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', LAYER_ID, () => {
      map.getCanvas().style.cursor = '';
    });
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Refetch 300 ms after the map stops moving or the range changes; a newer fetch aborts the older.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || rangeError) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const observed = observedRange(range, new Date());
      if ('error' in observed) {
        return;
      }
      const b = map.getBounds();
      const bbox = normalizeBounds({
        west: b.getWest(),
        south: b.getSouth(),
        east: b.getEast(),
        north: b.getNorth(),
      });
      setStatus({ state: 'loading' });
      fetchMapDetections(bbox, observed, { signal: controller.signal }).then(
        ({ detections, truncated }) => {
          const points = toFeatureCollection(detections);
          void map.getSource<GeoJSONSource>(SOURCE_ID)?.setData(points);
          setStatus({ state: 'ready', count: points.features.length, truncated });
        },
        (error: unknown) => {
          if (!controller.signal.aborted) {
            setStatus({
              state: 'error',
              message: error instanceof Error ? error.message : String(error),
            });
          }
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [mapReady, moves, range, rangeError]);

  return (
    <section className="map-page">
      <div className="map-toolbar">
        <fieldset className="time-range">
          <legend>Observed</legend>
          {TIME_PRESETS.map((preset) => (
            <label key={preset.value}>
              <input
                type="radio"
                name="time-preset"
                value={preset.value}
                checked={range.preset === preset.value}
                onChange={() => {
                  setRange({ ...range, preset: preset.value });
                }}
              />
              {preset.label}
            </label>
          ))}
          {range.preset === 'custom' && (
            <>
              <label>
                From{' '}
                <input
                  type="datetime-local"
                  value={range.from}
                  onChange={(event) => {
                    setRange({ ...range, from: event.target.value });
                  }}
                />
              </label>
              <label>
                To{' '}
                <input
                  type="datetime-local"
                  value={range.to}
                  onChange={(event) => {
                    setRange({ ...range, to: event.target.value });
                  }}
                />
              </label>
            </>
          )}
        </fieldset>
        <div className="map-legend">
          <span className="dot" style={{ background: OWN_COLOR }} /> own location
          <span className="dot" style={{ background: CAPTURE_COLOR }} /> capture&apos;s location
        </div>
      </div>
      <p className="map-status" data-testid="map-status" role="status">
        {rangeError && <span className="error">{rangeError}</span>}
        {!rangeError && status.state === 'loading' && 'Loading…'}
        {!rangeError && status.state === 'error' && <span className="error">{status.message}</span>}
        {!rangeError &&
          status.state === 'ready' &&
          (status.truncated
            ? `Showing the first ${String(MAP_POINT_LIMIT)} detections; zoom in or narrow the time range to see the rest.`
            : `${String(status.count)} detections in view.`)}
      </p>
      <div ref={container} className="map" />
    </section>
  );
}
