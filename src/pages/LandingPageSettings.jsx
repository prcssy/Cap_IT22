import React, { useContext, useEffect, useRef, useState } from 'react';
import {
  FaUpload, FaTrash, FaTimes, FaPlus, FaSync, FaChevronDown, FaChevronUp,
  FaCalendarAlt, FaFileSignature, FaClipboardList, FaCheckCircle,
} from 'react-icons/fa';
import { BrandingContext } from '../components/BrandingContext';
import {
  subscribeLandingPageConfig,
  updateLandingPageConfig,
  DEFAULT_LANDING_PAGE,
} from '../services/firestoreService';
import { resizeImageToDataUrl } from '../utils/resizeImage';
import './LandingPageSettings.css';

// Source-file gate before resizing — generous, since the canvas resize
// below (not this raw size) determines what actually gets stored on the
// Firestore doc (which has a hard 1MB-per-document ceiling).
const MAX_IMAGE_SOURCE_BYTES = 8 * 1024 * 1024; // 8MB
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_GALLERY_IMAGES = 12;
const STEP_ICONS = [FaFileSignature, FaClipboardList, FaCheckCircle];

function friendlyError(err, fallback) {
  const isPermission = err?.code === 'permission-denied' || /permission/i.test(err?.message || '');
  if (isPermission) return `${fallback} — you don't have permission for this action.`;
  return err?.message || `${fallback} — check your connection and try again.`;
}

const uid = () => Math.random().toString(36).slice(2, 10);

function withIds(list) {
  return (list || []).map((item) => ({ _id: uid(), ...item }));
}
function stripIds(list) {
  return (list || []).map(({ title, description }) => ({ title, description }));
}

/* Collapsible section shell — one numbered card per CMS section, shared
   by all five below so the accordion look/feel (number badge, title,
   chevron, animated body) only needs to exist in one place. */
function AccordionSection({ index, title, subtitle, isOpen, onToggle, children }) {
  return (
    <div className={`sa-card lp-section ${isOpen ? 'lp-section--open' : ''}`}>
      <button type="button" className="lp-section__head" onClick={onToggle}>
        <span className="lp-section__badge">{index}</span>
        <span className="lp-section__headtext">
          <span className="lp-section__title">{title}</span>
          <span className="lp-section__subtitle">{subtitle}</span>
        </span>
        {isOpen ? <FaChevronUp /> : <FaChevronDown />}
      </button>
      {isOpen && <div className="lp-section__body">{children}</div>}
    </div>
  );
}

/**
 * Super Admin → Web Customization → Landing Page. One doc
 * (siteConfig/landingPage, via subscribeLandingPageConfig) is the single
 * source of truth for the public homepage's Hero Section, Feature Cards,
 * How to Join as a Player steps, Highlights Gallery, and Bottom Text
 * (CTA) section. Every field here mirrors what LandingPage.jsx actually
 * renders — nothing decorative that isn't wired to the public page.
 */
