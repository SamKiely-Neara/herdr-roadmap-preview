// Pure view model for team roadmap snapshots: no herdr imports.

/** @typedef {{ name: string, short: string, role: "lead" | "member" | "former", preset: string | null,
 *    doing: string[], open: string[], queued: string[], state: "working" | "idle" }} Member */
/** @typedef {{ id: string, title: string, status: string, phase: string | null, prereqs: string[], brief: string,
 *    assignments: Array<{ member: string, from: string, to: string | null }>,
 *    queue: string | null,
 *    log: Array<{ at: string, by: string, change: string }>,
 *    created: string, changed: string,
 *    kind: "done" | "active" | "partial" | "blocked" | "waiting" | "ready" | "parked",
 *    waits: string[],
 *    people: string[],
 *    touched: string[],
 *    owner: string | null,
 *    assignee: string | null
 *  }} Task */
/** @typedef {{ title: string, tasks: Task[] }} Phase */
/** @typedef {{ team: string, members: Member[], phases: Phase[], tasks: Task[] }} RoadmapView */

function shortName(team, name) {
  const prefix = `${team}-`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function taskKind(status, waits) {
  if (status === "done") return "done";
  if (status === "in-progress") return "active";
  if (status === "partial") return "partial";
  if (status === "blocked") return "blocked";
  if (status === "parked") return "parked";
  return waits.length ? "waiting" : "ready";
}

/**
 * Turns a team-roadmap snapshot into what the map draws.
 * snap is the CLI's output, already schema-checked; only the version is re-checked here.
 * @param {{ team: { team: string, lead: { name: string, preset: string },
 *           members: { name: string, preset: string }[] },
 *           roadmap: { schema: 1, rev: number, tasks: object[] } }} snap  output of `team-roadmap snapshot`
 * @returns {RoadmapView}  members: lead, then team.json members, then former assignees; phases in first-seen order
 */
export function toView(snap) {
  if (snap?.roadmap?.schema !== 1) {
    throw new Error(`Unsupported roadmap schema: ${snap?.roadmap?.schema}`);
  }
  const teamName = snap.team.team;
  const rawTasks = snap.roadmap.tasks;
  const statusById = new Map(rawTasks.map((t) => [t.id, t.status]));

  const members = [];
  const memberByName = new Map();
  const addMember = (name, role, preset) => {
    if (memberByName.has(name)) return;
    const entry = {
      name,
      short: shortName(teamName, name),
      role,
      preset,
      doing: [],
      open: [],
      queued: [],
      state: "idle",
    };
    memberByName.set(name, entry);
    members.push(entry);
  };

  addMember(snap.team.lead.name, "lead", snap.team.lead.preset);
  for (const m of snap.team.members) {
    addMember(m.name, "member", m.preset);
  }

  const tasks = [];
  const phases = [];
  const phaseMap = new Map();

  for (const raw of rawTasks) {
    const waits = raw.prereqs.filter((id) => statusById.get(id) !== "done");
    const people = [...new Set(raw.assignments.map((a) => a.member))];
    for (const name of people) addMember(name, "former", null);
    const touched = [...new Set([...people, ...raw.log.map((l) => l.by)])];
    const lastAssignment = raw.assignments.at(-1);
    const activeAssignee = lastAssignment?.to === null ? lastAssignment.member : null;
    // The schema keeps the open assignment last, so the last entry is the owner (active, or else the most recent).
    const owner = lastAssignment?.member ?? null;
    const task = { ...raw, kind: taskKind(raw.status, waits), waits, people, touched, owner, assignee: activeAssignee };
    tasks.push(task);

    if (activeAssignee) {
      const m = memberByName.get(activeAssignee);
      if (raw.status === "in-progress") m.doing.push(raw.id);
      if (raw.status !== "done" && raw.status !== "parked") m.open.push(raw.id);
    } else if (raw.queue && (raw.status === "open" || raw.status === "partial") && waits.length === 0) {
      for (const m of members) {
        if (m.preset === raw.queue) m.queued.push(raw.id);
      }
    }

    const phaseTitle = task.phase ?? "Tasks";
    let phase = phaseMap.get(phaseTitle);
    if (!phase) {
      phase = { title: phaseTitle, tasks: [] };
      phaseMap.set(phaseTitle, phase);
      phases.push(phase);
    }
    phase.tasks.push(task);
  }

  for (const m of members) {
    m.state = m.doing.length ? "working" : "idle";
  }

  return { team: teamName, members, phases, tasks };
}

/** Task ids to highlight for a member: ones they were ever assigned, or claimable by their preset now. */
export function relatedTo(view, memberName) {
  const member = view.members.find((m) => m.name === memberName);
  const ids = new Set(member ? member.queued : []);
  for (const task of view.tasks) {
    if (task.people.includes(memberName)) ids.add(task.id);
  }
  return ids;
}
