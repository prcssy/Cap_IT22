import './LandingPage.css';

export default function HeaderWithLines({ text, className = '' }) {
  return (
    <div className={`header-with-lines ${className}`}>
      <div className="header-line left-line" />
      <div className="header-text">{text}</div>
      <div className="header-line right-line" />
    </div>
  );
}
