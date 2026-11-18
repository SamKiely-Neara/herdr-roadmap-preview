// Derived from roadmap-preview by Nikospy (MIT, see LICENSE).
/** Sets t.d (column) and t.r (row) on every task, in place; returns the grid size { cols, rows }. */

// Columns by dependency depth; a chain keeps its row, a branch takes the next one; tasks with no
// links at all fill a block under the chains, five to a column.
export function layout(tasks) {
  const mine = new Map(tasks.map((t) => [t.id, t]));
  const pre = (t) => t.prereqs.filter((p) => mine.has(p));
  const depth = (t, seen = new Set()) => {
    if (t.d != null) return t.d;
    if (seen.has(t.id)) return 0;
    seen.add(t.id);
    const ps = pre(t);
    return (t.d = ps.length ? 1 + Math.max(...ps.map((p) => depth(mine.get(p), seen))) : 0);
  };
  for (const t of tasks) { t.d = null; t.r = null; }
  tasks.forEach((t) => depth(t));
  const linked = new Set();
  for (const t of tasks) for (const p of pre(t)) { linked.add(t.id); linked.add(p); }
  let rows = 0;
  const place = (t, row) => {
    t.r = row;
    let first = true;
    for (const kid of tasks) {
      if (kid.r != null || pre(kid)[0] !== t.id) continue;
      place(kid, first ? row : rows++);
      first = false;
    }
  };
  for (const t of tasks) if (linked.has(t.id) && t.r == null && !pre(t).length) place(t, rows++);
  for (const t of tasks) if (linked.has(t.id) && t.r == null) place(t, rows++); // a cycle's leftovers
  const loose = tasks.filter((t) => !linked.has(t.id));
  const lcols = Math.ceil(loose.length / 5), lrows = lcols ? Math.ceil(loose.length / lcols) : 0;
  loose.forEach((t, n) => { t.d = Math.floor(n / lrows); t.r = rows + (n % lrows); });
  const cols = Math.max(1, lcols, ...tasks.filter((t) => linked.has(t.id)).map((t) => t.d + 1));
  return { cols, rows: rows + lrows };
}
