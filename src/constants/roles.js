/* ─────────────────────────────────────────────
   Shared role labels/colors for the Roles & Permissions tab.

   STAFF_ROLES lists exactly the roles a Super Admin can grant/revoke via
   assignStaffRole/removeStaffRole (firestoreService.js) — 'student' isn't
   assignable, it's just what's left once every staff role is removed.

   Colors match the ones SuperAdminPage.jsx already uses for its
   role-distribution donut, so a role reads the same way in both tabs.
───────────────────────────────────────────── */
export const STAFF_ROLES = ['moderator', 'admin', 'superadmin'];

export const ROLE_LABELS = {
  student: 'Player',
  moderator: 'Moderator',
  admin: 'Admin',
  superadmin: 'Super Admin',
  audience: 'Audience',
};

export const ROLE_COLORS = {
  student: '#f5a623',
  moderator: '#16a34a',
  admin: '#dc2626',
  superadmin: '#7c3aed',
  audience: '#1d4ed8',
};

export function roleLabel(role) {
  return ROLE_LABELS[role] || (role ? role[0].toUpperCase() + role.slice(1) : 'Unknown');
}

export function roleColor(role) {
  return ROLE_COLORS[role] || '#64748b';
}