export default function LandingPageSettings({ actorEmail, actorRole }) {
  const branding = useContext(BrandingContext);
  const [content, setContent] = useState(DEFAULT_LANDING_PAGE);
  const [loading, setLoading] = useState(true);
  const seededRef = useRef(false);

  useEffect(() => {
    const unsubscribe = subscribeLandingPageConfig((data) => {
      setContent(data);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const [openSection, setOpenSection] = useState(1);
  const toggleSection = (i) => setOpenSection((prev) => (prev === i ? null : i));

  /* ── Drafts — one per section, seeded exactly once from the first real
     snapshot so a Firestore push (including this page's own Save) never
     clobbers in-progress edits. Same convention as BrandingSettings. ── */
  const [draftHero, setDraftHero] = useState(DEFAULT_LANDING_PAGE.hero);
  const [draftCards, setDraftCards] = useState(withIds(DEFAULT_LANDING_PAGE.featureCards));
  const [draftSteps, setDraftSteps] = useState(withIds(DEFAULT_LANDING_PAGE.howToJoin));
  const [draftGallery, setDraftGallery] = useState(DEFAULT_LANDING_PAGE.gallery);
  const [draftBottom, setDraftBottom] = useState(DEFAULT_LANDING_PAGE.bottomSection);

  useEffect(() => {
    if (seededRef.current || loading) return;
    seededRef.current = true;
    setDraftHero(content.hero);
    setDraftCards(withIds(content.featureCards));
    setDraftSteps(withIds(content.howToJoin));
    setDraftGallery(content.gallery);
    setDraftBottom(content.bottomSection);
  }, [loading, content]);

  /* ── Per-section busy/message state ── */
  const [heroBusy, setHeroBusy] = useState(false);
  const [heroMsg, setHeroMsg] = useState(null);
  const [heroImgBusy, setHeroImgBusy] = useState(false);
  const [cardsBusy, setCardsBusy] = useState(false);
  const [cardsMsg, setCardsMsg] = useState(null);
  const [stepsBusy, setStepsBusy] = useState(false);
  const [stepsMsg, setStepsMsg] = useState(null);
  const [galleryBusy, setGalleryBusy] = useState(false);
  const [galleryMsg, setGalleryMsg] = useState(null);
  const [galleryImgBusy, setGalleryImgBusy] = useState(false);
  const [bottomBusy, setBottomBusy] = useState(false);
  const [bottomMsg, setBottomMsg] = useState(null);
  const [saveAllBusy, setSaveAllBusy] = useState(false);
  const [saveAllMsg, setSaveAllMsg] = useState(null);

  const heroFileRef = useRef(null);
  const galleryFileRef = useRef(null);

  const validateImage = (file, setMsg) => {
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      setMsg({ tone: 'error', text: 'Please choose a PNG, JPEG, or WEBP image.' });
      return false;
    }
    if (file.size > MAX_IMAGE_SOURCE_BYTES) {
      setMsg({ tone: 'error', text: 'That image is larger than 8MB — please choose a smaller file.' });
      return false;
    }
    return true;
  };

  /* ── Hero Section ── */
  const handleHeroBgPick = () => heroFileRef.current?.click();
  const handleHeroBgChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!validateImage(file, setHeroMsg)) return;

    setHeroImgBusy(true);
    setHeroMsg(null);
    try {
      // Resized client-side to a base64 data URL and stored directly on
      // siteConfig/landingPage — same approach as the Sports & Teams logo
      // upload, no Firebase Storage required (which is what made this
      // silently fail before).
      const dataUrl = await resizeImageToDataUrl(file, {
        maxWidth: 1280, maxHeight: 720, mode: 'contain', format: 'jpeg', quality: 0.7,
      });
      setDraftHero((prev) => ({ ...prev, backgroundImageURL: dataUrl }));
      setHeroMsg({ tone: 'success', text: 'Background image ready — click Save to publish it.' });
    } catch (err) {
      console.error('Failed to process hero background:', err);
      setHeroMsg({ tone: 'error', text: friendlyError(err, 'Could not use this image') });
    } finally {
      setHeroImgBusy(false);
    }
  };
  const handleRemoveHeroBg = () => setDraftHero((prev) => ({ ...prev, backgroundImageURL: null }));

  const handleSaveHero = async () => {
    setHeroBusy(true);
    setHeroMsg(null);
    try {
      await updateLandingPageConfig({ hero: draftHero }, actorEmail, actorRole);
      setHeroMsg({ tone: 'success', text: 'Hero section saved.' });
    } catch (err) {
      console.error('Failed to save hero section:', err);
      setHeroMsg({ tone: 'error', text: friendlyError(err, 'Could not save these changes') });
    } finally {
      setHeroBusy(false);
    }
  };

  /* ── Feature Cards ── */
  const updateCard = (id, field, value) => {
    setDraftCards((prev) => prev.map((c) => (c._id === id ? { ...c, [field]: value } : c)));
  };
  const handleSaveCards = async () => {
    setCardsBusy(true);
    setCardsMsg(null);
    try {
      await updateLandingPageConfig({ featureCards: stripIds(draftCards) }, actorEmail, actorRole);
      setCardsMsg({ tone: 'success', text: 'Feature cards saved.' });
    } catch (err) {
      console.error('Failed to save feature cards:', err);
      setCardsMsg({ tone: 'error', text: friendlyError(err, 'Could not save these changes') });
    } finally {
      setCardsBusy(false);
    }
  };

  /* ── How to Join as Player ── */
  const updateStep = (id, field, value) => {
    setDraftSteps((prev) => prev.map((s) => (s._id === id ? { ...s, [field]: value } : s)));
  };
  const handleSaveSteps = async () => {
    setStepsBusy(true);
    setStepsMsg(null);
    try {
      await updateLandingPageConfig({ howToJoin: stripIds(draftSteps) }, actorEmail, actorRole);
      setStepsMsg({ tone: 'success', text: 'Steps saved.' });
    } catch (err) {
      console.error('Failed to save steps:', err);
      setStepsMsg({ tone: 'error', text: friendlyError(err, 'Could not save these changes') });
    } finally {
      setStepsBusy(false);
    }
  };

  /* ── Highlights Gallery ── */
  const handleGalleryPick = () => galleryFileRef.current?.click();
  const handleGalleryChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (draftGallery.images.length >= MAX_GALLERY_IMAGES) {
      setGalleryMsg({ tone: 'error', text: `You can only add up to ${MAX_GALLERY_IMAGES} images.` });
      return;
    }
    if (!validateImage(file, setGalleryMsg)) return;

    setGalleryImgBusy(true);
    setGalleryMsg(null);
    try {
      // Kept smaller than the hero image (500×500 max) since up to 12 of
      // these live in the same Firestore document, which has a hard 1MB
      // total-size ceiling — same base64-on-Firestore approach as the
      // logo/hero above, no Firebase Storage involved.
      const dataUrl = await resizeImageToDataUrl(file, {
        maxWidth: 500, maxHeight: 500, mode: 'contain', format: 'jpeg', quality: 0.6,
      });
      setDraftGallery((prev) => ({ ...prev, images: [...prev.images, dataUrl] }));
      setGalleryMsg({ tone: 'success', text: 'Image added — click Save to publish it.' });
    } catch (err) {
      console.error('Failed to process gallery image:', err);
      setGalleryMsg({ tone: 'error', text: friendlyError(err, 'Could not use this image') });
    } finally {
      setGalleryImgBusy(false);
    }
  };
  const removeGalleryImage = (url) => {
    setDraftGallery((prev) => ({ ...prev, images: prev.images.filter((img) => img !== url) }));
  };
  const handleSaveGallery = async () => {
    setGalleryBusy(true);
    setGalleryMsg(null);
    try {
      await updateLandingPageConfig({ gallery: draftGallery }, actorEmail, actorRole);
      setGalleryMsg({ tone: 'success', text: 'Highlights gallery saved.' });
    } catch (err) {
      console.error('Failed to save gallery:', err);
      setGalleryMsg({ tone: 'error', text: friendlyError(err, 'Could not save these changes') });
    } finally {
      setGalleryBusy(false);
    }
  };

  /* ── Bottom Text Section ── */
  const handleSaveBottom = async () => {
    setBottomBusy(true);
    setBottomMsg(null);
    try {
      await updateLandingPageConfig({ bottomSection: draftBottom }, actorEmail, actorRole);
      setBottomMsg({ tone: 'success', text: 'Bottom section saved.' });
    } catch (err) {
      console.error('Failed to save bottom section:', err);
      setBottomMsg({ tone: 'error', text: friendlyError(err, 'Could not save these changes') });
    } finally {
      setBottomBusy(false);
    }
  };

  /* ── Top-level Save Changes — persists every section's draft at once,
     as one write + one activity log entry. ── */
  const handleSaveAll = async () => {
    setSaveAllBusy(true);
    setSaveAllMsg(null);
    try {
      await updateLandingPageConfig({
        hero: draftHero,
        featureCards: stripIds(draftCards),
        howToJoin: stripIds(draftSteps),
        gallery: draftGallery,
        bottomSection: draftBottom,
      }, actorEmail, actorRole);
      setSaveAllMsg({ tone: 'success', text: 'All changes saved.' });
    } catch (err) {
      console.error('Failed to save landing page changes:', err);
      setSaveAllMsg({ tone: 'error', text: friendlyError(err, 'Could not save these changes') });
    } finally {
      setSaveAllBusy(false);
    }
  };

  const heroLines = (draftHero.subtitle || '').split('\n');

  return (
    <div className="ws-wrap">
      <div className="sa-panel__head">
        <div>
          <h2 className="sa-panel__title">LANDING PAGE</h2>
          <p className="sa-panel__sub">Customize the content of your public homepage.</p>
        </div>
        <div className="lp-headactions">
          {saveAllMsg && <p className={`ws-msg ws-msg--${saveAllMsg.tone}`}>{saveAllMsg.text}</p>}
          <button type="button" className="sa-export" onClick={handleSaveAll} disabled={saveAllBusy}>
            {saveAllBusy ? <FaSync className="sa-spin" /> : <FaPlus />} Save Changes
          </button>
        </div>
      </div>

      <div className="ws-grid lp-grid">
        <div className="ws-col">

          {/* ── 1. Hero Section ── */}
          <AccordionSection
            index={1}
            title="Hero Section"
            subtitle="Main banner content on homepage."
            isOpen={openSection === 1}
            onToggle={() => toggleSection(1)}
          >
            <label className="ws-field">
              <span className="ws-field__label">Hero Subtitle *</span>
              <textarea
                rows={4}
                value={draftHero.subtitle}
                onChange={(e) => setDraftHero((p) => ({ ...p, subtitle: e.target.value }))}
              />
              <span className="ws-card-hint">Shown under the tagline on the hero banner. One line per row.</span>
            </label>

            <div className="ws-field">
              <span className="ws-field__label">Background Image</span>
              <div className="lp-image-upload-row">
                <div className="lp-image-preview lp-image-preview--wide">
                  {draftHero.backgroundImageURL
                    ? <img src={draftHero.backgroundImageURL} alt="Hero background preview" />
                    : <span className="lp-image-preview__empty">No image set</span>}
                </div>
                <div className="ws-logo-actions">
                  <button type="button" className="sa-export" onClick={handleHeroBgPick} disabled={heroImgBusy}>
                    {heroImgBusy ? <FaSync className="sa-spin" /> : <FaUpload />} Upload Image
                  </button>
                  {draftHero.backgroundImageURL && (
                    <button type="button" className="ws-btn-ghost" onClick={handleRemoveHeroBg} disabled={heroImgBusy}>
                      <FaTrash /> Remove
                    </button>
                  )}
                  <input
                    ref={heroFileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    style={{ display: 'none' }}
                    onChange={handleHeroBgChange}
                  />
                  <span className="ws-card-hint">Any size or format works — it's resized automatically. Source file up to 8MB.</span>
                </div>
              </div>
            </div>

            <div className="ws-card-actions">
              {heroMsg && <p className={`ws-msg ws-msg--${heroMsg.tone}`}>{heroMsg.text}</p>}
              <button type="button" className="sa-export" onClick={handleSaveHero} disabled={heroBusy}>
                {heroBusy && <FaSync className="sa-spin" />} Save
              </button>
            </div>
          </AccordionSection>

          {/* ── 2. Feature Cards ── */}
          <AccordionSection
            index={2}
            title="Feature Cards"
            subtitle="Three feature cards below the hero section."
            isOpen={openSection === 2}
            onToggle={() => toggleSection(2)}
          >
            <div className="lp-cards-grid">
              {draftCards.map((card, i) => (
                <div className="lp-mini-card" key={card._id}>
                  <span className="ws-field__label">Card {i + 1}</span>
                  <input
                    type="text"
                    placeholder="Title"
                    value={card.title}
                    onChange={(e) => updateCard(card._id, 'title', e.target.value)}
                  />
                  <textarea
                    rows={4}
                    placeholder="Description"
                    value={card.description}
                    onChange={(e) => updateCard(card._id, 'description', e.target.value)}
                  />
                </div>
              ))}
            </div>
            <div className="ws-card-actions">
              {cardsMsg && <p className={`ws-msg ws-msg--${cardsMsg.tone}`}>{cardsMsg.text}</p>}
              <button type="button" className="sa-export" onClick={handleSaveCards} disabled={cardsBusy}>
                {cardsBusy && <FaSync className="sa-spin" />} Save
              </button>
            </div>
          </AccordionSection>

          {/* ── 3. How to Join as Player ── */}
          <AccordionSection
            index={3}
            title="How to Join as Player"
            subtitle="Three feature cards below the hero section."
            isOpen={openSection === 3}
            onToggle={() => toggleSection(3)}
          >
            <div className="lp-cards-grid">
              {draftSteps.map((step, i) => (
                <div className="lp-mini-card" key={step._id}>
                  <span className="ws-field__label">Step {i + 1}</span>
                  <input
                    type="text"
                    placeholder="Title"
                    value={step.title}
                    onChange={(e) => updateStep(step._id, 'title', e.target.value)}
                  />
                  <textarea
                    rows={3}
                    placeholder="Description"
                    value={step.description}
                    onChange={(e) => updateStep(step._id, 'description', e.target.value)}
                  />
                </div>
              ))}
            </div>
            <div className="ws-card-actions">
              {stepsMsg && <p className={`ws-msg ws-msg--${stepsMsg.tone}`}>{stepsMsg.text}</p>}
              <button type="button" className="sa-export" onClick={handleSaveSteps} disabled={stepsBusy}>
                {stepsBusy && <FaSync className="sa-spin" />} Save
              </button>
            </div>
          </AccordionSection>

          {/* ── 4. Highlights Gallery ── */}
          <AccordionSection
            index={4}
            title="Highlights Gallery"
            subtitle="Three feature cards below the hero section."
            isOpen={openSection === 4}
            onToggle={() => toggleSection(4)}
          >
            <label className="ws-field">
              <span className="ws-field__label">Title</span>
              <input
                type="text"
                value={draftGallery.title}
                onChange={(e) => setDraftGallery((p) => ({ ...p, title: e.target.value }))}
              />
            </label>

            <div className="ws-card-toprow">
              <span className="ws-card-hint">{draftGallery.images.length} / {MAX_GALLERY_IMAGES} images</span>
              <button
                type="button"
                className="sa-export sa-export--small"
                onClick={handleGalleryPick}
                disabled={galleryImgBusy || draftGallery.images.length >= MAX_GALLERY_IMAGES}
              >
                {galleryImgBusy ? <FaSync className="sa-spin" /> : <FaPlus />} Upload Image
              </button>
              <input
                ref={galleryFileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                style={{ display: 'none' }}
                onChange={handleGalleryChange}
              />
            </div>

            <div className="lp-gallery-grid">
              {draftGallery.images.map((url, i) => (
                <div className="lp-gallery-thumb" key={url}>
                  <img src={url} alt={`Gallery ${i + 1}`} />
                  <button type="button" className="lp-gallery-thumb__remove" onClick={() => removeGalleryImage(url)} title="Remove image">
                    <FaTimes />
                  </button>
                </div>
              ))}
            </div>

            <div className="ws-card-actions">
              {galleryMsg && <p className={`ws-msg ws-msg--${galleryMsg.tone}`}>{galleryMsg.text}</p>}
              <button type="button" className="sa-export" onClick={handleSaveGallery} disabled={galleryBusy}>
                {galleryBusy && <FaSync className="sa-spin" />} Save
              </button>
            </div>
          </AccordionSection>

          {/* ── 5. Bottom Text Section ── */}
          <AccordionSection
            index={5}
            title="Bottom Text Section"
            subtitle="Text information direct to log in."
            isOpen={openSection === 5}
            onToggle={() => toggleSection(5)}
          >
            <label className="ws-field">
              <span className="ws-field__label">Title</span>
              <input
                type="text"
                value={draftBottom.title}
                onChange={(e) => setDraftBottom((p) => ({ ...p, title: e.target.value }))}
              />
            </label>
            <label className="ws-field">
              <span className="ws-field__label">Description</span>
              <textarea
                rows={3}
                value={draftBottom.description}
                onChange={(e) => setDraftBottom((p) => ({ ...p, description: e.target.value }))}
              />
            </label>
            <label className="ws-field">
              <span className="ws-field__label">Button Text</span>
              <input
                type="text"
                value={draftBottom.buttonText}
                onChange={(e) => setDraftBottom((p) => ({ ...p, buttonText: e.target.value }))}
              />
            </label>

            <div className="ws-card-actions">
              {bottomMsg && <p className={`ws-msg ws-msg--${bottomMsg.tone}`}>{bottomMsg.text}</p>}
              <button type="button" className="sa-export" onClick={handleSaveBottom} disabled={bottomBusy}>
                {bottomBusy && <FaSync className="sa-spin" />} Save
              </button>
            </div>
          </AccordionSection>
        </div>

        {/* ── Live Preview — reflects every draft above instantly, before Save ── */}
        <div className="ws-col ws-col--preview">
          <div className="sa-card ws-preview-card lp-preview">
            <h3 className="ws-card-title">Preview</h3>

            <div
              className="lp-preview-hero"
              style={draftHero.backgroundImageURL ? {
                backgroundImage: `linear-gradient(to right, rgba(0,21,41,0.88), rgba(0,21,41,0.35)), url(${draftHero.backgroundImageURL})`,
              } : undefined}
            >
              <img src={branding.logo} alt="Logo preview" className="ws-preview-logo" />
              <span className="ws-preview-name">{branding.schoolName}</span>
              <span className="ws-preview-tagline">{branding.tagline}</span>
              {heroLines.map((line, i) => <span className="lp-preview-hero__line" key={i}>{line}</span>)}
            </div>

            <div className="lp-preview-cards">
              {draftCards.map((card) => (
                <div className="lp-preview-card" key={card._id}>
                  <strong>{card.title || 'Untitled'}</strong>
                  <p>{card.description}</p>
                </div>
              ))}
            </div>

            <div className="lp-preview-steps">
              {draftSteps.map((step, i) => {
                const Icon = STEP_ICONS[i] || FaCheckCircle;
                return (
                  <div className="lp-preview-step" key={step._id}>
                    <span className="lp-preview-step__icon"><Icon /></span>
                    <strong>{step.title || 'Untitled'}</strong>
                    <p>{step.description}</p>
                  </div>
                );
              })}
            </div>

            <div className="lp-preview-gallery">
              <span className="lp-preview-gallery__title">{draftGallery.title}</span>
              <div className="lp-preview-gallery__grid">
                {draftGallery.images.slice(0, 6).map((url) => (
                  <img src={url} alt="" key={url} />
                ))}
                {draftGallery.images.length === 0 && (
                  <span className="lp-image-preview__empty">No images yet</span>
                )}
              </div>
            </div>

            <div className="lp-preview-bottom">
              <span className="lp-preview-bottom__title">{draftBottom.title}</span>
              <p>{draftBottom.description}</p>
              <span className="lp-preview-bottom__btn"><FaCalendarAlt /> {draftBottom.buttonText}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
