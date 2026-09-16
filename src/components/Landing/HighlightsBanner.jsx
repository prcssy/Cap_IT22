import { FaCamera } from 'react-icons/fa';
import './LandingPage.css';

// HighlightsBanner: small navy badge with a camera icon and "HIGHLIGHTS" label,
// meant to sit just above the ImageCarousel.
// Props:
// - text: label to display (default "HIGHLIGHTS")
export default function HighlightsBanner({ text = 'HIGHLIGHTS' }) {
  return (
    <div className="highlights-banner">
      <span className="highlights-banner-icon">
        <FaCamera />
      </span>
      <span className="highlights-banner-text">{text}</span>
      <span className="highlights-banner-notch" aria-hidden="true" />
    </div>
  );
}