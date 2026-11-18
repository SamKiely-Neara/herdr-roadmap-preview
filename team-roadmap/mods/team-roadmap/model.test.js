import { describe, expect, test } from "bun:test";
import { liveByName, relatedTo, toView } from "./model.js";
import { layout } from "./layout.js";

function makeSnapshot({
  milestones = [{ id: "M-1", title: "Setup", goal: "Foundation", created: "2026-11-18T15:00:00+11:00" }],
  tasks = [],
  members = [
    { name: "alpha-worker", preset: "worker" },
    { name: "alpha-coder", preset: "coder" },
  ],
  schema = 2,
} = {}) {
  return {
    token: "1:abcdef123456",
    team: {
      team: "alpha",
      lead: { name: "alpha-lead", preset: "lead" },
      members,
    },
    roadmap: {
      schema,
      rev: 1,
      milestones,
      tasks,
    },
  };
}

function makeTask(overrides = {}) {
  return {
    id: "T-1",
    title: "Sample",
    status: "open",
    milestone: "M-1",
    prereqs: [],
    blocker: null,
    steps: [],
    brief: "",
    created: "2026-11-18T15:30:00+11:00",
    changed: "2026-11-18T15:30:00+11:00",
    assignments: [],
    queue: null,
    log: [{ at: "2026-11-18T15:30:00+11:00", by: "alpha-lead", change: "added" }],
    ...overrides,
  };
}

