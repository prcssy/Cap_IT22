import { useEffect } from 'react';
import { FaMedal, FaCalendarAlt, FaTimes } from 'react-icons/fa';
import './AwardsModal.css';

export default function AwardsModal({ isOpen, onClose, awards = [] }) {
  useEffect(() => {
    const handleKey = (e) => { if (e.key === 'Escape') onClose(); };
    if (isOpen) document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  return (
    <div
      className={`aw-overlay ${isOpen ? 'aw-overlay--visible' : ''}`}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      aria-modal="true"
      role="dialog"
      aria-label="Awards"
    >
      <div className={`aw-modal ${isOpen ? 'aw-modal--visible' : ''}`}>

        {/* Header */}
        <div className="aw-header">
          <div className="aw-header-icon-wrap">
            <FaMedal className="aw-header-icon" />
          </div>
          <div className="aw-header-text">
            <h2 className="aw-header-title">AWARDS</h2>
            <p className="aw-header-sub">List of awards and achievements you have earned.</p>
          </div>
          <button className="aw-close-btn" onClick={onClose} aria-label="Close modal">
            <FaTimes />
          </button>
        </div>

        {/* Awards list */}
        <div className="aw-list">
          {awards.length === 0 ? (
            <p className="aw-empty">No awards earned yet.</p>
          ) : (
            awards.map((award, i) => (
              <div className="aw-item" key={i}>
                <div className="aw-item-info">
                  <p className="aw-item-name">{award.name}</p>
                  <p className="aw-item-desc">{award.description}</p>
                  <p className="aw-item-event">{award.event}</p>
                </div>
                <div className="aw-item-date">
                  <FaCalendarAlt className="aw-date-icon" />
                  <span>{award.date}</span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="aw-footer">
          <span className="aw-footer-label">Total Awards Earned</span>
          <span className="aw-footer-count">{awards.length}</span>
        </div>

      </div>
    </div>
  );
}