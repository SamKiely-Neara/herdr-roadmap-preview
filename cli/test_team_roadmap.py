"""Subprocess tests for cli/team-roadmap."""

from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import os
import subprocess
from concurrent import futures
from pathlib import Path

import pytest

CLI = Path(__file__).resolve().parent / "team-roadmap"
TEAM = "demo-team"


def _run(
    home: Path,
    *args: str,
    stdin_text: str | None = None,
    agent_name: str | None = f"{TEAM}-lead",
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["TEAM_ROADMAP_HOME"] = str(home)
    if agent_name is None:
        env.pop("AGENT_NAME", None)
    else:
        env["AGENT_NAME"] = agent_name
    return subprocess.run(
        [str(CLI), *args],
        env=env,
        input=stdin_text,
        text=True,
        capture_output=True,
        check=False,
    )


@pytest.fixture()
def team_home(tmp_path: Path) -> Path:
    """Create a temporary TEAM_ROADMAP_HOME with demo-team/team.json."""
    team_dir = tmp_path / TEAM
    team_dir.mkdir(parents=True)
    team_json = {
        "team": TEAM,
        "cwd": str(tmp_path),
        "lead": {"name": f"{TEAM}-lead", "preset": "lead"},
        "members": [
            {"name": f"{TEAM}-worker", "preset": "worker"},
            {"name": f"{TEAM}-coder", "preset": "coder"},
        ],
    }
    (team_dir / "team.json").write_text(json.dumps(team_json, indent=2) + "\n", encoding="utf-8")
    return tmp_path


def test_add_twice_and_snapshot(team_home: Path) -> None:
    """Adding two tasks yields T-1 and T-2; snapshot lists both at rev 2."""
    r1 = _run(team_home, "add", TEAM, "--title", "First task", "--step", "write spec", "--step", "write code")
    r2 = _run(
        team_home,
        "add",
        TEAM,
        "--title",
        "Second task",
        "--prereq",
        "T-1",
        "--brief-file",
        "-",
        stdin_text="Hello **md**\n",
    )
    assert r1.returncode == 0, r1.stderr
    assert r2.returncode == 0, r2.stderr
    assert r1.stdout.strip() == "T-1"
    assert r2.stdout.strip() == "T-2"

    snap = _run(team_home, "snapshot", TEAM)
    assert snap.returncode == 0, snap.stderr
    data = json.loads(snap.stdout)
    assert data["roadmap"]["schema"] == 2
    assert data["roadmap"]["rev"] == 2
    tasks = data["roadmap"]["tasks"]
    assert [t["id"] for t in tasks] == ["T-1", "T-2"]
    assert tasks[0]["milestone"] is None
    assert tasks[0]["steps"] == [
        {"text": "write spec", "done": False},
        {"text": "write code", "done": False},
    ]
    assert tasks[1]["prereqs"] == ["T-1"]
    assert tasks[1]["brief"] == "Hello **md**\n"


def test_set_status_preserves_assignments(team_home: Path) -> None:
    """set-status changes status without modifying assignments."""
    _run(team_home, "add", TEAM, "--title", "Build CLI", "--assign", "worker")
    before = json.loads(_run(team_home, "snapshot", TEAM).stdout)["roadmap"]["tasks"][0]

    res = _run(team_home, "set-status", TEAM, "T-1", "done")
    assert res.returncode == 0, res.stderr
    after = json.loads(_run(team_home, "snapshot", TEAM).stdout)["roadmap"]["tasks"][0]
    assert after["status"] == "done"
    assert after["assignments"] == before["assignments"]
    assert after["assignments"][0]["member"] == f"{TEAM}-worker"
    assert after["assignments"][0]["to"] is None


def test_reassign_closes_previous_and_appends(team_home: Path) -> None:
    """Reassigning closes the active entry and appends a new active entry."""
    _run(team_home, "add", TEAM, "--title", "Implement mod")
    assert _run(team_home, "assign", TEAM, "T-1", "worker").returncode == 0
    assert _run(team_home, "assign", TEAM, "T-1", f"{TEAM}-coder").returncode == 0

    task = json.loads(_run(team_home, "snapshot", TEAM).stdout)["roadmap"]["tasks"][0]
    assignments = task["assignments"]
    assert len(assignments) == 2
    assert assignments[0]["member"] == f"{TEAM}-worker"
    assert assignments[0]["to"] is not None
    assert assignments[1]["member"] == f"{TEAM}-coder"
    assert assignments[1]["to"] is None


def test_assign_same_member_is_noop(team_home: Path) -> None:
    """Assigning to the already-active member does not append or bump rev."""
    _run(team_home, "add", TEAM, "--title", "Same owner", "--assign", "worker")
    before = json.loads(_run(team_home, "snapshot", TEAM).stdout)

    res = _run(team_home, "assign", TEAM, "T-1", f"{TEAM}-worker")
    assert res.returncode == 0, res.stderr
    after = json.loads(_run(team_home, "snapshot", TEAM).stdout)
    assert after["roadmap"]["rev"] == before["roadmap"]["rev"]
    assert after["roadmap"]["tasks"][0]["assignments"] == before["roadmap"]["tasks"][0]["assignments"]


def test_assign_none_closes_active(team_home: Path) -> None:
    """assign none closes the active assignment; repeating it is a no-op."""
    _run(team_home, "add", TEAM, "--title", "Unassign me", "--assign", "worker")
    assert _run(team_home, "assign", TEAM, "T-1", "none").returncode == 0
    snap1 = json.loads(_run(team_home, "snapshot", TEAM).stdout)
    assert snap1["roadmap"]["tasks"][0]["assignments"][0]["to"] is not None

    assert _run(team_home, "assign", TEAM, "T-1", "none").returncode == 0
    snap2 = json.loads(_run(team_home, "snapshot", TEAM).stdout)
    assert snap2["roadmap"]["rev"] == snap1["roadmap"]["rev"]


@pytest.mark.parametrize(
    "args",
    [
        ("add", TEAM, "--title", "Bad member", "--assign", "worker9"),
        ("add", TEAM, "--title", "Bad status", "--status", "bogus"),
        ("add", TEAM, "--title", "Bad prereq", "--prereq", "T-99"),
        ("set-status", TEAM, "T-99", "done"),
        ("set-status", TEAM, "T-1", "invalid"),
        ("assign", TEAM, "T-99", "worker"),
        ("assign", TEAM, "T-1", "ghost"),
    ],
    ids=[
        "add-unknown-member",
        "add-bad-status",
        "add-unknown-prereq",
        "status-unknown-id",
        "status-invalid",
        "assign-unknown-id",
        "assign-unknown-member",
    ],
)
def test_invalid_inputs_exit_2_without_modifying_file(team_home: Path, args: tuple[str, ...]) -> None:
    """Invalid arguments exit 2 and leave roadmap.json byte-identical."""
    _run(team_home, "add", TEAM, "--title", "Seed task")
    roadmap_path = team_home / TEAM / "roadmap.json"
    before_bytes = roadmap_path.read_bytes()

    res = _run(team_home, *args)
    assert res.returncode == 2
    assert len(res.stderr.strip().splitlines()) == 1
    assert roadmap_path.read_bytes() == before_bytes


def test_snapshot_since_detects_team_json_change(team_home: Path) -> None:
    """Adding a member to team.json invalidates the snapshot token."""
    first = json.loads(_run(team_home, "snapshot", TEAM).stdout)
    token = first["token"]
    assert first["roadmap"] == {"schema": 2, "rev": 0, "milestones": [], "tasks": []}

    unchanged = json.loads(_run(team_home, "snapshot", TEAM, "--since", token).stdout)
    assert unchanged == {"unchanged": True}

    team_path = team_home / TEAM / "team.json"
    team_data = json.loads(team_path.read_text(encoding="utf-8"))
    team_data["members"].append({"name": f"{TEAM}-reviewer", "preset": "reviewer"})
    team_path.write_text(json.dumps(team_data, indent=2) + "\n", encoding="utf-8")

    updated = json.loads(_run(team_home, "snapshot", TEAM, "--since", token).stdout)
    assert updated["token"] != token
    assert [m["name"] for m in updated["team"]["members"]] == [
        f"{TEAM}-worker",
        f"{TEAM}-coder",
        f"{TEAM}-reviewer",
    ]


def test_parallel_adds_produce_distinct_ids_and_rev_20(team_home: Path) -> None:
    """20 concurrent add calls produce 20 distinct IDs and rev 20."""

    def add_one(idx: int) -> str:
        res = _run(team_home, "add", TEAM, "--title", f"Task {idx}")
        assert res.returncode == 0, res.stderr
        return res.stdout.strip()

    with futures.ThreadPoolExecutor(max_workers=8) as pool:
        ids = list(pool.map(add_one, range(20)))

    assert len(set(ids)) == 20
    assert set(ids) == {f"T-{i}" for i in range(1, 21)}
    snap = json.loads(_run(team_home, "snapshot", TEAM).stdout)
    assert snap["roadmap"]["rev"] == 20
    assert len(snap["roadmap"]["tasks"]) == 20


def test_set_brief_updates_markdown(team_home: Path, tmp_path: Path) -> None:
    """set-brief replaces task brief from a file."""
    _run(team_home, "add", TEAM, "--title", "With brief")
    brief_file = tmp_path / "brief.md"
    brief_file.write_text("## Details\n\nUpdated brief.\n", encoding="utf-8")

    res = _run(team_home, "set-brief", TEAM, "T-1", "--brief-file", str(brief_file))
    assert res.returncode == 0, res.stderr
    task = json.loads(_run(team_home, "snapshot", TEAM).stdout)["roadmap"]["tasks"][0]
    assert task["brief"] == "## Details\n\nUpdated brief.\n"


def _valid_task(task_id: str = "T-1") -> dict:
    return {
        "id": task_id,
        "title": "Valid task",
        "status": "open",
        "milestone": "M-1",
        "prereqs": [],
        "blocker": None,
        "steps": [],
        "brief": "",
        "created": "2026-11-18T15:30:00+11:00",
        "changed": "2026-11-18T15:30:00+11:00",
        "assignments": [],
        "queue": None,
        "log": [{"at": "2026-11-18T15:30:00+11:00", "by": f"{TEAM}-lead", "change": "added"}],
    }


def _valid_milestone(ms_id: str = "M-1") -> dict:
    return {
        "id": ms_id,
        "title": "Setup",
        "goal": "Initial setup",
        "created": "2026-11-18T15:30:00+11:00",
    }


def _corrupt_roadmap(case: str) -> dict:
    base = {"schema": 2, "rev": 1, "milestones": [_valid_milestone("M-1")], "tasks": [_valid_task("T-1")]}
    t = base["tasks"][0]
    if case == "unknown-top-key":
        base["extra"] = 1
    elif case == "unknown-task-key":
        t["extra"] = 1
    elif case == "missing-task-key":
        del t["brief"]
    elif case == "schema-3":
        base["schema"] = 3
    elif case == "bad-status":
        t["status"] = "bogus"
    elif case == "bad-id":
        t["id"] = "X-1"
    elif case == "duplicate-id":
        base["tasks"].append(_valid_task("T-1"))
    elif case == "title-over-80":
        t["title"] = "x" * 81
    elif case == "title-newline":
        t["title"] = "line1\nline2"
    elif case == "unknown-milestone":
        t["milestone"] = "M-99"
    elif case == "bad-milestone-id":
        base["milestones"][0]["id"] = "P-1"
        t["milestone"] = "P-1"
    elif case == "duplicate-milestone-id":
        base["milestones"].append(_valid_milestone("M-1"))
    elif case == "prereq-self":
        t["prereqs"] = ["T-1"]
    elif case == "prereq-unknown":
        t["prereqs"] = ["T-2"]
    elif case == "prereq-duplicate":
        t2 = _valid_task("T-2")
        base["tasks"].append(t2)
        t["prereqs"] = ["T-2", "T-2"]
    elif case == "prereq-cycle":
        t2 = _valid_task("T-2")
        t["prereqs"] = ["T-2"]
        t2["prereqs"] = ["T-1"]
        base["tasks"].append(t2)
    elif case == "blocked-no-reason":
        t["status"] = "blocked"
    elif case == "non-blocked-with-reason":
        t["blocker"] = {"reason": "stale", "since": "2026-11-18T15:30:00+11:00", "by": f"{TEAM}-lead"}
    elif case == "empty-blocker-reason":
        t["status"] = "blocked"
        t["blocker"] = {"reason": "   ", "since": "2026-11-18T15:30:00+11:00", "by": f"{TEAM}-lead"}
    elif case == "step-empty":
        t["steps"] = [{"text": "  ", "done": False}]
    elif case == "step-non-bool":
        t["steps"] = [{"text": "step", "done": "yes"}]
    elif case == "two-open-assignments":
        t["assignments"] = [
            {"member": f"{TEAM}-worker", "from": "2026-11-18T15:31:00+11:00", "to": None},
            {"member": f"{TEAM}-coder", "from": "2026-11-18T15:32:00+11:00", "to": None},
        ]
    elif case == "open-assignment-not-last":
        t["assignments"] = [
            {"member": f"{TEAM}-worker", "from": "2026-11-18T15:31:00+11:00", "to": None},
            {"member": f"{TEAM}-coder", "from": "2026-11-18T15:32:00+11:00", "to": "2026-11-18T15:33:00+11:00"},
        ]
    elif case == "to-before-from":
        t["assignments"] = [
            {"member": f"{TEAM}-worker", "from": "2026-11-18T15:35:00+11:00", "to": "2026-11-18T15:30:00+11:00"},
        ]
    elif case == "timestamp-no-offset":
        t["created"] = "2026-11-18T15:30:00"
    elif case == "rev-zero":
        base["rev"] = 0
    elif case == "rev-bool":
        base["rev"] = True
    elif case == "bad-queue":
        t["queue"] = "Bad Queue!"
    elif case == "empty-log":
        t["log"] = []
    elif case == "log-extra-key":
        t["log"][0]["extra"] = 1
    elif case == "log-at-backwards":
        t["log"].append({"at": "2026-11-18T15:29:00+11:00", "by": f"{TEAM}-lead", "change": "later"})
    elif case == "log-bad-by":
        t["log"][0]["by"] = "Bad Actor"
    return base


@pytest.mark.parametrize(
    "case",
    [
        "unknown-top-key",
        "unknown-task-key",
        "missing-task-key",
        "schema-3",
        "bad-status",
        "bad-id",
        "duplicate-id",
        "title-over-80",
        "title-newline",
        "unknown-milestone",
        "bad-milestone-id",
        "duplicate-milestone-id",
        "prereq-self",
        "prereq-unknown",
        "prereq-duplicate",
        "prereq-cycle",
        "blocked-no-reason",
        "non-blocked-with-reason",
        "empty-blocker-reason",
        "step-empty",
        "step-non-bool",
        "two-open-assignments",
        "open-assignment-not-last",
        "to-before-from",
        "timestamp-no-offset",
        "rev-zero",
        "rev-bool",
        "bad-queue",
        "empty-log",
        "log-extra-key",
        "log-at-backwards",
        "log-bad-by",
    ],
)
def test_corrupt_roadmap_json_fails_validation(team_home: Path, case: str) -> None:
    """Schema validation rejects malformed roadmap.json on snapshot and add without modifying the file."""
    roadmap_path = team_home / TEAM / "roadmap.json"
    raw = (json.dumps(_corrupt_roadmap(case), indent=2) + "\n").encode("utf-8")
    roadmap_path.write_bytes(raw)

    for args in (("snapshot", TEAM), ("add", TEAM, "--title", "Should fail")):
        res = _run(team_home, *args)
        assert res.returncode == 1
        assert res.stderr.startswith("roadmap.json: ")
        assert roadmap_path.read_bytes() == raw


def test_team_json_without_lead_name_exits_1(team_home: Path) -> None:
    """team.json missing lead.name fails snapshot with exit 1 naming the field."""
    team_path = team_home / TEAM / "team.json"
    team_data = json.loads(team_path.read_text(encoding="utf-8"))
    del team_data["lead"]["name"]
    team_path.write_text(json.dumps(team_data, indent=2) + "\n", encoding="utf-8")

    res = _run(team_home, "snapshot", TEAM)
    assert res.returncode == 1
    assert "lead.name" in res.stderr


def test_missing_team_json_exits_1(tmp_path: Path) -> None:
    """Missing team.json returns exit 1 with one line on stderr."""
    res = _run(tmp_path, "snapshot", "missing-team")
    assert res.returncode == 1
    assert len(res.stderr.strip().splitlines()) == 1


def test_invalid_team_name_exits_2(team_home: Path) -> None:
    """Path-traversal or invalid team names exit 2."""
    res = _run(team_home, "snapshot", "../escape")
    assert res.returncode == 2


def test_former_member_keeps_history(team_home: Path) -> None:
    """A member removed from team.json stays in assignment history and snapshot still validates."""
    _run(team_home, "add", TEAM, "--title", "Build CLI", "--assign", "worker")
    team_path = team_home / TEAM / "team.json"
    team = json.loads(team_path.read_text(encoding="utf-8"))
    team["members"] = [m for m in team["members"] if m["name"] != f"{TEAM}-worker"]
    team_path.write_text(json.dumps(team), encoding="utf-8")

    snap = _run(team_home, "snapshot", TEAM)
    assert snap.returncode == 0, snap.stderr
    task = json.loads(snap.stdout)["roadmap"]["tasks"][0]
    assert task["assignments"][0]["member"] == f"{TEAM}-worker"
    assert _run(team_home, "assign", TEAM, "T-1", "worker").returncode == 2


def test_partial_status_and_log_entries(team_home: Path, tmp_path: Path) -> None:
    """Writes record actor and exact change text; partial works; unset AGENT_NAME logs sam; no-op writes no entry."""
    assert _run(team_home, "add", TEAM, "--title", "Log check").returncode == 0
    assert _run(team_home, "set-status", TEAM, "T-1", "partial", agent_name=None).returncode == 0
    assert _run(team_home, "assign", TEAM, "T-1", "worker").returncode == 0
    assert _run(team_home, "assign", TEAM, "T-1", "none").returncode == 0
    brief_file = tmp_path / "brief.md"
    brief_file.write_text("Updated\n", encoding="utf-8")
    assert _run(team_home, "set-brief", TEAM, "T-1", "--brief-file", str(brief_file)).returncode == 0

    before = json.loads(_run(team_home, "snapshot", TEAM).stdout)["roadmap"]
    assert _run(team_home, "set-status", TEAM, "T-1", "partial").returncode == 0
    assert _run(team_home, "assign", TEAM, "T-1", "none").returncode == 0
    after = json.loads(_run(team_home, "snapshot", TEAM).stdout)["roadmap"]
    assert after["rev"] == before["rev"]

    log = after["tasks"][0]["log"]
    assert [(e["by"], e["change"]) for e in log] == [
        (f"{TEAM}-lead", "added"),
        ("sam", "status open → partial"),
        (f"{TEAM}-lead", "assigned worker"),
        (f"{TEAM}-lead", "unassigned worker"),
        (f"{TEAM}-lead", "brief changed"),
    ]


@pytest.mark.parametrize(
    ("actor_name", "command", "expected_code"),
    [
        (f"{TEAM}-lead", ("add", TEAM, "--title", "Lead add"), 0),
        (f"{TEAM}-worker", ("add", TEAM, "--title", "Worker add"), 3),
        (f"{TEAM}-worker", ("set-status", TEAM, "T-1", "done"), 3),
        (f"{TEAM}-lead", ("set-status", TEAM, "T-1", "done"), 0),
        (f"{TEAM}-worker", ("set-status", TEAM, "T-1", "blocked", "--reason", "waiting"), 0),
        (f"{TEAM}-worker", ("set-status", TEAM, "T-2", "blocked", "--reason", "waiting"), 3),
        (None, ("add", TEAM, "--title", "Sam add"), 0),
        (None, ("set-status", TEAM, "T-1", "done"), 0),
        (None, ("assign", TEAM, "T-2", "worker"), 0),
        ("orchestrator", ("add", TEAM, "--title", "Orch add"), 3),
        (f"{TEAM}-lead", ("claim", TEAM), 3),
    ],
    ids=[
        "lead-add",
        "worker-add-refused",
        "worker-done-refused",
        "lead-done",
        "worker-blocked-own",
        "worker-blocked-other-refused",
        "sam-add",
        "sam-done",
        "sam-assign",
        "orchestrator-add-refused",
        "lead-claim-refused",
    ],
)
def test_permission_matrix(
    team_home: Path,
    actor_name: str | None,
    command: tuple[str, ...],
    expected_code: int,
) -> None:
    """Role permissions enforce exit 3 and leave roadmap.json byte-identical on refusal."""
    assert _run(team_home, "add", TEAM, "--title", "Worker task", "--assign", "worker").returncode == 0
    assert _run(team_home, "add", TEAM, "--title", "Coder task", "--assign", "coder").returncode == 0
    roadmap_path = team_home / TEAM / "roadmap.json"
    before_bytes = roadmap_path.read_bytes()

    res = _run(team_home, *command, agent_name=actor_name)
    assert res.returncode == expected_code, res.stderr
    if expected_code == 3:
        assert res.stderr.startswith("team-roadmap: ")
        assert roadmap_path.read_bytes() == before_bytes


def test_claim_queue_ordering_errors_and_concurrency(team_home: Path) -> None:
    """claim handles ready selection, prereq skipping, wrong queue, assigned tasks, empty queue, and races."""
    assert _run(team_home, "add", TEAM, "--title", "Done prereq", "--status", "done").returncode == 0
    assert _run(team_home, "add", TEAM, "--title", "Open blocker").returncode == 0
    assert (
        _run(team_home, "add", TEAM, "--title", "Waiting queued", "--prereq", "T-2", "--queue", "worker").returncode
        == 0
    )
    assert (
        _run(team_home, "add", TEAM, "--title", "Ready queued", "--prereq", "T-1", "--queue", "worker").returncode == 0
    )

    assert _run(team_home, "claim", TEAM, "T-4", agent_name=f"{TEAM}-coder").returncode == 3
    res = _run(team_home, "claim", TEAM, agent_name=f"{TEAM}-worker")
    assert res.returncode == 0, res.stderr
    assert res.stdout.strip() == "T-4"

    task4 = json.loads(_run(team_home, "snapshot", TEAM).stdout)["roadmap"]["tasks"][3]
    assert task4["status"] == "in-progress"
    assert task4["queue"] == "worker"
    assert task4["assignments"][-1]["member"] == f"{TEAM}-worker"
    assert task4["log"][-1]["change"] == "claimed from the worker queue"

    assert _run(team_home, "claim", TEAM, "T-4", agent_name=f"{TEAM}-worker").returncode == 2
    assert _run(team_home, "claim", TEAM, agent_name=f"{TEAM}-worker").returncode == 4

    assert _run(team_home, "add", TEAM, "--title", "Race task", "--queue", "worker").returncode == 0

    def race_claim(_: int) -> int:
        return _run(team_home, "claim", TEAM, "T-5", agent_name=f"{TEAM}-worker").returncode

    with futures.ThreadPoolExecutor(max_workers=2) as pool:
        codes = list(pool.map(race_claim, range(2)))
    assert sorted(codes) == [0, 2]


def test_queue_unknown_preset_and_assign_none_returns_to_queue(team_home: Path) -> None:
    """queue rejects unknown presets with exit 2; assign none returns a claimed task to its queue."""
    assert _run(team_home, "add", TEAM, "--title", "Queued task", "--queue", "worker").returncode == 0
    assert _run(team_home, "queue", TEAM, "T-1", "unknown").returncode == 2
    res_lead = _run(team_home, "queue", TEAM, "T-1", "lead")
    assert res_lead.returncode == 2
    assert "unknown preset 'lead'" in res_lead.stderr
    assert _run(team_home, "claim", TEAM, agent_name=f"{TEAM}-worker").returncode == 0
    assert _run(team_home, "assign", TEAM, "T-1", "none").returncode == 0
    assert _run(team_home, "set-status", TEAM, "T-1", "open").returncode == 0

    res = _run(team_home, "claim", TEAM, agent_name=f"{TEAM}-worker")
    assert res.returncode == 0, res.stderr
    assert res.stdout.strip() == "T-1"


def test_only_lead_reopens_done_and_starting_in_progress_pauses_other(team_home: Path) -> None:
    """Only the lead moves tasks out of done, and starting in-progress pauses the member's other active task."""
    assert _run(team_home, "add", TEAM, "--title", "Task 1", "--assign", "worker").returncode == 0
    assert _run(team_home, "add", TEAM, "--title", "Task 2", "--assign", "worker").returncode == 0
    assert _run(team_home, "add", TEAM, "--title", "Task 3", "--queue", "worker").returncode == 0
    assert (
        _run(team_home, "add", TEAM, "--title", "Task 4", "--assign", "coder", "--status", "in-progress").returncode
        == 0
    )
    assert _run(team_home, "set-status", TEAM, "T-1", "done").returncode == 0

    roadmap_path = team_home / TEAM / "roadmap.json"
    before_bytes = roadmap_path.read_bytes()
    refused = _run(team_home, "set-status", TEAM, "T-1", "open", agent_name=f"{TEAM}-worker")
    assert refused.returncode == 3
    assert roadmap_path.read_bytes() == before_bytes
    assert _run(team_home, "set-status", TEAM, "T-1", "open").returncode == 0

    assert _run(team_home, "set-status", TEAM, "T-1", "in-progress", agent_name=f"{TEAM}-worker").returncode == 0
    res_start = _run(team_home, "set-status", TEAM, "T-2", "in-progress", agent_name=f"{TEAM}-worker")
    assert res_start.returncode == 0, res_start.stderr
    assert "paused T-1" in res_start.stderr.splitlines()

    tasks = {t["id"]: t for t in json.loads(_run(team_home, "snapshot", TEAM).stdout)["roadmap"]["tasks"]}
    assert tasks["T-1"]["status"] == "partial"
    assert tasks["T-1"]["log"][-1]["change"] == "status in-progress → partial (worker started T-2)"
    assert tasks["T-2"]["status"] == "in-progress"
    assert tasks["T-4"]["status"] == "in-progress"

    res_claim = _run(team_home, "claim", TEAM, agent_name=f"{TEAM}-worker")
    assert res_claim.returncode == 0, res_claim.stderr
    assert "paused T-2" in res_claim.stderr.splitlines()

    res_add = _run(team_home, "add", TEAM, "--title", "Task 5", "--status", "in-progress", "--assign", "coder")
    assert res_add.returncode == 0, res_add.stderr
    assert "paused T-4" in res_add.stderr.splitlines()

    res_assign = _run(team_home, "assign", TEAM, "T-3", "coder")
    assert res_assign.returncode == 0, res_assign.stderr
    assert "paused T-5" in res_assign.stderr.splitlines()


def _load_cli_module() -> object:
    loader = importlib.machinery.SourceFileLoader("team_roadmap_cli", str(CLI))
    spec = importlib.util.spec_from_loader("team_roadmap_cli", loader)
    assert spec is not None
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def test_with_roadmap_tab_adds_idempotently_and_rejects_missing_space() -> None:
    """with_roadmap_tab appends the Roadmap tab once, returns None on second call, and raises CliError(1) if missing."""
    cli_mod = _load_cli_module()
    doc = {
        "spaces": [
            {
                "id": "demo-team",
                "name": "demo-team",
                "tabs": [
                    {
                        "id": "tb1",
                        "name": "Main",
                        "root": {"type": "row", "id": "tb1", "children": [{"type": "block", "id": "t1"}]},
                    }
                ],
            }
        ]
    }

    updated = cli_mod.with_roadmap_tab(doc, "demo-team", "mrct")
    assert updated is not None
    tabs = updated["spaces"][0]["tabs"]
    assert len(tabs) == 2
    roadmap_tab = tabs[1]
    assert roadmap_tab["name"] == "Roadmap"
    assert roadmap_tab["id"].startswith("tb")
    block = roadmap_tab["root"]["children"][0]
    assert block["id"].startswith("p")
    assert block["content"] == {"mod": "team-roadmap", "props": {"team": "demo-team", "machine": "mrct"}}

    assert cli_mod.with_roadmap_tab(updated, "demo-team", "mrct") is None

    with pytest.raises(cli_mod.CliError) as exc_info:
        cli_mod.with_roadmap_tab(doc, "missing-space", None)
    assert exc_info.value.code == 1


def test_without_roadmap_tab_removes_tab_or_empty_space_and_ignores_absent() -> None:
    """without_roadmap_tab strips only Roadmap tabs, drops empty spaces, and returns None when absent."""
    cli_mod = _load_cli_module()
    agents_tab = {
        "id": "tb1",
        "name": "Agents",
        "root": {"type": "row", "id": "tb1", "children": [{"type": "block", "id": "t1"}]},
    }
    roadmap_tab = {
        "id": "tb2",
        "name": "Roadmap",
        "root": {
            "type": "row",
            "id": "tb2",
            "children": [{"type": "block", "id": "p1", "content": {"mod": "team-roadmap", "props": {"team": "t"}}}],
        },
    }

    doc_both = {"spaces": [{"id": "demo-team", "name": "demo-team", "tabs": [agents_tab, roadmap_tab]}]}
    stripped = cli_mod.without_roadmap_tab(doc_both, "demo-team")
    assert stripped is not None
    assert [t["name"] for t in stripped["spaces"][0]["tabs"]] == ["Agents"]

    doc_only_roadmap = {"spaces": [{"id": "demo-team", "name": "demo-team", "tabs": [roadmap_tab]}]}
    removed_space = cli_mod.without_roadmap_tab(doc_only_roadmap, "demo-team")
    assert removed_space is not None
    assert removed_space["spaces"] == []

    assert cli_mod.without_roadmap_tab(stripped, "demo-team") is None
    assert cli_mod.without_roadmap_tab(doc_both, "missing-space") is None


def test_v1_migration_preserves_phases_and_adds_blocked_placeholder(team_home: Path) -> None:
    """v1 roadmap migrates phases to M-1..M-k in first-seen order and fills placeholder blocker reason."""
    v1 = {
        "schema": 1,
        "rev": 5,
        "tasks": [
            {
                "id": "T-1",
                "title": "Fork repo",
                "status": "done",
                "phase": "1. Setup",
                "prereqs": [],
                "brief": "",
                "created": "2026-11-18T15:00:00+11:00",
                "changed": "2026-11-18T15:05:00+11:00",
                "assignments": [],
                "queue": None,
                "log": [{"at": "2026-11-18T15:00:00+11:00", "by": f"{TEAM}-lead", "change": "added"}],
            },
            {
                "id": "T-2",
                "title": "Blocked task",
                "status": "blocked",
                "phase": None,
                "prereqs": ["T-1"],
                "brief": "",
                "created": "2026-11-18T15:10:00+11:00",
                "changed": "2026-11-18T15:15:00+11:00",
                "assignments": [],
                "queue": None,
                "log": [{"at": "2026-11-18T15:10:00+11:00", "by": f"{TEAM}-worker", "change": "blocked"}],
            },
            {
                "id": "T-3",
                "title": "Another setup task",
                "status": "open",
                "phase": "1. Setup",
                "prereqs": [],
                "brief": "",
                "created": "2026-11-18T15:20:00+11:00",
                "changed": "2026-11-18T15:20:00+11:00",
                "assignments": [],
                "queue": None,
                "log": [{"at": "2026-11-18T15:20:00+11:00", "by": f"{TEAM}-lead", "change": "added"}],
            },
        ],
    }
    (team_home / TEAM / "roadmap.json").write_text(json.dumps(v1, indent=2) + "\n", encoding="utf-8")

    snap = _run(team_home, "snapshot", TEAM)
    assert snap.returncode == 0, snap.stderr
    rm = json.loads(snap.stdout)["roadmap"]
    assert rm["schema"] == 2
    assert rm["milestones"] == [{"id": "M-1", "title": "1. Setup", "goal": "", "created": "2026-11-18T15:00:00+11:00"}]
    assert rm["tasks"][0]["milestone"] == "M-1"
    assert rm["tasks"][1]["milestone"] is None
    assert rm["tasks"][1]["blocker"] == {
        "reason": "(no reason recorded)",
        "since": "2026-11-18T15:15:00+11:00",
        "by": f"{TEAM}-worker",
    }
    assert rm["tasks"][2]["milestone"] == "M-1"

    # Next write persists schema 2
    add_res = _run(team_home, "add", TEAM, "--title", "After migration")
    assert add_res.returncode == 0, add_res.stderr
    stored = json.loads((team_home / TEAM / "roadmap.json").read_text(encoding="utf-8"))
    assert stored["schema"] == 2
    assert stored["rev"] == 6


def test_v1_migration_fails_loudly_on_title_over_80(team_home: Path) -> None:
    """v1 title over 80 chars is not truncated and fails load() with exit 1."""
    v1 = {
        "schema": 1,
        "rev": 1,
        "tasks": [
            {
                "id": "T-1",
                "title": "x" * 81,
                "status": "open",
                "phase": None,
                "prereqs": [],
                "brief": "",
                "created": "2026-11-18T15:00:00+11:00",
                "changed": "2026-11-18T15:00:00+11:00",
                "assignments": [],
                "queue": None,
                "log": [{"at": "2026-11-18T15:00:00+11:00", "by": f"{TEAM}-lead", "change": "added"}],
            }
        ],
    }
    (team_home / TEAM / "roadmap.json").write_text(json.dumps(v1, indent=2) + "\n", encoding="utf-8")
    res = _run(team_home, "snapshot", TEAM)
    assert res.returncode == 1
    assert "80" in res.stderr


def test_blocker_reason_rules_on_add_and_set_status(team_home: Path) -> None:
    """blocked requires --reason, non-blocked rejects --reason, changing reason logs, leaving clears."""
    assert _run(team_home, "add", TEAM, "--title", "Bad", "--status", "blocked").returncode == 2
    assert _run(team_home, "add", TEAM, "--title", "Bad", "--status", "open", "--reason", "nope").returncode == 2
    assert _run(team_home, "add", TEAM, "--title", "x" * 81).returncode == 2

    r1 = _run(team_home, "add", TEAM, "--title", "Wait on decision", "--status", "blocked", "--reason", "waiting D2")
    assert r1.returncode == 0, r1.stderr
    assert _run(team_home, "set-status", TEAM, "T-1", "open", "--reason", "extra").returncode == 2
    assert _run(team_home, "set-status", TEAM, "T-1", "blocked").returncode == 2

    # Same reason is a no-op
    rev_before = json.loads(_run(team_home, "snapshot", TEAM).stdout)["roadmap"]["rev"]
    assert _run(team_home, "set-status", TEAM, "T-1", "blocked", "--reason", "waiting D2").returncode == 0
    rev_same = json.loads(_run(team_home, "snapshot", TEAM).stdout)["roadmap"]["rev"]
    assert rev_same == rev_before

    # Different reason replaces blocker and logs
    assert _run(team_home, "set-status", TEAM, "T-1", "blocked", "--reason", "waiting D3").returncode == 0
    t1 = json.loads(_run(team_home, "snapshot", TEAM).stdout)["roadmap"]["tasks"][0]
    assert t1["blocker"]["reason"] == "waiting D3"
    assert "blocker → waiting D3" in t1["log"][-1]["change"]

    # Leaving blocked clears blocker
    assert _run(team_home, "set-status", TEAM, "T-1", "open").returncode == 0
    t1 = json.loads(_run(team_home, "snapshot", TEAM).stdout)["roadmap"]["tasks"][0]
    assert t1["blocker"] is None


@pytest.mark.parametrize(
    ("fixture_name", "expected_tasks", "expected_milestones"),
    [
        ("panel-v1.json", 14, []),
        (
            "territory-layout-v1.json",
            11,
            ["1. Setup & Design", "2. Core Helpers & Layout (C1-13)", "3. Persistence, Exclusion & Proof"],
        ),
    ],
)
def test_real_v1_fixture_migration(
    tmp_path: Path, fixture_name: str, expected_tasks: int, expected_milestones: list[str]
) -> None:
    """Real v1 panel and territory-layout roadmaps migrate to schema 2 and still validate after save()."""
    cli_mod = _load_cli_module()
    fixture = Path(__file__).parent / "fixtures" / fixture_name
    raw = json.loads(fixture.read_text(encoding="utf-8"))
    team_dir = tmp_path / "t"
    team_dir.mkdir()
    (team_dir / "roadmap.json").write_text(json.dumps(raw), encoding="utf-8")

    loaded = cli_mod.load(team_dir)
    assert loaded["schema"] == 2
    assert len(loaded["tasks"]) == expected_tasks
    assert [m["title"] for m in loaded["milestones"]] == expected_milestones

    cli_mod.save(team_dir, loaded)
    reloaded = cli_mod.load(team_dir)
    assert reloaded["schema"] == 2
    assert len(reloaded["tasks"]) == expected_tasks

def test_milestone_add_set_move_and_permissions(team_home: Path) -> None:
    """milestone add/set/move manage milestone order and enforce lead-only permissions."""
    assert _run(team_home, "milestone", "add", TEAM, "--title", "M1", agent_name=f"{TEAM}-worker").returncode == 3

    m1 = _run(team_home, "milestone", "add", TEAM, "--title", "First", "--goal", "Goal 1")
    m2 = _run(team_home, "milestone", "add", TEAM, "--title", "Second")
    m3 = _run(team_home, "milestone", "add", TEAM, "--title", "Third")
    assert [m1.stdout.strip(), m2.stdout.strip(), m3.stdout.strip()] == ["M-1", "M-2", "M-3"]

    assert (
        _run(team_home, "milestone", "set", TEAM, "M-2", "--title", "Second edited", "--goal", "Goal 2").returncode == 0
    )
    assert _run(team_home, "milestone", "move", TEAM, "M-3", "--before", "M-1").returncode == 0
    assert _run(team_home, "milestone", "move", TEAM, "M-1", "--last").returncode == 0

    milestones = json.loads(_run(team_home, "snapshot", TEAM).stdout)["roadmap"]["milestones"]
    assert [m["id"] for m in milestones] == ["M-3", "M-2", "M-1"]
    assert milestones[1]["title"] == "Second edited"
    assert milestones[1]["goal"] == "Goal 2"


def test_set_and_link_cycle_detection(team_home: Path) -> None:
    """set edits title/milestone; link rejects 2-cycles and 3-cycles with exit 2 and leaves file unchanged."""
    _run(team_home, "milestone", "add", TEAM, "--title", "Phase 1")
    _run(team_home, "add", TEAM, "--title", "Task A")
    _run(team_home, "add", TEAM, "--title", "Task B")
    _run(team_home, "add", TEAM, "--title", "Task C")

    assert _run(team_home, "set", TEAM, "T-1", "--title", "Task A updated", "--milestone", "M-1").returncode == 0
    assert json.loads(_run(team_home, "snapshot", TEAM).stdout)["roadmap"]["tasks"][0]["milestone"] == "M-1"
    assert _run(team_home, "set", TEAM, "T-1", "--milestone", "none").returncode == 0
    assert json.loads(_run(team_home, "snapshot", TEAM).stdout)["roadmap"]["tasks"][0]["milestone"] is None
    assert _run(team_home, "set", TEAM, "T-1", "--title", "x" * 81).returncode == 2

    assert _run(team_home, "link", TEAM, "T-2", "--needs", "T-1").returncode == 0
    # Re-link is a no-op
    rev_before = json.loads(_run(team_home, "snapshot", TEAM).stdout)["roadmap"]["rev"]
    assert _run(team_home, "link", TEAM, "T-2", "--needs", "T-1").returncode == 0
    assert json.loads(_run(team_home, "snapshot", TEAM).stdout)["roadmap"]["rev"] == rev_before

    # 2-cycle: T-1 -> T-2 -> T-1
    roadmap_path = team_home / TEAM / "roadmap.json"
    raw_before = roadmap_path.read_bytes()
    c2 = _run(team_home, "link", TEAM, "T-1", "--needs", "T-2")
    assert c2.returncode == 2
    assert "T-1" in c2.stderr and "T-2" in c2.stderr
    assert roadmap_path.read_bytes() == raw_before

    # 3-cycle: T-3 needs T-2, then T-1 needs T-3
    assert _run(team_home, "link", TEAM, "T-3", "--needs", "T-2").returncode == 0
    raw_before_3 = roadmap_path.read_bytes()
    c3 = _run(team_home, "link", TEAM, "T-1", "--needs", "T-3")
    assert c3.returncode == 2
    assert "T-1" in c3.stderr and "T-2" in c3.stderr and "T-3" in c3.stderr
    assert roadmap_path.read_bytes() == raw_before_3

    assert _run(team_home, "unlink", TEAM, "T-2", "--needs", "T-1").returncode == 0
    t2 = json.loads(_run(team_home, "snapshot", TEAM).stdout)["roadmap"]["tasks"][1]
    assert t2["prereqs"] == []


def test_steps_crud_permissions_and_bounds(team_home: Path) -> None:
    """step add/done/undo/rm use 1-based indexing, allow assignee, refuse others (exit 3), and reject OOB (exit 2)."""
    _run(team_home, "add", TEAM, "--title", "With steps", "--assign", "worker")
    assert _run(team_home, "step", "add", TEAM, "T-1", "First step", agent_name=f"{TEAM}-worker").returncode == 0
    assert _run(team_home, "step", "add", TEAM, "T-1", "Second step").returncode == 0

    assert _run(team_home, "step", "done", TEAM, "T-1", "1", agent_name=f"{TEAM}-coder").returncode == 3
    assert _run(team_home, "step", "done", TEAM, "T-1", "0", agent_name=f"{TEAM}-worker").returncode == 2
    assert _run(team_home, "step", "done", TEAM, "T-1", "3", agent_name=f"{TEAM}-worker").returncode == 2

    assert _run(team_home, "step", "done", TEAM, "T-1", "1", agent_name=f"{TEAM}-worker").returncode == 0
    assert _run(team_home, "step", "undo", TEAM, "T-1", "1", agent_name=f"{TEAM}-worker").returncode == 0
    assert _run(team_home, "step", "done", TEAM, "T-1", "2", agent_name=f"{TEAM}-worker").returncode == 0
    assert _run(team_home, "step", "rm", TEAM, "T-1", "1", agent_name=f"{TEAM}-worker").returncode == 0

    steps = json.loads(_run(team_home, "snapshot", TEAM).stdout)["roadmap"]["tasks"][0]["steps"]
    assert steps == [{"text": "Second step", "done": True}]


def test_import_preserves_history_and_is_atomic(team_home: Path, tmp_path: Path) -> None:
    """import preserves historic timestamps, appends imported log entry, and rolls back on clash or cycle."""
    _run(team_home, "milestone", "add", TEAM, "--title", "Existing M")
    _run(team_home, "add", TEAM, "--title", "Existing T")

    payload = {
        "milestones": [
            {"id": "M-10", "title": "Historic M", "goal": "Past work", "created": "2026-11-17T10:00:00+11:00"}
        ],
        "tasks": [
            {
                "id": "T-10",
                "title": "Historic done",
                "status": "done",
                "milestone": "M-10",
                "prereqs": ["T-1"],
                "blocker": None,
                "steps": [{"text": "shipped", "done": True}],
                "brief": "Done earlier\n",
                "created": "2026-11-17T10:05:00+11:00",
                "changed": "2026-11-17T11:00:00+11:00",
                "assignments": [
                    {"member": f"{TEAM}-worker", "from": "2026-11-17T10:05:00+11:00", "to": "2026-11-17T11:00:00+11:00"}
                ],
                "queue": None,
                "log": [
                    {"at": "2026-11-17T10:05:00+11:00", "by": f"{TEAM}-lead", "change": "created"},
                    {"at": "2026-11-17T11:00:00+11:00", "by": f"{TEAM}-lead", "change": "status open -> done"},
                ],
            },
            {
                "id": "T-11",
                "title": "Depends on T-10",
                "status": "open",
                "milestone": "M-10",
                "prereqs": ["T-10"],
                "blocker": None,
                "steps": [],
                "brief": "",
                "created": "2026-11-17T11:05:00+11:00",
                "changed": "2026-11-17T11:05:00+11:00",
                "assignments": [],
                "queue": None,
                "log": [{"at": "2026-11-17T11:05:00+11:00", "by": f"{TEAM}-lead", "change": "created"}],
            },
        ],
    }
    imp_file = tmp_path / "historic.json"
    imp_file.write_text(json.dumps(payload), encoding="utf-8")

    assert _run(team_home, "import", TEAM, str(imp_file), agent_name=f"{TEAM}-worker").returncode == 3
    res = _run(team_home, "import", TEAM, str(imp_file))
    assert res.returncode == 0, res.stderr

    snap = json.loads(_run(team_home, "snapshot", TEAM).stdout)["roadmap"]
    assert [m["id"] for m in snap["milestones"]] == ["M-1", "M-10"]
    assert [t["id"] for t in snap["tasks"]] == ["T-1", "T-10", "T-11"]
    t10 = snap["tasks"][1]
    assert t10["created"] == "2026-11-17T10:05:00+11:00"
    assert t10["log"][-1]["change"] == "imported from historic.json"

    # Clash on existing task id exits 2 and leaves roadmap.json untouched
    roadmap_path = team_home / TEAM / "roadmap.json"
    raw_before = roadmap_path.read_bytes()
    clash = _run(team_home, "import", TEAM, str(imp_file))
    assert clash.returncode == 2
    assert roadmap_path.read_bytes() == raw_before
