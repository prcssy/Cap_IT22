import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { FaMapMarkerAlt, FaTimes, FaExternalLinkAlt, FaDirections } from 'react-icons/fa';
import { getVenues, getCampusMap } from '../../services/firestoreService';
import { hasPin, hasLocation } from '../../utils/venueLocation';
import './VenueLocator.css';

/* ─────────────────────────────────────────────
   "Where is this venue?" for students — a venue name anywhere on the site
   (match cards, schedules) becomes a link that opens the venue's pin on
   the campus map, its photo, directions and/or a Google Maps link, as set
   by an admin in the Venues tab (see the venue location fields in
   firestoreService.js). A venue with none of that set stays plain text.
───────────────────────────────────────────── */

const norm = (v) => String(v || '').trim().toLowerCase();

// One shared read of the venue list (and the campus map image, fetched only
// when someone actually opens a venue) for every link on the page, refreshed
// at most once a minute.
const CACHE_MS = 60 * 1000;
let venuesCache = { at: 0, promise: null };
let mapCache = { at: 0, promise: null };

function loadVenues() {
  if (!venuesCache.promise || Date.now() - venuesCache.at > CACHE_MS) {
    venuesCache = { at: Date.now(), promise: getVenues().catch(() => []) };
  }
  return venuesCache.promise;
}

function loadCampusMap() {
  if (!mapCache.promise || Date.now() - mapCache.at > CACHE_MS) {
    mapCache = { at: Date.now(), promise: getCampusMap().catch(() => null) };
  }
  return mapCache.promise;
}

/** Campus map with the venue's pin, plus photo / directions / Maps link. */
export function VenueMapView({ venue, mapImage, onMapClick }) {
  const pinned = hasPin(venue);
  return (
    <div className="vl-view">
      {mapImage && (pinned || onMapClick) && (
        <div
          className={`vl-map${onMapClick ? ' vl-map--editable' : ''}`}
          onClick={onMapClick ? (e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const x = ((e.clientX - rect.left) / rect.width) * 100;
            const y = ((e.clientY - rect.top) / rect.height) * 100;
            onMapClick(Math.round(x * 10) / 10, Math.round(y * 10) / 10);
          } : undefined}
        >
          <img src={mapImage} alt="Campus map" draggable={false} />
          {pinned && (
            <span className="vl-pin" style={{ left: `${venue.mapX}%`, top: `${venue.mapY}%` }}>
              <FaMapMarkerAlt />
              <span className="vl-pin__label">{venue.name}</span>
            </span>
          )}
        </div>
      )}
      {(venue.photo || (venue.directions || '').trim()) && (
        <div className="vl-details">
          {venue.photo && <img className="vl-photo" src={venue.photo} alt={venue.name} />}
          {(venue.directions || '').trim() && (
            <p className="vl-directions"><FaDirections /> <span>{venue.directions}</span></p>
          )}
        </div>
      )}
      {venue.mapsUrl && (
        <a className="vl-maps-link" href={venue.mapsUrl} target="_blank" rel="noopener noreferrer">
          <FaExternalLinkAlt /> Open in Google Maps
        </a>
      )}
    </div>
  );
}

function VenueModal({ venue, onClose }) {
  const [mapImage, setMapImage] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (hasPin(venue)) loadCampusMap().then((img) => { if (!cancelled) setMapImage(img); });
    return () => { cancelled = true; };
  }, [venue]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="vl-overlay" onClick={onClose}>
      <div className="vl-modal" role="dialog" aria-modal="true" aria-label={`Where is ${venue.name}`} onClick={(e) => e.stopPropagation()}>
        <div className="vl-modal__head">
          <span className="vl-modal__icon"><FaMapMarkerAlt /></span>
          <div>
            <span className="vl-modal__eyebrow">Where is it?</span>
            <h3>{venue.name}</h3>
          </div>
          <button type="button" className="vl-modal__close" onClick={onClose} aria-label="Close"><FaTimes /></button>
        </div>
        <div className="vl-modal__body">
          {hasPin(venue) && !mapImage ? <p className="vl-loading">Loading campus map…</p> : null}
          <VenueMapView venue={venue} mapImage={mapImage} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * A venue name that opens its location when the admin has set one.
 * `name` is matched to the Venues list case-insensitively (some cards show
 * it upper-cased); `children` is what's shown (defaults to `name`).
 */
export default function VenueLink({ name, children, className = '' }) {
  const [venue, setVenue] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!norm(name) || norm(name) === 'tba') return undefined;
    loadVenues().then((list) => {
      if (!cancelled) setVenue(list.find((v) => norm(v.name) === norm(name)) || null);
    });
    return () => { cancelled = true; };
  }, [name]);

  const label = children ?? name;
  if (!hasLocation(venue)) return <>{label}</>;

  return (
    <>
      <button
        type="button"
        className={`vl-link ${className}`}
        title={`Where is ${venue.name}?`}
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); setOpen(true); }}
      >
        <FaMapMarkerAlt className="vl-link__icon" />
        <span>{label}</span>
      </button>
      {open && <VenueModal venue={venue} onClose={() => setOpen(false)} />}
    </>
  );
}
