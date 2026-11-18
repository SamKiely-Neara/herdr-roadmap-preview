"""Subprocess tests for cli/team-roadmap."""

from __future__ import annotations

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
    r1 = _run(team_home, "add", TEAM, "--title", "First task", "--phase", "Setup")
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
    assert data["roadmap"]["rev"] == 2
    tasks = data["roadmap"]["tasks"]
    assert [t["id"] for t in tasks] == ["T-1", "T-2"]
    assert tasks[0]["phase"] == "Setup"
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
    assert first["roadmap"] == {"schema": 1, "rev": 0, "tasks": []}

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
        "phase": "Setup",
        "prereqs": [],
        "brief": "",
        "created": "2026-11-18T15:30:00+11:00",
        "changed": "2026-11-18T15:30:00+11:00",
        "assignments": [],
        "queue": None,
        "log": [{"at": "2026-11-18T15:30:00+11:00", "by": f"{TEAM}-lead", "change": "added"}],
    }


def _corrupt_roadmap(case: str) -> dict:
    base = {"schema": 1, "rev": 1, "tasks": [_valid_task("T-1")]}
    t = base["tasks"][0]
    if case == "unknown-top-key":
        base["extra"] = 1
    elif case == "unknown-task-key":
        t["extra"] = 1
    elif case == "missing-task-key":
        del t["brief"]
    elif case == "schema-2":
        base["schema"] = 2
    elif case == "bad-status":
        t["status"] = "bogus"
    elif case == "bad-id":
        t["id"] = "X-1"
    elif case == "duplicate-id":
        base["tasks"].append(_valid_task("T-1"))
    elif case == "prereq-self":
        t["prereqs"] = ["T-1"]
    elif case == "prereq-later":
        t["prereqs"] = ["T-2"]
        base["tasks"].append(_valid_task("T-2"))
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
        "schema-2",
        "bad-status",
        "bad-id",
        "duplicate-id",
        "prereq-self",
        "prereq-later",
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
