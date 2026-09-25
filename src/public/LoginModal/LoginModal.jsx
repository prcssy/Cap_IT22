import { useContext, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AuthContext } from '../../shared/context/AuthContext';
import { BrandingContext } from '../../shared/context/BrandingContext';
import { LevelLabelsContext } from '../../shared/context/LevelLabelsContext';
import { FaTimes, FaEye, FaEyeSlash, FaArrowLeft } from 'react-icons/fa';
import './LoginModal.css';

// Every one of these is a React.lazy() page in App.jsx, so the very first
// time a session visits one, the browser has to fetch its JS chunk before
// anything can render — normally invisible, but landing right on login
// (the very first authenticated navigation) turned into a new, visible
// "why is this taking a while" delay that didn't exist before route
// splitting. login() itself already takes a moment (Firebase Auth +
// Firestore role lookups), so kicking these off in parallel with that,
// rather than only after it resolves and we know which one we actually
// need, means the right chunk is usually already loaded (or loading) by
// the time we know where to redirect — dynamic import() calls for the same
// module are deduped/cached by the browser, so prefetching all 4 possible
// destinations costs nothing extra once the real one is needed.
function prefetchPostLoginRoutes() {
  import('../../student/DashboardPage').catch(() => {});
  import('../../admin/AdminSchedulePage').catch(() => {});
  import('../../moderator/ModeratorPage').catch(() => {});
  import('../../superadmin/SuperAdminPage').catch(() => {});
}

