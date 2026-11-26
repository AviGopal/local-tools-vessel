// gap_check runs a gap's test file at one commit of origin's branch by git_diff's own runner, and says each named test's
// state from the runner's report. Throwaway repositories; origin is a local bare repository, so the file transport is
// allowed for these tests only.
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failMessageOf, gapCheckAt } from "./git-land";
import { gapCheckVia, resolvers } from "./index";
import { SHAPE_ANSWERS, SHAPE_INPUTS, wrapsClone } from "./shape-inputs";

setDefaultTimeout(120_000);
const T = mkdtempSync(join(tmpdir(), "gap-check-test-"));
chmodSync(T, 0o755);
const ORIGIN = join(T, "demo.git");
const SEED = join(T, "seed");
const saved = { clones: process.env.MITOSIS_PUSH_CLONE_DIR, runtime: process.env.MITOSIS_RUNTIME_DIR };
const gitEnv = { PATH: process.env.PATH ?? "", HOME: T, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...gitEnv, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" }, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
const commit = (files: Record<string, string>, m: string, push = true): string => {
  for (const [p, text] of Object.entries(files)) writeFileSync(join(SEED, p), text);
  g(SEED, "add", "-A"); g(SEED, "commit", "-q", "-m", m);
  if (push) g(SEED, "push", "-q", "origin", "HEAD:dev");
  return g(SEED, "rev-parse", "HEAD");
};
const TEST = 'import { expect, test, describe } from "bun:test";\nimport { add } from "./calc";\n' +
  'describe("add", () => { test("adds", () => { expect(add(1, 2)).toBe(3); }); test("zero", () => { expect(add(0, 0)).toBe(0); }); });\n';
const red = "export const add = (a: number, b: number): number => a - b;\n";
const fixed = "export const add = (a: number, b: number): number => a + b;\n";
const ask = (ref: string, more: Record<string, unknown> = {}) =>
  ({ repo: "demo", ref, branch: "dev", test_file: "calc.test.ts", only_tests: ["add > adds"], ...more }) as never;
const opts = { transports: ["file"] };
let base = "";
let green = "";

beforeAll(() => {
  Object.assign(process.env, { MITOSIS_PUSH_CLONE_DIR: join(T, "clones"), MITOSIS_RUNTIME_DIR: join(T, "runtime") });
  // demo's install on this node: this vessel's own
  mkdirSync(join(T, "runtime", "demo"), { recursive: true });
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(T, "runtime", "demo", "node_modules"));
  g(T, "init", "-q", "--bare", "-b", "dev", ORIGIN);
  g(T, "clone", "-q", ORIGIN, SEED);
  base = commit({ "calc.ts": red, "calc.test.ts": TEST }, "a failing check");
  green = commit({ "calc.ts": fixed }, "the fix");
  // the node's copy of demo, which says where its origin is
  mkdirSync(join(T, "clones"));
  g(T, "clone", "-q", "-b", "dev", ORIGIN, join(T, "clones", "demo"));
});
afterAll(() => {
  for (const [k, v] of [["MITOSIS_PUSH_CLONE_DIR", saved.clones], ["MITOSIS_RUNTIME_DIR", saved.runtime]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(T, { recursive: true, force: true });
});

describe("a failure's message from the runner's output", () => {
  const out = ["bun test v1", "", "a.test.ts:", "1 | src", "    ^", "error: expect(received).toBe(expected)", "", "Expected: 3", "Received: -1", "",
    "      at <anonymous> (a.test.ts:2:60)", "(fail) add > adds [0.18ms]", "1 | src", "error: boom here", "      at <anonymous> (a.test.ts:2:167)",
    "(fail) add > throws [0.06ms]", "(pass) add > zero [0.01ms]", "", " 1 pass", " 2 fail"].join("\n");
  it("[MUST-FAIL] each name's own block, from its error line, and none of the one before", () => {
    expect(failMessageOf(out, "add > adds")).toBe("error: expect(received).toBe(expected)\n\nExpected: 3\nReceived: -1\n\n      at <anonymous> (a.test.ts:2:60)");
    expect(failMessageOf(out, "add > throws")).toBe("error: boom here\n      at <anonymous> (a.test.ts:2:167)");
  });
  it("[MUST-FAIL] a name the output does not fail is no message, and a long one is bounded", () => {
    expect(failMessageOf(out, "add > zero")).toBe("");
    expect(failMessageOf(out, "add > add")).toBe("");
    expect(failMessageOf(`a.test.ts:\nerror: ${"y".repeat(5000)}\n(fail) add > big [1ms]`, "add > big").length).toBe(2000);
  });
});

describe("gap_check", () => {
  it("[MUST-FAIL] runs the test file at the commit asked: red where the source is broken, green where it is fixed, each name by the report", async () => {
    const r = await gapCheckAt(ask(base, { only_tests: ["add > adds", "add > zero"] }), opts);
    expect(r).toMatchObject({ shape: "gapCheck", ran: true, passed: false, repo: "demo", head: base, test_file: "calc.test.ts", exit_code: 1, signalled: false });
    if (!r.ran) throw new Error(r.why);
    expect(r.names["add > adds"]).toMatchObject({ result: "fail", error: expect.any(String) });
    expect(r.names["add > zero"]).toEqual({ result: "pass" });
    expect(r.out).toContain("add > adds");
    expect(await gapCheckAt(ask(green), opts)).toMatchObject({ ran: true, passed: true, head: green, names: { "add > adds": { result: "pass" } }, exit_code: 0 });
  });

  it("[MUST-FAIL] a name the report does not hold is absent, and does not pass", async () => {
    expect(await gapCheckAt(ask(green, { only_tests: ["add > adds", "add > gone"] }), opts))
      .toMatchObject({ ran: true, passed: false, names: { "add > adds": { result: "pass" }, "add > gone": { result: "absent" } } });
  });

  it("[GUARD] served by its shape, the handler runs the names, file and commit the pointer asks, and gives each name back", async () => {
    const serve = gapCheckVia(opts);
    const at = (ref: string, more: Record<string, unknown> = {}) => serve({ body: { impulse: { pointer: { type: "gap_check", ...(ask(ref, more) as object) } } } } as never);
    expect(await at(base, { only_tests: ["add > adds", "add > zero", "add > gone"] })).toMatchObject({ ran: true, passed: false, repo: "demo", head: base,
      test_file: "calc.test.ts", names: { "add > adds": { result: "fail" }, "add > zero": { result: "pass" }, "add > gone": { result: "absent" } } });
    expect(await at(green)).toMatchObject({ ran: true, passed: true, head: green, names: { "add > adds": { result: "pass" } } });
    // a branch origin does not have is fetched as asked, and refused
    expect(await at(green, { branch: "main" })).toMatchObject({ ran: false, passed: false });
  });

  it("[MUST-FAIL] a failing name carries the runner's own message for it, which is what a closer reads", async () => {
    const r = await gapCheckAt(ask(base), opts);
    if (!r.ran) throw new Error(r.why);
    // the report names the failure's type only; the message is the runner's own block for that name
    const error = (r.names["add > adds"] as { error?: string }).error ?? "";
    expect(error.startsWith("error: expect(received).toBe(expected)")).toBe(true);
    expect(error).toContain("Expected: 3");
    expect(error).toContain("Received: -1");
    expect(error).not.toContain("(fail)");
  });

  it("[GUARD] a run's out past the bound is kept from its end, where the runner prints its failures and counts", async () => {
    const long = `HEAD-OF-RUN\n${"x".repeat(300 * 1024)}\nEND-OF-RUN 1 pass`;
    const run = async () => ({ passed: new Set(["add > adds"]), failed: new Map<string, string>(), exit_code: 0, signalled: false, killed: false, out: long });
    const r = await gapCheckAt(ask(green), { ...opts, run });
    expect(r).toMatchObject({ ran: true, passed: true, truncated: true });
    if (!r.ran) throw new Error(r.why);
    expect(r.out.endsWith("END-OF-RUN 1 pass")).toBe(true);
    expect(r.out.includes("HEAD-OF-RUN")).toBe(false);
    expect(r.out.length).toBe(256 * 1024);
  });

  it("[MUST-FAIL] a run a signal ended does not pass, even where its report says every named test passed", async () => {
    // bun writes no report when a test file kills it, so the runner is stood in for: the report as a clean run's, the end
    // a signal's
    const run = async () => ({ passed: new Set(["add > adds"]), failed: new Map<string, string>(), exit_code: 0, signalled: true, killed: false, out: "1 pass" });
    expect(await gapCheckAt(ask(green), { ...opts, run })).toMatchObject({ ran: true, passed: false, signalled: true, names: { "add > adds": { result: "pass" } } });
    expect(await gapCheckAt(ask(green, { only_tests: [] }), { ...opts, run })).toMatchObject({ ran: true, passed: false, signalled: true, exit_code: 0 });
  });

  it("[MUST-FAIL] with no names, the file's own exit decides", async () => {
    expect(await gapCheckAt(ask(base, { only_tests: [] }), opts)).toMatchObject({ ran: true, passed: false, names: {}, exit_code: 1 });
    expect(await gapCheckAt(ask(green, { only_tests: [] }), opts)).toMatchObject({ ran: true, passed: true, names: {}, exit_code: 0 });
  });

  it("[MUST-FAIL] runs nothing it cannot place: a commit not on origin's branch, a test file not in its tree, a repository with no copy, a malformed ask", async () => {
    const off = commit({ "calc.ts": fixed + "// not pushed\n" }, "never pushed", false);
    g(SEED, "push", "-q", "origin", `${off}:refs/heads/other`);
    expect(await gapCheckAt(ask(off), opts)).toMatchObject({ ran: false, passed: false, why: `${off} is not on origin's dev` });
    expect(await gapCheckAt(ask(green, { test_file: "nope.test.ts" }), opts)).toMatchObject({ ran: false, passed: false, why: expect.stringContaining("is not in the tree") });
    expect(await gapCheckAt(ask(green, { repo: "elsewhere" }), opts)).toMatchObject({ ran: false, passed: false, why: "elsewhere has no origin on this node" });
    for (const bad of [{ ref: "dev" }, { ref: green.slice(0, 12) }, { repo: "../demo" }, { branch: "../dev" }, { test_file: "../calc.test.ts" },
      { test_file: "/etc/passwd" }, { test_file: "-x" }, { test_file: "./calc.test.ts/" }, { only_tests: "add > adds" }, { only_tests: [1] }]) {
      expect(await gapCheckAt(ask(green, bad), opts)).toMatchObject({ ran: false, passed: false });
    }
    // a path that leaves the tree is refused by its form, even where it names a file that is there: the tree is written
    // out to a directory named gap, so ../gap/ comes back into it
    expect(await gapCheckAt(ask(green, { test_file: "../gap/calc.test.ts" }), opts)).toMatchObject({ ran: false, passed: false, why: "test_file must be a path inside the repository" });
    // a repository named by dots alone would be read from the clones zone itself or its parent: refused by its form
    for (const repo of [".", "..", "..."]) {
      expect(await gapCheckAt(ask(green, { repo }), opts)).toMatchObject({ ran: false, passed: false, why: "repo must be a repository's name" });
    }
  });

  it("[MUST-FAIL] is served to a caller by its shape, works in no clone, and is not offered to the walk", async () => {
    expect(resolvers.has("gap_check")).toBe(true);
    expect(wrapsClone("gap_check")).toBe(false);
    expect("gap_check" in SHAPE_INPUTS || "gap_check" in SHAPE_ANSWERS).toBe(false);
    // https only outside a test: the local origin is refused by its transport, and so runs nothing
    const r = await resolvers.get("gap_check")!({ body: { impulse: { pointer: { type: "gap_check", ...(ask(green) as object) } } } } as never);
    expect(r).toMatchObject({ ran: false, passed: false, why: "fetching dev from origin failed" });
  });
});
