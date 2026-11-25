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

// How many bases are kept: a base is reused only until origin moves, so the newest few cover every diff in flight.
const KEPT = 16;
const runs = new Map<string, Promise<BaseRun>>();

/**
 * The base's whole-suite run, made once per key (the repository, the base's sha, the install identity, the runner's
 * version): every diff of a change on that base runs the same tests on the same code against the same packages, so its
 * run is reused, and two diffs asking at once share one run. Only what the verdicts read is kept (the tests passed and
 * failed, the exit code, whether it was signalled). A run stopped at its bound or that wrote no report is never kept,
 * so the next diff runs it again.
 * A flaky test is read as the kept run had it, until origin moves: a flaky pass kept makes every tree where it fails
 * read it as regressed; a flaky failure kept reads it as the base's own.
 */
export async function baseRun(key: readonly unknown[], run: () => Promise<BaseRun>): Promise<BaseRun> {
  const k = JSON.stringify(key);
  const held = runs.get(k);
  if (held !== undefined) return held;
  const made = run().then((r) => {
    if (r.killed || r.passed === null) runs.delete(k);
    else runs.set(k, Promise.resolve({ passed: r.passed, failed: r.failed, exit_code: r.exit_code, signalled: r.signalled, killed: false, out: "" }));
    return r;
  }, (e: unknown) => { runs.delete(k); throw e; });
  runs.set(k, made);
  while (runs.size > KEPT) runs.delete(runs.keys().next().value as string);
  return made;
}

/** Whether a base run for this key is kept or in flight (for the suite's record: base_cached). */
export const baseHeld = (key: readonly unknown[]): boolean => runs.has(JSON.stringify(key));
