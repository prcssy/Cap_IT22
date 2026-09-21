import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { subscribeScheduleRequests } from '../services/firestoreService';
import { AuthContext } from './AuthContext';

/* ════════════════════════════════════════════════════════════════════
   A single shared `scheduleRequests/all` listener for the whole
   authenticated session, instead of Sidebar, AdminSchedulePage, and
   ModeratorPage each opening their own `onSnapshot` on the exact same doc
   at once — e.g. an admin viewing AdminSchedulePage with the Sidebar
   mounted alongside it used to mean 2 separate listeners doing identical
   snapshot processing for the same data. Mirrors BrandingContext's
   provider-owns-the-listener shape.

   Only staff (admin/superadmin/moderator) ever need this — a plain
   student never sees schedule requests — so the listener is gated the
   same way Sidebar's own subscription used to gate itself, rather than
   opening one for every signed-in user regardless of role.
   ════════════════════════════════════════════════════════════════════ */

export const ScheduleRequestsContext = createContext({
  scheduleRequests: [],
  pendingRequestCount: 0,
});

export function ScheduleRequestsProvider({ children }) {
  const { userProfile } = useContext(AuthContext);
  const isStaff = userProfile?.isAdmin || userProfile?.role === 'moderator';
  const [allRequests, setAllRequests] = useState([]);
  const staffLevel = userProfile?.staffLevel || null;

  useEffect(() => {
    if (!isStaff) {
      setAllRequests([]);
      return undefined;
    }
    const unsubscribe = subscribeScheduleRequests(setAllRequests);
    return unsubscribe;
  }, [isStaff]);

  // Level-scoped admins/moderators only see requests for their own level
  // (Super Admin, staffLevel null, sees all).
  const scheduleRequests = useMemo(
    () => (staffLevel ? allRequests.filter((r) => r.level === staffLevel) : allRequests),
    [allRequests, staffLevel]
  );

  const pendingRequestCount = scheduleRequests.filter((r) => r.status === 'pending').length;

  return (
    <ScheduleRequestsContext.Provider value={{ scheduleRequests, pendingRequestCount }}>
      {children}
    </ScheduleRequestsContext.Provider>
  );
}
