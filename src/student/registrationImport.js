/* Player registration via Excel: download a template, fill it in, upload it, and
   the registration form is pre-filled from it (the player still reviews and saves).

   Template layout — one sheet, one player: column A is the field name, column B is
   the answer, column C is a hint. Rows are found by their field name in column A, so
   reordering rows is harmless.

   Matching/normalising lives here (no Firebase, no React) so it can be tested. The
   Excel read/write at the bottom loads exceljs on demand, like bulkImport.js. */

import { getCountryCallingCode, parsePhoneNumberFromString } from 'libphonenumber-js';
import { cellText } from '../admin/bulkImport';

export const GENDERS = ['Male', 'Female', 'Others'];

/* key = form field; label = what column A shows; required mirrors the form's validate() */
export const TEMPLATE_FIELDS = [
  { key: 'event',           label: 'Register For Event',        required: true,  hint: 'Pick from the dropdown.' },
  { key: 'fullName',        label: 'Full Name',                 required: true,  hint: 'Last Name, First Name, Middle Name' },
  { key: 'dob',             label: 'Date of Birth',             required: true,  hint: 'Type as yyyy-mm-dd, e.g. 2008-05-14. Age is worked out for you.' },
  { key: 'gender',          label: 'Gender',                    required: true,  hint: 'Pick from the dropdown.' },
  { key: 'phoneCountry',    label: 'Country (Phone Numbers)',   required: false, hint: 'Applies to both phone numbers below. Leave as is for the Philippines.' },
  { key: 'contactNumber',   label: 'Contact Number',            required: true,  hint: 'Your number without the country code, e.g. 9171234567.' },
  { key: 'emergencyName',   label: 'Emergency Contact Name',    required: true,  hint: "Contact person's name." },
  { key: 'emergencyNumber', label: 'Emergency Contact Number',  required: true,  hint: 'Their number without the country code.' },
  { key: 'province',        label: 'Province',                  required: true,  hint: 'Pick from the dropdown (use Metro Manila for NCR).' },
  { key: 'municipality',    label: 'City / Municipality',       required: true,  hint: 'Pick from the dropdown — choose the Province first.' },
  { key: 'barangay',        label: 'Barangay',                  required: true,  hint: 'Pick from the dropdown — choose the City / Municipality first.' },
  { key: 'street',          label: 'House No. / Street / Unit', required: false, hint: 'Optional.' },
  { key: 'gradeLevel',      label: 'Grade / Year Level',        required: true,  hint: 'Pick from the dropdown. Decides which teams and sports you can choose.' },
  { key: 'section',         label: 'Section',                   required: true,  hint: 'e.g. Section A' },
  { key: 'teamName',        label: 'Team Name',                 required: true,  hint: 'Pick from the dropdown — choose the Grade / Year Level first.' },
  { key: 'sport',           label: 'Sport / Event',             required: true,  hint: "Pick from the dropdown — choose the Team first (it lists only that team's sports)." },
  { key: 'position',        label: 'Position',                  required: true,  hint: 'Pick from the dropdown — choose the Sport first. Individual sports use "Player".' },
  { key: 'message',         label: 'Message',                   required: false, hint: 'Optional.' },
];

const norm = (v) => String(v ?? '').trim().toLowerCase();
const key = (v) => norm(v).replace(/[^a-z0-9]/g, '');
const labelToField = new Map(TEMPLATE_FIELDS.map(f => [key(f.label), f.key]));

/* Find the option whose keys match `raw`: exact first, then a loose match that
   only counts when it is unambiguous. `keysOf(option)` returns the strings to compare. */
function findOption(options, raw, keysOf) {
  const k = key(raw);
  if (!k) return null;
  const exact = options.find(o => keysOf(o).some(s => key(s) === k));
  if (exact) return exact;
  const loose = options.filter(o => keysOf(o).some(s => { const sk = key(s); return sk.length > 2 && (sk.startsWith(k) || k.startsWith(sk)); }));
  return loose.length === 1 ? loose[0] : null;
}

/* "Angeles City" / "City of Angeles" / "Angeles" all name the same place */
const bareCityName = (s) => key(s).replace(/^cityof/, '').replace(/city$/, '');
const bareBarangayName = (s) => key(s).replace(/^(brgy|barangay)/, '');

