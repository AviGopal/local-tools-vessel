// The base's whole-suite run is made once per key (repository, base sha, install identity, runner) and reused by every
// diff of that base; two diffs asking at once share one run; a run stopped at its bound, or that wrote no report, is
// not kept. The install identity changes when any installed package is replaced.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BaseRun, baseHeld, baseRun, installIdentity } from "./base-cache.js";

const done = (over: Partial<BaseRun> = {}): BaseRun => ({ passed: new Set(["a"]), failed: new Map([["b", "x"]]), exit_code: 1, signalled: false, killed: false, out: "log", ...over });
const counted = (r: () => BaseRun, wait = 0) => {
  const n = { runs: 0 };
  const run = async () => { n.runs++; if (wait) await Bun.sleep(wait); return r(); };
  return { n, run };
};

describe("the base's suite run, kept per key", () => {
  test("[MUST-FAIL] the same key twice runs the base once, and the second reads what the verdicts read", async () => {
    const { n, run } = counted(() => done());
    const key = ["demo", "sha-same", "inst", "1.0"];
    const first = await baseRun(key, run);
    const second = await baseRun(key, run);
    expect(n.runs).toBe(1);
    expect(baseHeld(key)).toBe(true);
    expect([...(second.passed ?? [])]).toEqual([...(first.passed ?? [])]);
    expect([...second.failed]).toEqual([...first.failed]);
    expect([second.exit_code, second.signalled, second.killed]).toEqual([1, false, false]);
  });

  test("[GUARD] a new base sha, or a changed install identity or runner, runs again", async () => {
    const { n, run } = counted(() => done());
    await baseRun(["demo", "sha-1", "inst", "1.0"], run);
    await baseRun(["demo", "sha-2", "inst", "1.0"], run);
    await baseRun(["demo", "sha-1", "inst-2", "1.0"], run);
    await baseRun(["demo", "sha-1", "inst", "1.1"], run);
    await baseRun(["other", "sha-1", "inst", "1.0"], run);
    expect(n.runs).toBe(5);
  });

  test("[GUARD] a run stopped at its bound, or that wrote no report, is not kept: the next asks again", async () => {
    for (const [i, over] of [{ killed: true, passed: null }, { passed: null }, { killed: true }].entries()) {
      const { n, run } = counted(() => done(over as Partial<BaseRun>));
      const key = ["demo", `sha-bad-${i}`, "inst", "1.0"];
      const r = await baseRun(key, run);
      expect(r.passed === null || r.killed).toBe(true);
      expect(baseHeld(key)).toBe(false);
      await baseRun(key, run);
      expect(n.runs).toBe(2);
    }
  });

  test("[GUARD] a run that throws is not kept", async () => {
    let n = 0;
    const key = ["demo", "sha-throw", "inst", "1.0"];
    await expect(baseRun(key, async () => { n++; throw new Error("no"); })).rejects.toThrow("no");
    expect(baseHeld(key)).toBe(false);
    await baseRun(key, async () => { n++; return done(); });
    expect(n).toBe(2);
  });

  test("[GUARD] two diffs asking at once share one run", async () => {
    const { n, run } = counted(() => done(), 30);
    const key = ["demo", "sha-both", "inst", "1.0"];
    const [a, b] = await Promise.all([baseRun(key, run), baseRun(key, run)]);
    expect(n.runs).toBe(1);
    expect(a.exit_code).toBe(b.exit_code);
  });
});

describe("the install identity", () => {
  const modules = () => {
    const m = mkdtempSync(join(tmpdir(), "mods-"));
    for (const p of ["typescript", "@scope/pkg"]) { mkdirSync(join(m, p), { recursive: true }); writeFileSync(join(m, p, "index.js"), "1"); }
    return m;
  };

  test("[GUARD] unchanged packages give the same identity", () => {
    const m = modules();
    expect(installIdentity(m)).toBe(installIdentity(m));
  });

  test("[MUST-FAIL] a package replaced, at the top or under a scope, gives a new identity", () => {
    for (const p of ["typescript", "@scope/pkg"]) {
      const m = modules();
      const before = installIdentity(m);
      renameSync(join(m, p), join(m, `${p}.old`));
      mkdirSync(join(m, p));
      expect(installIdentity(m)).not.toBe(before);
    }
    // a package unpacked with the times it was archived with: the same modification time, another directory
    const same = modules();
    const at = (...ps: string[]) => { for (const p of ps) utimesSync(p, 1_000_000, 1_000_000); };
    at(join(same, "typescript"), same);
    const kept = installIdentity(same);
    renameSync(join(same, "typescript"), join(mkdtempSync(join(tmpdir(), "aside-")), "typescript"));
    mkdirSync(join(same, "typescript"));
    at(join(same, "typescript"), same);
    expect(installIdentity(same)).not.toBe(kept);
    // a linked package: what it links to is replaced, the link is not
    const m = modules();
    const target = mkdtempSync(join(tmpdir(), "linked-"));
    mkdirSync(join(target, "pkg"));
    symlinkSync(join(target, "pkg"), join(m, "@scope", "linked"));
    const before = installIdentity(m);
    renameSync(join(target, "pkg"), join(target, "pkg.old"));
    mkdirSync(join(target, "pkg"));
    expect(installIdentity(m)).not.toBe(before);
  });

  test("[GUARD] no installed packages gives an identity still (the run is made, and kept as such)", () => {
    const missing = join(tmpdir(), "no-such-modules-dir");
    expect(installIdentity(missing)).toBe(installIdentity(missing));
  });
});
