import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './shared/context/AuthContext';
import { BrandingProvider } from './shared/context/BrandingContext';
import { SidebarProvider } from './shared/components/Sidebar/SidebarContext';
import PublicLayout from './public/PublicLayout';
import AuthenticatedLayout from './shared/layouts/AuthenticatedLayout';
import DashboardPage from './student/DashboardPage';
import AdminSchedulePage from './admin/AdminSchedulePage';
import ModeratorPage from './moderator/ModeratorPage';
import SuperAdminPage from './superadmin/SuperAdminPage';
import NotFoundPage from './shared/NotFoundPage';
import ProfilePage from './student/ProfilePage';
import ProtectedRoute from './shared/components/ProtectedRoute';
import LoginModal from './public/LoginModal/LoginModal';
import RegistrationPage from './student/RegistrationPage';
import TeamAndSportsPage from './student/TeamAndSportsPage';
import MatchSchedulesPage from './student/MatchSchedulesPage';
import RankingPage from './student/RankingPage';

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
