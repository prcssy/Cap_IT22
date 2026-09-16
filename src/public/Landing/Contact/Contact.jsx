import React, { useContext, useMemo } from 'react';
import { FaMapMarkerAlt, FaPhoneAlt, FaEnvelope, FaFacebookF } from 'react-icons/fa';
import HeaderWithLines from '../HeaderWithLines';
import { BrandingContext } from '../../../shared/context/BrandingContext';

// Icons are fixed here; display text/link come live from BrandingContext's
// `contact` field (Super Admin → Web Customization → Branding → Contact
// Information) — the single source every page that renders this footer
// reads from, so an edit there reaches all of them at once.
const CONTACT_ICONS = {
  address: FaMapMarkerAlt,
  phone: FaPhoneAlt,
  email: FaEnvelope,
  facebook: FaFacebookF,
};

export default function ContactFooter({ items, contactFooterRef }) {
  const { copyrightText, contact } = useContext(BrandingContext);
  const resolvedItems = useMemo(() => (
    items || Object.keys(CONTACT_ICONS)
      .map((key) => ({
        icon: CONTACT_ICONS[key],
        text: contact?.[key]?.text || '',
        href: contact?.[key]?.href || '',
      }))
      .filter((item) => item.text)
  ), [items, contact]);

  return (
    <footer className="contact-footer" ref={contactFooterRef}>
      <HeaderWithLines text="CONTACT US" className="contact-footer-header" />
      <div className="contact-footer-row">
        {resolvedItems.map((item, i) => {
          const content = (
            <>
              <span className="contact-icon-circle">
                <item.icon />
              </span>
              <span className="contact-text">{item.text}</span>
            </>
          );
          return (
            <React.Fragment key={item.text}>
              {item.href ? (
                <a
                  href={item.href}
                  className="contact-item contact-item-link"
                  target={item.href.startsWith("http") ? "_blank" : undefined}
                  rel={item.href.startsWith("http") ? "noopener noreferrer" : undefined}
                >
                  {content}
                </a>
              ) : (
                <span className="contact-item">{content}</span>
              )}
              {i < resolvedItems.length - 1 && (
                <span className="contact-divider" />
              )}
            </React.Fragment>
          );
        })}
      </div>
      {copyrightText && <p className="contact-copyright">{copyrightText}</p>}
    </footer>
  );
}