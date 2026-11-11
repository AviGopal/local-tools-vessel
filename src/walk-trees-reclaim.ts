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

// What it did with each clone it looked at, so the answer (and the walk's hop row of it) says why each went or stayed.
export type Decision = { cwd: string; did: "removed" | "kept" | "reported"; why: string };
export type Reclaimed =
  | { shape: "walkTreesReclaim"; removed: string[]; reported: Array<{ cwd: string; why: string }>; kept: number; decisions: Decision[]; more: boolean; busy?: true }
  | { error: string };

type Env = Record<string, string | undefined>;

// One reclaim at a time: a call that finds one running answers at once that it is busy, rather than queueing a whole
// second pass behind it (a caller that gave up on the first would otherwise stack them).
let running = false;

/** budgetMs: how long it may decide and remove before answering with what it has done (more: true when clones remain
 *  unexamined), so the answer always comes back to the caller within its wait. */
export const reclaimWalkTrees = async (env: Env = process.env, remove: (p: string) => unknown = (p) => rmSync(p, { recursive: true }), budgetMs = 5_000): Promise<Reclaimed> => {
  if (running) return { shape: "walkTreesReclaim", removed: [], reported: [], kept: 0, decisions: [], more: true, busy: true };
  running = true;
  try { return await withClones(() => reclaim(env, remove, budgetMs)); } finally { running = false; }
};

// Under the clones lock, from reading the rows to the last removal, so no clone is handed out in between.
async function reclaim(env: Env, remove: (p: string) => unknown, budgetMs: number): Promise<Reclaimed> {
  const started = Date.now();
  const dir = walkTreesDir(env);
  let base: string;
  try { base = realpathSync(dir); } catch { return { shape: "walkTreesReclaim", removed: [], reported: [], kept: 0, decisions: [], more: false }; }

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
  // Newest first (names sort by when they were made): the first unchanged clone of an origin is the one git_worktree hands
  // out again and is kept; an older unchanged one may go only after it. So stopping at the budget leaves only unexamined
  // older clones, never a removal made without the newer one seen.
  const removed: string[] = [];
  const reported: Array<{ cwd: string; why: string }> = [];
  const decisions: Decision[] = [];
  const target = new Map<string, string>();
  let kept = 0;
  let more = false;
  const decide = (cwd: string, did: Decision["did"], why: string) => {
    decisions.push({ cwd, did, why });
    if (did === "removed") removed.push(cwd); else kept++;
    if (did === "reported") reported.push({ cwd, why });
  };
  for (const name of readdirSync(base).sort().reverse()) {
    if (Date.now() - started > budgetMs) { more = true; break; }
    const cwd = join(base, name);
    try {
      if (!lstatSync(cwd).isDirectory()) continue; // a symlink or a file is never a clone of ours
      if (realpathSync(cwd) !== cwd || !cwd.startsWith(base + sep)) continue;
      if (!lstatSync(join(cwd, ".git")).isDirectory()) continue; // a gitfile points elsewhere: not a whole clone
    } catch { continue; }
    const status = await out(cwd, ["status", "--porcelain", "--untracked-files=all"]);
    const ahead = await out(cwd, ["rev-list", "HEAD", "--not", "--remotes"]);
    const origin = (await out(cwd, ["config", "--get", "remote.origin.url"])) ?? "";
    if (status === null || ahead === null) { decide(cwd, "reported", "its state could not be read"); continue; }
    const unchanged = status === "" && ahead === "";
    if (unchanged && !target.has(origin)) { target.set(origin, cwd); decide(cwd, "kept", "the newest unchanged clone of its origin: handed out again"); continue; }
    const roots = named.get(cwd) ?? new Set<string>();
    const inUse = [...roots].some((r) => open.has(r) || busy.has(r)) || (roots.size > 0 && busy.has("?")) || (roots.size === 0 && making);
    if (inUse) { decide(cwd, "kept", "a request that is open or has a call in flight holds it"); continue; }
    if (landed.has(cwd) || unchanged) {
      try { await remove(cwd); decide(cwd, "removed", landed.has(cwd) ? "its change landed" : "unchanged, and no open request holds it"); }
      catch (e) { decide(cwd, "reported", `could not be removed: ${(e as Error).message}`); }
      continue;
    }
    decide(cwd, "reported", roots.size > 0 ? "changed and not landed; its request is closed" : "changed, and no walk row names it");
  }
  return { shape: "walkTreesReclaim", removed, reported, kept, decisions, more };
}