describe("toView", () => {
  test("maps each status and prerequisite state to its kind and waits", () => {
    const snap = makeSnapshot({
      tasks: [
        makeTask({ id: "T-1", status: "done" }),
        makeTask({ id: "T-2", status: "in-progress" }),
        makeTask({
          id: "T-3",
          status: "blocked",
          blocker: { reason: "waiting on Sam", since: "2026-11-18T15:31:00+11:00", by: "alpha-lead" },
        }),
        makeTask({ id: "T-4", status: "parked" }),
        makeTask({ id: "T-5", status: "open", prereqs: ["T-2"] }),
        makeTask({ id: "T-6", status: "open", prereqs: ["T-1"] }),
      ],
    });

    const view = toView(snap);
    expect(view.tasks.map((t) => [t.id, t.kind, t.waits])).toEqual([
      ["T-1", "done", []],
      ["T-2", "active", []],
      ["T-3", "blocked", []],
      ["T-4", "parked", []],
      ["T-5", "waiting", ["T-2"]],
      ["T-6", "ready", []],
    ]);
  });

  test("tracks people without repeats and picks active or last owner", () => {
    const snap = makeSnapshot({
      tasks: [
        makeTask({
          id: "T-1",
          status: "in-progress",
          assignments: [
            { member: "alpha-worker", from: "2026-11-18T15:00:00+11:00", to: "2026-11-18T15:10:00+11:00" },
            { member: "alpha-coder", from: "2026-11-18T15:10:00+11:00", to: "2026-11-18T15:20:00+11:00" },
            { member: "alpha-worker", from: "2026-11-18T15:20:00+11:00", to: null },
          ],
        }),
        makeTask({
          id: "T-2",
          status: "done",
          assignments: [
            { member: "alpha-coder", from: "2026-11-18T15:00:00+11:00", to: "2026-11-18T15:30:00+11:00" },
          ],
        }),
        makeTask({ id: "T-3", status: "open", assignments: [] }),
      ],
    });

    const view = toView(snap);
    expect(view.tasks[0].people).toEqual(["alpha-worker", "alpha-coder"]);
    expect(view.tasks[0].owner).toBe("alpha-worker");
    expect(view.tasks[1].owner).toBe("alpha-coder");
    expect(view.tasks[2].owner).toBeNull();
  });

  test("appends former assignees once after live members and strips team prefix", () => {
    const snap = makeSnapshot({
      members: [{ name: "alpha-worker", preset: "worker" }],
      tasks: [
        makeTask({
          id: "T-1",
          assignments: [
            { member: "alpha-scout", from: "2026-11-18T15:00:00+11:00", to: "2026-11-18T15:05:00+11:00" },
            { member: "alpha-worker", from: "2026-11-18T15:05:00+11:00", to: null },
          ],
        }),
        makeTask({
          id: "T-2",
          assignments: [{ member: "alpha-scout", from: "2026-11-18T15:06:00+11:00", to: null }],
        }),
      ],
    });

    const view = toView(snap);
    expect(view.members).toEqual([
      {
        name: "alpha-lead",
        short: "lead",
        role: "lead",
        preset: "lead",
        doing: [],
        open: [],
        queued: [],
        live: "offline",
        drift: false,
      },
      {
        name: "alpha-worker",
        short: "worker",
        role: "member",
        preset: "worker",
        doing: [],
        open: ["T-1"],
        queued: [],
        live: "offline",
        drift: false,
      },
      {
        name: "alpha-scout",
        short: "scout",
        role: "former",
        preset: null,
        doing: [],
        open: ["T-2"],
        queued: [],
        live: "offline",
        drift: false,
      },
    ]);
  });

  test("derives milestone states, places null/unknown milestones in Unplanned, and emits all edges", () => {
    const snap = makeSnapshot({
      milestones: [
        { id: "M-1", title: "Done M", goal: "All done", created: "2026-11-18T15:00:00+11:00" },
        { id: "M-2", title: "Blocked M", goal: "One blocked", created: "2026-11-18T15:01:00+11:00" },
        { id: "M-3", title: "Planned M", goal: "None started", created: "2026-11-18T15:02:00+11:00" },
      ],
      tasks: [
        makeTask({ id: "T-1", status: "done", milestone: "M-1" }),
        makeTask({ id: "T-2", status: "parked", milestone: "M-1" }),
        makeTask({
          id: "T-3",
          status: "blocked",
          milestone: "M-2",
          prereqs: ["T-1"],
          blocker: { reason: "need input", since: "2026-11-18T15:31:00+11:00", by: "alpha-lead" },
        }),
        makeTask({ id: "T-4", status: "open", milestone: "M-3", prereqs: ["T-3"] }),
        makeTask({ id: "T-5", status: "open", milestone: null }),
        makeTask({ id: "T-6", status: "open", milestone: "M-999" }),
      ],
    });

    const view = toView(snap);
    expect(view.milestones.map((m) => [m.id, m.title, m.state, m.done, m.total])).toEqual([
      ["M-1", "Done M", "done", 1, 2],
      ["M-2", "Blocked M", "active", 0, 1],
      ["M-3", "Planned M", "planned", 0, 1],
      [null, "Unplanned", "planned", 0, 2],
    ]);
    expect(view.edges).toEqual([
      { from: "T-1", to: "T-3", met: true, fromKind: "done" },
      { from: "T-3", to: "T-4", met: false, fromKind: "blocked" },
    ]);
    expect(view.tasks.find((t) => t.id === "T-3")?.neededBy).toEqual(["T-4"]);
  });

  test("throws on unsupported roadmap schema", () => {
    expect(() => toView(makeSnapshot({ schema: 1 }))).toThrow("Unsupported roadmap schema");
  });

  test("queues per preset include ready, waiting, and blocked rows, and empty presets stay at 0", () => {
    const view = toView(
      makeSnapshot({
        tasks: [
          makeTask({ id: "T-1", status: "open" }),
          makeTask({ id: "T-2", status: "open", queue: "worker" }),
          makeTask({ id: "T-3", status: "open", queue: "worker", prereqs: ["T-1"] }),
          makeTask({
            status: "open",
            queue: "worker",
            assignments: [{ member: "alpha-coder", from: "2026-11-18T15:31:00+11:00", to: null }],
          }),
          makeTask({
            id: "T-5",
            status: "blocked",
            queue: "worker",
            blocker: { reason: "blocked queue item", since: "2026-11-18T15:31:00+11:00", by: "alpha-lead" },
          }),
          makeTask({ id: "T-6", status: "done", queue: "coder" }),
        ],
      }),
    );

    const worker = view.members.find((m) => m.name === "alpha-worker");
    expect(worker.queued).toEqual(["T-2"]);
    expect(view.queues.map((q) => [q.preset, q.tasks.map((t) => [t.id, t.kind])])).toEqual([
      ["lead", []],
      [
        "worker",
        [
          ["T-2", "ready"],
          ["T-3", "waiting"],
          ["T-5", "blocked"],
        ],
      ],
      ["coder", []],
    ]);
  });

  test("touched lists assignees then log authors without repeats, and relatedTo includes own queue", () => {
    const view = toView(
      makeSnapshot({
        tasks: [
          makeTask({
            id: "T-1",
            status: "in-progress",
            assignments: [
              { member: "alpha-worker", from: "2026-11-18T15:31:00+11:00", to: "2026-11-18T15:32:00+11:00" },
              { member: "alpha-coder", from: "2026-11-18T15:32:00+11:00", to: null },
            ],
            log: [
              { at: "2026-11-18T15:30:00+11:00", by: "alpha-lead", change: "added" },
              { at: "2026-11-18T15:31:00+11:00", by: "alpha-worker", change: "status open -> in-progress" },
            ],
          }),
          makeTask({ id: "T-2", status: "open", queue: "worker" }),
          makeTask({ id: "T-3", status: "open", queue: "coder" }),
        ],
      }),
    );
    expect(view.tasks[0].touched).toEqual(["alpha-worker", "alpha-coder", "alpha-lead"]);
    expect(view.tasks[0].assignee).toBe("alpha-coder");
    expect(relatedTo(view, "alpha-lead")).toEqual(new Set());
    expect(relatedTo(view, "alpha-worker")).toEqual(new Set(["T-1", "T-2"]));
    expect(relatedTo(view, "alpha-coder")).toEqual(new Set(["T-1", "T-3"]));
  });

  test("detects drift when member is live working with no in-progress task", () => {
    const live = liveByName(
      [
        { state: "live", address: "t1", status: "working", labels: { "agent.name": "alpha-worker" } },
        { state: "live", address: "t2", status: "done", labels: { "agent.name": "alpha-coder" } },
      ],
      null,
    );
    const view = toView(
      makeSnapshot({
        tasks: [
          makeTask({
            id: "T-1",
            status: "open",
            assignments: [{ member: "alpha-worker", from: "2026-11-18T15:30:00+11:00", to: null }],
          }),
        ],
      }),
      live,
    );
    const lead = view.members.find((m) => m.name === "alpha-lead");
    const worker = view.members.find((m) => m.name === "alpha-worker");
    const coder = view.members.find((m) => m.name === "alpha-coder");
    expect(lead.live).toBe("offline");
    expect(lead.drift).toBe(false);
    expect(worker.live).toBe("working");
    expect(worker.drift).toBe(true);
    expect(coder.live).toBe("idle");
    expect(coder.drift).toBe(false);
  });
});

