import { exec, home, watchFolder } from "herdr";

/**
 * Fetches the team's snapshot from its machine.
 * @param {{ team: string, machine: string | null }} src
 * @param {string | null} since
 * @returns {Promise<{token: string, team: object, roadmap: object} | {unchanged: true}>}
 *   Output of team-roadmap snapshot.
 */
export async function snapshot(src, since) {
  const bin = src.machine
    ? "/home/sam/.claude/orchestrator/bin/team-roadmap"
    : `${home()}/.claude/orchestrator/bin/team-roadmap`;
  const args = ["snapshot", src.team, ...(since ? ["--since", since] : [])];
  const res = await exec(bin, args, { on: src.machine, timeout: 10000 });
  if (res.code !== 0) {
    throw new Error((res.stderr || res.stdout || `exit ${res.code}`).trim());
  }
  return JSON.parse(res.stdout);
}

/**
 * Calls onChange(cx) whenever the team's data may have changed; returns a cancel function.
 * @param {{ team: string, machine: string | null }} src
 * @param {any} cx
 * @param {(cx: any) => void} onChange
 * @returns {() => void}
 */
export function watch(src, cx, onChange) {
  if (src.machine) {
    const timer = cx.timer.every(2000, onChange);
    return () => timer.cancel();
  }
  const dir = `${home()}/.claude/teams/${src.team}`;
  let stopped = false;
  let activeWatch = null;
  const relevant = (changed) =>
    changed.some((p) => p === dir || p.endsWith("/team.json") || p.endsWith("/roadmap.json"));
  cx.spawn(async (cx) => {
    for (;;) {
      activeWatch = watchFolder(dir);
      const changed = await activeWatch;
      if (stopped) break;
      if (!changed.length || relevant(changed)) onChange(cx);
    }
  });
  const timer = cx.timer.every(10000, onChange);
  return () => {
    stopped = true;
    activeWatch?.cancel();
    timer.cancel();
  };
}
