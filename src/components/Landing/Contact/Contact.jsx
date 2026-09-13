import React, { useContext } from 'react';
import { FaMapMarkerAlt, FaPhoneAlt, FaEnvelope, FaFacebookF } from 'react-icons/fa';
import HeaderWithLines from '../HeaderWithLines';
import { BrandingContext } from '../../BrandingContext';

const DEFAULT_CONTACT_ITEMS = [
  {
    icon: FaMapMarkerAlt,
    text: "San Jose, Santa Rita Pampanga, Philippines",
    href: "https://www.google.com/maps/place/Santa+Rita+College/@14.9989285,120.6178094,18.6z/data=!4m14!1m7!3m6!1s0x339658b934844e19:0x7ba727f39f0709df!2sSanta+Rita+College+Of+Pampanga,Inc.+Annex-1!8m2!3d14.9763355!4d120.6370981!16s%2Fg%2F11h0mw9qvh!3m5!1s0x3396f5ffca98627b:0xd9691231b874272b!8m2!3d14.9993667!4d120.6182403!16s%2Fg%2F1q5bm6dg_?entry=ttu&g_ep=EgoyMDI2MDYxNi4wIKXMDSoASAFQAw%3D%3D",
  },
  {
    icon: FaPhoneAlt,
    text: "(045) 900 0557",
    href: "tel:+0459000557",
  },
  {
    icon: FaEnvelope,
    text: "src_educ_ph@yahoo.com",
    href: "mailto:src_educ_ph@yahoo.com",
  },
  {
    icon: FaFacebookF,
    text: "facebook.com/santaritacollege",
    href: "https://facebook.com/santaritacollege",
  },
];

export default function ContactFooter({ items = DEFAULT_CONTACT_ITEMS, contactFooterRef }) {
  const { copyrightText } = useContext(BrandingContext);
  return (
    <footer className="contact-footer" ref={contactFooterRef}>
      <HeaderWithLines text="CONTACT US" className="contact-footer-header" />
      <div className="contact-footer-row">
        {items.map((item, i) => {
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
              {i < items.length - 1 && (
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