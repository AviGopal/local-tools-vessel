// Whether work in a walk clone can still land: a clone is made at this node's copy of its repository, and landing takes
// a fast-forward of origin's branch, which the copy follows. Once the copy has moved on (a push, installed), a change made
// in an older clone cannot land as it is. That was said only when the change was diffed, the last step before landing,
// and a walk that never got there (its stale tree failing to typecheck) kept working in a clone that could not land.
// So every answer about a path in a walk clone says so, the moment the clone is touched (index.ts).
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, vesselGit } from "./git-commit.js";
import { walkTreesDir } from "./tool-roots.js";
import { containmentZones, type Env } from "./write-containment.js";

/** The walk clone a call's pointer names a path in, if any: <trees>/<repo>-<made>-<id>, and the repository it is of. */
export function cloneOf(pointer: unknown, env: Env): { dir: string; repo: string } | null {
  const trees = walkTreesDir(env);
  if (typeof pointer !== "object" || pointer === null) return null;
  for (const v of Object.values(pointer as Record<string, unknown>)) {
    if (typeof v !== "string" || !v.startsWith(`${trees}/`)) continue;
    const name = v.slice(trees.length + 1).split("/")[0];
    const parts = name.split("-");
    if (parts.length < 3 || name === "") continue;
    return { dir: join(trees, name), repo: parts.slice(0, -2).join("-") };
  }
  return null;
}

/** Why a change made in this clone cannot land, when this node's copy of its repository has moved past it; else null. */
export async function behind(clone: { dir: string; repo: string }, env: Env): Promise<string | null> {
  const zones = containmentZones(env);
  const copy = clone.repo === "super" ? zones.supers[0] : join(zones.clones, clone.repo);
  if (!copy) return null;
  const head = await vesselGit(["rev-parse", "HEAD"], copy);
  if (head.exit_code !== 0) return null;
  const at = head.stdout.trim();
  // As the shell user, who owns the clone. A copy's commit the clone does not have, or one it has but not under its HEAD,
  // is a copy that moved on.
  const has = await git(["-C", clone.dir, "merge-base", "--is-ancestor", at, "HEAD"], tmpdir());
  if (has.exit_code === 0) return null;
  return `${clone.dir} was made before this node's copy of ${clone.repo} moved on (to ${at.slice(0, 10)}): a change made in ` +
    `it cannot land; ask for git_worktree of ${clone.repo} for a fresh clone and make the edits again there`;
}
