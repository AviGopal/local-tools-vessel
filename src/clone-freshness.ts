// Whether work in a walk clone can still land: a clone is made at this node's copy of its repository, and landing takes
// a fast-forward of origin's branch, which the copy follows. Once the copy has moved on (a push, installed), a change made
// in an older clone cannot land as it is. That was said only when the change was diffed, the last step before landing,
// and a walk that never got there (its stale tree failing to typecheck) kept working in a clone that could not land.
// So every answer about a path in a walk clone says so, the moment the clone is touched (index.ts).
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, vesselGit } from "./git-commit.js";
import { movedOnAnswer, type Unread, unreadOf } from "./git-worktree.js";
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

// The answers of the tools that change a file.
const EDITS = new Set(["fileWriteResult", "fileEditResult", "codeInsertResult", "codeReplaceResult", "codeAddImportResult"]);

/** The walk clone an edit changed a file in, when it changed one: an edit answer with no error, not one that found the
 *  change already made (applied: false, already_present), whose path is in a walk clone. A reader can then tell an edit
 *  of this clone from one of another, and an edit newer than the clone's last commit from one older. */
export function editedClone(answer: unknown, env: Env): string | null {
  if (typeof answer !== "object" || answer === null) return null;
  const a = answer as Record<string, unknown>;
  if (!EDITS.has(String(a.shape)) || "error" in a || a.applied === false || a.action === "already_present") return null;
  return typeof a.path === "string" ? cloneOf({ path: a.path }, env)?.dir ?? null : null;
}

/** What the refresh before a call said of the clone, read from the call's answer (clone-refresh.ts freshFirst): the paths
 *  that conflict, whether it held a change, and, for commits and uncommitted edits held together, whether the edits are
 *  still held or a commit run past that refusal ended it. Null when the answer is no refusal. */
export type Refusal = { conflicts: string[]; changed?: boolean; held: "edits" | "committed" | null; unread?: true };
export function refusalOf(answer: unknown): Refusal | null {
  if (typeof answer !== "object" || answer === null) return null;
  const a = answer as Record<string, unknown>;
  if (a.refresh_refused === "commits_and_edits") return { conflicts: [], changed: true, held: "error" in a ? "edits" : "committed" };
  if (!("error" in a) || !Array.isArray(a.conflicts)) return null;
  return { conflicts: a.conflicts.map(String), ...(typeof a.changed === "boolean" ? { changed: a.changed } : {}),
    held: a.held === "commits_and_edits" ? "edits" : null, ...(typeof a.unread === "object" && a.unread !== null ? { unread: true as const } : {}) };
}

/** Why a change made in this clone cannot land as it is, when this node's copy of its repository has moved past it, and
 *  the way on from what the refresh said (refusal): a commit where the clone holds commits and edits together, the next
 *  call where only commits are held, a fresh clone where the change conflicts or nothing is held. Else null. */
export async function behind(clone: { dir: string; repo: string }, env: Env, refusal: Refusal | null = null):
  Promise<string | { clone_unread: { cwd: string } & Unread } | null> {
  const zones = containmentZones(env);
  const copy = clone.repo === "super" ? zones.supers[0] : join(zones.clones, clone.repo);
  if (!copy) return null;
  const head = await vesselGit(["rev-parse", "HEAD"], copy);
  if (head.exit_code !== 0) return null;
  const at = head.stdout.trim();
  // As the shell user, who owns the clone. A copy's commit the clone does not have, or one it has but not under its HEAD,
  // is a copy that moved on. Any other failure of this check (a timeout, a clone git refuses) is git not answering: said
  // as a clone that could not be read, with the exit and its class, and no way on, since nothing about the clone is known.
  const has = await git(["-C", clone.dir, "merge-base", "--is-ancestor", at, "HEAD"], tmpdir());
  if (has.exit_code === 0) return null;
  if (!movedOnAnswer(has, at)) return { clone_unread: { cwd: clone.dir, ...unreadOf(has) } };
  const moved = `${clone.dir} was made before this node's copy of ${clone.repo} moved on (to ${at.slice(0, 10)})`;
  // The refresh could not read the clone: that it moved on is known, nothing about what it holds is.
  if (refusal?.unread) return moved;
  const fresh = `ask for git_worktree of ${clone.repo} for a fresh clone`;
  if (refusal?.held === "edits") {
    return `${moved}: it holds commits and uncommitted edits, which are not carried together; git_commit in ${clone.dir} ` +
      `commits the edits, then the next tool called there carries the commits onto the copy`;
  }
  if (refusal?.held === "committed") return `${moved}: its edits are committed, so the next tool called in ${clone.dir} carries the commits onto the copy`;
  if (refusal !== null && refusal.conflicts.length > 0) {
    return `${moved}, and the copy's newer change also changed ${refusal.conflicts.join(", ")}, which the change in ${clone.dir} ` +
      `changes, so it cannot be carried: ${fresh} and make the change to those paths again there`;
  }
  // Edits to make again only where the refresh said the clone held a change: one that held none (clean, or unreadable) has none.
  return `${moved}: a change made in it cannot land; ${fresh}${refusal?.changed === true ? " and make the edits again there" : ""}`;
}
