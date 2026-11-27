// git_worktree: a fresh clone for one change, owned by the shell user, outside every protected location.
//
// It is cloned from this node's own copy of the repository (the super-repo clone, or the push clone of a vessel), so no
// credential is needed and none is in the command's env. Its origin is set to that copy's origin, which is where a
// landing pushes. The answer names the clone, its base (the copy's HEAD it was cloned at) and the super-repo's HEAD,
// whose hooks judge a commit in it. The walk records that answer in its hop row, and a commit or landing reads it back
// from there (walk-rows.ts).
//
// Every call makes a new clone, and no clone is ever handed out again or moved onto a newer base: a clone is the base it
// was made at, so a change in it is judged against exactly that base. A clone behind its copy is replaced by asking for
// a new one, and the change is made again there. Clones are bounded only by walk_trees_reclaim, which removes those
// nothing will use again.
import { mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, vesselGit } from "./git-commit.js";
import { agentWritableDir } from "./shell-privilege.js";
import { withClones } from "./clones-lock.js";
import { walkTreesDir } from "./tool-roots.js";
import { containmentZones, type Env } from "./write-containment.js";

// Where change clones are made: also a tool root (tool-roots.ts), so the file tools work in a clone's cwd.
export { walkTreesDir };

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type Worktree =
  | { shape: "gitWorktree"; cwd: string; repo: string; branch: string; base: string; super_base: string; origin_url: string; committed_tree?: string }
  | { error: string };

const isRepo = (p: string): boolean => { try { return statSync(join(p, ".git")).isDirectory(); } catch { return false; } };

export async function makeWorktree(repo: string, env: Env = process.env): Promise<Worktree> {
  if (!NAME.test(repo)) return { error: `repo must be "super" or a vessel's name, not ${JSON.stringify(repo)}` };
  const zones = containmentZones(env);
  const superDir = zones.supers[0];
  if (!superDir) return { error: "this node has no super-repo clone: nothing would judge a commit" };
  const source = repo === "super" ? superDir : join(zones.clones, repo);
  if (!isRepo(source)) return { error: `this node has no copy of ${repo}` };
  // The node's copies are this vessel's: read them as the vessel (the shell user cannot).
  const read = async (args: string[], cwd: string) => { const r = await vesselGit(args, cwd); return r.exit_code === 0 ? r.stdout.trim() : null; };
  const base = await read(["rev-parse", "HEAD"], source);
  const superBase = await read(["rev-parse", "HEAD"], superDir);
  const origin = await read(["config", "--get", "remote.origin.url"], source);
  // The branch the copy follows is where a landing goes.
  const branch = await read(["rev-parse", "--abbrev-ref", "HEAD"], source);
  if (!base || !superBase || !origin || !branch || branch === "HEAD") return { error: `the copy of ${repo} has no branch, HEAD or origin to clone from` };

  const trees = walkTreesDir(env);
  mkdirSync(trees, { recursive: true, mode: 0o755 });
  return withClones(() => freshClone(trees, repo, base, superBase, origin, branch, source));
}

// Under the clones lock (clones-lock.ts), so a reclaim never removes a clone while it is being made.
async function freshClone(trees: string, repo: string, base: string, superBase: string, origin: string, branch: string, source: string): Promise<Worktree> {
  const id = `${repo}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const cwd = agentWritableDir(join(trees, id));
  const steps: string[][] = [
    // The shell user clones the vessel's copy. Its upload-pack runs as the shell user against a repository it does not
    // own, which git refuses unless told this one is safe: the copy is the vessel's own, so it is.
    ["clone", "--quiet", "--no-hardlinks", "--no-checkout", "--upload-pack=git -c 'safe.directory=*' upload-pack", source, cwd],
    ["-C", cwd, "checkout", "--quiet", "-b", `walk/${id}`, base],
    ["-C", cwd, "remote", "set-url", "origin", origin],
  ];
  for (const args of steps) {
    const r = await git(args, tmpdir(), { timeoutMs: 300_000 });
    if (r.exit_code !== 0) return { error: `git ${args.find((a) => !a.startsWith("-") && a !== cwd)} failed: ${r.stderr.slice(-500)}` };
  }
  return { shape: "gitWorktree", cwd, repo, branch, base, super_base: superBase, origin_url: origin, ...(await committedTree(cwd)) };
}

/** Why git could not read a clone, as fields: its exit and the class of what it wrote, not its words. A clone git could not
 *  read is said as that, never as off its branch or behind: those are what git answered, this is that it did not answer. */
export type Unread = { exit_code: number; stderr_class: "timeout" | "dubious_ownership" | "not_a_repository" | "lock" | "permission" | "other" };
export function unreadOf(r: { exit_code: number; stderr: string }): Unread {
  const e = r.stderr;
  const stderr_class = /\[killed at the step bound/.test(e) ? "timeout"
    : /dubious ownership/i.test(e) ? "dubious_ownership"
    : /not a git repository/i.test(e) ? "not_a_repository"
    : /Unable to create '[^']*\.lock'|\.lock': File exists/.test(e) ? "lock"
    : /Permission denied/i.test(e) ? "permission"
    : "other";
  return { exit_code: r.exit_code, stderr_class };
}
/** Whether `merge-base --is-ancestor <at> HEAD` failing in a clone is an answer that the copy (at its commit `at`) moved
 *  on: not under HEAD (exit 1), or `at` a commit the clone does not hold at all (git names that commit not a valid one;
 *  a clone missing its own HEAD's commit is named the same way, and is a clone git could not read). Else git did not
 *  answer, and the clone could not be read. */
export const movedOnAnswer = (r: { exit_code: number; stderr: string }, at: string): boolean =>
  r.exit_code === 1 || (r.exit_code === 128 && r.stderr.includes(`Not a valid commit name ${at}`));
// The tree a commit in the clone holds (committed_tree), said only of a clone holding nothing uncommitted (no changed or
// untracked file): a clone with an edit not yet committed is not that tree, so a reader that checks a change only once it
// is committed never takes the clone for one. Nothing is said when the tree or the clone's state cannot be read.
export async function committedTree(cwd: string): Promise<{ committed_tree: string } | Record<string, never>> {
  const tree = await git(["-C", cwd, "rev-parse", "HEAD^{tree}"], tmpdir());
  if (tree.exit_code !== 0 || tree.stdout.trim() === "") return {};
  const dirty = await git(["-C", cwd, "status", "--porcelain", "--untracked-files=all"], tmpdir());
  return dirty.exit_code === 0 && dirty.stdout.trim() === "" ? { committed_tree: tree.stdout.trim() } : {};
}
