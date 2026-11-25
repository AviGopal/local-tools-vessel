import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** A whole-suite run as git_diff reads it: the tests its report says passed (null: no report) and failed. */
export type BaseRun = { passed: Set<string> | null; failed: Map<string, string>; exit_code: number; signalled: boolean; killed: boolean; out: string };

/**
 * What the installed packages a suite runs against are, as a key: each entry of node_modules, and each package under a
 * scope, by inode and modification time, of what it is or (a linked package) what it links to. An install replaces a
 * package's directory (the old one is moved aside), so a new install of any package gives a new key, and a base run made
 * against the old packages is not reused.
 */
export function installIdentity(modules: string): string {
  const h = createHash("sha256");
  const stamp = (rel: string): void => {
    try { const s = statSync(join(modules, rel)); h.update(`${rel}\0${s.ino}\0${s.mtimeMs}\0`); } catch { h.update(`${rel}\0-\0`); }
  };
  const list = (rel: string): string[] => { try { return readdirSync(join(modules, rel)).sort(); } catch { return []; } };
  stamp("");
  for (const n of list("")) {
    stamp(n);
    if (n.startsWith("@")) for (const m of list(n)) stamp(join(n, m));
  }
  return h.digest("hex");
}

// How much of a kept run's output is kept: its tail, as much as a check shows of its own (CHECK_OUT_MAX, git-land.ts), so
// the base's evidence is still there on a diff that reads the kept run.
export const BASE_OUT_KEPT = 4 * 1024;
type Entry = { run: Promise<BaseRun>; settled: boolean };
const runs = new Map<string, Entry>();

/**
 * The base's whole-suite run, made once per key (the repository first, then the base's sha, the install identity, the
 * runner's version): every diff of a change on that base runs the same tests on the same code against the same packages,
 * so its run is reused, and two diffs asking at once share one run. Only what the verdicts read is kept (the tests
 * passed and failed, the exit code, whether it was signalled), with its output's tail. A run stopped at its bound, that
 * wrote no report, or that threw is never kept, so the next diff runs it again.
 * One base is kept per repository: a run for a new base of it replaces the one kept, since a diff is made on origin's
 * newest base, and a diff on an older one runs its own.
 * fresh: the kept run is not read; this run replaces it (a run in flight is still shared). A kept run is read once more
 * only as its run had it: a flaky test that passed there and fails on a tree would read as the tree's regression on every
 * diff of the base, and refuse each, so a regression read against a kept run is judged again on a fresh one.
 */
export async function baseRun(key: readonly unknown[], run: () => Promise<BaseRun>, fresh = false): Promise<BaseRun> {
  const k = JSON.stringify(key);
  const held = runs.get(k);
  if (held !== undefined && !(fresh && held.settled)) return held.run;
  const entry: Entry = { run: Promise.resolve(null as never), settled: false };
  entry.run = run().then((r) => {
    if (runs.get(k) !== entry) return r;
    if (r.killed || r.passed === null) runs.delete(k);
    else {
      runs.set(k, { run: Promise.resolve({ passed: r.passed, failed: r.failed, exit_code: r.exit_code, signalled: r.signalled, killed: false, out: r.out.slice(-BASE_OUT_KEPT) }), settled: true });
    }
    return r;
  }, (e: unknown) => { if (runs.get(k) === entry) runs.delete(k); throw e; });
  for (const other of [...runs.keys()]) if (other !== k && JSON.parse(other)[0] === key[0]) runs.delete(other);
  runs.set(k, entry);
  return entry.run;
}

/** Whether a base run for this key is kept or in flight (for the suite's record: base_cached). */
export const baseHeld = (key: readonly unknown[]): boolean => runs.has(JSON.stringify(key));
