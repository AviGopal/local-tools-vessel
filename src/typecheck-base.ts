import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installIdentity } from "./base-cache.js";
import { agentWritableDir } from "./shell-privilege.js";
import type { Made } from "./walk-rows.js";

/** The compiler's errors in a typecheck's output: each line naming an error TS code, as the compiler wrote it. */
export const tsErrors = (out: string): string[] => out.split("\n").map((l) => l.trimEnd()).filter((l) => /\berror TS\d+:/.test(l));

/** The change's errors the base does not have, as many times as the change has them more often. Two errors are compared
 * without their line and column, so an error the change only moved is the same error; each one added is given as the
 * change's compile wrote it, where it is now. The key is the comparison's only: a reader is shown where. */
const errorKey = (e: string): string => e.replace(/\(\d+,\d+\)/, "");
export function addedErrors(base: string[], change: string[]): string[] {
  const left = new Map<string, number>();
  for (const e of base) left.set(errorKey(e), (left.get(errorKey(e)) ?? 0) + 1);
  const out: string[] = [];
  for (const e of change) {
    const n = left.get(errorKey(e)) ?? 0;
    if (n > 0) left.set(errorKey(e), n - 1);
    else out.push(e);
  }
  return out;
}

/** A shell command run as the walk's own shell calls are (unprivileged, bounded), in cwd. */
export type Sh = (cmd: string, cwd: string) => Promise<{ stdout: string; stderr: string; exit_code: number }>;
export type BaseTypecheck = { errors: string[]; exit_code: number };

// Printed after the base's script ends, with its exit code: a run cut at its bound never prints it, so it is not kept.
const DONE = "__typecheck_base_done__";
const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const kept = new Map<string, Promise<BaseTypecheck | { why: string }>>();

/**
 * The same typecheck script run on the clone's base: the base's tree, written out of the clone by the shell user (the
 * clone is the shell's own), against the clone's installed modules, so the base and the change are compiled against the
 * same packages. Made once per key, the base cache's own (the repository, the base's sha, the install identity of those
 * modules, the runner's version), with the command added: every typecheck of a change on that base compiles the same
 * code against the same packages. One base is kept per repository, and a run that did not end (cut at its bound) or
 * could not write the base out is not kept.
 */
export function baseTypecheck(made: Made, bunCmd: string, script: string, sh: Sh, work = tmpdir()): Promise<BaseTypecheck | { why: string }> {
  const modules = join(made.cwd, "node_modules");
  const key = JSON.stringify([made.repo, made.base, existsSync(modules) ? installIdentity(realpathSync(modules)) : "", Bun.version, bunCmd, script]);
  const held = kept.get(key);
  if (held !== undefined) return held;
  const run = (async (): Promise<BaseTypecheck | { why: string }> => {
    const parent = mkdtempSync(join(work, "typecheck-base-"));
    try {
      chmodSync(parent, 0o711);
      const dir = agentWritableDir(join(parent, "base"));
      const r = await sh([
        `set -o pipefail; git archive --format=tar ${q(made.base)} | tar -x -C ${q(dir)} || exit 90`,
        `if [ -e node_modules ]; then ln -s "$(pwd -P)/node_modules" ${q(join(dir, "node_modules"))}; fi`,
        `cd ${q(dir)} && ${bunCmd} run ${script}; echo "${DONE} $?"`,
      ].join("\n"), made.cwd);
      const out = `${r.stdout}\n${r.stderr}`;
      const done = new RegExp(`^${DONE} (\\d+)$`, "m").exec(r.stdout);
      if (done === null) return { why: r.exit_code === 90 ? "the base could not be written out of the clone" : `the base's typecheck did not end (exit ${r.exit_code})` };
      return { errors: tsErrors(out), exit_code: Number(done[1]) };
    } finally {
      try { rmSync(parent, { recursive: true, force: true }); } catch { /* a temp dir */ }
    }
  })();
  run.then((r) => { if ("why" in r && kept.get(key) === run) kept.delete(key); }, () => { if (kept.get(key) === run) kept.delete(key); });
  for (const other of [...kept.keys()]) if (JSON.parse(other)[0] === made.repo) kept.delete(other);
  kept.set(key, run);
  return run;
}

/**
 * How many of a typecheck's errors were the base's and how many the change added: the same script run on the clone's
 * base (baseTypecheck), compared error by error as git_diff's typecheck compares them. A cwd that is not the clone the
 * walk made has no base to compare with: said so, with why.
 */
export async function errorsAgainstBase(out: string, made: Made | { error: string } | null, bunCmd: string, script: string, sh: Sh, work?: string):
  Promise<{ base_error_count: number; added_error_count: number; base: string } | { base_why: string }> {
  if (made === null || "error" in made) return { base_why: made === null ? "cwd is not a clone the walk made: there is no base to compare with" : made.error };
  const b = await baseTypecheck(made, bunCmd, script, sh, work).catch((e: unknown) => ({ why: String(e) }));
  if ("why" in b) return { base_why: b.why };
  return { base_error_count: b.errors.length, added_error_count: addedErrors(b.errors, tsErrors(out)).length, base: made.base };
}
