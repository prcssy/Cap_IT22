import { useContext } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AuthContext } from './context/AuthContext';

const ROLE_HOME = {
  student: '/dashboard', player: '/dashboard', coach: '/coach',
  moderator: '/moderator', admin: '/admin', superadmin: '/superadmin',
};

export default function AccessDeniedPage() {
  const { userRole } = useContext(AuthContext);
  const { state } = useLocation();
  return (
    <main style={{ padding: '3rem 1.5rem', textAlign: 'center', color: '#fff' }}>
      <h1>Access Denied</h1>
      <p>
        Your account{userRole && userRole !== 'guest' ? ` (${userRole})` : ''} doesn't have
        permission to open {state?.from || 'that page'}.
      </p>
      <Link to={ROLE_HOME[userRole] || '/'} style={{ color: 'var(--c-gold, #fcbf19)' }}>
        Go to my dashboard
      </Link>
    </main>
  );
}
