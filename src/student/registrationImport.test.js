import { describe, it, expect } from 'vitest';
import { resolveRegistration, resolveGrade, nationalDigits, parseDob } from './registrationImport';

const ctx = {
  events: [{ key: 'intramurals', label: 'Intramurals' }, { key: 'prisaa', label: 'PRISAA' }],
  gradeOptions: [{ value: 'Grade 7', label: 'Grade 7 (High School)' }, { value: 'Grade 1', label: 'Grade 1 (Elementary)' }],
  countries: [{ code: 'PH', name: 'Philippines', callingCode: '63' }, { code: 'US', name: 'United States', callingCode: '1' }],
  address: {
    provinces: [{ name: 'Pampanga', psgcCode: 'P1' }, { name: 'Metro Manila', psgcCode: 'NCR' }],
    municipalitiesOf: (p) => (p === 'P1' ? [{ name: 'City of Angeles', psgcCode: 'M1' }, { name: 'Mabalacat City', psgcCode: 'M2' }] : []),
    barangaysOf: (m) => (m === 'M1' ? [{ name: 'Balibago', psgcCode: 'B1' }, { name: 'Pulungbulu', psgcCode: 'B2' }] : []),
  },
  sports: [{ name: 'Basketball', positions: ['Guard', 'Forward'] }, { name: 'Chess', positions: [] }],
  teams: [{ name: 'Red Dragons', sportIds: ['Basketball'] }, { name: 'Blue Eagles', sportIds: [] }],
};

describe('nationalDigits', () => {
  it('strips the country code and trunk zero', () => {
    expect(nationalDigits('9171234567', 'PH')).toBe('9171234567');
    expect(nationalDigits('09171234567', 'PH')).toBe('9171234567');
    expect(nationalDigits('+63 917 123 4567', 'PH')).toBe('9171234567');
    expect(nationalDigits('', 'PH')).toBe('');
  });
});

describe('parseDob', () => {
  it('reads ISO and Excel-date strings, refuses ambiguous numeric dates', () => {
    expect(parseDob('2008-05-14')).toBe('2008-05-14');
    expect(parseDob('2008-05-14T00:00:00.000Z')).toBe('2008-05-14');
    expect(parseDob('39582')).toBe('2008-05-14'); // Excel serial
    expect(parseDob('2008-02-31')).toBe('');
    expect(parseDob('03/04/2008')).toBe('');
  });
});

describe('resolveGrade', () => {
  it('accepts the value or the dropdown label', () => {
    expect(resolveGrade('grade 7', ctx.gradeOptions)).toBe('Grade 7');
    expect(resolveGrade('Grade 7 (High School)', ctx.gradeOptions)).toBe('Grade 7');
    expect(resolveGrade('Grade 9', ctx.gradeOptions)).toBe('');
  });
});

describe('resolveRegistration', () => {
  const good = {
    event: 'intramurals', fullName: ' Dela Cruz, Juan ', dob: '2008-05-14', gender: 'male',
    phoneCountry: 'Philippines', contactNumber: '09171234567', emergencyName: 'Maria', emergencyNumber: '9181234567',
    province: 'pampanga', municipality: 'Angeles City', barangay: 'Brgy. Balibago', street: '12 Rizal St',
    gradeLevel: 'Grade 7 (High School)', section: 'A', teamName: 'red dragons', sport: 'Basketball', position: 'guard',
  };

  it('resolves a complete sheet with no warnings', () => {
    const r = resolveRegistration(good, ctx);
    expect(r.warnings).toEqual([]);
    expect(r.form).toMatchObject({
      event: 'Intramurals', fullName: 'Dela Cruz, Juan', dob: '2008-05-14', gender: 'Male', phoneCountry: 'PH',
      contactNumberNational: '9171234567', emergencyContactNational: '9181234567',
      gradeLevel: 'Grade 7', teamName: 'Red Dragons', sport: 'Basketball', position: 'Guard',
    });
    expect(r.addr).toEqual({ provinceCode: 'P1', municipalityCode: 'M1', barangayCode: 'B1', street: '12 Rizal St' });
  });

  it('only sets fields that were filled, and warns on unrecognised ones', () => {
    const r = resolveRegistration({ event: 'Nonsense', gender: 'Male', municipality: 'Angeles City' }, ctx);
    expect(r.form).toEqual({ gender: 'Male' });
    expect(r.warnings.some(w => /Register For Event "Nonsense"/.test(w))).toBe(true);
    expect(r.warnings.some(w => /needs a valid Province/.test(w))).toBe(true);
  });

  it('drops a team that does not play the chosen sport', () => {
    const r = resolveRegistration({ ...good, sport: 'Chess', position: 'Player' }, ctx);
    expect(r.form.teamName).toBeUndefined();
    expect(r.form).toMatchObject({ sport: 'Chess', position: 'Player' });
    expect(r.warnings.some(w => /doesn't play Chess/.test(w))).toBe(true);
  });

  it('skips team/sport/position without a valid grade', () => {
    const r = resolveRegistration({ teamName: 'Red Dragons', sport: 'Basketball' }, ctx);
    expect(r.form).toEqual({});
    expect(r.warnings.some(w => /skipped/.test(w))).toBe(true);
  });
});
