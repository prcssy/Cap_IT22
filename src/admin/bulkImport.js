/* Bulk import of sports & teams from an Excel workbook.

   Workbook layout (one workbook, two sheets — either may be omitted):

   "Sports"  Sport | Category | Division | Format | Positions | Violations
             One row per division. Repeat the sport name on each row (or leave it blank to continue the row above); Category
             groups divisions (e.g. MALE / FEMALE). Positions / Violations are
             comma- or semicolon-separated and may sit on any row of the sport.
   "Teams"   Team | Sports
             Sports is a comma-separated list of sport names, or ALL.

   Pure parsing/merging lives here (no Firebase, no React) so it can be tested. */

export const FORMAT_OPTIONS = [
  { id: 'single-time',  label: '1 vs 1 (Time Basis)' },
  { id: 'single-solo',  label: '1 vs 1 (Point Basis)' },
  { id: 'single-group', label: '1 vs Many (Time Basis)' },
  { id: 'team-play',    label: '1 vs Many (Point Basis)' },
];

export const TEAM_COLORS = ['#b45309','#dc2626','#15803d','#6d28d9','#92400e','#9f1239','#374151','#ea580c'];

const uid = () => Math.random().toString(36).slice(2, 10);
const norm = (v) => String(v ?? '').trim().toLowerCase();
const key = (v) => norm(v).replace(/[^a-z0-9]/g, '');
const splitList = (v) => String(v ?? '').split(/[,;\n]/).map(s => s.trim()).filter(Boolean);

const SPORT_HEADERS = {
  sport: ['sport', 'sports', 'sportname', 'sportsname'],
  category: ['category', 'categories', 'group'],
  division: ['division', 'divisions', 'event', 'categorydivision'],
  format: ['format', 'sportformat', 'sportsformat'],
  positions: ['positions', 'position', 'positiontypes'],
  violations: ['violations', 'violation', 'violationtypes'],
  logo: ['logo', 'image', 'picture'],
};
const TEAM_HEADERS = {
  team: ['team', 'teams', 'teamname'],
  sports: ['sports', 'sport', 'sportsplayed', 'sportlist'],
  logo: ['logo', 'image', 'picture'],
};

/* header text -> canonical field, for one row of headers */
function mapHeaders(headerCells, spec) {
  const map = {};
  headerCells.forEach((h, i) => {
    const k = key(h);
    for (const [field, aliases] of Object.entries(spec)) {
      if (!(field in map) && aliases.includes(k)) map[field] = i;
    }
  });
  return map;
}

function rowsToObjects(matrix, spec, logosByRow = {}) {
  if (!matrix.length) return [];
  const map = mapHeaders(matrix[0].cells, spec);
  return matrix.slice(1)
    .map(({ n, cells }) => ({
      ...Object.fromEntries(Object.keys(map).map(f => [f, String(cells[map[f]] ?? '').trim()])),
      logo: logosByRow[n] || null,
    }))
    .filter(r => Object.values(r).some(Boolean));
}

/* Accepts the format id, its full label, or a loose "time"/"point" hint. */
export function resolveFormat(raw) {
  const k = key(raw);
  if (!k) return '';
  const exact = FORMAT_OPTIONS.find(f => key(f.id) === k || key(f.label) === k);
  if (exact) return exact.id;
  const many = /many|group/.test(k);
  const time = /time/.test(k);
  const point = /point|score/.test(k);
  if (many && time) return 'single-group';
  if (many && point) return 'team-play';
  if (time) return 'single-time';
  if (point) return 'single-solo';
  return null; // unrecognised
}

/* ── Sports ── */
export function parseSports(rows) {
  const warnings = [];
  const bySport = new Map();
  let lastName = ''; // a blank Sport cell continues the sport from the row above

  rows.forEach((r, idx) => {
    const line = idx + 2;
    const name = (r.sport || '').trim() || lastName;
    lastName = name;
    if (!name) { warnings.push(`Sports row ${line}: no sport name — skipped.`); return; }
    const k = norm(name);
    if (!bySport.has(k)) bySport.set(k, { name, groups: new Map(), positions: [], violations: [], logo: null });
    const s = bySport.get(k);
    if (r.logo && !s.logo) s.logo = r.logo;

    splitList(r.positions).forEach(p => { if (!s.positions.some(x => norm(x) === norm(p))) s.positions.push(p); });
    splitList(r.violations).forEach(v => { if (!s.violations.some(x => norm(x) === norm(v))) s.violations.push(v); });

    const category = (r.category || '').trim().toUpperCase();
    const division = (r.division || '').trim();
    if (!category && !division) {
      if (r.format) warnings.push(`Sports row ${line}: format given without a category/division — ignored.`);
      return;
    }
    let format = resolveFormat(r.format);
    if (format === null) {
      warnings.push(`Sports row ${line}: unknown format "${r.format}" — left blank.`);
      format = '';
    }
    const label = category || 'OPEN';
    if (!s.groups.has(label)) s.groups.set(label, []);
    s.groups.get(label).push({ id: uid(), name: division || label, format });
  });

  const sports = [...bySport.values()].map(s => ({
    id: uid(),
    name: s.name,
    logo: s.logo,
    categoryGroups: [...s.groups.entries()].map(([label, divisions]) => ({ id: uid(), label, divisions })),
    violations: s.violations.map(name => ({ id: uid(), name })),
    positions: s.positions,
  }));
  return { sports, warnings };
}

