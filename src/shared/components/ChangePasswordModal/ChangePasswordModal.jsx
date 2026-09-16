import { useState, useEffect } from 'react';
import { FaTimes, FaEye, FaEyeSlash, FaSave } from 'react-icons/fa';
import './ChangePasswordModal.css';

/* ── Password strength calculator ── */
function getStrength(password) {
  if (!password) return { score: 0, label: '', color: '' };
  let score = 0;
  if (password.length >= 8)  score++;
  if (password.length >= 12) score++;
  if (/[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  if (score <= 1) return { score: 1, label: 'Weak',   color: '#ef4444' };
  if (score === 2) return { score: 2, label: 'Fair',   color: '#f97316' };
  if (score === 3) return { score: 3, label: 'Good',   color: '#FCBF19' };
  if (score === 4) return { score: 4, label: 'Strong', color: '#22c55e' };
  return                     { score: 5, label: 'Very Strong', color: '#16a34a' };
}

/* ── Single password field ── */
function PasswordField({ label, value, onChange, placeholder = '***********' }) {
  const [show, setShow] = useState(false);
  return (
    <div className="cp-field">
      <label className="cp-label">{label}</label>
      <div className="cp-input-wrap">
        <input
          className="cp-input"
          type={show ? 'text' : 'password'}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          autoComplete="off"
        />
        <button
          type="button"
          className="cp-eye-btn"
          onClick={() => setShow(p => !p)}
          aria-label={show ? 'Hide password' : 'Show password'}
        >
          {show ? <FaEye /> : <FaEyeSlash />}
        </button>
      </div>
    </div>
  );
}

/* ── Strength bar ── */
function StrengthBar({ password }) {
  const { score, label, color } = getStrength(password);
  const totalBars = 4;

  // map score (1-5) to filled bars (1-4)
  const filled = Math.min(Math.ceil(score * totalBars / 5), totalBars);

  return (
    <div className="cp-strength">
      <span className="cp-strength-label">Password Strength</span>
      <div className="cp-strength-row">
        <div className="cp-bars">
          {Array.from({ length: totalBars }).map((_, i) => (
            <div
              key={i}
              className="cp-bar"
              style={{
                background: i < filled ? color : '#e2e8f0',
                transition: `background 0.3s ease ${i * 0.07}s`,
              }}
            />
          ))}
        </div>
        {label && (
          <span className="cp-strength-text" style={{ color }}>
            {label}
          </span>
        )}
      </div>
    </div>
  );
}

/* ── Success screen ── */
function SuccessScreen() {
  return (
    <div className="cp-success">
      <div className="cp-success-circle">
        <svg viewBox="0 0 80 80" className="cp-success-svg">
          <circle cx="40" cy="40" r="36" className="cp-success-ring" />
          <polyline points="22,42 35,55 58,28" className="cp-success-check" />
        </svg>
      </div>
      <p className="cp-success-text">Password Updated<br />Successfully</p>
    </div>
  );
}

/* ── Main modal ── */
export default function ChangePasswordModal({ isOpen, onClose, onSave }) {
  const [current,  setCurrent]  = useState('');
  const [newPass,  setNewPass]  = useState('');
  const [confirm,  setConfirm]  = useState('');
  const [error,    setError]    = useState('');
  const [success,  setSuccess]  = useState(false);
  const [saving,   setSaving]   = useState(false);

  /* Reset state every time the modal opens */
  useEffect(() => {
    if (isOpen) {
      setCurrent(''); setNewPass(''); setConfirm('');
      setError(''); setSuccess(false); setSaving(false);
    }
  }, [isOpen]);

  const handleClose = () => {
    onClose();
  };

  /* Escape key */
  useEffect(() => {
    const handleKey = (e) => { if (e.key === 'Escape') handleClose(); };
    if (isOpen) document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen]);

  const handleSave = async () => {
    setError('');
    if (!current)               return setError('Please enter your current password.');
    if (newPass.length < 8)     return setError('New password must be at least 8 characters.');
    if (newPass !== confirm)     return setError('Passwords do not match.');
    if (newPass === current)     return setError('New password must differ from current password.');

    setSaving(true);
    try {
      if (onSave) await onSave(current, newPass);
      setSuccess(true);
      /* Auto-close after 2.4 s */
      setTimeout(() => { onClose(); }, 2400);
    } catch (err) {
      setError(err?.message || 'Failed to update password. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={`cp-overlay ${isOpen ? 'cp-overlay--visible' : ''}`}
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
      aria-modal="true"
      role="dialog"
      aria-label="Change Password"
    >
      <div className={`cp-modal ${isOpen ? 'cp-modal--visible' : ''} ${success ? 'cp-modal--success' : ''}`}>

        {/* ── Close button ── */}
        <button className="cp-close-btn" onClick={handleClose} aria-label="Close">
          <FaTimes />
        </button>

        {/* ── Success view ── */}
        {success ? (
          <SuccessScreen />
        ) : (
          <>
            <h2 className="cp-title">CHANGE PASSWORD</h2>

            <div className="cp-form">
              <PasswordField
                label="Current Password"
                value={current}
                onChange={e => setCurrent(e.target.value)}
              />
              <PasswordField
                label="Create New Password"
                value={newPass}
                onChange={e => setNewPass(e.target.value)}
              />
              <PasswordField
                label="Confirm Password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                placeholder="*********"
              />

              <StrengthBar password={newPass} />

              {error && <p className="cp-error">{error}</p>}

              <div className="cp-actions">
                <button className="cp-btn-cancel" onClick={handleClose} type="button">
                  Cancel
                </button>
                <button
                  className="cp-btn-save"
                  onClick={handleSave}
                  type="button"
                  disabled={saving}
                >
                  <FaSave />
                  {saving ? 'Saving…' : 'Save Changes'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}