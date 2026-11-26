// git_worktree: a fresh clone for one change, owned by the shell user, outside every protected location.
//
// It is cloned from this node's own copy of the repository (the super-repo clone, or the push clone of a vessel), so no
// credential is needed and none is in the command's env. Its origin is set to that copy's origin, which is where a
// landing pushes. The answer names the clone, its base (the copy's HEAD it was cloned at) and the super-repo's HEAD,
// whose hooks judge a commit in it. The walk records that answer in its hop row, and a commit or landing reads it back
// from there (walk-rows.ts).
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, vesselGit } from "./git-commit.js";
import { agentWritableDir } from "./shell-privilege.js";
import { withClones } from "./clones-lock.js";
import { walkTreesDir } from "./tool-roots.js";
import { readRows, type Row, walkCalls } from "./walk-rows.js";
import { containmentZones, type Env } from "./write-containment.js";

// Where change clones are made: also a tool root (tool-roots.ts), so the file tools work in a clone's cwd.
export { walkTreesDir };

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type Worktree =
  | { shape: "gitWorktree"; cwd: string; repo: string; branch: string; base: string; super_base: string; origin_url: string; refreshed_from?: string; head?: string; tree?: string; committed_tree?: string;
      // What a refresh carried onto the new base: the clone's uncommitted edits, or its commits (replayed).
      carried?: "uncommitted" | "commits";
      // A clone of this request's whose change could not be carried onto the new base: where it is, and which paths the
      // new base also changed (its change is left as it was there; this answer is a fresh clone).
      not_carried?: { cwd: string; from: string; conflicts: string[]; why: string } }
  | { error: string };

const isRepo = (p: string): boolean => { try { return statSync(join(p, ".git")).isDirectory(); } catch { return false; } };

export async function makeWorktree(repo: string, env: Env = process.env, selectionRef?: string): Promise<Worktree> {
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
  return withClones(() => chooseOrClone(trees, repo, base, superBase, origin, branch, source, selectionRef));
}

// Which clones may be handed to the request a call is made for: an unchanged clone goes again only to the request it
// was handed to, or once every request it was handed to is closed. Read from records' calls read (walk-rows.ts
// walkCalls): the walk's git_worktree and git_land calls, each with its root and whether that root is open, and no
// selection, so the read grows with the calls made, not with what the selections saw. A clone no open root's call names
// was handed only to closed requests, or to none. Anything unread (no selection named, a records read failing) hands
// nothing out again: a fresh clone costs disk, a shared one would put one request's edit into another's commit. `ours`
// is the asking request's own clones, newest first, each with what its call answered (repo, branch, base, origin), less
// any it has landed.
type Handouts = { mine: string; may: (cwd: string) => boolean; ours: Array<{ cwd: string; made: Row }> };
async function handouts(selectionRef: string | undefined): Promise<Handouts | null> {
  if (!selectionRef) return null;
  const [sel, arms] = await Promise.all([readRows({ ids: [selectionRef] }), readRows({ shape: "arm" })]);
  if (!Array.isArray(sel) || !Array.isArray(arms)) return null;
  const mine = String(sel.find((r) => r.id === selectionRef)?.root ?? "");
  if (!mine) return null;
  const calls = await walkCalls([...new Set((arms as Row[]).map((a) => String(a.vessel_id ?? "")).filter((v) => v !== ""))], ["git_worktree", "git_land"]);
  if (!Array.isArray(calls)) return null;
  const to = new Map<string, Set<string>>();
  const own: Array<{ cwd: string; made: Row; seq: number }> = [];
  const landed = new Set<string>();
  for (const c of calls.filter((x) => x.state === "ended")) {
    const cwd = String(c.output?.cwd ?? "");
    if (!cwd) continue;
    if (c.type === "git_land") { if (c.root === mine) landed.add(cwd); continue; }
    if (c.type !== "git_worktree" || !c.open) continue;
    if (!to.has(cwd)) to.set(cwd, new Set());
    to.get(cwd)!.add(c.root);
    if (c.root === mine) own.push({ cwd, made: (c.output ?? {}) as Row, seq: c.seq });
  }
  const ours = own.filter((o) => !landed.has(o.cwd)).sort((x, y) => y.seq - x.seq).map(({ cwd, made }) => ({ cwd, made }));
  const may = (cwd: string) => [...(to.get(cwd) ?? [])].every((r) => r === mine);
  return { mine, may, ours };
}

