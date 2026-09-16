import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './components/AuthContext';
import { BrandingProvider } from './components/BrandingContext';
import { SidebarProvider } from './components/Sidebar/SidebarContext';
import PublicLayout from './layouts/PublicLayout';
import AuthenticatedLayout from './layouts/AuthenticatedLayout';
import DashboardPage from './pages/DashboardPage';
import AdminSchedulePage from './pages/AdminSchedulePage';
import ModeratorPage from './pages/ModeratorPage';
import SuperAdminPage from './pages/SuperAdminPage';
import NotFoundPage from './pages/NotFoundPage';
import ProfilePage from './pages/ProfilePage';
import ProtectedRoute from './components/ProtectedRoute';
import LoginModal from './components/LoginModal/LoginModal';
import RegistrationPage from './pages/RegistrationPage';
import TeamAndSportsPage from './pages/TeamAndSportsPage';
import MatchSchedulesPage from './pages/MatchSchedulesPage';
import RankingPage from './pages/RankingPage';

function App() {
  return (
    <BrandingProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<PublicLayout />} />

            <Route
              element={
                <SidebarProvider>
                  <AuthenticatedLayout />
                </SidebarProvider>
              }
            >
              <Route
                path="/dashboard"
                element={
                  <ProtectedRoute>
                    <DashboardPage />
                  </ProtectedRoute>
                }
              />
              <Route
                 path="/profile"
                 element={
                   <ProtectedRoute>
                     <ProfilePage />
                   </ProtectedRoute>
                }
              />
              {/* Admin lands on the real, functional admin dashboard
                  (registrations / sports / schedules management) — not a stub page. */}
              <Route
                path="/admin"
                element={
                  <ProtectedRoute allowedRoles={["admin", "superadmin"]}>
                    <AdminSchedulePage />
                  </ProtectedRoute>
                }
              />
              {/* Moderators (and super admins) only — regular admins no longer
                  fall through into the moderator area. */}
              <Route
                path="/moderator"
                element={
                  <ProtectedRoute allowedRoles={["moderator", "superadmin"]}>
                    <ModeratorPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/superadmin"
                element={
                  <ProtectedRoute allowedRoles={["superadmin"]}>
                    <SuperAdminPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/registration"
                element={
                  <ProtectedRoute>
                    <RegistrationPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/events"
                element={
                  <ProtectedRoute>
                    <TeamAndSportsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/schedule"
                element={
                  <ProtectedRoute>
                    <MatchSchedulesPage />
                  </ProtectedRoute>
                }
              />

              <Route
                path="/ranking"
                element={
                  <ProtectedRoute>
                    <RankingPage />
                  </ProtectedRoute>
                }
              />
              {/* Kept as an alias of /admin so existing links/bookmarks still work */}
              <Route
                path="/schedule-admin"
                element={
                  <ProtectedRoute allowedRoles={["admin", "superadmin"]}>
                    <AdminSchedulePage />
                  </ProtectedRoute>
                }
              />
            </Route>

            <Route path="*" element={<NotFoundPage />} />
          </Routes>
          <LoginModal />
        </BrowserRouter>
      </AuthProvider>
    </BrandingProvider>
  );
}

export default App;
