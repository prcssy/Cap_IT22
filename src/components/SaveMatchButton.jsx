import { useState } from 'react';
import { FaBookmark, FaRegBookmark } from 'react-icons/fa';
import { getCalendarAccessToken, insertCalendarEvent, deleteCalendarEvent } from '../services/googleCalendar';
import { saveMatchReminder, deleteSavedMatch } from '../services/firestoreService';

/* ── "Save Match" toggle: on save, gets a Google Calendar event with a
   ~10-minute-before popup reminder via a separate Google OAuth consent
   (independent of this app's own Firebase Auth). On failure to obtain
   consent, fails silently — the match just stays unsaved. ── */
export default function SaveMatchButton({ match, currentUser, savedInfo, onChange }) {
  const [busy, setBusy] = useState(false);

  if (!currentUser) return null;

  const disabled = !match.date || !match.time;

  async function handleClick() {
    if (busy || disabled) return;
    setBusy(true);
    try {
      if (savedInfo) {
        try {
          const token = await getCalendarAccessToken();
          await deleteCalendarEvent(savedInfo.calendarEventId, token);
        } catch (err) {
          console.warn('Could not remove the Google Calendar event (it may need manual cleanup):', err);
        }
        // Delete the Firestore doc regardless of the Calendar call's
        // outcome, so the app's own UI state stays consistent.
        await deleteSavedMatch(currentUser.uid, match.id);
        onChange(match.id, null);
      } else {
        const token = await getCalendarAccessToken();
        const eventId = await insertCalendarEvent(match, token);
        await saveMatchReminder(currentUser.uid, match.level, match, eventId);
        onChange(match.id, { calendarEventId: eventId });
      }
    } catch (err) {
      console.warn('Save Match failed (Google Calendar authorization may have been denied):', err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={`ms-save-btn ${savedInfo ? 'ms-save-btn--saved' : ''}`}
      onClick={handleClick}
      disabled={disabled || busy}
      aria-pressed={!!savedInfo}
      title={
        disabled
          ? 'This match has no confirmed date/time yet'
          : savedInfo ? 'Remove Calendar reminder' : 'Save Match — get a Calendar reminder'
      }
    >
      {savedInfo ? <FaBookmark /> : <FaRegBookmark />}
    </button>
  );
}
