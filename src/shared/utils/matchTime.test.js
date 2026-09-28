import { describe, it, expect } from 'vitest';
import { matchStart, matchEnd, matchDurationMinutes, formatCountdown, ASSUMED_MATCH_MINUTES, isMatchLive } from './matchTime';

describe('isMatchLive', () => {
  const match = { id: 's1', sport: 'Soccer', teamA: 'Black Beetles', teamB: 'Yellow Rajah', date: '2026-09-28', time: '23:08' };
  const during = new Date('2026-09-28T23:40').getTime();

  it('is live inside its time slot', () => {
    expect(isMatchLive(match, [], during)).toBe(true);
  });

  it('is over once a result is recorded, even mid-slot', () => {
    expect(isMatchLive(match, [{ scheduleId: 's1' }], during)).toBe(false);
    // older record without a scheduleId: same sport, both teams
    const legacy = { sportName: 'soccer', teamA: { name: 'Yellow Rajah' }, teamB: { name: 'black beetles' } };
    expect(isMatchLive(match, [legacy], during)).toBe(false);
  });

  it('is over once the moderator marked it finished', () => {
    expect(isMatchLive({ ...match, finished: true }, [], during)).toBe(false);
  });

  it('ignores a record for a different fixture', () => {
    expect(isMatchLive(match, [{ scheduleId: 'other' }], during)).toBe(true);
  });
});

describe('match end time', () => {
  const match = { date: '2026-09-28', time: '23:08' };

  it('runs the assumed length from its scheduled start', () => {
    expect(matchDurationMinutes(match)).toBe(ASSUMED_MATCH_MINUTES);
    expect(matchEnd(match).getTime() - matchStart(match).getTime()).toBe(ASSUMED_MATCH_MINUTES * 60000);
  });

  it('pushes the end later by the time a moderator added', () => {
    const extended = { ...match, extraMinutes: 30 };
    expect(matchEnd(extended).getTime() - matchEnd(match).getTime()).toBe(30 * 60000);
  });

  it('has no start or end without a date and time', () => {
    expect(matchStart({ date: '2026-09-28' })).toBeNull();
    expect(matchEnd({})).toBeNull();
  });
});

describe('formatCountdown', () => {
  it('shows hours only when there are some', () => {
    expect(formatCountdown((1 * 3600 + 5 * 60 + 9) * 1000)).toBe('1:05:09');
    expect(formatCountdown((45 * 60 + 3) * 1000)).toBe('45:03');
    expect(formatCountdown(9 * 1000)).toBe('0:09');
  });

  it('never goes negative', () => {
    expect(formatCountdown(-5000)).toBe('0:00');
  });
});