function LoginScreen({ onSwitchScreen, onLogin, onSuccess, onResendVerification }) {
  const { logo } = useContext(BrandingContext);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [resending, setResending] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setNeedsVerification(false);
    prefetchPostLoginRoutes();
    try {
      const { role } = await onLogin(email, password);
      onSuccess(role);
    } catch (error) {
      if (error.code === 'auth/email-not-verified') {
        setNeedsVerification(true);
      }
      alert(error.message || 'Login failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleResend = async () => {
    setResending(true);
    try {
      await onResendVerification(email, password);
      alert(`Verification email re-sent to ${email}. Please check your gmail inbox.`);
    } catch (error) {
      alert(error.message || 'Could not resend verification email.');
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="auth-modal-content login-screen">
      <div className="auth-logo">
        <img src={logo} alt="School logo" />
      </div>

      <h2 className="auth-title">Login to Dashboard</h2>

      <form onSubmit={handleSubmit} className="auth-form">
        <div className="form-group">
          <label htmlFor="email">Email</label>
          <input
            type="email"
            id="email"
            placeholder="Enter your email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>

        <div className="form-group">
          <label htmlFor="password">Password</label>
          <div className="password-input-wrapper">
            <input
              type={showPassword ? 'text' : 'password'}
              id="password"
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <button
              type="button"
              className="password-toggle"
              onClick={() => setShowPassword(!showPassword)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <FaEye /> : <FaEyeSlash />}
            </button>
          </div>
        </div>

        <button type="submit" className="auth-btn auth-btn-primary" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Log In'}
        </button>
      </form>

      {needsVerification && (
        <div className="auth-footer">
          <button
            type="button"
            className="auth-link"
            onClick={handleResend}
            disabled={resending}
          >
            {resending ? 'Resending…' : 'Resend verification email'}
          </button>
        </div>
      )}

      <div className="auth-footer">
        <button
          type="button"
          className="auth-link"
          onClick={() => onSwitchScreen('forgotPassword')}
        >
          Forgot Password?
        </button>
      </div>

      <div className="auth-divider">or</div>

      <div className="auth-action">
        <span>Don't have an account?</span>
        <button
          type="button"
          className="auth-link-action"
          onClick={() => onSwitchScreen('signup')}
        >
          Create an account
        </button>
      </div>
    </div>
  );
}

function SignUpScreen({ onSwitchScreen, onSignUp, onSuccess }) {
  const { logo } = useContext(BrandingContext);
  const levelLabels = useContext(LevelLabelsContext);
  const GRADE_LEVEL_GROUPS = [
    {
      label: levelLabels.elementary,
      options: ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6'],
    },
    {
      label: levelLabels.highSchool,
      options: ['Grade 7', 'Grade 8', 'Grade 9', 'Grade 10', 'Grade 11', 'Grade 12'],
    },
    {
      label: levelLabels.college,
      options: ['1st Year', '2nd Year', '3rd Year', '4th Year'],
    },
  ];
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
    gender: '',
    gradeLevel: '',
    section: '',
  });
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value,
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (formData.password !== formData.confirmPassword) {
      alert('Passwords do not match');
      return;
    }

    setSubmitting(true);
    try {
      // This form only ever creates student accounts. Admin/Moderator/
      // Super Admin accounts are never self-service: letting anyone
      // create a Firebase Auth account for an arbitrary email — even one
      // pre-cleared on the staff allowlist — meant an attacker could
      // "claim" a staff member's email with a password of their own
      // choosing before the real owner ever signed up, and Firebase still
      // sends the verification link to the real inbox regardless of who
      // created the account. If the real owner later clicked that link
      // (thinking it was their own signup), it would verify the
      // attacker's account instead — full account takeover. Staff
      // accounts are now provisioned directly by a Super Admin (see
      // create-staff-account.cjs), the same trusted, console/CLI-only
      // process already used for the admins/moderators/superadmins
      // allowlist docs themselves.
      const { verificationEmailSent } = await onSignUp(formData.name, formData.email, formData.password, {
        role: 'student',
        gender: formData.gender,
        gradeLevel: formData.gradeLevel,
        section: formData.section,
      });

      if (verificationEmailSent) {
        alert(
          `Account created successfully! We sent a verification link to ${formData.email} — ` +
          'please check your gmail inbox and verify your email before logging in.'
        );
      } else {
        alert(
          'Account created, but we could not send the verification email right now ' +
          '(the daily email sending limit may have been reached). Please wait a while, ' +
          'then use "Resend verification email" from the login screen.'
        );
      }
      onSuccess();
    } catch (error) {
      alert(error.message || 'Sign up failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-modal-content signup-screen">
      <button
        type="button"
        className="auth-modal-back"
        onClick={() => onSwitchScreen('login')}
        aria-label="Back to login"
      >
        <FaArrowLeft />
      </button>

      <div className="auth-logo">
        <img src={logo} alt="School logo" />
      </div>

      <h2 className="auth-title">Sign up to Dashboard</h2>

      <form onSubmit={handleSubmit} className="auth-form">
        <div className="auth-fields">
            <div className="form-group">
              <label htmlFor="name">Full Name</label>
              <input
                type="text"
                id="name"
                name="name"
                placeholder="Enter your name"
                value={formData.name}
                onChange={handleChange}
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="email">Email</label>
              <input
                type="email"
                id="email"
                name="email"
                placeholder="Enter your email"
                value={formData.email}
                onChange={handleChange}
                required
              />
            </div>

            <div className="form-group">
              <label>Gender</label>
              <div className="auth-radio-group">
                {['Male', 'Female', 'Others'].map((g) => (
                  <label className="auth-radio-label" key={g}>
                    <input
                      type="radio"
                      name="gender"
                      value={g}
                      checked={formData.gender === g}
                      onChange={handleChange}
                      required
                    />
                    {g}
                  </label>
                ))}
              </div>
            </div>

            <div className="auth-form-row">
              <div className="form-group">
                <label htmlFor="gradeLevel">Grade / Year Level</label>
                <select
                  id="gradeLevel"
                  name="gradeLevel"
                  value={formData.gradeLevel}
                  onChange={handleChange}
                  required
                >
                  <option value="">Select</option>
                  {GRADE_LEVEL_GROUPS.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.options.map((g) => <option key={g} value={g}>{g}</option>)}
                    </optgroup>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label htmlFor="section">Section</label>
                <input
                  type="text"
                  id="section"
                  name="section"
                  placeholder="Enter your section"
                  value={formData.section}
                  onChange={handleChange}
                  required
                />
              </div>
            </div>

            <div className="auth-form-row">
              <div className="form-group">
                <label htmlFor="password">Create Password</label>
                <div className="password-input-wrapper">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    id="password"
                    name="password"
                    placeholder="Create a password"
                    value={formData.password}
                    onChange={handleChange}
                    required
                  />
                  <button
                    type="button"
                    className="password-toggle"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <FaEye /> : <FaEyeSlash />}
                  </button>
                </div>
              </div>

              <div className="form-group">
                <label htmlFor="confirmPassword">Confirm Password</label>
                <div className="password-input-wrapper">
                  <input
                    type={showConfirmPassword ? 'text' : 'password'}
                    id="confirmPassword"
                    name="confirmPassword"
                    placeholder="Confirm password"
                    value={formData.confirmPassword}
                    onChange={handleChange}
                    required
                  />
                  <button
                    type="button"
                    className="password-toggle"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                  >
                    {showConfirmPassword ? <FaEye /> : <FaEyeSlash />}
                  </button>
                </div>
              </div>
            </div>
        </div>

        <button type="submit" className="auth-btn auth-btn-primary" disabled={submitting}>
          {submitting ? 'Submitting…' : 'Submit'}
        </button>
      </form>

      <p className="auth-staff-note">
        Staff account? Ask your Super Admin to set one up for you.
      </p>
    </div>
  );
}

function ForgotPasswordScreen({ onSwitchScreen, onResetPassword }) {
  const { logo } = useContext(BrandingContext);
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await onResetPassword(email);
      alert('Password reset email sent. Please check your inbox.');
      onSwitchScreen('login');
    } catch (error) {
      alert(error.message || 'Could not send reset email.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-modal-content forgot-password-screen">
      <div className="auth-logo">
        <img src={logo} alt="School logo" />
      </div>

      <h2 className="auth-title">Forgot Password</h2>

      <form onSubmit={handleSubmit} className="auth-form">
        <div className="form-group">
          <label htmlFor="email">Enter your email</label>
          <input
            type="email"
            id="email"
            placeholder="Enter your email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>

        <button type="submit" className="auth-btn auth-btn-primary" disabled={submitting}>
          {submitting ? 'Sending…' : 'Continue'}
        </button>
      </form>

      <div className="auth-action">
        <button
          type="button"
          className="auth-link"
          onClick={() => onSwitchScreen('login')}
        >
          Back to login
        </button>
      </div>
    </div>
  );
}

