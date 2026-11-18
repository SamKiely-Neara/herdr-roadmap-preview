// Pure view model for team roadmap snapshots: no herdr imports.

/** @typedef {{ name: string, short: string, role: "lead" | "member" | "former", preset: string | null,
 *    doing: string[], open: string[], queued: string[],
 *    live: "working" | "blocked" | "idle" | "offline",
 *    drift: boolean }} Member */
/** @typedef {{ id: string, title: string, status: string, milestone: string | null, prereqs: string[],
 *    blocker: { reason: string, since: string, by: string } | null,
 *    steps: Array<{ text: string, done: boolean }>,
 *    brief: string,
 *    assignments: Array<{ member: string, from: string, to: string | null }>,
 *    queue: string | null,
 *    log: Array<{ at: string, by: string, change: string }>,
 *    created: string, changed: string,
 *    kind: "done" | "active" | "partial" | "blocked" | "waiting" | "ready" | "parked",
 *    waits: string[], neededBy: string[],
 *    people: string[], touched: string[],
 *    owner: string | null, assignee: string | null }} Task */
/** @typedef {{ id: string | null, title: string, goal: string, state: "done" | "active" | "planned",
 *    done: number, total: number, tasks: Task[] }} MilestoneLane */
/** @typedef {{ from: string, to: string, met: boolean, fromKind: string }} Edge */
/** @typedef {{ preset: string, tasks: Task[] }} PresetQueue */
/** @typedef {{ team: string, members: Member[], milestones: MilestoneLane[], tasks: Task[],
 *    edges: Edge[], queues: PresetQueue[] }} RoadmapView */

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

function milestoneState(tasks) {
  if (tasks.length > 0 && tasks.every((t) => t.status === "done" || t.status === "parked")) return "done";
  if (tasks.some((t) => t.status === "in-progress" || t.status === "partial" || t.status === "blocked")) return "active";
  return "planned";
}

/**
 * Live hc state per agent name, for one machine.
 * @param {Array<Record<string, any>>} terms  herdr terminals()
 * @param {string | null} machine  null: this computer (address has no "/"); else addresses "<machine>/…"
 * @returns {Map<string, "working" | "blocked" | "idle">}
 */
export function liveByName(terms, machine) {
  const map = new Map();
  if (!Array.isArray(terms)) return map;
  for (const t of terms) {
    if (!t || t.state !== "live" || typeof t.address !== "string") continue;
    if (machine == null) {
      if (t.address.includes("/")) continue;
    } else if (!t.address.startsWith(`${machine}/`)) {
      continue;
    }
    const name = t.labels?.["agent.name"] ?? t.name;
    if (!name) continue;
    const status = t.status === "working" ? "working" : t.status === "blocked" ? "blocked" : "idle";
    map.set(name, status);
  }
  return map;
}

/**
 * Turns a team-roadmap snapshot + live terminal map into what the map draws.
 * @param {{ team: { team: string, lead: { name: string, preset: string },
 *           members: { name: string, preset: string }[] },
 *           roadmap: { schema: 2, rev: number, milestones: object[], tasks: object[] } }} snap
 * @param {Map<string, "working" | "blocked" | "idle">} [live]
 * @returns {RoadmapView}
 */
export function toView(snap, live = new Map()) {
  if (snap?.roadmap?.schema !== 2) {
    throw new Error(`Unsupported roadmap schema: ${snap?.roadmap?.schema}`);
  }
  const teamName = snap.team.team;
  const rawMilestones = snap.roadmap.milestones ?? [];
  const rawTasks = snap.roadmap.tasks ?? [];
  const statusById = new Map(rawTasks.map((t) => [t.id, t.status]));

  const members = [];
  const memberByName = new Map();
  const presetOrder = [];
  const addPreset = (preset) => {
    if (preset && !presetOrder.includes(preset)) presetOrder.push(preset);
  };
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
      live: "offline",
      drift: false,
    };
    memberByName.set(name, entry);
    members.push(entry);
    if (role !== "former") addPreset(preset);
  };

  addMember(snap.team.lead.name, "lead", snap.team.lead.preset);
  for (const m of snap.team.members) {
    addMember(m.name, "member", m.preset);
  }

  const tasks = [];
  const taskById = new Map();
  const neededByMap = new Map();
  for (const raw of rawTasks) {
    for (const p of raw.prereqs) {
      if (!neededByMap.has(p)) neededByMap.set(p, []);
      neededByMap.get(p).push(raw.id);
    }
  }

  for (const raw of rawTasks) {
    const waits = raw.prereqs.filter((id) => statusById.get(id) !== "done");
    const people = [...new Set(raw.assignments.map((a) => a.member))];
    for (const name of people) addMember(name, "former", null);
    const touched = [...new Set([...people, ...raw.log.map((l) => l.by)])];
    const lastAssignment = raw.assignments.at(-1);
    const activeAssignee = lastAssignment?.to === null ? lastAssignment.member : null;
    const owner = lastAssignment?.member ?? null;
    const task = {
      ...raw,
      blocker: raw.blocker ?? null,
      steps: raw.steps ?? [],
      kind: taskKind(raw.status, waits),
      waits,
      neededBy: neededByMap.get(raw.id) ?? [],
      people,
      touched,
      owner,
      assignee: activeAssignee,
    };
    tasks.push(task);
    taskById.set(task.id, task);

    if (activeAssignee) {
      const m = memberByName.get(activeAssignee);
      if (raw.status === "in-progress") m.doing.push(raw.id);
      if (raw.status !== "done" && raw.status !== "parked") m.open.push(raw.id);
    } else if (raw.queue && (raw.status === "open" || raw.status === "partial") && waits.length === 0) {
      for (const m of members) {
        if (m.preset === raw.queue) m.queued.push(raw.id);
      }
    }
  }

  for (const m of members) {
    if (m.role === "former") continue;
    m.live = live.get(m.name) ?? "offline";
    m.drift = m.live === "working" && m.doing.length === 0;
  }

  const laneById = new Map();
  const milestones = rawMilestones.map((m) => {
    const lane = { id: m.id, title: m.title, goal: m.goal ?? "", state: "planned", done: 0, total: 0, tasks: [] };
    laneById.set(m.id, lane);
    return lane;
  });
  const unplanned = [];
  for (const task of tasks) {
    const lane = task.milestone ? laneById.get(task.milestone) : null;
    if (lane) lane.tasks.push(task);
    else unplanned.push(task);
  }
  if (unplanned.length) {
    milestones.push({ id: null, title: "Unplanned", goal: "", state: "planned", done: 0, total: 0, tasks: unplanned });
  }
  for (const lane of milestones) {
    lane.done = lane.tasks.filter((t) => t.status === "done").length;
    lane.total = lane.tasks.length;
    lane.state = milestoneState(lane.tasks);
  }

  const edges = [];
  for (const task of tasks) {
    for (const p of task.prereqs) {
      const src = taskById.get(p);
      edges.push({
        from: p,
        to: task.id,
        met: src.status === "done",
        fromKind: src.kind,
      });
    }
  }

  const queues = presetOrder.map((preset) => ({
    preset,
    tasks: tasks.filter(
      (t) => t.assignee === null && t.queue === preset && t.status !== "done" && t.status !== "parked",
    ),
  }));

  return { team: teamName, members, milestones, tasks, edges, queues };
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