function findByBareName(options, raw, bare) {
  const k = bare(raw);
  if (!k) return null;
  const hits = options.filter(o => bare(o.name) === k);
  return hits.length === 1 ? hits[0] : null;
}

export function resolveGrade(raw, gradeOptions) {
  return findOption(gradeOptions, raw, o => [o.value, o.label])?.value || '';
}

/* Turn whatever was typed into the digits the form's National Number box wants. */
export function nationalDigits(raw, country) {
  const text = String(raw ?? '').trim();
  let d = text.replace(/\D/g, '');
  if (!d) return '';
  let cc;
  try { cc = String(getCountryCallingCode(country)); } catch { return d; }
  if (text.startsWith('+') && d.startsWith(cc)) d = d.slice(cc.length);
  else if (d.startsWith(`00${cc}`)) d = d.slice(cc.length + 2);
  else if (d.startsWith('0') && parsePhoneNumberFromString(d.slice(1), country)?.isValid()) d = d.slice(1); // trunk "0" — the form adds +cc itself
  return d;
}

/* Excel dates arrive as ISO strings (see cellText); typed dates should be yyyy-mm-dd. */
export function parseDob(raw) {
  const text = String(raw ?? '').trim();
  /* a real Excel date in a text-formatted cell comes through as its serial day number */
  if (/^\d{5}$/.test(text)) {
    return new Date(Date.UTC(1899, 11, 30) + Number(text) * 86400000).toISOString().slice(0, 10);
  }
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    const [, y, m, d] = iso;
    const date = new Date(Date.UTC(+y, +m - 1, +d));
    if (date.getUTCFullYear() === +y && date.getUTCMonth() === +m - 1 && date.getUTCDate() === +d) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    return '';
  }
  /* "May 14, 2008" style only — numeric d/m vs m/d is ambiguous, so it is refused */
  if (/[a-z]/i.test(text)) {
    const t = Date.parse(text);
    if (!Number.isNaN(t)) {
      const d = new Date(t);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
  }
  return '';
}

/* Match the uploaded answers against what the form actually offers.
   raw:  { fieldKey: string } as read from the sheet.
   ctx:  { events:[{key,label}], gradeOptions:[{value,label}], countries:[{code,name,callingCode}],
           address:{ provinces:[{name,psgcCode}], municipalitiesOf(code), barangaysOf(code) },
           sports:[{name,positions}], teams:[{name,sportIds}],   (sports/teams = the grade's level)
           currentGrade?, currentCountry? }                      (what the form already has)
   Returns { form, addr, warnings }: only fields that were filled AND recognised are set,
   so anything else stays as the player already has it in the form. */