// Under the clones lock (clones-lock.ts): hand out an unchanged clone, or make one.
async function chooseOrClone(trees: string, repo: string, base: string, superBase: string, origin: string, branch: string, source: string, selectionRef?: string): Promise<Worktree> {
  // A clone nothing has changed yet (its own branch, at this base, from this origin, with no change and no commit) is
  // exactly what a new one would be: it is handed out again, not made again. Every clone is a whole repository, and one
  // made per call, with nothing removing them, filled a node's disk. A clone holding any change is never handed out.
  const h = await handouts(selectionRef);
  // The request's own clone goes back to it as its hop recorded it, changed or not (its change is its own work), with no
  // git read: a commit or landing reads that same row back (walk-rows.ts madeClone), so the answer must agree with it.
  // Only while it was made at the copy's HEAD now, from the same origin: once the copy has moved on (a push landed), the
  // request is asking for a clone at the new tip, which is how it recovers from working in one that is behind.
  // Never one another open request also holds (may): a clone handed to two requests would carry one's edit into the
  // other's commit, and a refresh would move its base under the other's change.
  const ownClone = h?.ours.find((o) => o.made.repo === repo && o.made.base === base && o.made.origin_url === origin && h.may(o.cwd)
    && isRepo(o.cwd) && typeof o.made.branch === "string" && o.made.branch !== "");
  if (ownClone) {
    const m = ownClone.made as Record<string, string>;
    return { shape: "gitWorktree", cwd: ownClone.cwd, repo, branch: m.branch, base: m.base, super_base: superBase, origin_url: m.origin_url,
      ...(await committedTree(ownClone.cwd)) };
  }
  // The request's own clone made at an older base (the copy has moved on since: a push landed) is brought to the new base
  // in place when nothing in it has changed: the new base is fetched from the copy into it and its own branch moved there.
  // Making a fresh clone instead copies the whole repository again, and every push would do that for every request.
  // The answer says which base it moved from (refreshed_from), so a later commit reads the clone's rows as one clone.
  // A clone holding the request's change is carried too, when the new base changed none of what it changed: its
  // uncommitted edits stay in place across the move (git's own rule: a checkout keeps local changes to files the two
  // bases share unchanged), its commits are replayed onto the new base. Nothing is edited or merged by hand: where the
  // new base also changed a path the change touches, the clone is left exactly as it was and the answer says which
  // paths (not_carried), beside a fresh clone. A carried change is a new tree: the diff, typecheck and verdict of the old
  // one judge nothing here (a landing takes only a verdict on its own tree).
  const stale = h?.ours.find((o) => o.made.repo === repo && o.made.origin_url === origin && typeof o.made.base === "string"
    && o.made.base !== base && h.may(o.cwd) && isRepo(o.cwd));
  let notCarried: { cwd: string; from: string; conflicts: string[]; why: string } | undefined;
  if (stale) {
    const r = await refreshed(stale.cwd, String(stale.made.base), base, branch, source);
    if (r.ok) {
      return { shape: "gitWorktree", cwd: stale.cwd, repo, branch, base, super_base: superBase, origin_url: origin, refreshed_from: String(stale.made.base),
        ...(r.carried ? { carried: r.carried } : {}), ...(await clonePlace(stale.cwd)), ...(await committedTree(stale.cwd)) };
    }
    if (r.changed) notCarried = { cwd: stale.cwd, from: String(stale.made.base), conflicts: r.conflicts, why: r.why };
  }
  const also = notCarried ? { not_carried: notCarried } : {};
  const reused = await unchangedClone(trees, repo, base, origin, h);
  if (reused) return { shape: "gitWorktree", cwd: reused, repo, branch, base, super_base: superBase, origin_url: origin, ...also, ...(await committedTree(reused)) };
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
  return { shape: "gitWorktree", cwd, repo, branch, base, super_base: superBase, origin_url: origin, ...also, ...(await committedTree(cwd)) };
}

