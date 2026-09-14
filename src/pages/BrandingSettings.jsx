import React, { useContext, useEffect, useRef, useState } from 'react';
import {
  FaUpload, FaTrash, FaArrowUp, FaArrowDown, FaPlus, FaSync,
} from 'react-icons/fa';
import { BrandingContext } from '../components/BrandingContext';
import { updateBrandingInfo, saveSchoolEvents, uploadBrandingLogo } from '../services/firestoreService';
import './BrandingSettings.css';

const MAX_LOGO_BYTES = 1 * 1024 * 1024; // 1MB, matches the storage.rules limit
const ALLOWED_LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

function friendlyBrandingError(err, fallback) {
  const isPermission = err?.code === 'permission-denied' || /permission/i.test(err?.message || '');
  if (isPermission) return `${fallback} — you don't have permission for this action.`;
  return err?.message || `${fallback} — check your connection and try again.`;
}

function slugify(label, existingKeys) {
  const base = String(label || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'event';
  let key = base;
  let n = 2;
  while (existingKeys.has(key)) { key = `${base}-${n}`; n += 1; }
  existingKeys.add(key);
  return key;
}

const uid = () => Math.random().toString(36).slice(2, 10);

/**
 * Super Admin → Web Customization → Branding. One doc (siteConfig/branding,
 * via BrandingContext) is the single source of truth for the school name,
 * tagline, motto, copyright text, logo, and the real school events list
 * (the same categories RegistrationPage's dropdown and AdminSchedulePage's
 * filters use) — nothing here is a separate/duplicate content system.
 */
export default function BrandingSettings({ actorEmail, actorRole }) {
  const branding = useContext(BrandingContext);
  const seededRef = useRef(false);

  const [draftInfo, setDraftInfo] = useState({
    schoolName: branding.schoolName,
    tagline: branding.tagline,
    motto: branding.motto,
    copyrightText: branding.copyrightText,
  });
  const [draftEvents, setDraftEvents] = useState(
    branding.events.map((e) => ({ _id: uid(), key: e.key, label: e.label })),
  );
  const [draftContact, setDraftContact] = useState(branding.contact);

  // Seed the draft exactly once, the first time real data arrives —
  // never again afterward, so a Firestore push (including the one this
  // page's own Save just triggered) can't clobber in-progress edits.
  useEffect(() => {
    if (seededRef.current || branding.loading) return;
    seededRef.current = true;
    setDraftInfo({
      schoolName: branding.schoolName,
      tagline: branding.tagline,
      motto: branding.motto,
      copyrightText: branding.copyrightText,
    });
    setDraftEvents(branding.events.map((e) => ({ _id: uid(), key: e.key, label: e.label })));
    setDraftContact(branding.contact);
  }, [branding.loading, branding.schoolName, branding.tagline, branding.motto, branding.copyrightText, branding.events, branding.contact]);

  /* ── Logo ── */
  const fileInputRef = useRef(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoMsg, setLogoMsg] = useState(null); // { tone, text }

  const handleLogoPick = () => fileInputRef.current?.click();

  const handleLogoChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow picking the same file again later
    if (!file) return;

    if (!ALLOWED_LOGO_TYPES.includes(file.type)) {
      setLogoMsg({ tone: 'error', text: 'Please choose a PNG, JPEG, or WEBP image.' });
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setLogoMsg({ tone: 'error', text: 'That image is larger than 1MB — please choose a smaller file.' });
      return;
    }

    setLogoBusy(true);
    setLogoMsg(null);
    try {
      const url = await uploadBrandingLogo(file);
      if (!url) {
        setLogoMsg({ tone: 'error', text: 'Upload failed — Cloud Storage may not be set up for this project yet.' });
        return;
      }
      await updateBrandingInfo({ logoURL: url }, actorEmail, actorRole);
      setLogoMsg({ tone: 'success', text: 'Logo updated.' });
    } catch (err) {
      console.error('Failed to upload logo:', err);
      setLogoMsg({ tone: 'error', text: friendlyBrandingError(err, 'Could not update the logo') });
    } finally {
      setLogoBusy(false);
    }
  };

  const handleRemoveLogo = async () => {
    setLogoBusy(true);
    setLogoMsg(null);
    try {
      await updateBrandingInfo({ logoURL: null }, actorEmail, actorRole);
      setLogoMsg({ tone: 'success', text: 'Logo removed — back to the default.' });
    } catch (err) {
      console.error('Failed to remove logo:', err);
      setLogoMsg({ tone: 'error', text: friendlyBrandingError(err, 'Could not remove the logo') });
    } finally {
      setLogoBusy(false);
    }
  };

  /* ── School Information ── */
  const [infoBusy, setInfoBusy] = useState(false);
  const [infoMsg, setInfoMsg] = useState(null);

  const handleSaveInfo = async () => {
    setInfoBusy(true);
    setInfoMsg(null);
    try {
      await updateBrandingInfo({
        schoolName: draftInfo.schoolName.trim() || branding.schoolName,
        tagline: draftInfo.tagline.trim(),
        motto: draftInfo.motto.trim(),
        copyrightText: draftInfo.copyrightText.trim(),
      }, actorEmail, actorRole);
      setInfoMsg({ tone: 'success', text: 'School information saved.' });
    } catch (err) {
      console.error('Failed to save school information:', err);
      setInfoMsg({ tone: 'error', text: friendlyBrandingError(err, 'Could not save these changes') });
    } finally {
      setInfoBusy(false);
    }
  };

  /* ── School Events ── */
  const [eventsBusy, setEventsBusy] = useState(false);
  const [eventsMsg, setEventsMsg] = useState(null);

  const moveEvent = (index, dir) => {
    setDraftEvents((prev) => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };
  const updateEventLabel = (id, label) => {
    setDraftEvents((prev) => prev.map((ev) => (ev._id === id ? { ...ev, label } : ev)));
  };
  const removeEvent = (id) => {
    setDraftEvents((prev) => prev.filter((ev) => ev._id !== id));
  };
  const addEvent = () => {
    setDraftEvents((prev) => [...prev, { _id: uid(), key: '', label: '' }]);
  };

  const handleSaveEvents = async () => {
    const labeled = draftEvents.filter((ev) => ev.label.trim());
    if (labeled.length === 0) {
      setEventsMsg({ tone: 'error', text: 'Add at least one event before saving.' });
      return;
    }
    // Existing keys are never changed by a label edit — only a brand-new
    // row (no key yet) gets one generated, since RegistrationPage /
    // AdminSchedulePage / existing registrations all reference the KEY,
    // not the label.
    const existingKeys = new Set(labeled.filter((ev) => ev.key).map((ev) => ev.key));
    const cleaned = labeled.map((ev) => ({
      key: ev.key || slugify(ev.label, existingKeys),
      label: ev.label.trim(),
    }));

    setEventsBusy(true);
    setEventsMsg(null);
    try {
      await saveSchoolEvents(cleaned, actorEmail, actorRole);
      setDraftEvents(cleaned.map((ev) => ({ _id: uid(), ...ev })));
      setEventsMsg({ tone: 'success', text: 'School events saved.' });
    } catch (err) {
      console.error('Failed to save school events:', err);
      setEventsMsg({ tone: 'error', text: friendlyBrandingError(err, 'Could not save these events') });
    } finally {
      setEventsBusy(false);
    }
  };

  /* ── Contact Information (public landing page footer) ── */
  const [contactBusy, setContactBusy] = useState(false);
  const [contactMsg, setContactMsg] = useState(null);

  const updateContactField = (key, field, value) => {
    setDraftContact((prev) => ({ ...prev, [key]: { ...prev[key], [field]: value } }));
  };

  const handleSaveContact = async () => {
    setContactBusy(true);
    setContactMsg(null);
    try {
      await updateBrandingInfo({ contact: draftContact }, actorEmail, actorRole);
      setContactMsg({ tone: 'success', text: 'Contact information saved.' });
    } catch (err) {
      console.error('Failed to save contact information:', err);
      setContactMsg({ tone: 'error', text: friendlyBrandingError(err, 'Could not save these changes') });
    } finally {
      setContactBusy(false);
    }
  };

  return (
    <div className="ws-wrap">
      <div className="sa-panel__head">
        <div>
          <h2 className="sa-panel__title">SCHOOL</h2>
          <p className="sa-panel__sub">Customize your system's school identity.</p>
        </div>
      </div>

      <div className="ws-grid">
        <div className="ws-col">

          {/* ── Logo ── */}
          <div className="sa-card">
            <h3 className="ws-card-title">Logo</h3>
            <p className="ws-card-hint">This logo will appear on the favicon, header, footer, and login page.</p>

            <div className="ws-logo-row">
              <div className="ws-logo-box">
                <img src={branding.logo} alt="Current logo" />
              </div>
              <div className="ws-logo-actions">
                <button type="button" className="sa-export" onClick={handleLogoPick} disabled={logoBusy}>
                  {logoBusy ? <FaSync className="sa-spin" /> : <FaUpload />}
                  {branding.logoURL ? 'Change Logo' : 'Upload Logo'}
                </button>
                {branding.logoURL && (
                  <button type="button" className="ws-btn-ghost" onClick={handleRemoveLogo} disabled={logoBusy}>
                    <FaTrash /> Remove
                  </button>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  style={{ display: 'none' }}
                  onChange={handleLogoChange}
                />
                <span className="ws-card-hint">Recommended size 300 × 300px (PNG, JPEG). Max file size: 1MB.</span>
              </div>
            </div>
            {logoMsg && <p className={`ws-msg ws-msg--${logoMsg.tone}`}>{logoMsg.text}</p>}
          </div>

          {/* ── School Information ── */}
          <div className="sa-card">
            <h3 className="ws-card-title">School Information</h3>

            <label className="ws-field">
              <span className="ws-field__label">Website Name *</span>
              <input
                type="text"
                value={draftInfo.schoolName}
                onChange={(e) => setDraftInfo((p) => ({ ...p, schoolName: e.target.value }))}
              />
              <span className="ws-card-hint">This will appear in the header, footer, and login page.</span>
            </label>

            <label className="ws-field">
              <span className="ws-field__label">Tagline *</span>
              <input
                type="text"
                value={draftInfo.tagline}
                onChange={(e) => setDraftInfo((p) => ({ ...p, tagline: e.target.value }))}
              />
              <span className="ws-card-hint">This will appear in the landing page.</span>
            </label>

            <label className="ws-field">
              <span className="ws-field__label">Motto *</span>
              <input
                type="text"
                value={draftInfo.motto}
                onChange={(e) => setDraftInfo((p) => ({ ...p, motto: e.target.value }))}
              />
              <span className="ws-card-hint">This will appear in the landing page.</span>
            </label>

            <label className="ws-field">
              <span className="ws-field__label">Copyright Text *</span>
              <input
                type="text"
                value={draftInfo.copyrightText}
                onChange={(e) => setDraftInfo((p) => ({ ...p, copyrightText: e.target.value }))}
              />
              <span className="ws-card-hint">This will appear in the landing page and footer.</span>
            </label>

            <div className="ws-card-actions">
              {infoMsg && <p className={`ws-msg ws-msg--${infoMsg.tone}`}>{infoMsg.text}</p>}
              <button type="button" className="sa-export" onClick={handleSaveInfo} disabled={infoBusy}>
                {infoBusy && <FaSync className="sa-spin" />} Save Changes
              </button>
            </div>
          </div>

          {/* ── School Events ── */}
          <div className="sa-card">
            <div className="ws-card-toprow">
              <h3 className="ws-card-title">School Events</h3>
              <button type="button" className="sa-icon-btn" onClick={addEvent} title="Add event">
                <FaPlus />
              </button>
            </div>

            <div className="ws-events-list">
              {draftEvents.map((ev, i) => (
                <div className="ws-event-row" key={ev._id}>
                  <span className="ws-event-row__num">{i + 1}</span>
                  <input
                    type="text"
                    value={ev.label}
                    placeholder="Enter Event"
                    onChange={(e) => updateEventLabel(ev._id, e.target.value)}
                  />
                  <button type="button" className="sa-icon-btn" disabled={i === 0} onClick={() => moveEvent(i, -1)} title="Move up">
                    <FaArrowUp />
                  </button>
                  <button type="button" className="sa-icon-btn" disabled={i === draftEvents.length - 1} onClick={() => moveEvent(i, 1)} title="Move down">
                    <FaArrowDown />
                  </button>
                  <button type="button" className="sa-icon-btn ws-icon-btn--danger" onClick={() => removeEvent(ev._id)} title="Remove event">
                    <FaTrash />
                  </button>
                </div>
              ))}
            </div>

            <div className="ws-card-actions">
              {eventsMsg && <p className={`ws-msg ws-msg--${eventsMsg.tone}`}>{eventsMsg.text}</p>}
              <button type="button" className="sa-export" onClick={handleSaveEvents} disabled={eventsBusy}>
                {eventsBusy && <FaSync className="sa-spin" />} Save Changes
              </button>
            </div>
          </div>

          {/* ── Contact Information ── */}
          <div className="sa-card">
            <h3 className="ws-card-title">Contact Information</h3>
            <p className="ws-card-hint">Shown in the "Contact Us" strip at the bottom of the public landing page.</p>

            <div className="ws-contact-grid">
              <div className="ws-contact-group">
                <span className="ws-field__label">Address</span>
                <input
                  type="text"
                  placeholder="Display text"
                  value={draftContact.address.text}
                  onChange={(e) => updateContactField('address', 'text', e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Map link (URL)"
                  value={draftContact.address.href}
                  onChange={(e) => updateContactField('address', 'href', e.target.value)}
                />
              </div>

              <div className="ws-contact-group">
                <span className="ws-field__label">Phone</span>
                <input
                  type="text"
                  placeholder="Display text"
                  value={draftContact.phone.text}
                  onChange={(e) => updateContactField('phone', 'text', e.target.value)}
                />
                <input
                  type="text"
                  placeholder="tel: link"
                  value={draftContact.phone.href}
                  onChange={(e) => updateContactField('phone', 'href', e.target.value)}
                />
              </div>

              <div className="ws-contact-group">
                <span className="ws-field__label">Email</span>
                <input
                  type="text"
                  placeholder="Display text"
                  value={draftContact.email.text}
                  onChange={(e) => updateContactField('email', 'text', e.target.value)}
                />
                <input
                  type="text"
                  placeholder="mailto: link"
                  value={draftContact.email.href}
                  onChange={(e) => updateContactField('email', 'href', e.target.value)}
                />
              </div>

              <div className="ws-contact-group">
                <span className="ws-field__label">Facebook</span>
                <input
                  type="text"
                  placeholder="Display text"
                  value={draftContact.facebook.text}
                  onChange={(e) => updateContactField('facebook', 'text', e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Profile/page link (URL)"
                  value={draftContact.facebook.href}
                  onChange={(e) => updateContactField('facebook', 'href', e.target.value)}
                />
              </div>
            </div>

            <div className="ws-card-actions">
              {contactMsg && <p className={`ws-msg ws-msg--${contactMsg.tone}`}>{contactMsg.text}</p>}
              <button type="button" className="sa-export" onClick={handleSaveContact} disabled={contactBusy}>
                {contactBusy && <FaSync className="sa-spin" />} Save Changes
              </button>
            </div>
          </div>
        </div>

        {/* ── Preview ── */}
        <div className="ws-col ws-col--preview">
          <div className="sa-card ws-preview-card">
            <h3 className="ws-card-title">Preview</h3>
            <div className="ws-preview-hero">
              <img src={branding.logo} alt="Logo preview" className="ws-preview-logo" />
              <span className="ws-preview-name">{draftInfo.schoolName}</span>
              <span className="ws-preview-tagline">{draftInfo.tagline}</span>
              <span className="ws-preview-motto">{draftInfo.motto}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
