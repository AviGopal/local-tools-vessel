// git_worktree: a fresh clone for one change, owned by the shell user, outside every protected location.
//
// It is cloned from this node's own copy of the repository (the super-repo clone, or the push clone of a vessel), so no
// credential is needed and none is in the command's env. Its origin is set to that copy's origin, which is where a
// landing pushes. The answer names the clone, its base (the copy's HEAD it was cloned at) and the super-repo's HEAD,
// whose hooks judge a commit in it. The walk records that answer in its hop row, and a commit or landing reads it back
// from there (walk-rows.ts).
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, vesselGit } from "./git-commit.js";
import { agentWritableDir } from "./shell-privilege.js";
import { withClones } from "./clones-lock.js";
import { walkTreesDir } from "./tool-roots.js";
import { openEpisodes, readRows, type Row } from "./walk-rows.js";
import { containmentZones, type Env } from "./write-containment.js";

// Where change clones are made: also a tool root (tool-roots.ts), so the file tools work in a clone's cwd.
export { walkTreesDir };

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type Worktree =
  | { shape: "gitWorktree"; cwd: string; repo: string; branch: string; base: string; super_base: string; origin_url: string }
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
// was handed to, or once every request it was handed to is closed. Read from the rows of the roots records lists as open
// (openEpisodes: each open root's selections and their hops), so the read is bounded by the work open now: a clone no
// open root's git_worktree hop names was handed only to closed requests, or to none. Anything unread (no selection
// named, a records read failing) hands nothing out again: a fresh clone costs disk, a shared one would put one request's
// edit into another's commit. `ours` is the asking request's own clones, newest first, each with what its hop recorded
// (repo, branch, base, origin), less any it has landed.
type Handouts = { mine: string; may: (cwd: string) => boolean; ours: Array<{ cwd: string; made: Row }> };
async function handouts(selectionRef: string | undefined): Promise<Handouts | null> {
  if (!selectionRef) return null;
  const [sel, arms] = await Promise.all([readRows({ ids: [selectionRef] }), readRows({ shape: "arm" })]);
  if (!Array.isArray(sel) || !Array.isArray(arms)) return null;
  const mine = String(sel.find((r) => r.id === selectionRef)?.root ?? "");
  if (!mine) return null;
  const eps = await openEpisodes([...new Set((arms as Row[]).map((a) => String(a.vessel_id ?? "")).filter((v) => v !== ""))]);
  if (!Array.isArray(eps)) return null;
  const to = new Map<string, Set<string>>();
  const own: Array<{ cwd: string; made: Row; seq: number }> = [];
  const landed = new Set<string>();
  for (const { root, rows } of eps) {
    const walk = rows.filter((r) => r.shape === "hop" && r.role === "walk");
    const called = (type: string) => new Set(walk.filter((h) => h.phase === "started" && h.pointer_type === type).map((h) => String(h.call_id)));
    const [made, lands] = [called("git_worktree"), called("git_land")];
    for (const h of walk.filter((x) => x.phase === "ended")) {
      const cwd = String(h.output?.cwd ?? "");
      if (!cwd) continue;
      if (lands.has(String(h.call_id))) { if (root === mine) landed.add(cwd); continue; }
      if (!made.has(String(h.call_id))) continue;
      if (!to.has(cwd)) to.set(cwd, new Set());
      to.get(cwd)!.add(root);
      if (root === mine) own.push({ cwd, made: (h.output ?? {}) as Row, seq: Number(h.seq ?? 0) });
    }
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
  const ownClone = h?.ours.find((o) => o.made.repo === repo && o.made.base === base && o.made.origin_url === origin && isRepo(o.cwd)
    && typeof o.made.branch === "string" && o.made.branch !== "");
  if (ownClone) {
    const m = ownClone.made as Record<string, string>;
    return { shape: "gitWorktree", cwd: ownClone.cwd, repo, branch: m.branch, base: m.base, super_base: superBase, origin_url: m.origin_url };
  }
  const reused = await unchangedClone(trees, repo, base, origin, h);
  if (reused) return { shape: "gitWorktree", cwd: reused, repo, branch, base, super_base: superBase, origin_url: origin };
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
  return { shape: "gitWorktree", cwd, repo, branch, base, super_base: superBase, origin_url: origin };
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
