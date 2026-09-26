import { describe, it, expect } from 'vitest';
import {
  RACE_FORMAT_LABEL, isRaceMatch, raceParticipants, buildRaceFields,
  formatRaceTime, ordinal, raceStandingsFromRecord, raceWinnerName, recordCoversRace,
} from './raceFormat';

const teams = ['Red', 'Blue', 'Green', 'Gold', 'Black'].map((name) => ({ name, logo: `${name}.png` }));

describe('buildRaceFields / isRaceMatch', () => {
  const fields = buildRaceFields(teams);
  const match = { id: 'm1', format: RACE_FORMAT_LABEL, ...fields };

  it('packs every team plus the first two as teamA/teamB', () => {
    expect(fields.participants).toHaveLength(5);
    expect(fields.teamA).toBe('Red');
    expect(fields.teamB).toBe('Blue');
    expect(fields.round).toBe(1);
  });

  it('recognises a race, and never a bracket or 1v1 match', () => {
    expect(isRaceMatch(match)).toBe(true);
    expect(isRaceMatch({ teamA: 'A', teamB: 'B', stage: 'Finals' })).toBe(false);
    expect(isRaceMatch({ format: RACE_FORMAT_LABEL, participants: [{ name: 'Only' }] })).toBe(false);
    expect(isRaceMatch(null)).toBe(false);
  });

  it('raceParticipants falls back to the two teams of a normal match', () => {
    expect(raceParticipants(match).map((p) => p.name)).toEqual(['Red', 'Blue', 'Green', 'Gold', 'Black']);
    expect(raceParticipants({ teamA: 'A', teamB: 'B' }).map((p) => p.name)).toEqual(['A', 'B']);
  });
});

describe('formatting', () => {
  it('formats times', () => {
    expect(formatRaceTime(1.5)).toBe('1:30');
    expect(formatRaceTime(61.25)).toBe('1:01:15');
    expect(formatRaceTime(null)).toBeNull();
  });
  it('builds ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd']);
  });
});

describe('results', () => {
  const record = {
    scheduleId: 'm1',
    participants: [
      { name: 'Blue', place: 2, minutes: 1.6 },
      { name: 'Red', place: 1, minutes: 1.5 },
      { name: 'Green', place: 3, minutes: 1.7 },
    ],
  };

  it('orders standings by place and finds the winner', () => {
    expect(raceStandingsFromRecord(record).map((s) => s.name)).toEqual(['Red', 'Blue', 'Green']);
    expect(raceStandingsFromRecord(record)[0].scoreLabel).toBe('1:30');
    expect(raceWinnerName(record)).toBe('Red');
  });

  it('reads a 2-team result from teamA/teamB and the winner flag', () => {
    const two = { winner: 'B', teamA: { name: 'A', points: 3 }, teamB: { name: 'B', points: 5 } };
    expect(raceWinnerName(two)).toBe('B');
    expect(raceStandingsFromRecord(two)[0].scoreLabel).toBe('5 pts');
  });

  it('has no winner without a record or on a tie for first', () => {
    expect(raceWinnerName(null)).toBeNull();
    expect(raceWinnerName({ draw: true, teamA: { name: 'A' }, teamB: { name: 'B' } })).toBeNull();
  });

  it('matches a record to its fixture by scheduleId, else by full roster', () => {
    const match = { id: 'm1', ...buildRaceFields(teams.slice(0, 3)) };
    expect(recordCoversRace(record, match)).toBe(true);
    expect(recordCoversRace({ ...record, scheduleId: 'other' }, match)).toBe(false);
    expect(recordCoversRace({ participants: record.participants }, match)).toBe(true);
    expect(recordCoversRace({ participants: record.participants.slice(0, 2) }, match)).toBe(false);
  });
});