/* ── Teams ── */
export function parseTeams(rows) {
  const warnings = [];
  const byTeam = new Map();
  let lastName = '';
  rows.forEach((r, idx) => {
    const name = (r.team || '').trim() || lastName;
    lastName = name;
    if (!name) { warnings.push(`Teams row ${idx + 2}: no team name — skipped.`); return; }
    const k = norm(name);
    if (!byTeam.has(k)) byTeam.set(k, { name, sports: [], logo: null });
    if (r.logo && !byTeam.get(k).logo) byTeam.get(k).logo = r.logo;
    splitList(r.sports).forEach(sp => byTeam.get(k).sports.push(sp));
  });
  return { teams: [...byTeam.values()], warnings };
}

/* Work out what saving would do, without saving anything.
   Existing entries keep their id/logo/color; uploaded values fill in the rest. */
export function buildImport({ sportRows = [], teamRows = [], existingSports = [], existingTeams = [] }) {
  const parsedSports = parseSports(sportRows);
  const parsedTeams = parseTeams(teamRows);
  const warnings = [...parsedSports.warnings, ...parsedTeams.warnings];

  let addedSports = 0, updatedSports = 0;
  const mergedSports = existingSports.map(s => s);
  parsedSports.sports.forEach(incoming => {
    const at = mergedSports.findIndex(s => norm(s.name) === norm(incoming.name));
    if (at < 0) { mergedSports.push(incoming); addedSports++; return; }
    const old = mergedSports[at];
    mergedSports[at] = {
      ...old,
      logo: incoming.logo || old.logo || null,
      categoryGroups: incoming.categoryGroups.length ? incoming.categoryGroups : old.categoryGroups,
      violations: incoming.violations.length ? incoming.violations : old.violations,
      positions: incoming.positions.length ? incoming.positions : old.positions,
    };
    updatedSports++;
  });

  const canonicalSport = new Map(mergedSports.map(s => [norm(s.name), s.name]));
  let addedTeams = 0, updatedTeams = 0;
  const mergedTeams = existingTeams.map(t => t);
  parsedTeams.teams.forEach(incoming => {
    let sportIds = [];
    const wantsAll = incoming.sports.some(s => norm(s) === 'all');
    if (wantsAll) {
      sportIds = mergedSports.map(s => s.name);
    } else {
      incoming.sports.forEach(sp => {
        const known = canonicalSport.get(norm(sp));
        if (known) { if (!sportIds.includes(known)) sportIds.push(known); }
        else warnings.push(`Team "${incoming.name}": sport "${sp}" doesn't exist — not assigned.`);
      });
    }
    const at = mergedTeams.findIndex(t => norm(t.name) === norm(incoming.name));
    if (at < 0) {
      mergedTeams.push({
        id: uid(), name: incoming.name, logo: incoming.logo, sportIds,
        color: TEAM_COLORS[mergedTeams.length % TEAM_COLORS.length],
      });
      addedTeams++;
    } else {
      const old = mergedTeams[at];
      mergedTeams[at] = { ...old, logo: incoming.logo || old.logo || null, sportIds: [...new Set([...(old.sportIds || []), ...sportIds])] };
      updatedTeams++;
    }
  });

  return {
    sports: mergedSports, teams: mergedTeams, warnings,
    summary: { addedSports, updatedSports, addedTeams, updatedTeams },
    incomingSports: parsedSports.sports,
    incomingTeams: parsedTeams.teams,
    hasSports: parsedSports.sports.length > 0,
    hasTeams: parsedTeams.teams.length > 0,
  };
}

/* ── Excel I/O (exceljs is loaded on demand so it stays out of the main bundle) ── */
function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map(t => t.text).join('');
    if ('result' in v) return cellText(v.result);
    if ('text' in v) return cellText(v.text);
    if (v instanceof Date) return v.toISOString();
    return '';
  }
  return String(v);
}

