import { useContext } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { AuthContext } from '../context/AuthContext';

export default function ProtectedRoute({ children, allowedRoles = [] }) {
  const { currentUser, userRole, authLoading } = useContext(AuthContext);
  const location = useLocation();

  if (authLoading) {
    return <div role="status" aria-live="polite">Loading...</div>;
  }

  if (!currentUser) {
    return <Navigate to="/" replace />;
  }

  // Wrong role: show an explicit "Access Denied" page instead of silently
  // bouncing to /dashboard, so the user knows why.
  if (allowedRoles.length > 0 && !allowedRoles.includes(userRole)) {
    return <Navigate to="/access-denied" replace state={{ from: location.pathname }} />;
  }

  return children;
}