export function resolveRegistration(raw, ctx) {
  const warnings = [];
  const form = {};
  const addr = {};
  const has = (k) => String(raw[k] ?? '').trim() !== '';
  const bad = (label, value, why = "isn't an available option") => warnings.push(`${label} "${value}" ${why} — left blank.`);
  const labelOf = (k) => TEMPLATE_FIELDS.find(f => f.key === k).label;

  if (has('event')) {
    const ev = findOption(ctx.events, raw.event, e => [e.label, e.key]);
    if (ev) form.event = ev.label; else bad(labelOf('event'), raw.event);
  }
  if (has('fullName')) form.fullName = String(raw.fullName).trim();
  if (has('dob')) {
    const dob = parseDob(raw.dob);
    if (dob) form.dob = dob; else bad(labelOf('dob'), raw.dob, "isn't a date I can read (use yyyy-mm-dd)");
  }
  if (has('gender')) {
    const g = findOption(GENDERS.map(name => ({ name })), raw.gender, o => [o.name, o.name === 'Others' ? 'Other' : o.name]);
    if (g) form.gender = g.name; else bad(labelOf('gender'), raw.gender);
  }

  let country = ctx.currentCountry || 'PH';
  if (has('phoneCountry')) {
    const c = findOption(ctx.countries, raw.phoneCountry, o => [o.code, o.name, `${o.name} (+${o.callingCode})`]);
    if (c) { form.phoneCountry = c.code; country = c.code; } else bad(labelOf('phoneCountry'), raw.phoneCountry);
  }
  if (has('contactNumber')) form.contactNumberNational = nationalDigits(raw.contactNumber, country);
  if (has('emergencyName')) form.emergencyContactName = String(raw.emergencyName).trim();
  if (has('emergencyNumber')) form.emergencyContactNational = nationalDigits(raw.emergencyNumber, country);

  /* address cascades: each level is only looked up inside the one above it */
  let province = null, municipality = null;
  if (has('province')) {
    province = findOption(ctx.address.provinces, raw.province, p => [p.name]);
    if (province) addr.provinceCode = province.psgcCode; else bad(labelOf('province'), raw.province);
  }
  if (has('municipality')) {
    if (!province) warnings.push(`City / Municipality "${raw.municipality}" needs a valid Province — left blank.`);
    else {
      const list = ctx.address.municipalitiesOf(province.psgcCode) || [];
      municipality = findOption(list, raw.municipality, m => [m.name]) || findByBareName(list, raw.municipality, bareCityName);
      if (municipality) addr.municipalityCode = municipality.psgcCode;
      else bad(labelOf('municipality'), raw.municipality, `wasn't found in ${province.name}`);
    }
  }
  if (has('barangay')) {
    if (!municipality) warnings.push(`Barangay "${raw.barangay}" needs a valid City / Municipality — left blank.`);
    else {
      const list = ctx.address.barangaysOf(municipality.psgcCode) || [];
      const b = findOption(list, raw.barangay, o => [o.name]) || findByBareName(list, raw.barangay, bareBarangayName);
      if (b) addr.barangayCode = b.psgcCode; else bad(labelOf('barangay'), raw.barangay, `wasn't found in ${municipality.name}`);
    }
  }
  if (has('street')) addr.street = String(raw.street).trim();

  /* a sheet with no grade still resolves team/sport against the grade already on the form */
  let grade = ctx.currentGrade || '';
  if (has('gradeLevel')) {
    grade = resolveGrade(raw.gradeLevel, ctx.gradeOptions);
    if (grade) form.gradeLevel = grade; else bad(labelOf('gradeLevel'), raw.gradeLevel);
  }
  if (has('section')) form.section = String(raw.section).trim();

  /* team / sport / position only make sense against the grade's own level */
  if (has('teamName') || has('sport') || has('position')) {
    if (!grade) {
      warnings.push('Team, Sport and Position were skipped — they depend on a valid Grade / Year Level.');
    } else {
      const team = has('teamName') ? findOption(ctx.teams, raw.teamName, t => [t.name]) : null;
      if (has('teamName')) { if (!team) bad(labelOf('teamName'), raw.teamName, "isn't a team for this grade's level"); }

      let sport = has('sport') ? findOption(ctx.sports, raw.sport, s => [s.name]) : null;
      if (has('sport') && !sport) bad(labelOf('sport'), raw.sport, "isn't a sport for this grade's level");

      const teamPlays = (t, s) => !(t.sportIds || []).length || t.sportIds.includes(s.name);
      let keptTeam = team;
      if (team && sport && !teamPlays(team, sport)) {
        warnings.push(`Team "${team.name}" doesn't play ${sport.name} — Team left blank.`);
        keptTeam = null;
      }
      if (keptTeam) form.teamName = keptTeam.name;
      if (sport) form.sport = sport.name;

      if (has('position')) {
        if (!sport) warnings.push(`Position "${raw.position}" needs a valid Sport — left blank.`);
        else {
          const options = (sport.positions || []).length ? sport.positions : ['Player'];
          const p = findOption(options.map(name => ({ name })), raw.position, o => [o.name]);
          if (p) form.position = p.name; else bad(labelOf('position'), raw.position, `isn't a ${sport.name} position (${options.join(', ')})`);
        }
      }
    }
  }
  if (has('message')) form.message = String(raw.message).trim();

  return { form, addr, warnings };
}

/* ── Excel I/O ── */

/* → { raw: { fieldKey: string }, extraRows } from the filled-in sheet.
   Headers are in row 1 (matched by name, so column order doesn't matter); the player's
   answers are the first filled row under them. Rows after that are ignored and counted. */