function sheetMatrix(ws) {
  const out = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    const cells = [];
    for (let c = 1; c <= row.cellCount; c++) cells.push(cellText(row.getCell(c).value));
    out.push({ n, cells });
  });
  return out;
}

/* Same 80x80 navy-backed JPEG the manual logo upload produces */
async function imageToLogo(buffer, extension) {
  const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' }[extension] || 'image/png';
  const bitmap = await createImageBitmap(new Blob([buffer], { type: mime }));
  const SIZE = 80;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#001529';
  ctx.fillRect(0, 0, SIZE, SIZE);
  const scale = Math.min(SIZE / bitmap.width, SIZE / bitmap.height);
  ctx.drawImage(bitmap, (SIZE - bitmap.width * scale) / 2, (SIZE - bitmap.height * scale) / 2, bitmap.width * scale, bitmap.height * scale);
  return canvas.toDataURL('image/jpeg', 0.75);
}

/* Pictures pasted into the sheet's Logo column, keyed by Excel row number */
async function logosByRow(wb, ws, spec) {
  const matrix = sheetMatrix(ws);
  if (!matrix.length) return {};
  const logoCol = mapHeaders(matrix[0].cells, spec).logo;
  if (logoCol == null) return {};
  const out = {};
  for (const img of ws.getImages()) {
    const tl = img.range?.tl;
    if (!tl || Math.floor(tl.nativeCol ?? tl.col) !== logoCol) continue;
    const row = Math.floor(tl.nativeRow ?? tl.row) + 1;
    const media = wb.getImage(img.imageId);
    if (!media || out[row]) continue;
    try { out[row] = await imageToLogo(media.buffer, media.extension); } catch { /* unreadable picture — skip it */ }
  }
  return out;
}

/* scope: 'sports' | 'teams' reads only that sheet; anything else reads both */
export async function readBulkWorkbook(file, scope = 'both') {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());

  const sheets = wb.worksheets;
  let sportsWs = sheets.find(ws => /sport/i.test(ws.name) && !/team/i.test(ws.name));
  let teamsWs = sheets.find(ws => /team/i.test(ws.name));
  if (!sportsWs && !teamsWs) {
    if (scope === 'teams') teamsWs = sheets[0];
    else [sportsWs, teamsWs] = sheets;
  }
  if (!sportsWs && !teamsWs) throw new Error('The workbook has no sheets.');
  if (teamsWs === sportsWs) teamsWs = null;
  if (scope === 'sports') teamsWs = null;
  if (scope === 'teams') sportsWs = null;

  const read = async (ws, spec) => (ws
    ? rowsToObjects(sheetMatrix(ws), spec, await logosByRow(wb, ws, spec).catch(() => ({})))
    : []);
  return {
    sportRows: await read(sportsWs, SPORT_HEADERS),
    teamRows: await read(teamsWs, TEAM_HEADERS),
  };
}

