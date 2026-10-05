import { useContext, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { FaMapMarkerAlt, FaPhoneAlt, FaEnvelope, FaFacebookF } from 'react-icons/fa';
import { BrandingContext } from '../../../shared/context/BrandingContext';
import './Contact.css';

// Icons/labels are fixed here; display text/link come live from
// BrandingContext's `contact` field (Super Admin → Web Customization →
// Branding → Contact Information) — the single source every page that
// renders this footer reads from, so an edit there reaches all of them.
const CONTACT_FIELDS = [
  { key: 'address', label: 'Address', icon: FaMapMarkerAlt },
  { key: 'phone', label: 'Phone', icon: FaPhoneAlt },
  { key: 'email', label: 'Email', icon: FaEnvelope },
  { key: 'facebook', label: 'Facebook', icon: FaFacebookF },
];

// "https://www.facebook.com/santaritacollege/" → "facebook.com/santaritacollege"
// — a full URL reads as clutter; the link itself is unchanged.
function displayText(key, text) {
  if (key !== 'facebook') return text;
  return text.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
}

/* Site footer shown at the bottom of the landing page and every logged-in
   page: the school's logo/name/tagline beside a plain Contact Us list
   (icon, small label, value — no boxes), on a dark band in the theme's
   colors, with the copyright bar underneath. Styles live in Contact.css
   with their own cf- class names, so page stylesheets can't restyle it. */
export default function ContactFooter({ items, contactFooterRef }) {
  const { copyrightText, contact, logo, schoolName, tagline } = useContext(BrandingContext);
  const resolvedItems = useMemo(() => (
    items || CONTACT_FIELDS
      .map(({ key, label, icon }) => ({
        key,
        label,
        icon,
        text: displayText(key, contact?.[key]?.text || ''),
        href: contact?.[key]?.href || '',
      }))
      .filter((item) => item.text)
  ), [items, contact]);

  return (
    <footer className="cf" ref={contactFooterRef}>
      <div className="cf__inner">
        <div className="cf__brand">
          {logo && <img className="cf__logo" src={logo} alt="" />}
          <div className="cf__brand-text">
            <span className="cf__school">{schoolName}</span>
            {tagline && <span className="cf__tagline">{tagline}</span>}
          </div>
        </div>

        <div className="cf__contact">
          <h2 className="cf__title">Contact Us</h2>
          <ul className="cf__list">
            {resolvedItems.map((item) => {
              const Icon = item.icon;
              const external = item.href.startsWith('http');
              const body = (
                <>
                  <span className="cf__icon"><Icon /></span>
                  <span className="cf__body">
                    {item.label && <span className="cf__label">{item.label}</span>}
                    <span className="cf__value">{item.text}</span>
                  </span>
                </>
              );
              return (
                <li key={item.key || item.text}>
                  {item.href ? (
                    <a
                      href={item.href}
                      className="cf__item cf__item--link"
                      target={external ? '_blank' : undefined}
                      rel={external ? 'noopener noreferrer' : undefined}
                    >
                      {body}
                    </a>
                  ) : (
                    <div className="cf__item">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <div className="cf__bottom">
        <p className="cf__copy">
          {copyrightText}
          {copyrightText && ' · '}
          <Link to="/privacy-policy" className="cf__copy-link">Privacy Policy</Link>
        </p>
      </div>
    </footer>
  );
}
