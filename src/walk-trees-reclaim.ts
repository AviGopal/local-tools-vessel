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
// Anything this cannot read fails closed: a records read that errors, or answers no list, removes nothing. Only a directory directly under the clones directory (realpath, no symlink) that is
// a whole clone (its own .git directory) is ever touched.
import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { withClones } from "./clones-lock.js";
import { git } from "./git-commit.js";
import { walkTreesDir } from "./tool-roots.js";
import { readRows, type Row, walkCalls } from "./walk-rows.js";

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

  // records' calls read: the walk's git_worktree and git_land calls and every call still in flight, each with its root
  // and whether that root is open, and no selection, so it grows with the calls, not with what the selections saw.
  const arms = await readRows({ shape: "arm" });
  if (!Array.isArray(arms)) return arms;
  const walks = [...new Set((arms as Row[]).map((a) => String(a.vessel_id ?? "")).filter((v) => v !== ""))];
  const calls = await walkCalls(walks, ["git_worktree", "git_land"]);
  if (!Array.isArray(calls)) return calls;
  const rootOf = (root: string): string => root || "?";
  const open = new Set(calls.filter((c) => c.open).map((c) => c.root));
  // Calls in flight (of any shape): their roots' clones are in use.
  const inFlight = calls.filter((c) => c.state === "started");
  const busy = new Set(inFlight.map((c) => rootOf(c.root)));
  // A clone being made is on disk before any row names it: while a git_worktree call is in flight, no unnamed clone goes.
  const making = inFlight.some((c) => c.type === "git_worktree");
  const named = new Map<string, Set<string>>();
  for (const c of calls.filter((x) => x.state === "ended" && x.type === "git_worktree")) {
    const cwd = String(c.output?.cwd ?? "");
    if (!cwd) continue;
    if (!named.has(cwd)) named.set(cwd, new Set());
    named.get(cwd)!.add(rootOf(c.root));
  }
  const landed = new Set(calls.filter((x) => x.state === "ended" && x.type === "git_land").map((c) => String(c.output?.cwd ?? "")));

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
