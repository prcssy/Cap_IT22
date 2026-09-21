import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './shared/context/AuthContext';
import { BrandingProvider } from './shared/context/BrandingContext';
import { LevelLabelsProvider } from './shared/context/LevelLabelsContext';
import { ScheduleRequestsProvider } from './shared/context/ScheduleRequestsContext';
import { SidebarProvider } from './shared/components/Sidebar/SidebarContext';
import PublicLayout from './public/PublicLayout';
import AuthenticatedLayout from './shared/layouts/AuthenticatedLayout';
import NotFoundPage from './shared/NotFoundPage';
import ProtectedRoute from './shared/components/ProtectedRoute';
import LoginModal from './public/LoginModal/LoginModal';

// Route-level code splitting: these used to be static imports, which meant
// every visitor's very first page load — even just the public landing page
// or a student's dashboard — downloaded the entire app in one ~2MB bundle,
// including the Admin console, Moderator match-entry tooling, and Super
// Admin analytics they may never open. Each of these now only loads once
// its own route is actually visited.
const DashboardPage = lazy(() => import('./student/DashboardPage'));
const AdminSchedulePage = lazy(() => import('./admin/AdminSchedulePage'));
const ModeratorPage = lazy(() => import('./moderator/ModeratorPage'));
const SuperAdminPage = lazy(() => import('./superadmin/SuperAdminPage'));
const ProfilePage = lazy(() => import('./student/ProfilePage'));
const TeamAndSportsPage = lazy(() => import('./student/TeamAndSportsPage'));
const MatchSchedulesPage = lazy(() => import('./student/MatchSchedulesPage'));
const RankingPage = lazy(() => import('./student/RankingPage'));
const PrivacyPolicyPage = lazy(() => import('./public/PrivacyPolicy/PrivacyPolicyPage'));

function App() {
  return (
    <BrandingProvider>
      <LevelLabelsProvider>
      <AuthProvider>
        <BrowserRouter>
          <Suspense fallback={<div>Loading...</div>}>
          <Routes>
            <Route path="/" element={<PublicLayout />} />
            <Route path="/privacy-policy" element={<PrivacyPolicyPage />} />

            <Route
              element={
                <ScheduleRequestsProvider>
                  <SidebarProvider>
                    <AuthenticatedLayout />
                  </SidebarProvider>
                </ScheduleRequestsProvider>
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
          </Suspense>
          <LoginModal />
        </BrowserRouter>
      </AuthProvider>
      </LevelLabelsProvider>
    </BrandingProvider>
  );
}

export default App;