export async function readRegistrationWorkbook(file) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const ws = wb.worksheets.find(s => /registration/i.test(s.name)) || wb.worksheets[0];
  if (!ws) throw new Error('The workbook has no sheets.');

  const cols = {}; // fieldKey -> column number
  const headerRow = ws.getRow(1);
  for (let c = 1; c <= headerRow.cellCount; c++) {
    const field = labelToField.get(key(cellText(headerRow.getCell(c).value)));
    if (field && !(field in cols)) cols[field] = c;
  }
  if (!Object.keys(cols).length) {
    throw new Error("This doesn't look like the registration template — download a fresh one and fill in the row under the headers.");
  }

  let raw = null, extraRows = 0;
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n < 2) return;
    const values = Object.fromEntries(Object.entries(cols).map(([f, c]) => [f, cellText(row.getCell(c).value).trim()]));
    if (!Object.values(values).some(Boolean)) return;
    if (!raw) raw = values; else extraRows++;
  });
  if (!raw) throw new Error('No answers found — fill in the row under the headers on the Registration sheet.');
  return { raw, extraRows };
}

/* events:[label]  grades:[{label, level}]  countries:[label]
   address: { provinces:[{name,psgcCode}], municipalitiesOf(code), barangaysOf(code) }
   levels:  [{ key, label, teams:[{name,sportIds}], sports:[{name,positions}] }]
   Same look as the sports/teams templates: headers across row 1, answers typed in the row below,
   a "how to fill" panel on the right. Every choice field is a dropdown. City/Barangay follow
   Province/City, and Team/Sport/Position follow Grade/Team/Sport, exactly like the form — via helper
   cells that build a lookup key and OFFSET/MATCH over blocks of values on the hidden Cascade sheet. */
