// walk_trees_reclaim: removes the change clones git_worktree made that nothing will use again. Each clone is a whole
// repository; made per change and never removed, they filled a node's disk.
//
// What a clone is for is read from the walk's rows in records (walk-rows.ts), never from a clock:
//   - in use: a selection whose call started and has neither ended nor failed works the root it belongs to, or that root
//     is still open (records' episode read lists it): kept;
//   - landed: a git_land call that ended names it: removed;
//   - unchanged (nothing modified or untracked, no commit beyond what its origin's copy has): removed once no open root
//     names it, except the newest unchanged clone of each origin, which git_worktree hands out again;
//   - changed and not landed: kept and reported. What the walk tried there is evidence; deciding to drop it is a later
//     rule, not this one.
// Anything this cannot read fails closed: a records read that errors, or an open-roots read that answers nothing while
// selections exist, removes nothing. Only a directory directly under the clones directory (realpath, no symlink) that is
// a whole clone (its own .git directory) is ever touched.
import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { withClones } from "./clones-lock.js";
import { git } from "./git-commit.js";
import { walkTreesDir } from "./tool-roots.js";
import { openRoots, readRows, type Row } from "./walk-rows.js";

export type Reclaimed =
  | { shape: "walkTreesReclaim"; removed: string[]; reported: Array<{ cwd: string; why: string }>; kept: number }
  | { error: string };

type Env = Record<string, string | undefined>;

export const reclaimWalkTrees = (env: Env = process.env, remove: (p: string) => unknown = (p) => rmSync(p, { recursive: true })): Promise<Reclaimed> =>
  withClones(() => reclaim(env, remove));

// Under the clones lock, from reading the rows to the last removal, so no clone is handed out in between.
async function reclaim(env: Env, remove: (p: string) => unknown): Promise<Reclaimed> {
  const dir = walkTreesDir(env);
  let base: string;
  try { base = realpathSync(dir); } catch { return { shape: "walkTreesReclaim", removed: [], reported: [], kept: 0 }; }

  const [hops, failures, sels, arms] = await Promise.all([
    readRows({ shape: "hop" }), readRows({ shape: "failure" }), readRows({ shape: "selection" }), readRows({ shape: "arm" }),
  ]);
  for (const r of [hops, failures, sels, arms]) if (!Array.isArray(r)) return r;
  const walkRows = (rows: Row[]) => rows.filter((r) => r.role === "walk");
  const hop = walkRows(hops as Row[]);
  const selection = new Map(walkRows(sels as Row[]).map((s) => [s.id, s]));
  const walks = [...new Set((arms as Row[]).map((a) => String(a.vessel_id ?? "")).filter((v) => v !== ""))];
  const open = await openRoots(walks);
  if (!(open instanceof Set)) return open;
  if (open.size === 0 && selection.size > 0) return { error: "records lists no open root while the walk has selections: nothing is removed" };

  const rootOf = (selRef: unknown): string | undefined => {
    const s = selection.get(String(selRef));
    return s === undefined ? undefined : String(s.root ?? "");
  };
  // Calls in flight: started, with no ended hop and no failure for the same call. Their roots' clones are in use.
  const settled = new Set([...hop.filter((h) => h.phase === "ended"), ...walkRows(failures as Row[])].map((r) => String(r.call_id)));
  const inFlight = hop.filter((h) => h.phase === "started" && !settled.has(String(h.call_id)))
  const busy = new Set(inFlight.map((h) => rootOf(h.selection_ref) ?? "?"));
  // A clone being made is on disk before any row names it: while a git_worktree call is in flight, no unnamed clone goes.
  const making = inFlight.some((h) => h.pointer_type === "git_worktree");
  const named = new Map<string, Set<string>>();
  for (const h of hop.filter((x) => x.phase === "ended" && x.pointer_type === "git_worktree")) {
    const cwd = String(h.output?.cwd ?? "");
    if (!cwd) continue;
    if (!named.has(cwd)) named.set(cwd, new Set());
    named.get(cwd)!.add(rootOf(h.selection_ref) ?? "?");
  }
  const landed = new Set(hop.filter((h) => h.phase === "ended" && h.pointer_type === "git_land").map((h) => String(h.output?.cwd ?? "")));

  const out = async (cwd: string, args: string[]) => {
    const r = await git(["-C", cwd, ...args], tmpdir());
    return r.exit_code === 0 ? r.stdout.trim() : null;
  };
  type Clone = { cwd: string; origin: string; unchanged: boolean };
  const clones: Clone[] = [];
  const reported: Array<{ cwd: string; why: string }> = [];
  for (const name of readdirSync(base).sort()) {
    const cwd = join(base, name);
    try {
      if (!lstatSync(cwd).isDirectory()) continue; // a symlink or a file is never a clone of ours
      if (realpathSync(cwd) !== cwd || !cwd.startsWith(base + sep)) continue;
      if (!lstatSync(join(cwd, ".git")).isDirectory()) continue; // a gitfile points elsewhere: not a whole clone
    } catch { continue; }
    const status = await out(cwd, ["status", "--porcelain", "--untracked-files=all"]);
    const ahead = await out(cwd, ["rev-list", "HEAD", "--not", "--remotes"]);
    const origin = (await out(cwd, ["config", "--get", "remote.origin.url"])) ?? "";
    if (status === null || ahead === null) { reported.push({ cwd, why: "its state could not be read" }); continue; }
    clones.push({ cwd, origin, unchanged: status === "" && ahead === "" });
  }
  // The newest unchanged clone of each origin is the one git_worktree hands out again (names sort by when they were made).
  const target = new Map<string, string>();
  for (const c of clones.filter((x) => x.unchanged)) target.set(c.origin, c.cwd);

  const removed: string[] = [];
  let kept = 0;
  for (const c of clones) {
    const roots = named.get(c.cwd) ?? new Set<string>();
    const inUse = [...roots].some((r) => open.has(r) || busy.has(r)) || (roots.size > 0 && busy.has("?")) || (roots.size === 0 && making);
    const drop = !inUse && (landed.has(c.cwd) || (c.unchanged && target.get(c.origin) !== c.cwd));
    if (drop) {
      try { await remove(c.cwd); removed.push(c.cwd); } catch (e) { reported.push({ cwd: c.cwd, why: `could not be removed: ${(e as Error).message}` }); }
      continue;
    }
    kept++;
    if (!inUse && !c.unchanged && !landed.has(c.cwd)) {
      reported.push({ cwd: c.cwd, why: roots.size > 0 ? "changed and not landed; its request is closed" : "changed, and no walk row names it" });
    }
  }
  return { shape: "walkTreesReclaim", removed, reported, kept };
}
