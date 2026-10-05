/* ─────────────────────────────────────────────
   Category / division choices for a sport, as configured in Sports & Teams
   (sport.categoryGroups: [{ id, label, divisions: [{ id, name, format }] }]).

   A group whose only division just repeats the group's own name (Sports &
   Teams saves "MEN" in MEN when no real divisions were filled in) is a
   category with no divisions to choose from — so the registration form
   asks for the category only.
───────────────────────────────────────────── */

const norm = (v) => String(v || '').trim().toLowerCase();

/** Category groups of a sport that have a label, each with its real divisions. */
export function sportCategoryOptions(sport) {
  return (sport?.categoryGroups || [])
    .filter((g) => (g.label || '').trim())
    .map((g) => ({
      id: g.id,
      label: g.label.trim(),
      divisions: (g.divisions || [])
        .filter((d) => (d.name || '').trim() && norm(d.name) !== norm(g.label))
        .map((d) => ({ id: d.id, name: d.name.trim() })),
    }));
}

/** "Male · 5 V 5", "Male", or '' — for showing a registration's pick. */
export function categoryDivisionLabel(reg) {
  return [reg?.category, reg?.division].map((v) => (v || '').trim()).filter(Boolean).join(' · ');
}
