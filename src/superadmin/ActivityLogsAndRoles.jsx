import React, { useMemo, useState } from 'react';
import {
  FaSearch, FaFilter, FaUndo, FaSync, FaChevronLeft, FaChevronRight,
  FaEllipsisV, FaUserShield, FaUserTie, FaUserCog, FaUserSlash,
  FaUserPlus, FaCopy,
} from 'react-icons/fa';
import { auth } from '../shared/firebase';
import { assignStaffRole, removeStaffRole, createStaffAccount } from '../shared/services/firestoreService';
import { roleLabel } from '../shared/constants/roles';
import './ActivityLogsAndRoles.css';

const PAGE_SIZE = 10;

const ROLE_FILTER_OPTIONS = ['All Roles', 'Player', 'Moderator', 'Admin', 'Super Admin'];

const ROLE_BUTTONS = [
  { role: 'admin', label: 'Add as Administrator', icon: FaUserTie },
  { role: 'moderator', label: 'Add as Moderator', icon: FaUserCog },
  { role: 'superadmin', label: 'Add as SuperAdmin', icon: FaUserShield },
];

function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDateTime(date) {
  if (!date) return '—';
  return date.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function dateOnly(date) {
  if (!date) return null;
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/* Firebase throws opaque messages like "Missing or insufficient
   permissions." — translate the common case into something that tells
   the Super Admin what to actually do about it, same convention as
   AdminSchedulePage's own `friendlyFirestoreError`. */
function friendlyRoleError(err, fallback) {
  const isPermission = err?.code === 'permission-denied' || /permission/i.test(err?.message || '');
  if (isPermission) return `${fallback} — you don't have permission for this action.`;
  return err?.message || `${fallback} — check your connection and try again.`;
}

/* `<input type="date">` gives a plain "YYYY-MM-DD" string. Handing that
   straight to `new Date(...)` parses it as UTC midnight, which reads back
   as the PREVIOUS calendar day in any timezone behind UTC — silently
   excluding the very day the viewer picked. Parsing the parts by hand
   builds the date in the viewer's own local timezone instead. */
function parseLocalDate(yyyyMmDd) {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Activity Logs & Roles Management — second tab of the Super Admin page.
 * `users`/`logs` are fetched once by SuperAdminPage.jsx and handed down as
 * props (no duplicate reads); `onRefresh` re-pulls a fresh batch of logs.
 */
export default function ActivityLogsAndRoles({ users, logs, loading, error, onRefresh, onUserRoleChanged, actorRole }) {
  /* ── Filters (draft vs. applied — a Filter button commits them, like
     the reference design, rather than filtering live on every keystroke) ── */
  const [draftType, setDraftType] = useState('All Types');
  const [draftRole, setDraftRole] = useState('All Roles');
  const [draftDate, setDraftDate] = useState('');
  // Search filters live (matches this app's convention elsewhere, e.g.
  // AdminSchedulePage's registration search) — it's visually separate from
  // the Activity Type/Role/Date row, which stay explicit-apply like the
  // reference design's Filter button.
  const [search, setSearch] = useState('');

  const [applied, setApplied] = useState({ type: 'All Types', role: 'All Roles', date: '' });
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState(null);

  const activityTypeOptions = useMemo(() => {
    const seen = new Set();
    logs.forEach((log) => { if (log.type) seen.add(log.type); });
    return ['All Types', ...[...seen].sort()];
  }, [logs]);

  const applyFilters = () => {
    setApplied({ type: draftType, role: draftRole, date: draftDate });
    setPage(1);
  };

  const resetFilters = () => {
    setDraftType('All Types');
    setDraftRole('All Roles');
    setDraftDate('');
    setSearch('');
    setApplied({ type: 'All Types', role: 'All Roles', date: '' });
    setPage(1);
  };

  const filteredLogs = useMemo(() => {
    const filterDate = applied.date ? parseLocalDate(applied.date) : null;
    const searchQ = search.trim().toLowerCase();

    return logs.filter((log) => {
      if (applied.type !== 'All Types' && log.type !== applied.type) return false;
      if (applied.role !== 'All Roles' && roleLabel(log.actorRole) !== applied.role) return false;

      if (filterDate) {
        const when = toDate(log.timestamp);
        if (!when || dateOnly(when).getTime() !== filterDate.getTime()) return false;
      }

      if (searchQ) {
        const haystack = `${log.actorName || ''} ${log.actorEmail || ''}`.toLowerCase();
        if (!haystack.includes(searchQ)) return false;
      }
      return true;
    });
  }, [logs, applied, search]);

  const totalPages = Math.max(1, Math.ceil(filteredLogs.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const pageRows = filteredLogs.slice(pageStart, pageStart + PAGE_SIZE);

  const pageNumbers = useMemo(() => {
    const radius = 2;
    const nums = [];
    for (let n = Math.max(1, currentPage - radius); n <= Math.min(totalPages, currentPage + radius); n++) nums.push(n);
    return nums;
  }, [currentPage, totalPages]);

  /* ── Manage user role ── */
  const [userQuery, setUserQuery] = useState('');
  // Optimistic local patches applied on top of the `users` prop after a
  // successful role change — avoids waiting on SuperAdminPage's own users
  // fetch (which this component never triggers) to reflect the new role.
  const [roleOverrides, setRoleOverrides] = useState({});
  const roster = useMemo(
    () => users.map((u) => (roleOverrides[u.id] ? { ...u, ...roleOverrides[u.id] } : u)),
    [users, roleOverrides]
  );

  const [selectedId, setSelectedId] = useState(null);
  const selectedUser = roster.find((u) => u.id === selectedId) || null;
  const [actionMsg, setActionMsg] = useState(null); // { tone: 'success'|'error', text }
  const [busyRole, setBusyRole] = useState(null); // which button is in flight

  const userMatches = useMemo(() => {
    const q = userQuery.trim().toLowerCase();
    if (!q) return [];
    return roster
      .filter((u) => (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q))
      .slice(0, 8);
  }, [roster, userQuery]);

  const isSelf = !!(selectedUser && auth?.currentUser?.uid === selectedUser.id);
  const selectedRole = selectedUser?.role || 'student';

  /* ── Create a new staff account (Cloud Function) ──
     Distinct from the "Manage user role" panel above, which only changes
     the role of a user who already has an account — creating one from
     scratch needs a new Firebase Auth user, which the client SDK can't
     do for anyone but the currently signed-in account. */
  const [createEmail, setCreateEmail] = useState('');
  const [createName, setCreateName] = useState('');
  const [createRole, setCreateRole] = useState('moderator');
  const [createBusy, setCreateBusy] = useState(false);
  const [createMsg, setCreateMsg] = useState(null); // { tone: 'success'|'error', text }
  const [createdAccount, setCreatedAccount] = useState(null); // { email, role, tempPassword }
  const [copied, setCopied] = useState(false);

  const handleCreateAccount = async (e) => {
    e.preventDefault();
    const email = createEmail.trim().toLowerCase();
    if (!email || !email.includes('@')) {
      setCreateMsg({ tone: 'error', text: 'Enter a valid email address.' });
      return;
    }
    setCreateBusy(true);
    setCreateMsg(null);
    setCreatedAccount(null);
    setCopied(false);
    try {
      const result = await createStaffAccount({ email, role: createRole, name: createName.trim() });
      setCreateMsg({
        tone: 'success',
        text: result.created
          ? `Account created for ${email} as ${roleLabel(result.role)}.`
          : `${email} already had an account — updated to ${roleLabel(result.role)}.`,
      });
      if (result.tempPassword) setCreatedAccount(result);
      setCreateEmail('');
      setCreateName('');
      onRefresh();
      onUserRoleChanged?.();
    } catch (err) {
      console.error('Failed to create staff account:', err);
      setCreateMsg({ tone: 'error', text: friendlyRoleError(err, 'Could not create this account') });
    } finally {
      setCreateBusy(false);
    }
  };

  const copyTempPassword = async () => {
    if (!createdAccount?.tempPassword) return;
    try {
      await navigator.clipboard.writeText(createdAccount.tempPassword);
      setCopied(true);
    } catch {
      // Clipboard API unavailable/blocked — the password is still shown on screen to copy by hand.
    }
  };

  const pickUser = (user) => {
    setSelectedId(user.id);
    setUserQuery(user.name || user.email || '');
    setActionMsg(null);
  };

  const handleAssign = async (role) => {
    if (!selectedUser || isSelf) return;
    setBusyRole(role);
    setActionMsg(null);
    try {
      await assignStaffRole(
        { id: selectedUser.id, email: selectedUser.email, name: selectedUser.name },
        role,
        actorRole
      );
      setRoleOverrides((prev) => ({
        ...prev,
        [selectedUser.id]: { role, isAdmin: role === 'admin' || role === 'superadmin' },
      }));
      setActionMsg({ tone: 'success', text: `${selectedUser.name || selectedUser.email} is now ${roleLabel(role)}.` });
      onRefresh();
      onUserRoleChanged?.();
    } catch (err) {
      console.error('Failed to assign role:', err);
      setActionMsg({ tone: 'error', text: friendlyRoleError(err, 'Could not update this role') });
    } finally {
      setBusyRole(null);
    }
  };

  const handleRemove = async () => {
    if (!selectedUser || isSelf) return;
    const confirmed = window.confirm(
      `Remove ${selectedUser.name || selectedUser.email} as ${roleLabel(selectedRole)}? They will lose staff access immediately.`
    );
    if (!confirmed) return;
    setBusyRole('remove');
    setActionMsg(null);
    try {
      await removeStaffRole(
        { id: selectedUser.id, email: selectedUser.email, name: selectedUser.name },
        actorRole
      );
      setRoleOverrides((prev) => ({
        ...prev,
        [selectedUser.id]: { role: 'student', isAdmin: false },
      }));
      setActionMsg({ tone: 'success', text: `${selectedUser.name || selectedUser.email}'s staff role was removed.` });
      onRefresh();
      onUserRoleChanged?.();
    } catch (err) {
      console.error('Failed to remove role:', err);
      setActionMsg({ tone: 'error', text: friendlyRoleError(err, 'Could not remove this role') });
    } finally {
      setBusyRole(null);
    }
  };

  return (
    <div className="arl-wrap">
      <div className="arl-main">
        {/* ── Filter bar ── */}
        <div className="arl-filters">
          <div className="arl-field">
            <label>Activity Type</label>
            <select className="sa-select" value={draftType} onChange={(e) => setDraftType(e.target.value)}>
              {activityTypeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="arl-field">
            <label>User Role</label>
            <select className="sa-select" value={draftRole} onChange={(e) => setDraftRole(e.target.value)}>
              {ROLE_FILTER_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="arl-field">
            <label>Date</label>
            <input
              type="date"
              className="arl-date-input"
              value={draftDate}
              onChange={(e) => setDraftDate(e.target.value)}
            />
          </div>
          <button className="sa-export arl-filter-btn" onClick={applyFilters}>
            <FaFilter /> Filter
          </button>
          <button className="sa-icon-btn" onClick={resetFilters} title="Reset filters">
            <FaUndo />
          </button>
        </div>

        {/* ── Search + count ── */}
        <div className="arl-toolbar">
          <h3 className="arl-count">All Activities ({filteredLogs.length})</h3>
          <div className="arl-search-wrap">
            <FaSearch className="arl-search-icon" />
            <input
              className="arl-search-input"
              type="text"
              placeholder="Search user"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <button className="sa-icon-btn" onClick={onRefresh} disabled={loading} title="Refresh">
            <FaSync className={loading ? 'sa-spin' : ''} />
          </button>
        </div>

        {error && <div className="sa-alert">{error}</div>}

        {/* ── Table ── */}
        <div className="sa-table-wrap">
          <table className="sa-table">
            <thead>
              <tr>
                <th>Date &amp; Time</th>
                <th>User</th>
                <th>Role</th>
                <th>Activity/Action</th>
                <th>Details</th>
                <th aria-label="Row actions" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6}><p className="sa-loading">Loading…</p></td></tr>
              ) : pageRows.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <p className="sa-loading">
                      {logs.length === 0
                        ? 'No activity recorded yet — actions taken around the app will start showing up here.'
                        : 'No activity matches these filters.'}
                    </p>
                  </td>
                </tr>
              ) : pageRows.map((log) => (
                <React.Fragment key={log.id}>
                  <tr>
                    <td className="sa-td--date" data-label="Date & Time">{formatDateTime(toDate(log.timestamp))}</td>
                    <td className="sa-td--name" data-label="User">{log.actorName || log.actorEmail || 'Unknown'}</td>
                    <td data-label="Role">
                      <span className={`sa-role sa-role--${log.actorRole || 'student'}`}>{roleLabel(log.actorRole)}</span>
                    </td>
                    <td data-label="Activity/Action">{log.type}</td>
                    <td data-label="Details" className="arl-details">{log.details}</td>
                    <td data-label="">
                      <button
                        className="arl-row-menu"
                        onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
                        aria-label="Toggle details"
                      >
                        <FaEllipsisV />
                      </button>
                    </td>
                  </tr>
                  {expandedId === log.id && (
                    <tr className="arl-expanded-row">
                      <td colSpan={6}>
                        <div className="arl-expanded">
                          <span><strong>Target:</strong> {log.targetType || '—'}{log.targetLabel ? ` (${log.targetLabel})` : ''}</span>
                          <span><strong>Actor email:</strong> {log.actorEmail || '—'}</span>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>

        {/* ── Pagination ── */}
        {filteredLogs.length > 0 && (
          <div className="arl-pagination">
            <span className="arl-pagination__caption">
              Showing {pageStart + 1} to {Math.min(pageStart + PAGE_SIZE, filteredLogs.length)} of {filteredLogs.length} entries
            </span>
            <div className="arl-pagination__pages">
              <button className="sa-icon-btn" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>
                <FaChevronLeft />
              </button>
              {pageNumbers.map((n) => (
                <button
                  key={n}
                  className={`arl-page-btn ${n === currentPage ? 'arl-page-btn--active' : ''}`}
                  onClick={() => setPage(n)}
                >
                  {n}
                </button>
              ))}
              <button className="sa-icon-btn" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>
                <FaChevronRight />
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="arl-aside-stack">
      {/* ── Manage user role ── */}
      <aside className="sa-card arl-role-panel">
        <h3 className="arl-role-panel__title">Manage user role</h3>

        <div className="arl-user-picker">
          <input
            type="text"
            placeholder="Search a user by name or email…"
            value={userQuery}
            onChange={(e) => { setUserQuery(e.target.value); setSelectedId(null); setActionMsg(null); }}
          />
          {userQuery.trim() && !selectedUser && userMatches.length > 0 && (
            <ul className="arl-user-suggestions">
              {userMatches.map((u) => (
                <li key={u.id}>
                  <button onClick={() => pickUser(u)}>
                    <span className="arl-user-suggestions__name">{u.name || 'Unnamed'}</span>
                    <span className="arl-user-suggestions__email">{u.email}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {selectedUser ? (
          <>
            <p className="arl-selected-user">
              <strong>{selectedUser.name || selectedUser.email}</strong>
              <span className={`sa-role sa-role--${selectedRole}`}>{roleLabel(selectedRole)}</span>
            </p>

            {isSelf ? (
              <p className="arl-self-note">You can't change your own role here — ask another Super Admin.</p>
            ) : (
              <div className="arl-role-buttons">
                {ROLE_BUTTONS.map(({ role, label, icon: Icon }) => (
                  <button
                    key={role}
                    className="arl-role-btn"
                    disabled={selectedRole === role || busyRole !== null}
                    onClick={() => handleAssign(role)}
                  >
                    <Icon /> {busyRole === role ? 'Working…' : label}
                  </button>
                ))}
                <button
                  className="arl-role-btn arl-role-btn--danger"
                  disabled={selectedRole === 'student' || busyRole !== null}
                  onClick={handleRemove}
                >
                  <FaUserSlash /> {busyRole === 'remove' ? 'Working…' : 'Remove'}
                </button>
              </div>
            )}

            {actionMsg && (
              <p className={`arl-action-msg arl-action-msg--${actionMsg.tone}`}>{actionMsg.text}</p>
            )}
          </>
        ) : (
          <p className="arl-role-panel__hint">Search for a user above to assign or remove a staff role.</p>
        )}
      </aside>

      {/* ── Create a new staff account ── */}
      <aside className="sa-card arl-role-panel">
        <h3 className="arl-role-panel__title">Create staff account</h3>
        <form className="arl-create-form" onSubmit={handleCreateAccount}>
          <input
            type="email"
            placeholder="Email address"
            value={createEmail}
            onChange={(e) => setCreateEmail(e.target.value)}
            required
          />
          <input
            type="text"
            placeholder="Full name (optional)"
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
          />
          <select className="sa-select" value={createRole} onChange={(e) => setCreateRole(e.target.value)}>
            <option value="moderator">Moderator</option>
            <option value="admin">Admin</option>
            <option value="superadmin">Super Admin</option>
          </select>
          <button type="submit" className="arl-role-btn" disabled={createBusy}>
            <FaUserPlus /> {createBusy ? 'Creating…' : 'Create account'}
          </button>
        </form>

        {createMsg && (
          <p className={`arl-action-msg arl-action-msg--${createMsg.tone}`}>{createMsg.text}</p>
        )}

        {createdAccount?.tempPassword && (
          <div className="arl-temp-password">
            <p className="arl-role-panel__hint">
              Share this temporary password with {createdAccount.email} out-of-band (not email/chat in
              plaintext if avoidable) — they can change it after logging in via Profile → Change Password.
            </p>
            <div className="arl-temp-password__row">
              <code>{createdAccount.tempPassword}</code>
              <button type="button" className="sa-icon-btn" onClick={copyTempPassword} title="Copy password">
                <FaCopy />
              </button>
            </div>
            {copied && <span className="arl-role-panel__hint">Copied.</span>}
          </div>
        )}
      </aside>
      </div>
    </div>
  );
}
