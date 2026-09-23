import { useCallback, useEffect, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, useMapEvents, useMap } from 'react-leaflet';
import { Crosshair, Loader2, MapPin, Search } from 'lucide-react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { api } from '../api/client';

// Leaflet's default marker icons are referenced by relative URL, which breaks
// under any bundler - the classic "my map has no marker" problem. Pointing the
// icon URLs at the bundled assets fixes it.
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

const DEFAULT_CENTER = [12.9716, 77.5946]; // Bengaluru

// Clicking the map moves the pin. Has to be a child component because
// useMapEvents only works inside MapContainer's context.
function ClickHandler({ onPick }) {
  useMapEvents({
    click: (e) => onPick(e.latlng.lat, e.latlng.lng),
  });
  return null;
}

// Recentres the map when the coordinates change from outside (an address
// search), without fighting the user while they pan around.
function Recenter({ position }) {
  const map = useMap();
  useEffect(() => {
    if (position) map.setView(position, Math.max(map.getZoom(), 15));
  }, [position, map]);
  return null;
}

/**
 * Pickup location picker.
 *
 * Three ways to set a location, because no single one always works:
 *   1. type an address      -> forward geocode
 *   2. click or drag the pin -> reverse geocode
 *   3. use my current location -> browser geolocation, then reverse geocode
 *
 * Whatever the route, the parent receives { lat, lng, address }. Sending exact
 * coordinates with the donation matters: donation-service will otherwise have
 * to geocode the address itself, and a typed address is far less precise than a
 * pin the donor placed on their own gate.
 */
export default function LocationPicker({ value, onChange }) {
  const [address, setAddress] = useState(value?.address ?? '');
  const [position, setPosition] = useState(
    value?.lat != null ? [value.lat, value.lng] : null,
  );
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState(null);

  // Guards against a slow earlier lookup landing after a newer one and
  // overwriting the more recent answer.
  const requestId = useRef(0);

  const commit = useCallback(
    (lat, lng, resolvedAddress, extra = null) => {
      setPosition([lat, lng]);
      setAddress(resolvedAddress);
      setMeta(extra);
      onChange({ lat, lng, address: resolvedAddress });
    },
    [onChange],
  );

  async function searchAddress(e) {
    e?.preventDefault();
    if (address.trim().length < 3) return;

    const id = ++requestId.current;
    setBusy(true);
    setStatus(null);

    try {
      const res = await api.geocode(address);
      if (id !== requestId.current) return; // a newer search has since started

      commit(res.lat, res.lng, res.formatted, {
        confidence: res.confidence,
        cached: res.cached,
        provider: res.provider,
      });
      setStatus(
        res.cached
          ? 'Found (served from cache — no API call made)'
          : 'Found',
      );
    } catch (err) {
      if (id !== requestId.current) return;
      setStatus(
        err.status === 404
          ? 'No match for that address. Try adding the area or city, or drop the pin on the map.'
          : `Lookup failed: ${err.message}`,
      );
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  }

  // Pin moved: ask what address is there. The lookup is best-effort - the
  // coordinates are already correct and are what actually matter, so a failed
  // reverse lookup must not discard them.
  const handlePick = useCallback(
    async (lat, lng) => {
      const id = ++requestId.current;
      setPosition([lat, lng]);
      setBusy(true);
      setStatus(null);

      try {
        const res = await api.reverse(lat, lng);
        if (id !== requestId.current) return;
        commit(lat, lng, res.formatted, {
          confidence: res.confidence,
          cached: res.cached,
          provider: res.provider,
        });
        setStatus(res.cached ? 'Address resolved (from cache)' : 'Address resolved');
      } catch {
        if (id !== requestId.current) return;
        const fallback = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
        commit(lat, lng, address || fallback);
        setStatus('Could not name that spot, but the coordinates are set.');
      } finally {
        if (id === requestId.current) setBusy(false);
      }
    },
    [address, commit],
  );

  function useMyLocation() {
    if (!navigator.geolocation) {
      setStatus('This browser does not support geolocation.');
      return;
    }
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => handlePick(pos.coords.latitude, pos.coords.longitude),
      () => {
        setBusy(false);
        setStatus('Location permission denied. Search for the address instead.');
      },
      { enableHighAccuracy: true, timeout: 8000 },
    );
  }

  const precise = meta?.confidence != null && meta.confidence >= 7;

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-ink-400"
            aria-hidden="true"
          />
          <input
            type="text"
            value={address}
            aria-label="Pickup address"
            placeholder="Pickup address, e.g. 12 MG Road, Bengaluru"
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              // A nested <form> is invalid inside the donation form, so Enter
              // is wired up by hand rather than by form submission.
              if (e.key === 'Enter') {
                e.preventDefault();
                searchAddress();
              }
            }}
            className="w-full rounded-xl border border-cream-300 bg-white py-2.5 pl-10 pr-4 text-sm transition-colors placeholder:text-ink-400 focus:border-leaf-500"
          />
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={searchAddress}
            disabled={busy || address.trim().length < 3}
            className="inline-flex items-center gap-1.5 rounded-xl bg-leaf-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-leaf-700 disabled:bg-leaf-300"
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            Find
          </button>
          <button
            type="button"
            onClick={useMyLocation}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-xl border border-leaf-300 bg-white px-4 py-2.5 text-sm font-semibold text-leaf-700 transition-colors hover:bg-leaf-50 disabled:text-leaf-300"
          >
            <Crosshair className="size-4" aria-hidden="true" />
            Use my location
          </button>
        </div>
      </div>

      <p className="text-xs text-ink-400">
        Click the map or drag the pin to set the exact pickup point.
      </p>

      <div className="overflow-hidden rounded-xl2 border border-cream-200">
        <MapContainer
          center={position ?? DEFAULT_CENTER}
          zoom={13}
          className="h-72 w-full sm:h-80"
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <ClickHandler onPick={handlePick} />
          <Recenter position={position} />
          {position && (
            <Marker
              position={position}
              draggable
              eventHandlers={{
                dragend: (e) => {
                  const { lat, lng } = e.target.getLatLng();
                  handlePick(lat, lng);
                },
              }}
            />
          )}
        </MapContainer>
      </div>

      {status && <p className="text-xs text-ink-500">{status}</p>}

      {position && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-leaf-50 px-4 py-3 text-xs">
          <MapPin className="size-4 text-leaf-600" aria-hidden="true" />
          <span className="font-semibold text-ink-700">Selected:</span>
          <span className="font-mono text-ink-600">
            {position[0].toFixed(5)}, {position[1].toFixed(5)}
          </span>

          {/* Surfaced because a vague address resolves to the middle of a long
              road, and an agent sent to the wrong end wastes a trip on food
              that may not keep. */}
          {meta?.confidence != null && (
            <span
              className={`font-semibold ${precise ? 'text-leaf-700' : 'text-warm-700'}`}
            >
              · {precise ? 'precise match' : 'rough match, please check the pin'}
            </span>
          )}
          {meta?.cached && <span className="text-ink-400">· cached</span>}
        </div>
      )}
    </div>
  );
}
