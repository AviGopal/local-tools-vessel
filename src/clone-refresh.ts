// SPDX-License-Identifier: MIT
// A walk clone behind this node's copy of its repository is brought onto the copy's HEAD in place, before any tool works in
// it: the same refresh git_worktree makes for a request's own stale clone (git-worktree.ts refreshed()), so a plan that
// replays calls with the clone's path bound to its old row keeps working there instead of failing "behind" every time.
// The answer says so (refreshed, the facts a gitWorktree answer gives), and madeClone reads it as the clone's new base. A
// change that cannot be carried (a conflict) leaves the clone exactly as it was and is said, naming the paths; the tool
// does not run in it. Nothing here writes a records row: the walk records what the answer says.
import { AsyncLocalStorage } from "node:async_hooks";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, vesselGit } from "./git-commit.js";
import { withClones } from "./clones-lock.js";
import { clonePlace, refreshed } from "./git-worktree.js";
import { madeClone } from "./walk-rows.js";
import { containmentZones, type Env } from "./write-containment.js";

export type Refreshed = { shape: "gitWorktree"; cwd: string; repo: string; branch: string; base: string; super_base: string; origin_url: string;
  refreshed_from: string; carried?: "uncommitted" | "commits"; head?: string; tree?: string };

/** The clone brought to its copy's HEAD (refreshed), why it could not be (error, with the paths), or null when it is not
 *  behind or is not a clone a walk row records (then nothing is touched). */
export async function refreshInPlace(clone: { dir: string; repo: string }, env: Env, made = madeClone):
  Promise<{ refreshed: Refreshed } | { error: string; conflicts: string[] } | null> {
  const zones = containmentZones(env);
  const superDir = zones.supers[0];
  const source = clone.repo === "super" ? superDir : join(zones.clones, clone.repo);
  if (!source || !superDir) return null;
  const read = async (args: string[], cwd: string) => { const r = await vesselGit(args, cwd); return r.exit_code === 0 ? r.stdout.trim() : null; };
  const to = await read(["rev-parse", "HEAD"], source);
  const branch = await read(["rev-parse", "--abbrev-ref", "HEAD"], source);
  const superBase = await read(["rev-parse", "HEAD"], superDir);
  const origin = await read(["config", "--get", "remote.origin.url"], source);
  if (!to || !branch || branch === "HEAD" || !superBase || !origin) return null;
  // Not behind: the copy's HEAD is already under the clone's (as the shell user, who owns the clone).
  if ((await git(["-C", clone.dir, "merge-base", "--is-ancestor", to, "HEAD"], tmpdir())).exit_code === 0) return null;
  const m = await made(clone.dir);
  if ("error" in m || m.origin_url !== origin) return null;
  return withClones(async () => {
    const r = await refreshed(clone.dir, m.base, to, branch, source);
    if (!r.ok) return { error: `${clone.dir} is behind this node's copy of ${clone.repo} and could not be brought onto it: ${r.why}`, conflicts: r.conflicts };
    return { refreshed: { shape: "gitWorktree", cwd: clone.dir, repo: clone.repo, branch, base: to, super_base: superBase, origin_url: origin,
      refreshed_from: m.base, ...(r.carried ? { carried: r.carried } : {}), ...(await clonePlace(clone.dir)) } };
  });
}

/** Run a tool after bringing the clone it works in onto the copy: a clone that could not be is said, and the tool does not
 *  run; one that was is said first in the answer (the walk keeps the start of a long answer), then the tool's own. */
export async function freshFirst(clone: { dir: string; repo: string } | null, run: () => Promise<unknown>, env: Env,
  refresh: typeof refreshInPlace = refreshInPlace): Promise<unknown> {
  const r = clone === null ? null : await refresh(clone, env).catch(() => null);
  if (r !== null && "error" in r) return { error: r.error, conflicts: r.conflicts };
  // The tool runs knowing the move this call just made (thisCall, below): its rows cannot say it yet (the walk records it
  // from this answer), so without it the tool would read the clone's old base and refuse its own refresh.
  const out = r === null ? await run() : await thisCall.run(r.refreshed, run);
  return r !== null && typeof out === "object" && out !== null ? { refreshed: r.refreshed, ...out } : out;
}

// The refresh made by the call now running, for that call only (an async context, gone when the call ends): never kept
// across calls, so every other call reads the clone's base from git and rows alone.
const thisCall = new AsyncLocalStorage<Refreshed>();

/** The clone's base as its rows say it, unless git shows the clone already moved onto a newer base of the copy that no
 *  row records (a refresh whose row the walk never wrote): then that is said, as a fact, and nothing computes against a
 *  base the clone is no longer on. Read from git and rows only, so it holds across a restart. */
export async function madeCurrent(cwd: string, made = madeClone, env: Env = process.env): Promise<Awaited<ReturnType<typeof madeClone>> | { error: string; moved_unrecorded: string }> {
  const m = await made(cwd);
  if ("error" in m) return m;
  // This call's own refresh: the clone's base is where this call moved it, from the base the rows say.
  const own = thisCall.getStore();
  if (own !== undefined && own.cwd === cwd && own.refreshed_from === m.base) return { ...m, base: own.base, super_base: own.super_base };
  const zones = containmentZones(env);
  const source = m.repo === "super" ? zones.supers[0] : join(zones.clones, m.repo);
  if (!source) return m;
  const copy = await vesselGit(["rev-parse", "HEAD"], source);
  if (copy.exit_code !== 0) return m;
  const mb = await git(["-C", cwd, "merge-base", "HEAD", copy.stdout.trim()], tmpdir());
  const at = mb.exit_code === 0 ? mb.stdout.trim() : "";
  if (at === "" || at === m.base) return m;
  // newer only: the rows' base is under the merge-base (the clone moved forward onto the copy), not a clone of another line
  if ((await git(["-C", cwd, "merge-base", "--is-ancestor", m.base, at], tmpdir())).exit_code !== 0) return m;
  return { error: `the clone at ${cwd} was moved onto a newer base (${at.slice(0, 12)}) that no row records: nothing is computed against its recorded base ${m.base.slice(0, 12)}; git_worktree for ${m.repo} on this request records it`, moved_unrecorded: at };
}