// Bring a clone made at `from` to `to`. The copy's branch is fetched into it (the same upload-pack form the clone was made
// with: never shared objects), then its own branch moved to `to`:
//   - unchanged (nothing modified or untracked, no commit of its own): moved, as before;
//   - uncommitted edits only: moved with a checkout, which keeps them in place when `to` changed none of those files and
//     refuses, changing nothing, when it did (carried: "uncommitted");
//   - commits of its own only: replayed onto `to` (git decides what conflicts); on a conflict the replay is undone, the
//     clone left as it was, and the conflicting paths are named (carried: "commits");
//   - both: not carried (commit or drop the edits first; nothing is guessed), and said as held: "commits_and_edits",
//     refused before anything is moved, so a commit made in the clone as it is ends exactly this state.
// The clone's commits are those past where it forks from `to` (merge-base), never past `from`: a clone moved since its
// row was written sits past `from`.
// Not ok: changed says whether the clone held a change (so a fresh clone does not hide it), conflicts which paths `to`
// also changed, why in words. Nothing here edits a file or resolves a conflict.
export type Refresh = { ok: true; carried?: "uncommitted" | "commits" }
  | { ok: false; changed: boolean; conflicts: string[]; why: string; held?: "commits_and_edits" }
  | { ok: false; changed?: undefined; conflicts: []; why: string; unread: Unread };

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
// Where a clone is now: its HEAD and HEAD's tree, as fields, so a reader (the walk's newest tree) never parses a sha out
// of words. Read after a move; nothing is said when either cannot be read.
export async function clonePlace(cwd: string): Promise<{ head: string; tree: string } | Record<string, never>> {
  const at = async (ref: string) => { const r = await git(["-C", cwd, "rev-parse", ref], tmpdir()); return r.exit_code === 0 ? r.stdout.trim() : ""; };
  const [head, tree] = [await at("HEAD"), await at("HEAD^{tree}")];
  return head && tree ? { head, tree } : {};
}
// The tree a commit in the clone holds (committed_tree), said only of a clone holding nothing uncommitted (no changed or
// untracked file): a clone with an edit not yet committed is not that tree, so a reader that checks a change only once it
// is committed never takes the clone for one. Apart from `tree` (where a refresh left the clone, whatever it carried),
// so what a landing reads is not changed by it. Nothing is said when the tree or the clone's state cannot be read.
export async function committedTree(cwd: string): Promise<{ committed_tree: string } | Record<string, never>> {
  const tree = await git(["-C", cwd, "rev-parse", "HEAD^{tree}"], tmpdir());
  if (tree.exit_code !== 0 || tree.stdout.trim() === "") return {};
  const dirty = await git(["-C", cwd, "status", "--porcelain", "--untracked-files=all"], tmpdir());
  return dirty.exit_code === 0 && dirty.stdout.trim() === "" ? { committed_tree: tree.stdout.trim() } : {};
}
export async function refreshed(cwd: string, from: string, to: string, branch: string, source: string): Promise<Refresh> {
  const run = (args: string[], timeoutMs?: number) => git(["-C", cwd, ...args], tmpdir(), timeoutMs ? { timeoutMs } : undefined);
  const out = async (args: string[], timeoutMs?: number) => { const r = await run(args, timeoutMs); return r.exit_code === 0 ? r.stdout.trim() : null; };
  const no = (why: string, changed = false, conflicts: string[] = []): Extract<Refresh, { ok: false; changed: boolean }> => ({ ok: false, changed, conflicts, why });
  // A replay a restart cut off leaves the clone mid-rebase, off its own branch: undone first, which puts the clone back
  // on its branch exactly as it was, so it is carried (or named) like any other.
  if (existsSync(join(cwd, ".git", "rebase-merge")) || existsSync(join(cwd, ".git", "rebase-apply"))) await run(["rebase", "--abort"]);
  const unread = (r: { exit_code: number; stderr: string }): Refresh => ({ ok: false, conflicts: [], why: "the clone could not be read", unread: unreadOf(r) });
  const head = await run(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head.exit_code !== 0) return unread(head);
  const own = head.stdout.trim();
  if (!own.startsWith("walk/")) {
    // Still off its branch: whatever it holds past its base is named, never dropped in silence by a fresh clone.
    const held = await out(["rev-list", "HEAD", "--not", from]);
    return no("the clone is not on its own walk/ branch", held !== null && held !== "");
  }
  const status = await run(["status", "--porcelain", "--untracked-files=all"]);
  if (status.exit_code !== 0) return unread(status);
  const dirty = status.stdout.trim();
  // The new base is fetched first: a fetch adds objects and moves nothing, so a clone refused below is still exactly as it
  // was. Its objects tell where the clone really forks from the copy's history (the newest commit both hold), which is
  // the base its own work sits on. `from` is the base a row recorded, and a clone moved since (a refresh in place the
  // asker's rows do not say) sits past it: counted from there, the copy's own commits it was carried over would be read
  // as the clone's, replayed again (a conflict where the copy changed that path twice), and a clean clone with an edit
  // held as commits and edits.
  if ((await out(["fetch", "--quiet", "--upload-pack=git -c 'safe.directory=*' upload-pack", source, branch], 300_000)) === null) {
    return no("the new base could not be fetched into the clone", dirty !== "" || ((await out(["rev-list", "HEAD", "--not", from])) ?? "") !== "");
  }
  const fork = await out(["merge-base", "HEAD", to]);
  const ahead = fork === null ? null : await out(["rev-list", "HEAD", "--not", fork]);
  if (fork === null || ahead === null) return no("the clone shares no history with the new base", true);
  if (dirty !== "" && ahead !== "") return { ...no("the clone holds both commits and uncommitted edits; commit or drop the edits first", true), held: "commits_and_edits" };
  // The paths the new base changed since the clone's fork: uncommitted edits to any of them cannot be carried.
  const moved = new Set(((await out(["diff", "--name-only", "--no-renames", fork, to])) ?? "").split("\n").filter(Boolean));
  if (ahead !== "") {
    // git's own replay decides what conflicts; a conflicting one is undone, leaving the clone as it was.
    const r = await run(["rebase", "--quiet", "--onto", to, fork], 300_000);
    if (r.exit_code !== 0) {
      const conflicts = ((await out(["diff", "--name-only", "--diff-filter=U"])) ?? "").split("\n").filter(Boolean);
      await run(["rebase", "--abort"]);
      return no(`the commits could not be replayed onto the new base: ${r.stderr.trim().slice(-200)}`, true, conflicts);
    }
    return (await out(["merge-base", "--is-ancestor", to, "HEAD"])) !== null ? { ok: true, carried: "commits" } : no("the replay did not end on the new base", true);
  }
  if (dirty !== "") {
    const edited = ((await out(["diff", "--name-only", "--no-renames", "HEAD"])) ?? "").split("\n").filter(Boolean);
    const added = ((await out(["ls-files", "--others", "--exclude-standard"])) ?? "").split("\n").filter(Boolean);
    const mine = [...new Set([...edited, ...added])];
    const both = mine.filter((f) => moved.has(f));
    if (both.length > 0) return no("the new base also changed paths the clone's uncommitted edits change", true, both);
    if ((await out(["checkout", "--quiet", "-B", own, to])) === null) return no("the edits could not be kept across the move", true, mine);
    return (await out(["rev-parse", "HEAD"])) === to ? { ok: true, carried: "uncommitted" } : no("the move did not end on the new base", true);
  }
  if ((await out(["checkout", "--quiet", "-B", own, to])) === null) return no("the clone's branch could not be moved");
  return (await out(["rev-parse", "HEAD"])) === to ? { ok: true } : no("the move did not end on the new base");
}

// The newest clone under `trees` of this repo, that this request may be handed (handouts), still as made: its own walk/<name> branch, HEAD at `base`, origin
// `origin`, nothing changed or untracked. Read as the shell user, who owns the clones.
async function unchangedClone(trees: string, repo: string, base: string, origin: string, h: Handouts | null): Promise<string | null> {
  if (h === null) return null;
  let names: string[];
  try { names = readdirSync(trees).filter((n) => n.startsWith(`${repo}-`)).sort().reverse(); } catch { return null; }
  for (const name of names) {
    const dir = join(trees, name);
    if (!h.may(dir)) continue;
    if (!isRepo(dir)) continue;
    const out = async (args: string[]) => { const r = await git(["-C", dir, ...args], tmpdir()); return r.exit_code === 0 ? r.stdout.trim() : null; };
    if ((await out(["rev-parse", "--abbrev-ref", "HEAD"])) !== `walk/${name}`) continue;
    if ((await out(["rev-parse", "HEAD"])) !== base) continue;
    if ((await out(["config", "--get", "remote.origin.url"])) !== origin) continue;
    if ((await out(["status", "--porcelain", "--untracked-files=all"])) !== "") continue;
    return dir;
  }
  return null;
}
