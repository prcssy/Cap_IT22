import { useEffect } from 'react';
import { FaTrophy, FaCalendarAlt, FaMapMarkerAlt, FaTimes } from 'react-icons/fa';
import './EventsJoinedModal.css';

export default function EventsJoinedModal({ isOpen, onClose, events = [] }) {
  /* Close on Escape key */
  useEffect(() => {
    const handleKey = (e) => { if (e.key === 'Escape') onClose(); };
    if (isOpen) document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  return (
    <div
      className={`ej-overlay ${isOpen ? 'ej-overlay--visible' : ''}`}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      aria-modal="true"
      role="dialog"
      aria-label="Events Joined"
    >
      <div className={`ej-modal ${isOpen ? 'ej-modal--visible' : ''}`}>

        {/* Header */}
        <div className="ej-header">
          <div className="ej-header-icon-wrap">
            <FaTrophy className="ej-header-icon" />
          </div>
          <div className="ej-header-text">
            <h2 className="ej-header-title">EVENTS JOINED</h2>
            <p className="ej-header-sub">List of sports events you have participated in.</p>
          </div>
          <button className="ej-close-btn" onClick={onClose} aria-label="Close modal">
            <FaTimes />
          </button>
        </div>

        {/* Events list */}
        <div className="ej-list">
          {events.length === 0 ? (
            <p className="ej-empty">No events joined yet.</p>
          ) : (
            events.map((event, i) => (
              <div className="ej-item" key={i}>
                <div className="ej-item-info">
                  <p className="ej-item-name">{event.name}</p>
                  <div className="ej-item-meta">
                    <span className="ej-meta-row">
                      <FaCalendarAlt className="ej-meta-icon" />
                      {event.date}
                    </span>
                    <span className="ej-meta-row">
                      <FaMapMarkerAlt className="ej-meta-icon" />
                      {event.venue}
                    </span>
                  </div>
                </div>
                <span className={`ej-badge ej-badge--${(event.status || 'completed').toLowerCase()}`}>
                  {event.status || 'Completed'}
                </span>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="ej-footer">
          <span className="ej-footer-label">Total Events Joined</span>
          <span className="ej-footer-count">{events.length}</span>
        </div>

      </div>
    </div>
  );
}