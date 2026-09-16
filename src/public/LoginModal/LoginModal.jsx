import { useContext, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AuthContext } from '../../shared/context/AuthContext';
import { BrandingContext } from '../../shared/context/BrandingContext';
import { FaTimes, FaEye, FaEyeSlash, FaArrowLeft } from 'react-icons/fa';
import { findStaffAllowlistEntry } from '../../shared/services/firestoreService';
import './LoginModal.css';

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
              {showPassword ? <FaEyeSlash /> : <FaEye />}
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

const GRADE_LEVEL_GROUPS = [
  {
    label: 'Elementary',
    options: ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6'],
  },
  {
    label: 'High School',
    options: ['Grade 7', 'Grade 8', 'Grade 9', 'Grade 10', 'Grade 11', 'Grade 12'],
  },
  {
    label: 'College',
    options: ['1st Year', '2nd Year', '3rd Year', '4th Year'],
  },
];

const ROLE_LABELS = {
  student: 'Student',
  admin: 'Admin',
  moderator: 'Moderator',
  superadmin: 'Super Admin',
};

function SignUpScreen({ onSwitchScreen, onSignUp, onSuccess }) {
  const { logo } = useContext(BrandingContext);
  const [role, setRole] = useState('student'); // student | admin | moderator | superadmin
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

  const isStaffRole = role !== 'student';

  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value,
    });
  };

  const handleRoleChange = (e) => {
    // Switching roles clears the form so a half-filled student form
    // can't leak into a staff signup (and vice versa).
    setRole(e.target.value);
    setFormData({
      name: '',
      email: '',
      password: '',
      confirmPassword: '',
      gender: '',
      gradeLevel: '',
      section: '',
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
      if (isStaffRole) {
        // Staff (admin / moderator / super admin) don't fill out the
        // full student form — just the gmail they were pre-cleared
        // with, plus a password. Confirm that gmail is on the
        // allowlist for the role they picked before creating the account.
        const staffEntry = await findStaffAllowlistEntry(formData.email, role);
        if (!staffEntry) {
          alert(
            'That email is not authorized to sign up as ' +
            ROLE_LABELS[role] +
            '. Please check the email or contact a super admin.'
          );
          return;
        }

        await onSignUp(staffEntry.name || '', formData.email, formData.password, {
          role,
          isStaff: true,
        });
      } else {
        await onSignUp(formData.name, formData.email, formData.password, {
          role: 'student',
          gender: formData.gender,
          gradeLevel: formData.gradeLevel,
          section: formData.section,
        });
      }

      alert(
        `Account created successfully! We sent a verification link to ${formData.email} — ` +
        'please check your gmail inbox and verify your email before logging in.'
      );
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
        <div className="form-group">
          <label htmlFor="role">Sign up as</label>
          <select id="role" name="role" value={role} onChange={handleRoleChange}>
            <option value="student">Student</option>
            <option value="admin">Admin</option>
            <option value="moderator">Moderator</option>
            <option value="superadmin">Super Admin</option>
          </select>
        </div>

        <div className="auth-fields" key={role}>
        {isStaffRole ? (
          <>
            {/* Staff accounts are pre-approved by gmail — no need to
                re-collect personal/academic info that's already on file. */}
            <div className="form-group">
              <label htmlFor="email">{ROLE_LABELS[role]} Gmail</label>
              <input
                type="email"
                id="email"
                name="email"
                placeholder="Enter your authorized gmail"
                value={formData.email}
                onChange={handleChange}
                required
              />
            </div>

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
                  {showPassword ? <FaEyeSlash /> : <FaEye />}
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
                  {showConfirmPassword ? <FaEyeSlash /> : <FaEye />}
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="form-group">
              <label htmlFor="name">Create Name</label>
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
                    {showPassword ? <FaEyeSlash /> : <FaEye />}
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
                    {showConfirmPassword ? <FaEyeSlash /> : <FaEye />}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
        </div>

        <button type="submit" className="auth-btn auth-btn-primary" disabled={submitting}>
          {submitting ? 'Submitting…' : 'Submit'}
        </button>
      </form>
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

function NewPasswordScreen({ onSwitchScreen, onUpdatePassword, currentUser }) {
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
              {showNewPassword ? <FaEyeSlash /> : <FaEye />}
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
              {showConfirmPassword ? <FaEyeSlash /> : <FaEye />}
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
    currentUser,
    userProfile,
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
                currentUser={currentUser}
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
}