describe("liveByName", () => {
  test("prefers labels agent.name, filters machine and non-live, and maps done to idle", () => {
    const terms = [
      { state: "live", address: "t1", name: "wrong", status: "working", labels: { "agent.name": "alpha-lead" } },
      { state: "live", address: "t2", name: "alpha-worker", status: "done", labels: {} },
      { state: "live", address: "t3", name: "alpha-coder", status: "blocked", labels: {} },
      { state: "exited", address: "t4", name: "alpha-ghost", status: "working", labels: {} },
      { state: "live", address: "mrc/t5", name: "alpha-remote", status: "working", labels: {} },
    ];

    const local = liveByName(terms, null);
    expect([...local.entries()]).toEqual([
      ["alpha-lead", "working"],
      ["alpha-worker", "idle"],
      ["alpha-coder", "blocked"],
    ]);

    const remote = liveByName(terms, "mrc");
    expect([...remote.entries()]).toEqual([["alpha-remote", "working"]]);
  });
});

describe("layout", () => {
  test("places dependency chains across columns and loose tasks below", () => {
    const tasks = [
      { id: "T-1", prereqs: [] },
      { id: "T-2", prereqs: ["T-1"] },
      { id: "T-3", prereqs: [] },
    ];
    const grid = layout(tasks);
    expect(grid).toEqual({ cols: 2, rows: 2 });
    expect(tasks.map((t) => [t.id, t.d, t.r])).toEqual([
      ["T-1", 0, 0],
      ["T-2", 1, 0],
      ["T-3", 0, 1],
    ]);
  });

  test("keeps cross-lane linked tasks in chain rows at depth 0 instead of loose block", () => {
    const t1 = { id: "T-1", prereqs: [] };
    const t2 = { id: "T-2", prereqs: ["T-1"] };
    const t3 = { id: "T-3", prereqs: [] };
    const all = [t1, t2, t3];
    const lane1 = [t1, t3];
    const lane2 = [t2];

    layout(lane1, all);
    layout(lane2, all);
    expect([t1.d, t1.r]).toEqual([0, 0]);
    expect([t3.d, t3.r]).toEqual([0, 1]);
    expect([t2.d, t2.r]).toEqual([0, 0]);
  });
});