/* scope: 'sports' | 'teams' downloads just that sheet; anything else gives both */
export async function downloadBulkTemplate(scope = 'both') {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();

  const solid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
  const NAVY = 'FF001529', GOLD = 'FFFFF3D6', GREY = 'FFF1F3F6';
  const thin = { style: 'thin', color: { argb: 'FFC9CED8' } };
  const box = { top: thin, left: thin, bottom: thin, right: thin };

  /* Header row of the area you type in, plus a note on each header */
  const styleHeader = (ws, cols, notes) => {
    cols.forEach((c, i) => {
      const cell = ws.getCell(1, i + 1);
      cell.value = c.header;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
      cell.fill = solid(NAVY);
      cell.alignment = { vertical: 'middle' };
      if (notes[i]) cell.note = notes[i];
      ws.getColumn(i + 1).width = c.width;
    });
    ws.getRow(1).height = 24;
    /* light bordered blank cells so it is obvious where to type */
    for (let r = 2; r <= 21; r++) for (let c = 1; c <= cols.length; c++) ws.getCell(r, c).border = box;
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };

  /* The "how to fill" box on the right — starts at column H, so it never overlaps the typing area */
  const sidePanel = (ws, startCol, title, steps) => {
    ws.getColumn(startCol - 1).width = 4;
    const t = ws.getCell(1, startCol);
    t.value = title;
    t.font = { bold: true, size: 12 };
    steps.forEach((s, i) => {
      const c = ws.getCell(2 + i, startCol);
      c.value = s;
      c.fill = solid(GOLD);
    });
  };

  /* ── SPORTS (opens first) ── */
  const sports = wb.addWorksheet('Sports');
  styleHeader(sports, [
    { header: 'Sport', width: 20 }, { header: 'Category', width: 14 }, { header: 'Division', width: 22 },
    { header: 'Format', width: 26 }, { header: 'Positions', width: 34 }, { header: 'Violations', width: 30 }, { header: 'Logo', width: 16 },
  ], [
    'Name of the sport, e.g. Volleyball. Leave blank to keep the sport from the row above.',
    'The group, e.g. Men, Women or Mixed.',
    'e.g. Senior, Junior, 100m Dash.',
    'Click the cell and pick from the dropdown arrow.',
    'Optional. Player positions separated by commas. Type once per sport.',
    'Optional. Violation types separated by commas. Type once per sport.',
    'Optional. Copy a picture (Insert > Pictures), then drop it so it sits inside this cell. One logo per sport.',
  ]);
  for (let r = 2; r <= 300; r++) {
    sports.getCell(`D${r}`).dataValidation = {
      type: 'list', allowBlank: true,
      formulae: [`"${FORMAT_OPTIONS.map(f => f.label).join(',')}"`],
      showErrorMessage: true, errorTitle: 'Format', error: 'Pick one of the formats from the list.',
    };
  }
  sidePanel(sports, 9, 'HOW TO FILL THIS SHEET', [
    '1. Type in the blue-headed columns on the LEFT, starting at row 2.',
    '2. One row = one division. A sport with 4 divisions uses 4 rows.',
    '3. Sport: type it on the first row, then leave it blank to repeat it.',
    '4. Format: click the cell and choose from the dropdown.',
    '5. Positions / Violations: optional — type once, separate with commas.',
    '6. Logo: optional — Insert > Pictures, and place the picture inside the Logo cell.',
    '7. Then fill the Teams tab, save, and upload.',
  ]);
  sports.getCell('I10').value = 'EXAMPLE — for looking only, do not type here:';
  sports.getCell('I10').font = { bold: true, italic: true };
  const exHead = ['Sport', 'Category', 'Division', 'Format', 'Positions', 'Violations'];
  const exRows = [
    ['Basketball', 'Men', 'Senior', '1 vs 1 (Point Basis)', 'Guard, Forward', 'Foul'],
    ['', 'Men', 'Junior', '1 vs 1 (Point Basis)', '', ''],
    ['', 'Women', 'Senior', '1 vs 1 (Point Basis)', '', ''],
    ['Swimming', 'Men', '50m Free', '1 vs 1 (Time Basis)', '', ''],
  ];
  [exHead, ...exRows].forEach((row, i) => row.forEach((v, j) => {
    const c = sports.getCell(11 + i, 9 + j);
    c.value = v;
    c.fill = solid(GREY);
    c.font = { italic: i > 0, bold: i === 0, color: { argb: 'FF5A6478' } };
    c.border = box;
  }));
  [20, 14, 22, 26, 18, 14].forEach((w, i) => { sports.getColumn(9 + i).width = w; });

  /* ── TEAMS ── */
  const teams = wb.addWorksheet('Teams');
  styleHeader(teams, [{ header: 'Team', width: 24 }, { header: 'Sports', width: 40 }, { header: 'Logo', width: 16 }], [
    'Name of the team, e.g. Red Dragons.',
    'Sports this team plays, separated by commas — or type ALL for every sport.',
    'Optional. Insert > Pictures, and place the picture inside this cell.',
  ]);
  sidePanel(teams, 5, 'HOW TO FILL THIS SHEET', [
    '1. One row per team, starting at row 2.',
    '2. Sports: list the sports the team plays, separated by commas.',
    '3. Type ALL to put the team in every sport.',
    '4. Sports must be on the Sports tab or already saved.',
    '5. Logo: optional — Insert > Pictures, placed inside the Logo cell.',
    'EXAMPLE — for looking only:',
    'Red Dragons  |  Basketball, Swimming',
    'Blue Eagles  |  ALL',
  ]);
  teams.getColumn(5).width = 60;
  teams.getCell('E7').font = { bold: true, italic: true };

  if (scope === 'sports') wb.removeWorksheet(teams.id);
  if (scope === 'teams') wb.removeWorksheet(sports.id);
  wb.views = [{ activeTab: 0 }];
  const blob = new Blob([await wb.xlsx.writeBuffer()],
    { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = scope === 'sports' ? 'sports-template.xlsx' : scope === 'teams' ? 'teams-template.xlsx' : 'sports-teams-template.xlsx';
  a.click();
  URL.revokeObjectURL(url);
}
