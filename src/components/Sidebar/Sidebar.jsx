import React, { useContext, useState, useEffect } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { FaBars, FaTimes, FaUserCircle, FaHome, FaFlag, FaEdit, FaCalendarAlt, FaMedal, FaShieldAlt, FaUserShield, FaChartPie } from "react-icons/fa";
import { SidebarContext } from "../Sidebar/SidebarContext";
import { AuthContext } from "../AuthContext";
import { subscribeScheduleRequests } from "../../services/firestoreService";
import "./Sidebar.css";

function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { panelOpen, toggleSidebar, openSidebar } = useContext(SidebarContext);
  const { openAuthModal = () => {}, currentUser, userProfile, logout } = useContext(AuthContext);

  // Live pending-request count so an admin sees a schedule request was
  // filed even before opening the Admin Panel itself.
  const [pendingRequestCount, setPendingRequestCount] = useState(0);
  useEffect(() => {
    // Not rendered at all when the viewer isn't an admin (see the Admin
    // Panel button/link below), so a stale count sitting unused in state
    // is harmless — no need to reset it back to 0 here.
    if (!userProfile?.isAdmin) return;
    const unsubscribe = subscribeScheduleRequests((requests) => {
      setPendingRequestCount(requests.filter((r) => r.status === 'pending').length);
    });
    return unsubscribe;
  }, [userProfile?.isAdmin]);

  return (
    <>
      {/* ── Fixed icon rail ── */}
      <aside className="sidebar">
        <div className="sidebar-top">
          <button
            className="sidebar-btn menu-btn"
            aria-label={panelOpen ? "Close Menu" : "Open Menu"}
            data-label={panelOpen ? "Close" : "Menu"}
            onClick={toggleSidebar}
          >
            <span className={`menu-icon ${panelOpen ? "open" : ""}`}>
              <FaBars className="menu-icon-bars" />
              <FaTimes className="menu-icon-close" />
            </span>
          </button>

          <div className={`sidebar-extra ${panelOpen ? "collapsed" : ""}`}>
            <div className="sidebar-divider" />
            <button
              className={`sidebar-btn ${location.pathname === "/profile" ? "active" : ""}`}
              aria-label="Profile"
              data-label="Profile"
              onClick={() => navigate("/profile")}
            >
              <FaUserCircle />
            </button>
            <button
              className={`sidebar-btn ${location.pathname === "/dashboard" ? "active" : ""}`}
              aria-label="Home"
              data-label="Home"
              onClick={() => navigate('/dashboard')}
            >
              <FaHome />
            </button>
            <button
              className={`sidebar-btn ${location.pathname === "/registration" ? "active" : ""}`}
              aria-label="Registration"
              data-label="Registration"
              onClick={() => navigate('/registration')}
            >
              <FaEdit />
            </button>
            <button
              className={`sidebar-btn ${location.pathname === "/events" ? "active" : ""}`}
              aria-label="Team and Sports"
              data-label="Team & Sports"
              onClick={() => navigate('/events')}
            >
              <FaFlag />
            </button>
            <button
              className={`sidebar-btn ${location.pathname === "/schedule" ? "active" : ""}`}
              aria-label="Match Schedules"
              data-label="Schedules"
              onClick={() => navigate('/schedule')}
            >
              <FaCalendarAlt />
            </button>
            <button
              className={`sidebar-btn ${location.pathname === "/ranking" ? "active" : ""}`}
              aria-label="Ranking"
              data-label="Ranking"
              onClick={() => navigate('/ranking')}
            >
              <FaMedal />
            </button>

            {/* Admin Panel icon — only visible to admins */}
            {userProfile?.isAdmin && (
              <button
                className={`sidebar-btn ${location.pathname === "/schedule-admin" ? "active" : ""}`}
                aria-label="Admin Panel"
                data-label="Admin"
                onClick={() => navigate('/schedule-admin')}
                style={{ position: 'relative' }}
              >
                <FaShieldAlt />
                {pendingRequestCount > 0 && (
                  <span style={{
                    position: 'absolute', top: 2, right: 2, width: 9, height: 9, borderRadius: '50%',
                    background: '#c0392b', border: '1.5px solid #fff',
                  }} />
                )}
              </button>
            )}

            {/* Moderator icon — visible to moderators and super admins only (not regular admins) */}
            {(userProfile?.role === 'moderator' || userProfile?.role === 'superadmin') && (
              <button
                className={`sidebar-btn ${location.pathname === "/moderator" ? "active" : ""}`}
                aria-label="Moderator"
                data-label="Moderator"
                onClick={() => navigate('/moderator')}
              >
                <FaUserShield />
              </button>
            )}

            {/* Super Admin icon — super admins only. The slide-out
                panel already links here, but the rail is what's visible
                without opening anything, so super admins can reach their
                own dashboard in one click. */}
            {userProfile?.role === 'superadmin' && (
              <button
                className={`sidebar-btn ${location.pathname === "/superadmin" ? "active" : ""}`}
                aria-label="SuperAdmin"
                data-label="SuperAdmin"
                onClick={() => navigate('/superadmin')}
              >
                <FaChartPie />
              </button>
            )}
          </div>
        </div>
      </aside>

      {/* ── Slide-out panel ── */}
      <div className={`sidebar-panel ${panelOpen ? "open" : ""}`}>
        <div className="panel-profile">
          <FaUserCircle className="panel-avatar" />
          {currentUser ? (
            <button className="panel-login-btn" onClick={logout}>
              Sign out
            </button>
          ) : (
            <button className="panel-login-btn" onClick={() => openAuthModal('login')}>
              Log in
            </button>
          )}
        </div>

        <nav className="panel-nav">
          <Link to="/profile" className={`panel-nav-item ${location.pathname === "/profile" ? "active" : ""}`}>
            <FaUserCircle className="panel-nav-icon" />
            <span>Profile</span>
          </Link>
          <Link to="/dashboard" className={`panel-nav-item ${location.pathname === "/dashboard" ? "active" : ""}`}>
            <FaHome className="panel-nav-icon" />
            <span>Home</span>
          </Link>
          <Link to="/registration" className={`panel-nav-item ${location.pathname === "/registration" ? "active" : ""}`}>
            <FaEdit className="panel-nav-icon" />
            <span>Registration</span>
          </Link>
          <Link to="/events" className={`panel-nav-item ${location.pathname === "/events" ? "active" : ""}`}>
            <FaFlag className="panel-nav-icon" />
            <span>Team and Sports</span>
          </Link>
          <Link to="/schedule" className={`panel-nav-item ${location.pathname === "/schedule" ? "active" : ""}`}>
            <FaCalendarAlt className="panel-nav-icon" />
            <span>Match Schedules</span>
          </Link>
          <Link to="/ranking" className={`panel-nav-item ${location.pathname === "/ranking" ? "active" : ""}`}>
            <FaMedal className="panel-nav-icon" />
            <span>Ranking</span>
          </Link>

          {/* Admin Panel link — only visible to admins */}
          {userProfile?.isAdmin && (
            <Link to="/schedule-admin" className={`panel-nav-item ${location.pathname === "/schedule-admin" ? "active" : ""}`}>
              <FaShieldAlt className="panel-nav-icon" />
              <span>Admin Panel</span>
              {pendingRequestCount > 0 && (
                <span style={{
                  marginLeft: 'auto', minWidth: 18, height: 18, padding: '0 4px', borderRadius: 999,
                  background: '#c0392b', color: '#fff', fontSize: '0.65rem', fontWeight: 800,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
                }}>
                  {pendingRequestCount}
                </span>
              )}
            </Link>
          )}

          {/* Moderator — visible to moderators and super admins only (not regular admins) */}
          {(userProfile?.role === 'moderator' || userProfile?.role === 'superadmin') && (
            <Link to="/moderator" className={`panel-nav-item ${location.pathname === "/moderator" ? "active" : ""}`}>
              <FaUserShield className="panel-nav-icon" />
              <span>Moderator</span>
            </Link>
          )}
          {/* Super Admin — visible to super admins only */}
          {userProfile?.role === 'superadmin' && (
            <Link to="/superadmin" className={`panel-nav-item ${location.pathname === "/superadmin" ? "active" : ""}`}>
              <FaChartPie className="panel-nav-icon" />
              <span>SuperAdmin</span>
            </Link>
          )}
        </nav>
      </div>

      {panelOpen && (
        <div
          className="sidebar-backdrop"
          onClick={toggleSidebar}
        />
      )}
    </>
  );
}

export default Sidebar;