import { useEffect, useState } from 'react';
import { formatCountdown } from '../utils/matchTime';

/* "1:05:09 left" until `end` (a Date or ms timestamp), ticking every second.
   Owns its own timer so only this bit of text re-renders each second, not
   the whole page. Shows `doneText` once the time is up. */
export default function MatchCountdown({ end, className = '', suffix = ' left', doneText = 'Time is up' }) {
  const endMs = end instanceof Date ? end.getTime() : Number(end);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!Number.isFinite(endMs)) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [endMs]);

  if (!Number.isFinite(endMs)) return null;
  const left = endMs - now;
  return (
    <span className={className} role="timer" aria-live="off">
      {left > 0 ? `${formatCountdown(left)}${suffix}` : doneText}
    </span>
  );
}
