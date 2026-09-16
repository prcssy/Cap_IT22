import { useEffect } from 'react';
import { FaClipboardList, FaCalendarAlt, FaTimes, FaChevronRight } from 'react-icons/fa';
import './SubmittedRegistrationsModal.css';

export default function SubmittedRegistrationsModal({ isOpen, onClose, registrations = [] }) {
  useEffect(() => {
    const handleKey = (e) => { if (e.key === 'Escape') onClose(); };
    if (isOpen) document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  return (
    <div
      className={`sr-overlay ${isOpen ? 'sr-overlay--visible' : ''}`}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      aria-modal="true"
      role="dialog"
      aria-label="Submitted Registrations"
    >
      <div className={`sr-modal ${isOpen ? 'sr-modal--visible' : ''}`}>

        {/* Header */}
        <div className="sr-header">
          <div className="sr-header-icon-wrap">
            <FaClipboardList className="sr-header-icon" />
          </div>
          <div className="sr-header-text">
            <h2 className="sr-header-title">SUBMITTED REGISTRATION</h2>
            <p className="sr-header-sub">List of sports registration you have submitted.</p>
          </div>
          <button className="sr-close-btn" onClick={onClose} aria-label="Close modal">
            <FaTimes />
          </button>
        </div>

        {/* Registrations list */}
        <div className="sr-list">
          {registrations.length === 0 ? (
            <p className="sr-empty">No registrations submitted yet.</p>
          ) : (
            registrations.map((reg, i) => (
              <div className="sr-item" key={i}>
                <div className="sr-item-info">
                  <p className="sr-item-name">{reg.name}</p>
                  <div className="sr-item-date-row">
                    <FaCalendarAlt className="sr-date-icon" />
                    <span>{reg.date}</span>
                  </div>
                </div>
                <div className="sr-item-right">
                  <span className={`sr-badge sr-badge--${(reg.status || 'pending').toLowerCase()}`}>
                    {reg.status || 'Pending'}
                  </span>
                  <span className="sr-item-submitted">{reg.submittedDate}</span>
                </div>
                <FaChevronRight className="sr-item-arrow" />
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="sr-footer">
          <span className="sr-footer-label">Total Events Joined</span>
          <span className="sr-footer-count">{registrations.length}</span>
        </div>

      </div>
    </div>
  );
}