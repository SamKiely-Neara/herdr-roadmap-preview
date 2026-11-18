# Team Roadmap

A Herdr workspace tab mod (`team-roadmap`) and CLI (`cli/team-roadmap`) that draw an orchestrator team's `roadmap.json` as an interactive metro map. Derived from [roadmap-preview](../roadmap-preview/RECIPE.md) by Nikospy (MIT, see [LICENSE](../LICENSE)).

## What you see

Top to bottom, on the theme's `background`:

1. **Header**, 32 px, on `chrome`: `Team roadmap · <team>`, machine label (`this Mac` or `mrct`), `N of M done`, error indicator if any, and zoom controls (`− 100% + Fit`).
2. **Roster bar**, 32 px, on `chrome`: a chip per team member (lead first, then `team.json` members, then former assignees in `dim`). Active workers show `· T-n` in `ansi4`; idle members show `· idle`. Clicking a chip filters the map and opens the member card.
3. **Now band**, on `chrome`, 24 px padding: three columns (**Now**, **Ready to start**, **Waiting, blocked, partial**) filtered by the selected member when active.
4. **Map**, zoomable (30–300 %). Phases run left to right; tasks are stations on a 200×104 px grid; prerequisites are horizontal/vertical lines (1 px solid `dim` when done, 2 px dashed `foreground` when blocking).
   - **done**: filled `ansi2`
   - **in-progress**: filled `ansi4` inside a 2 px `ansi4` ring
   - **partial**: 50 % `ansi3` inside a 2 px `ansi3` ring
   - **blocked**: filled `ansi1`
   - **ready**: 2 px `foreground` ring
   - **waiting**: 1 px `dim` ring
   - **parked**: 1 px `dim` square
   - Under each station: assignment history (`worker → coder`), `queued` route (`worker → coder queue`), `waits for T-1`, or `parked`.
5. **Side cards** (360 px right panel, toggled without shifting map coordinates):
   - **Member card**: open items and claimable role-queue tasks for the selected member.
   - **Task card**: clicking any station or label opens its status pill, queue, assignment history, `Touched by`, prerequisites, append-only `Log`, and markdown `Brief` (`TextView.markdown`).
6. **Legend footer**, 32 px: station marks, `worker queue`, line styles, and zoom/pan hint.

## Data flow and CLI

- **Store**: `<team_dir>/roadmap.json` (schema v1), written only by `cli/team-roadmap` under `fcntl.flock` with atomic replace.
- **Permissions**: the lead adds tasks, assigns/requeues, edits briefs, and moves tasks into or out of `done`. Members update status (`open`, `in-progress`, `partial`, `blocked`) on their own assigned tasks and `claim` from their preset's queue. Starting an `in-progress` task automatically pauses the member's other `in-progress` tasks to `partial`.
- **Tab placement**: `team-roadmap open-tab <team>` appends the `Roadmap` tab to the team's Herdr space via `hc connect` JSON-RPC; `team-roadmap close-tab <team>` removes it (and drops empty spaces).
- **Live updates**: `source.js` runs `team-roadmap snapshot <team> [--since <token>]` (locally or `--on mrct`), polling every 2 s and watching local team dirs.

## Install

```sh
cp -R team-roadmap/mods/team-roadmap ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/team-roadmap
```
