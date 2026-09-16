import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from '../components/Sidebar/Sidebar';
import './AuthenticatedLayout.css';

export default function AuthenticatedLayout() {
  const location = useLocation();

  return (
    <div className="dashboard-container">
      <Sidebar />
      <main className="authenticated-main">
        {/* key={pathname} forces this wrapper to remount on every page
            change, which re-triggers the fade/slide-up entrance animation */}
        <div className="page-transition" key={location.pathname}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}