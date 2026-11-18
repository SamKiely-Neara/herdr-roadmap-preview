import { describe, expect, test } from "bun:test";
import { relatedTo, toView } from "./model.js";
import { layout } from "./layout.js";

function makeSnapshot({
  tasks = [],
  members = [
    { name: "alpha-worker", preset: "worker" },
    { name: "alpha-coder", preset: "coder" },
  ],
  schema = 1,
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
      tasks,
    },
  };
}

function makeTask(overrides = {}) {
  return {
    id: "T-1",
    title: "Sample",
    status: "open",
    phase: "Setup",
    prereqs: [],
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
        makeTask({ id: "T-3", status: "blocked" }),
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
          assignments: [
            { member: "alpha-scout", from: "2026-11-18T15:06:00+11:00", to: null },
          ],
        }),
      ],
    });

    const view = toView(snap);
    expect(view.members).toEqual([
      { name: "alpha-lead", short: "lead", role: "lead", preset: "lead", doing: [], open: [], queued: [], state: "idle" },
      { name: "alpha-worker", short: "worker", role: "member", preset: "worker", doing: [], open: ["T-1"], queued: [], state: "idle" },
      { name: "alpha-scout", short: "scout", role: "former", preset: null, doing: [], open: ["T-2"], queued: [], state: "idle" },
    ]);
  });

  test("groups phases in first-seen order and maps null phase to Tasks", () => {
    const snap = makeSnapshot({
      tasks: [
        makeTask({ id: "T-1", phase: "Build" }),
        makeTask({ id: "T-2", phase: null }),
        makeTask({ id: "T-3", phase: "Build" }),
        makeTask({ id: "T-4", phase: "Verify" }),
      ],
    });

    const view = toView(snap);
    expect(view.phases.map((p) => [p.title, p.tasks.map((t) => t.id)])).toEqual([
      ["Build", ["T-1", "T-3"]],
      ["Tasks", ["T-2"]],
      ["Verify", ["T-4"]],
    ]);
  });

  test("throws on unsupported roadmap schema", () => {
    expect(() => toView(makeSnapshot({ schema: 2 }))).toThrow("Unsupported roadmap schema");
  });

  test("maps partial status to partial kind", () => {
    const view = toView(makeSnapshot({ tasks: [makeTask({ id: "T-1", status: "partial" })] }));
    expect(view.tasks[0].kind).toBe("partial");
  });

  test("computes member doing, open, and state from open assignments", () => {
    const view = toView(
      makeSnapshot({
        tasks: [
          makeTask({
            id: "T-1",
            status: "in-progress",
            assignments: [{ member: "alpha-worker", from: "2026-11-18T15:31:00+11:00", to: null }],
          }),
          makeTask({
            id: "T-2",
            status: "blocked",
            assignments: [
              { member: "alpha-worker", from: "2026-11-18T15:31:00+11:00", to: null },
            ],
          }),
          makeTask({
            id: "T-3",
            status: "blocked",
            assignments: [{ member: "alpha-coder", from: "2026-11-18T15:31:00+11:00", to: null }],
          }),
          makeTask({
            id: "T-4",
            status: "done",
            assignments: [{ member: "alpha-coder", from: "2026-11-18T15:31:00+11:00", to: null }],
          }),
        ],
      }),
    );
    const worker = view.members.find((m) => m.name === "alpha-worker");
    const coder = view.members.find((m) => m.name === "alpha-coder");
    expect(worker.doing).toEqual(["T-1"]);
    expect(worker.open).toEqual(["T-1", "T-2"]);
    expect(worker.state).toBe("working");
    expect(coder.doing).toEqual([]);
    expect(coder.open).toEqual(["T-3"]);
    expect(coder.state).toBe("idle");
  });

  test("queued honours prereqs and open assignments", () => {
    const view = toView(
      makeSnapshot({
        tasks: [
          makeTask({ id: "T-1", status: "open" }),
          makeTask({ id: "T-2", status: "open", queue: "worker" }),
          makeTask({ id: "T-3", status: "partial", queue: "worker", prereqs: ["T-1"] }),
          makeTask({
            id: "T-4",
            status: "open",
            queue: "worker",
            assignments: [{ member: "alpha-coder", from: "2026-11-18T15:31:00+11:00", to: null }],
          }),
          makeTask({ id: "T-5", status: "blocked", queue: "worker" }),
        ],
      }),
    );
    const worker = view.members.find((m) => m.name === "alpha-worker");
    expect(worker.queued).toEqual(["T-2"]);
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
              { at: "2026-11-18T15:31:00+11:00", by: "alpha-worker", change: "status open → in-progress" },
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

  test("unassigned queued task sets assignee to null and returns to preset queue", () => {
    const view = toView(
      makeSnapshot({
        tasks: [
          makeTask({
            id: "T-1",
            status: "partial",
            queue: "worker",
            assignments: [
              { member: "alpha-worker", from: "2026-11-18T15:31:00+11:00", to: "2026-11-18T15:35:00+11:00" },
            ],
          }),
        ],
      }),
    );
    expect(view.tasks[0].assignee).toBeNull();
    expect(view.tasks[0].owner).toBe("alpha-worker");
    const worker = view.members.find((m) => m.name === "alpha-worker");
    expect(worker.queued).toEqual(["T-1"]);
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
});