export async function downloadRegistrationTemplate({ events, grades, countries, address, levels = [] }) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();

  const solid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
  const NAVY = 'FF001529', GOLD = 'FFFFF3D6', GREY = 'FFF1F3F6';
  const thin = { style: 'thin', color: { argb: 'FFC9CED8' } };
  const box = { top: thin, left: thin, bottom: thin, right: thin };
  const ANSWER_ROW = 2;
  const colOf = (k) => TEMPLATE_FIELDS.findIndex(f => f.key === k) + 1;

  /* Visible sheets first, hidden helper sheets after — Excel opens on the first sheet, and a hidden
     first sheet would be shown. */
  const ws = wb.addWorksheet('Registration');
  const hasRef = levels.some(l => l.teams.length || l.sports.length);
  const ref = hasRef ? wb.addWorksheet('Teams & Sports') : null;
  const lists = wb.addWorksheet('Lists', { state: 'hidden' });
  const cascade = wb.addWorksheet('Cascade', { state: 'hidden' });
  const answer = (k) => `Registration!$${ws.getColumn(colOf(k)).letter}$${ANSWER_ROW}`;

  /* dropdown sources — a list formula string is capped at 255 chars, so they live on Lists */
  const provinces = address.provinces.map(p => p.name);
  const sources = { event: events, gender: GENDERS, phoneCountry: countries, province: provinces, gradeLevel: grades.map(g => g.label) };
  const range = {};
  Object.entries(sources).forEach(([k, values], col) => {
    values.forEach((v, i) => { lists.getCell(i + 1, col + 1).value = v; });
    const letter = lists.getColumn(col + 1).letter;
    range[k] = `Lists!$${letter}$1:$${letter}$${Math.max(values.length, 1)}`;
  });
  /* grade label -> school level key, beside the grade list (columns E and G) */
  grades.forEach((g, i) => { lists.getCell(i + 1, 7).value = g.level || ''; });

  /* helper cells (column I): the lookup key each dependent dropdown asks for */
  const KEY = { level: 'Lists!$I$1', team: 'Lists!$I$2', sport: 'Lists!$I$3', position: 'Lists!$I$4', muni: 'Lists!$I$5', brgy: 'Lists!$I$6' };
  const gradeCol = range.gradeLevel.replace(/^Lists!/, '');
  const levelCol = gradeCol.replace(/\$E\$/g, '$G$');
  lists.getCell('I1').value = { formula: `IFERROR(INDEX(${levelCol},MATCH(${answer('gradeLevel')},${gradeCol},0)),"")` };
  lists.getCell('I2').value = { formula: `IF(${KEY.level}="","","T|"&${KEY.level})` };
  lists.getCell('I3').value = { formula: `IF(${KEY.level}="","",IF(${answer('teamName')}="","S|"&${KEY.level},"S|"&${KEY.level}&"|"&${answer('teamName')}))` };
  lists.getCell('I4').value = { formula: `IF(OR(${KEY.level}="",${answer('sport')}=""),"","P|"&${KEY.level}&"|"&${answer('sport')})` };
  lists.getCell('I5').value = { formula: `"M|"&${answer('province')}` };
  lists.getCell('I6').value = { formula: `"B|"&${answer('province')}&"|"&${answer('municipality')}` };

  /* Cascade sheet: one column per block — row 1 key, row 2 how many, rows 3+ the values */
  let nextCol = 1;
  const addBlock = (blockKey, values) => {
    if (!values.length) return;
    cascade.getCell(1, nextCol).value = blockKey;
    cascade.getCell(2, nextCol).value = values.length;
    values.forEach((v, i) => { cascade.getCell(3 + i, nextCol).value = v; });
    nextCol++;
  };
  levels.forEach(({ key: lv, teams, sports }) => {
    if (!lv) return;
    addBlock(`T|${lv}`, teams.map(t => t.name));
    sports.forEach(s => addBlock(`P|${lv}|${s.name}`, (s.positions || []).length ? s.positions : ['Player']));
    addBlock(`S|${lv}`, sports.map(s => s.name));
    /* a team only offers the sports it plays; one with none set plays everything */
    teams.forEach(t => {
      const own = (t.sportIds || []).length ? sports.filter(s => t.sportIds.includes(s.name)) : sports;
      addBlock(`S|${lv}|${t.name}`, own.map(s => s.name));
    });
  });
  address.provinces.forEach(p => {
    const munis = address.municipalitiesOf(p.psgcCode) || [];
    addBlock(`M|${p.name}`, munis.map(m => m.name));
    munis.forEach(m => addBlock(`B|${p.name}|${m.name}`, (address.barangaysOf(m.psgcCode) || []).map(b => b.name)));
  });
  const lastCol = cascade.getColumn(Math.max(nextCol - 1, 1)).letter;
  const headers = `Cascade!$A$1:$${lastCol}$1`;
  const counts = `Cascade!$A$2:$${lastCol}$2`;
  const dependent = (keyCell) => {
    const at = `MATCH(${keyCell},${headers},0)`;
    return `OFFSET(Cascade!$A$3,0,${at}-1,INDEX(${counts},${at}),1)`;
  };
  const dependentRange = {
    municipality: dependent(KEY.muni), barangay: dependent(KEY.brgy),
    teamName: dependent(KEY.team), sport: dependent(KEY.sport), position: dependent(KEY.position),
  };

  /* ── REGISTRATION: header row across the top, the player's answers in the row below ── */
  const WIDTHS = {
    event: 20, fullName: 30, dob: 16, gender: 12, phoneCountry: 26, contactNumber: 18, emergencyName: 26, emergencyNumber: 20,
    province: 20, municipality: 24, barangay: 22, street: 28, gradeLevel: 24, section: 14, teamName: 22, sport: 22, position: 18, message: 30,
  };
  const NOTES = {
    event: 'Click the cell and pick the event from the dropdown arrow.',
    phoneCountry: 'Pick the country for your phone numbers (the +code). It applies to both numbers. Philippines (+63) for most players.',
    contactNumber: 'Your number WITHOUT the country code, e.g. 9171234567.',
    emergencyNumber: 'Their number WITHOUT the country code, e.g. 9181234567.',
    dob: 'Type as yyyy-mm-dd, e.g. 2008-05-14. Your age is worked out for you.',
    municipality: 'Pick your Province first, then choose the city / municipality from the dropdown.',
    barangay: 'Pick your City / Municipality first, then choose the barangay from the dropdown.',
    teamName: 'Pick your Grade / Year Level first, then choose your team from the dropdown.',
    sport: 'Pick your Team first — the dropdown shows only the sports that team plays.',
    position: 'Pick your Sport first, then choose your position. Individual sports use "Player".',
  };
  TEMPLATE_FIELDS.forEach((f, i) => {
    const c = i + 1;
    const head = ws.getCell(1, c);
    head.value = f.required ? `${f.label} *` : f.label;
    head.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
    head.fill = solid(NAVY);
    head.alignment = { vertical: 'middle' };
    head.note = NOTES[f.key] || f.hint;
    ws.getColumn(c).width = WIDTHS[f.key] || 22;

    const cell = ws.getCell(ANSWER_ROW, c);
    cell.border = box;
    cell.fill = solid(GOLD);
    /* text format so a phone number keeps its digits and a date isn't reinterpreted */
    if (['contactNumber', 'emergencyNumber', 'section', 'dob'].includes(f.key)) cell.numFmt = '@';
    if (range[f.key]) {
      cell.dataValidation = {
        type: 'list', allowBlank: true, formulae: [range[f.key]],
        showErrorMessage: true, errorTitle: f.label, error: 'Pick one of the options from the list.',
      };
    } else if (dependentRange[f.key]) {
      /* no hard error: the list is empty until the field it depends on is filled, and anything typed
         that doesn't match is reported (and skipped) at upload */
      cell.dataValidation = { type: 'list', allowBlank: true, formulae: [dependentRange[f.key]], showErrorMessage: false };
    }
  });
  ws.getRow(1).height = 24;
  ws.getRow(ANSWER_ROW).height = 22;
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  /* "how to fill" panel to the right of the typing area */
  const panelCol = TEMPLATE_FIELDS.length + 2;
  ws.getColumn(panelCol - 1).width = 4;
  ws.getColumn(panelCol).width = 80;
  ws.getCell(1, panelCol).value = 'HOW TO FILL THIS SHEET';
  ws.getCell(1, panelCol).font = { bold: true, size: 12 };
  [
    '1. Type in the yellow row (row 2) under the navy headers on the LEFT. Fields marked * are required.',
    '2. Fill it from left to right — some dropdowns depend on the one before them:',
    '     Province → City / Municipality → Barangay',
    '     Grade / Year Level → Team Name → Sport / Event → Position',
    '3. Dropdowns: click the cell and use the arrow that appears on its right.',
    '4. Phone numbers: type them without the country code (pick the country in its own column).',
    '5. This file is for ONE player. Only row 2 is read.',
    '6. Your photo and waiver are not part of this file — attach them on the form after uploading.',
    '7. Save the file, then upload it on the Player Registration page.',
  ].forEach((t, i) => {
    const c = ws.getCell(2 + i, panelCol);
    c.value = t;
    c.fill = solid(GOLD);
  });
  const exRow = 13;
  ws.getCell(exRow, panelCol).value = 'EXAMPLE — for looking only, do not type here:';
  ws.getCell(exRow, panelCol).font = { bold: true, italic: true };
  [
    ['Full Name', 'Dela Cruz, Juan Santos'],
    ['Date of Birth', '2008-05-14'],
    ['Contact Number', '9171234567   (Country: Philippines (+63))'],
    ['City / Municipality', 'Angeles City   (Province: Pampanga)'],
    ['Position', 'Guard   (Sport: Basketball)'],
  ].forEach(([k, v], i) => {
    const c = ws.getCell(exRow + 1 + i, panelCol);
    c.value = `${k}:  ${v}`;
    c.fill = solid(GREY);
    c.font = { italic: true, color: { argb: 'FF5A6478' } };
  });

  /* ── TEAMS & SPORTS: what exists per level, so nothing has to be guessed ── */
  if (ref) {
    ref.columns = [{ width: 32 }, { width: 60 }];
    let r = 1;
    const head = (a, b) => {
      [a, b].forEach((t, i) => {
        const c = ref.getCell(r, i + 1);
        c.value = t; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = solid(NAVY);
      });
      r++;
    };
    levels.forEach(({ label, teams, sports }) => {
      ref.getCell(r, 1).value = label.toUpperCase();
      ref.getCell(r, 1).font = { bold: true, size: 13 };
      r++;
      head('Team Name', 'Sports it plays');
      teams.forEach(t => {
        ref.getCell(r, 1).value = t.name;
        ref.getCell(r, 2).value = (t.sportIds || []).length ? t.sportIds.join(', ') : 'All sports';
        r++;
      });
      r++;
      head('Sport / Event', 'Positions');
      sports.forEach(s => {
        ref.getCell(r, 1).value = s.name;
        ref.getCell(r, 2).value = (s.positions || []).length ? s.positions.join(', ') : 'Player';
        r++;
      });
      r += 2;
    });
  }

  wb.views = [{ activeTab: 0 }];
  const blob = new Blob([await wb.xlsx.writeBuffer()],
    { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'player-registration-template.xlsx';
  a.click();
  URL.revokeObjectURL(url);
}
