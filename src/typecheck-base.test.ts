import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addedErrors, errorsAgainstBase, tsErrors, type Sh } from "./typecheck-base";
import type { Made } from "./walk-rows";

// A clone whose typecheck script prints errs.txt (the errors as tsc writes them) and fails when it has any.
const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};
const E1 = "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.";
const E2 = "src/b.ts(9,1): error TS2304: Cannot find name 'parseHeadline'.";
const E3 = "src/c.ts(1,14): error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.";
function clone(baseErrs: string[], scripts: Record<string, string> = {}): { made: Made; edit: (errs: string[]) => void; work: string } {
  const work = mkdtempSync(join(tmpdir(), "tcb-"));
  const cwd = join(work, "clone");
  Bun.spawnSync(["mkdir", cwd]);
  git(cwd, "init", "-q");
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { typecheck: "cat errs.txt; test ! -s errs.txt", ...scripts } }));
  const write = (errs: string[]) => writeFileSync(join(cwd, "errs.txt"), errs.map((e) => `${e}\n`).join(""));
  write(baseErrs);
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  const base = git(cwd, "rev-parse", "HEAD");
  return { made: { cwd, repo: `r-${base.slice(0, 8)}-${work.slice(-6)}`, branch: "b", base, super_base: base, origin_url: "file:///x" }, edit: write, work };
}
const runs: string[] = [];
const sh: Sh = async (cmd, cwd) => {
  runs.push(cwd);
  const p = Bun.spawnSync(["bash", "-c", cmd], { cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  return { stdout: p.stdout.toString(), stderr: p.stderr.toString(), exit_code: p.exitCode ?? -1 };
};
const typecheck = async (cwd: string) => (await sh("bun run typecheck", cwd)).stdout;
// The handler's shell drops to the shell user when the test runs as root (shell-privilege.ts): the clone is handed to it,
// as the walk's clones are its own, inside a directory it may enter.
const forShell = (c: { made: Made; work: string }) => {
  chmodSync(c.work, 0o755);
  if (process.getuid?.() === 0) Bun.spawnSync(["chown", "-R", "65534:65534", c.made.cwd]);
};

describe("a typecheck's errors, the base's and the clone's edits'", () => {
  it("[MUST-FAIL] errors the base already had are counted as the base's; only the edits' own are added (a moved one is not)", async () => {
    const c = clone([E1, E2]);
    try {
      c.edit([E1.replace("(3,7)", "(5,7)"), E2, E3]);
      const r = await errorsAgainstBase(await typecheck(c.made.cwd), c.made, "bun", "typecheck", sh, c.work);
      expect(r).toEqual({ base_error_count: 2, added_error_count: 1, base: c.made.base });
    } finally { rmSync(c.work, { recursive: true, force: true }); }
  });

  it("[MUST-FAIL] a clean base: every error is the edits'", async () => {
    const c = clone([]);
    try {
      c.edit([E1, E2, E3]);
      const r = await errorsAgainstBase(await typecheck(c.made.cwd), c.made, "bun", "typecheck", sh, c.work);
      expect(r).toEqual({ base_error_count: 0, added_error_count: 3, base: c.made.base });
    } finally { rmSync(c.work, { recursive: true, force: true }); }
  });

  it("[MUST-FAIL] the base's run is made once per base: a second typecheck reuses it, a new base runs its own", async () => {
    const c = clone([E1]);
    try {
      c.edit([E1, E2]);
      const out = await typecheck(c.made.cwd);
      runs.length = 0;
      await errorsAgainstBase(out, c.made, "bun", "typecheck", sh, c.work);
      await errorsAgainstBase(out, c.made, "bun", "typecheck", sh, c.work);
      expect(runs.length).toBe(1);
      git(c.made.cwd, "add", "-A");
      git(c.made.cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "next");
      const next = { ...c.made, base: git(c.made.cwd, "rev-parse", "HEAD") };
      expect(await errorsAgainstBase(out, next, "bun", "typecheck", sh, c.work)).toEqual({ base_error_count: 2, added_error_count: 0, base: next.base });
      expect(runs.length).toBe(2);
      // one base is kept per repository: the first base's run was replaced, so it runs again
      await errorsAgainstBase(out, c.made, "bun", "typecheck", sh, c.work);
      expect(runs.length).toBe(3);
    } finally { rmSync(c.work, { recursive: true, force: true }); }
  });

  it("[MUST-FAIL] a new install of the clone's modules, or another script, runs the base again", async () => {
    const c = clone([E1], { check: "cat errs.txt; test ! -s errs.txt" });
    try {
      mkdirSync(join(c.made.cwd, "node_modules", "pkg-a"), { recursive: true });
      runs.length = 0;
      await errorsAgainstBase(E1, c.made, "bun", "typecheck", sh, c.work);
      await errorsAgainstBase(E1, c.made, "bun", "typecheck", sh, c.work);
      expect(runs.length).toBe(1);
      mkdirSync(join(c.made.cwd, "node_modules", "pkg-b"));
      expect(await errorsAgainstBase(E1, c.made, "bun", "typecheck", sh, c.work)).toEqual({ base_error_count: 1, added_error_count: 0, base: c.made.base });
      expect(runs.length).toBe(2);
      expect(await errorsAgainstBase(E1, c.made, "bun", "check", sh, c.work)).toEqual({ base_error_count: 1, added_error_count: 0, base: c.made.base });
      expect(runs.length).toBe(3);
    } finally { rmSync(c.work, { recursive: true, force: true }); }
  });

  it("[MUST-FAIL] a base run that did not end is said so and not kept: the next typecheck runs it again", async () => {
    const c = clone([E1]);
    try {
      let n = 0;
      const cut: Sh = async () => { n++; return { stdout: "", stderr: "", exit_code: 137 }; };
      expect(await errorsAgainstBase(E1, c.made, "bun", "typecheck", cut, c.work)).toEqual({ base_why: "the base's typecheck did not end (exit 137)" });
      await errorsAgainstBase(E1, c.made, "bun", "typecheck", cut, c.work);
      expect(n).toBe(2);
    } finally { rmSync(c.work, { recursive: true, force: true }); }
  });

  it("[MUST-FAIL] a base the clone does not hold cannot be written out: said so, and not kept", async () => {
    const c = clone([E1]);
    try {
      const gone = { ...c.made, base: "0".repeat(40) };
      runs.length = 0;
      expect(await errorsAgainstBase(E1, gone, "bun", "typecheck", sh, c.work)).toEqual({ base_why: "the base could not be written out of the clone" });
      await errorsAgainstBase(E1, gone, "bun", "typecheck", sh, c.work);
      expect(runs.length).toBe(2);
    } finally { rmSync(c.work, { recursive: true, force: true }); }
  });

  it("[GUARD] a cwd that is not the walk's clone has no base: said why, and no count", async () => {
    expect(await errorsAgainstBase(E1, null, "bun", "typecheck", sh)).toEqual({ base_why: "cwd is not a clone the walk made: there is no base to compare with" });
    expect(await errorsAgainstBase(E1, { error: "no walk row records a clone made at /x" }, "bun", "typecheck", sh)).toEqual({ base_why: "no walk row records a clone made at /x" });
  });

  it("[GUARD] tsErrors keeps every error line, uncapped; addedErrors counts a repeated error as often as it is added", () => {
    const many = Array.from({ length: 30 }, (_, i) => `src/x.ts(${i + 1},1): error TS2304: Cannot find name 'n${i}'.`);
    expect(tsErrors(["noise", ...many, "Found 30 errors."].join("\n")).length).toBe(30);
    expect(addedErrors([E1], [E1, E1.replace("(3,7)", "(4,7)")])).toEqual([E1.replace("(3,7)", "(4,7)")]);
  });
});

describe("code_verify_typecheck on the walk's clone", () => {
  const realFetch = globalThis.fetch;
  // Every test file runs in one process: what this one sets is put back as it was, or removed if it was unset.
  const KEYS = ["DISCOVERY_ENDPOINT", "MITOSIS_PUSH_CLONE_DIR"];
  const before = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  afterAll(() => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  // records, through discovery: the walk's git_worktree call that made the clone, ended with its output; the node's copy
  // of its repository is a directory holding no repository, so the clone's base is the one the row says
  const records = (made: Made | null, work: string) => {
    process.env.DISCOVERY_ENDPOINT = "http://records.test";
    process.env.MITOSIS_PUSH_CLONE_DIR = work;
    if (made !== null) mkdirSync(join(work, made.repo), { recursive: true });
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const p = (JSON.parse(String(init?.body ?? "{}")) as { pointer: { shape?: string; where?: Record<string, unknown> } }).pointer;
      const w = p.where ?? {};
      if (made === null || p.shape !== "hop") return Response.json([]);
      if (w.phase === "started" && w.pointer_type === "git_worktree") return Response.json([{ id: "h1", shape: "hop", role: "walk", call_id: "c1", phase: "started", pointer_type: "git_worktree", seq: 1 }]);
      if (w.phase === "ended") return Response.json([{ id: "h2", shape: "hop", role: "walk", call_id: "c1", phase: "ended", seq: 2, output: made }]);
      return Response.json([]);
    }) as typeof fetch;
  };
  const verify = async (cwd: string) => {
    const { resolvers } = await import("./index");
    return (await resolvers.get("code_verify_typecheck")!({ body: { impulse: { pointer: { cwd } } } } as never)) as Record<string, unknown>;
  };

  it("[MUST-FAIL] its answer carries the base's error count and the edits' added count", async () => {
    const c = clone([E1]);
    try {
      c.edit([E1, E2, E3]);
      records(c.made, c.work);
      forShell(c);
      expect(await verify(c.made.cwd)).toMatchObject({ ok: false, base_error_count: 1, added_error_count: 2, base: c.made.base });
    } finally { rmSync(c.work, { recursive: true, force: true }); }
  });

  it("[GUARD] on a directory no walk row made, the answer is as before, with why there is no base", async () => {
    const c = clone([]);
    try {
      c.edit([E1]);
      records(null, c.work);
      forShell(c);
      const r = await verify(c.made.cwd);
      expect(r).toMatchObject({ ok: false, error_count: 1 });
      expect([r.base_error_count, r.added_error_count]).toEqual([undefined, undefined]);
      expect(String(r.base_why)).toContain("no walk row records a clone made at");
    } finally { rmSync(c.work, { recursive: true, force: true }); }
  });
});