function NewPasswordScreen({ onSwitchScreen, onUpdatePassword }) {
  const { logo } = useContext(BrandingContext);
  const [passwords, setPasswords] = useState({
    newPassword: '',
    confirmPassword: '',
  });
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const handleChange = (e) => {
    setPasswords({
      ...passwords,
      [e.target.name]: e.target.value,
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (passwords.newPassword !== passwords.confirmPassword) {
      alert('Passwords do not match');
      return;
    }

    try {
      await onUpdatePassword(passwords.newPassword);
      alert('Password changed successfully. Please log in again.');
      onSwitchScreen('login');
    } catch (error) {
      alert(error.message || 'Unable to update password.');
    }
  };

  return (
    <div className="auth-modal-content new-password-screen">
      <div className="auth-logo">
        <img src={logo} alt="School logo" />
      </div>

      <h2 className="auth-title">New Password</h2>

      <form onSubmit={handleSubmit} className="auth-form">
        <div className="form-group">
          <label htmlFor="newPassword">Create New Password</label>
          <div className="password-input-wrapper">
            <input
              type={showNewPassword ? 'text' : 'password'}
              id="newPassword"
              name="newPassword"
              placeholder="Enter new password"
              value={passwords.newPassword}
              onChange={handleChange}
              required
            />
            <button
              type="button"
              className="password-toggle"
              onClick={() => setShowNewPassword(!showNewPassword)}
              aria-label={showNewPassword ? 'Hide password' : 'Show password'}
            >
              {showNewPassword ? <FaEye /> : <FaEyeSlash />}
            </button>
          </div>
        </div>

        <div className="form-group">
          <label htmlFor="confirmPassword">Confirm Password</label>
          <div className="password-input-wrapper">
            <input
              type={showConfirmPassword ? 'text' : 'password'}
              id="confirmPassword"
              name="confirmPassword"
              placeholder="Confirm your password"
              value={passwords.confirmPassword}
              onChange={handleChange}
              required
            />
            <button
              type="button"
              className="password-toggle"
              onClick={() => setShowConfirmPassword(!showConfirmPassword)}
              aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
            >
              {showConfirmPassword ? <FaEye /> : <FaEyeSlash />}
            </button>
          </div>
        </div>

        <button type="submit" className="auth-btn auth-btn-primary">
          Change
        </button>
      </form>
    </div>
  );
}

export default function LoginModal() {
  const navigate = useNavigate();
  const {
    authModal,
    closeAuthModal,
    switchScreen,
    login,
    signup,
    resendVerificationEmail,
    resetPassword,
    updatePassword,
  } = useContext(AuthContext);

  if (!authModal.isOpen) return null;

  return (
    <>
      {/* Background Overlay */}
      <div className="auth-modal-backdrop" onClick={closeAuthModal} />

      {/* Modal Container */}
      <div className="auth-modal-container">
        {/* Building Background */}
        <div className="auth-modal-background">
          <img src="/src/assets/SRCBuilding.png" alt="Santa Rita College" />
        </div>

        {/* Modal Card */}
        <div className="auth-modal-card">
          {/* Close Button */}
          <button
            className="auth-modal-close"
            onClick={closeAuthModal}
            aria-label="Close modal"
          >
            <FaTimes />
          </button>

          {/* Screen Content */}
          <div className="auth-modal-card__body">
            {authModal.screen === 'login' && (
              <LoginScreen
                onSwitchScreen={switchScreen}
                onLogin={login}
                onResendVerification={resendVerificationEmail}
                onSuccess={(role) => {
                  closeAuthModal();
                  // redirect based on the Firestore-verified role returned by login()
                  if (role === 'admin') navigate('/admin');
                  else if (role === 'moderator') navigate('/moderator');
                  else if (role === 'superadmin') navigate('/superadmin');
                  else navigate('/dashboard');
                }}
              />
            )}
            {authModal.screen === 'signup' && (
              <SignUpScreen
                onSwitchScreen={switchScreen}
                onSignUp={signup}
                onSuccess={() => {
                  // The new account is signed out and unverified at this
                  // point — send them to the login screen instead of the
                  // dashboard so they log in for real once they've
                  // clicked the gmail verification link.
                  switchScreen('login');
                }}
              />
            )}
            {authModal.screen === 'forgotPassword' && (
              <ForgotPasswordScreen
                onSwitchScreen={switchScreen}
                onResetPassword={resetPassword}
              />
            )}
            {authModal.screen === 'newPassword' && (
              <NewPasswordScreen
                onSwitchScreen={switchScreen}
                onUpdatePassword={updatePassword}
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
}