import { useContext } from 'react';
import { Navigate } from 'react-router-dom';
import { AuthContext } from '../context/AuthContext';

export default function ProtectedRoute({ children, allowedRoles = [] }) {
  const { currentUser, userRole, authLoading } = useContext(AuthContext);

  if (authLoading) {
    return <div>Loading...</div>;
  }

  if (!currentUser) {
    return <Navigate to="/" replace />;
  }

  if (allowedRoles.length > 0 && !allowedRoles.includes(userRole)) {
    return <Navigate to="/dashboard" replace />;
  }

  return children;
}
