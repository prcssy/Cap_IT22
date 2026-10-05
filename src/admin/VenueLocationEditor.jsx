import { useRef, useState } from 'react';
import { FaMapMarkedAlt, FaUpload, FaTrash, FaTimes, FaSync, FaCamera } from 'react-icons/fa';
import { resizeImageToDataUrl } from '../shared/utils/resizeImage';
import { VenueMapView } from '../shared/components/VenueLocator/VenueLocator';
import { hasPin } from '../shared/utils/venueLocation';

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
// The campus map has a doc of its own (venuesConfig/campusMap, 1 MB cap):
// big enough to read building labels, small enough to load on a phone.
const MAP_OPTIONS = { maxWidth: 1600, maxHeight: 1600, mode: 'contain', format: 'jpeg', quality: 0.85, maxBytes: 600 * 1024 };
// Venue photos all share venuesConfig/global with the venue list, so keep each small.
const PHOTO_OPTIONS = { maxWidth: 640, maxHeight: 480, mode: 'contain', format: 'jpeg', quality: 0.8, maxBytes: 35 * 1024 };

function pickImage(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return null;
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file (JPG, PNG or WEBP).');
  if (file.size > MAX_SOURCE_BYTES) throw new Error('That image is over 10MB — choose a smaller one.');
  return file;
}

/* ── Campus map upload (one image for every venue's pin) ── */
export function CampusMapCard({ image, onSave }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const handleFile = async (e) => {
    setError('');
    try {
      const file = pickImage(e);
      if (!file) return;
      setBusy(true);
      await onSave(await resizeImageToDataUrl(file, MAP_OPTIONS));
    } catch (err) {
      console.error('Failed to save campus map:', err);
      setError(err.message || 'Could not upload the campus map — try again.');
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    setBusy(true);
    setError('');
    try {
      await onSave(null);
    } catch (err) {
      console.error('Failed to remove campus map:', err);
      setError('Could not remove the campus map — try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="msf-card vm-campus">
      <div className="vm-campus__text">
        <h2><FaMapMarkedAlt /> Campus map</h2>
        <p className="msf-muted">
          Upload a map or aerial photo of the campus, then use each venue&apos;s <b>Location</b> button to pin where it is.
          Students can tap a venue on any schedule to see it.
        </p>
        <div className="vm-campus__actions">
          <button type="button" className="msf-btn-primary" onClick={() => inputRef.current?.click()} disabled={busy}>
            {busy ? <FaSync className="vm-spin" /> : <FaUpload />} {image ? 'Replace map' : 'Upload map'}
          </button>
          {image && (
            <button type="button" className="msf-btn-ghost" onClick={handleRemove} disabled={busy}>
              <FaTrash /> Remove
            </button>
          )}
          <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={handleFile} />
        </div>
        {error && <p className="vm-error">{error}</p>}
      </div>
      {image && <img className="vm-campus__thumb" src={image} alt="Campus map" />}
    </div>
  );
}

/* ── One venue's location: map pin, photo, directions, Google Maps link ── */
export function VenueLocationEditor({ venue, mapImage, onClose, onSave }) {
  const [draft, setDraft] = useState({
    mapX: hasPin(venue) ? venue.mapX : null,
    mapY: hasPin(venue) ? venue.mapY : null,
    photo: venue.photo || null,
    directions: venue.directions || '',
    mapsUrl: venue.mapsUrl || '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const photoRef = useRef(null);

  const handlePhoto = async (e) => {
    setError('');
    try {
      const file = pickImage(e);
      if (!file) return;
      setBusy(true);
      const photo = await resizeImageToDataUrl(file, PHOTO_OPTIONS);
      setDraft((d) => ({ ...d, photo }));
    } catch (err) {
      setError(err.message || 'Could not use that photo — try another image.');
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async () => {
    const mapsUrl = draft.mapsUrl.trim();
    if (mapsUrl && !/^https:\/\/\S+$/i.test(mapsUrl)) {
      setError('The Google Maps link must start with https://');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSave({ ...draft, mapsUrl, directions: draft.directions.trim() });
    } catch (err) {
      console.error('Failed to save venue location:', err);
      setError('Could not save — check your connection and try again.');
      setBusy(false);
    }
  };

  const preview = { ...venue, ...draft };

  return (
    <div className="msf-overlay" onClick={() => !busy && onClose()}>
      <div className="vm-loc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="vm-loc-modal__head">
          <div>
            <span className="vm-loc-modal__eyebrow">Venue location</span>
            <h3>{venue.name}</h3>
          </div>
          <button type="button" className="vm-schedule-modal__close" onClick={onClose} disabled={busy} title="Close"><FaTimes /></button>
        </div>

        <div className="vm-loc-modal__body">
          <div className="msf-form-group">
            <label>Pin on the campus map</label>
            {mapImage ? (
              <>
                <p className="vm-hint">Click the spot on the map where {venue.name} is.</p>
                <VenueMapView
                  venue={{ ...preview, photo: null, directions: '', mapsUrl: '' }}
                  mapImage={mapImage}
                  onMapClick={(mapX, mapY) => setDraft((d) => ({ ...d, mapX, mapY }))}
                />
                {hasPin(draft) && (
                  <button type="button" className="vm-link-btn" onClick={() => setDraft((d) => ({ ...d, mapX: null, mapY: null }))}>
                    Remove pin
                  </button>
                )}
              </>
            ) : (
              <p className="vm-hint">Upload a campus map first (Campus map card above) to pin venues on it.</p>
            )}
          </div>

          <div className="msf-form-group">
            <label>Photo of the venue / entrance</label>
            <div className="vm-loc-photo">
              {draft.photo
                ? <img src={draft.photo} alt={venue.name} />
                : <span className="vm-loc-photo__empty"><FaCamera /></span>}
              <div className="vm-loc-photo__actions">
                <button type="button" className="msf-btn-ghost" onClick={() => photoRef.current?.click()} disabled={busy}>
                  {draft.photo ? 'Change photo' : 'Add photo'}
                </button>
                {draft.photo && (
                  <button type="button" className="vm-link-btn" onClick={() => setDraft((d) => ({ ...d, photo: null }))}>Remove</button>
                )}
              </div>
              <input ref={photoRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={handlePhoto} />
            </div>
          </div>

          <div className="msf-form-group">
            <label htmlFor="vm-directions">Directions</label>
            <textarea
              id="vm-directions"
              rows={2}
              maxLength={300}
              placeholder="e.g. Behind the main building, beside the canteen — 2nd floor"
              value={draft.directions}
              onChange={(e) => setDraft((d) => ({ ...d, directions: e.target.value }))}
            />
          </div>

          <div className="msf-form-group">
            <label htmlFor="vm-maps">Google Maps link (optional — useful for off-campus venues)</label>
            <input
              id="vm-maps"
              type="url"
              placeholder="https://maps.app.goo.gl/…"
              value={draft.mapsUrl}
              onChange={(e) => setDraft((d) => ({ ...d, mapsUrl: e.target.value }))}
            />
          </div>

          {error && <p className="vm-error">{error}</p>}

          <div className="msf-form-actions">
            <button type="button" className="msf-btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="button" className="msf-btn-primary" onClick={handleSave} disabled={busy}>
              {busy && <FaSync className="vm-spin" />} Save location
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
