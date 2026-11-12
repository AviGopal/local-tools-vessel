// git_land pushes a clone's change only when a verdict row approves its exact tree, the secrets scan is clean and it
// fast-forwards origin; every check runs in a repository of its own. Throwaway repositories; records is an in-memory
// table; origin is a local bare repository, so the file transport is allowed for these tests only.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitInClone } from "./git-commit";
import { diffClone, landClone } from "./git-land";
import { makeWorktree } from "./git-worktree";
import type { Made, Query, Row } from "./walk-rows";

// Run as root, git in the code under test drops to the shell user (shell-privilege.ts), which must read these
// fixtures: the test root is opened up, and what hooks write goes to a directory anyone may write.
const T = mkdtempSync(join(tmpdir(), "git-land-test-"));
chmodSync(T, 0o755);
const OUT = join(T, "out");
mkdirSync(OUT);
chmodSync(OUT, 0o777);
const ENV_KEYS = ["SUPER_REPO_DIR", "MITOSIS_PUSH_CLONE_DIR", "MITOSIS_RUNTIME_DIR", "WALK_TREES_DIR", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "PATH"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const gitEnv = { PATH: process.env.PATH ?? "", HOME: T, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...gitEnv, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" }, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
// A node gives commits their author from its system git config; a test clone gets one of its own. And what this test
// writes into a clone as itself is handed back to the clone's owner, the shell user when the test runs as root.
const asOwner = (cwd: string) => {
  g(cwd, "config", "user.name", "t"); g(cwd, "config", "user.email", "t@t");
  if (process.getuid?.() === 0) Bun.spawnSync(["chown", "-R", "65534:65534", cwd]);
};
const commitAll = (cwd: string, m: string) => { g(cwd, "add", "-A"); g(cwd, "commit", "-q", "-m", m); };
const SUPER = join(T, "super");
const ORIGIN = join(T, "demo.git");
const COPY = join(T, "clones", "demo");
const CONFIG = 'title = "t"\n\n[extend]\nuseDefault = true\n\n[[rules]]\nid = "substrate-api-key"\nregex = \'\'\'\\bmb[-_][A-Za-z0-9_-]{32,}\'\'\'\n';

const made = new Map<string, Made>();
const find = async (cwd: string) => made.get(cwd) ?? { error: "0 walk rows" };
let table: Row[] = [];
const rows = async (q: Query): Promise<Row[]> => table.filter((r) =>
  (q.shape === undefined || r.shape === q.shape) && (q.ids === undefined || q.ids.includes(r.id)) &&
  Object.entries(q.where ?? {}).every(([k, v]) => String(r[k]) === String(v)));
const deps = { find, rows, transports: ["file"] };

/** A clone with one committed change; its tree. */
const change = async (file: string, text: string): Promise<{ cwd: string; tree: string }> => {
  g(COPY, "pull", "-q", "origin", "dev");
  const w = await makeWorktree("demo");
  if ("error" in w) throw new Error(w.error);
  made.set(w.cwd, w);
  asOwner(w.cwd);
  mkdirSync(join(w.cwd, file, ".."), { recursive: true });
  writeFileSync(join(w.cwd, file), text);
  const c = await commitInClone(w.cwd, `change ${file}`, undefined, find);
  if (!("tree" in c)) throw new Error(JSON.stringify(c));
  return { cwd: w.cwd, tree: c.tree };
};
const originHead = () => g(ORIGIN, "rev-parse", "dev");
const ask = { id: "ask1", shape: "world_changed", role: "person" } as Row;
// What git_diff says of a tree that typechecks: a grader's verdict counts only from a diff that says so.
const TC_OK = { ran: true, passed: true, exit_code: 0, out: "", truncated: false };

beforeAll(() => {
  Object.assign(process.env, { SUPER_REPO_DIR: SUPER, MITOSIS_PUSH_CLONE_DIR: join(T, "clones"), MITOSIS_RUNTIME_DIR: join(T, "runtime"), WALK_TREES_DIR: join(T, "trees") });
  // demo's install on this node: this vessel's own, which carries the TypeScript compiler
  mkdirSync(join(T, "runtime", "demo"), { recursive: true });
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(T, "runtime", "demo", "node_modules"));
  for (const [k, v] of Object.entries(gitEnv)) if (k.startsWith("GIT_")) process.env[k] = v;
  mkdirSync(join(SUPER, "scripts", "git-hooks"), { recursive: true });
  g(SUPER, "init", "-q", "-b", "dev");
  for (const h of ["pre-commit", "vessel-pre-commit"]) writeFileSync(join(SUPER, "scripts", "git-hooks", h), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(SUPER, "scripts", "git-hooks", ".gitleaks.toml"), CONFIG);
  g(SUPER, "remote", "add", "origin", "https://example.invalid/super.git");
  commitAll(SUPER, "super base");
  g(T, "init", "-q", "--bare", "-b", "dev", ORIGIN);
  const seed = join(T, "seed");
  g(T, "clone", "-q", ORIGIN, seed);
  writeFileSync(join(seed, "a.txt"), "one\n");
  commitAll(seed, "base"); g(seed, "push", "-q", "origin", "HEAD:dev");
  mkdirSync(join(T, "clones"));
  g(T, "clone", "-q", "-b", "dev", ORIGIN, COPY);
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(T, { recursive: true, force: true });
});

// Every check below runs after the secrets scan, which needs gitleaks. On a node without it, git_land refuses before any
// of them: there, each case asserts that refusal (the node's real behaviour, itself a property that must hold) instead of
// a check it never reaches. Where gitleaks is present, the cases are exactly as written.
const SCANNER = Bun.which("gitleaks", { PATH: process.env.PATH ?? "" });
const scanned = (name: string, fn: () => Promise<void>) => it(SCANNER ? name : `${name} (no secrets scanner here: refused)`, SCANNER ? fn : async () => {
  const { cwd, tree } = await change(`noscan-${Math.random().toString(36).slice(2)}.txt`, "x\n");
  table = [{ id: "vp", shape: "land_verdict", repo: "demo", tree, role: "person", r: 1 }];
  const before = originHead();
  expect(String((await landClone(cwd, deps) as { error: string }).error)).toContain("no secrets scanner");
  expect(originHead()).toBe(before);
});

describe("git_land", () => {
  scanned("[MUST-FAIL] lands nothing without a verdict on its tree, nor with a verdict on another tree", async () => {
    const before = originHead();
    const { cwd, tree } = await change("a.txt", "two\n");
    table = [];
    expect(String((await landClone(cwd, deps) as { error: string }).error)).toContain("no verdict approves this tree");
    table = [{ id: "v1", shape: "land_verdict", repo: "demo", tree: "0".repeat(40), role: "person", r: 1 }];
    expect("error" in (await landClone(cwd, deps))).toBe(true);
    expect(originHead()).toBe(before);
    table = [{ id: "v2", shape: "land_verdict", repo: "demo", tree, role: "person", r: 1 }];
    const r = await landClone(cwd, deps);
    if (!("pushed" in r)) throw new Error(JSON.stringify(r));
    expect(originHead()).toBe(r.head);
    expect(r.verdict_ref).toBe("v2");
  });

  scanned("[MUST-FAIL] a grader's r 1 lands only from exactly the request and the walk's gitDiff of this tree", async () => {
    const { cwd, tree } = await change("b.txt", "b\n");
    const diff = { id: "d1", shape: "gitDiff", role: "walk", repo: "demo", tree, input_refs: ["ask1"], typecheck: TC_OK } as Row;
    const other = { id: "x1", shape: "fileContent", role: "described" } as Row;
    table = [ask, diff, other, { id: "v3", shape: "land_verdict", repo: "demo", tree, role: "described", r: 1, input_refs: ["ask1", "d1", "x1"] }];
    expect("error" in (await landClone(cwd, deps))).toBe(true);
    table = [ask, diff, { id: "v4", shape: "land_verdict", repo: "demo", tree, role: "described", r: 1, input_refs: ["x1", "d1"] }, other];
    expect("error" in (await landClone(cwd, deps))).toBe(true);
    // an owner's configuration row is not the request
    const channel = { id: "ch1", shape: "channel", role: "owner" } as Row;
    table = [ask, channel, { ...diff, input_refs: ["ch1"] }, { id: "v15", shape: "land_verdict", repo: "demo", tree, role: "described", r: 1, input_refs: ["ch1", "d1"] }];
    expect("error" in (await landClone(cwd, deps))).toBe(true);
    // a diff made for another request is not this request's change
    const ask2 = { id: "ask2", shape: "world_changed", role: "person" } as Row;
    table = [ask, ask2, { ...diff, input_refs: ["ask2"] }, { id: "v16", shape: "land_verdict", repo: "demo", tree, role: "described", r: 1, input_refs: ["ask1", "d1"] }];
    expect("error" in (await landClone(cwd, deps))).toBe(true)
    // the diff the grader saw must say the tree typechecks: one saying it does not, or saying nothing, lands nothing
    for (const typecheck of [{ ...TC_OK, passed: false, exit_code: 2 }, undefined]) {
      table = [ask, { ...diff, typecheck }, { id: "v17", shape: "land_verdict", repo: "demo", tree, role: "described", r: 1, input_refs: ["ask1", "d1"] }];
      expect(String((await landClone(cwd, deps) as { error: string }).error)).toContain("which says the tree typechecks");
    }
    table = [ask, diff, { id: "v5", shape: "land_verdict", repo: "demo", tree, role: "described", r: 1, writer: "described-x", input_refs: ["ask1", "d1"] }];
    const r = await landClone(cwd, deps);
    expect("pushed" in r && r.verdict_ref).toBe("v5");
    expect("pushed" in r && r.verdict_by).toBe("described-x");
  });

  scanned("[MUST-FAIL] any grader's r 0 on the tree blocks it until a person approves; no latest-wins", async () => {
    const { cwd, tree } = await change("c.txt", "c\n");
    const diff = { id: "d2", shape: "gitDiff", role: "walk", repo: "demo", tree, input_refs: ["ask1"], typecheck: TC_OK } as Row;
    const no = { id: "v6", shape: "land_verdict", repo: "demo", tree, role: "described", r: 0, input_refs: ["ask1", "d2"] } as Row;
    const yes = { id: "v7", shape: "land_verdict", repo: "demo", tree, role: "described", r: 1, input_refs: ["ask1", "d2"] } as Row;
    table = [ask, diff, no, yes];
    expect(String((await landClone(cwd, deps) as { error: string }).error)).toContain("r 0");
    table = [ask, diff, no, yes, { id: "v8", shape: "land_verdict", repo: "demo", tree, role: "person", r: 1, writer: "kid-person" }];
    const r = await landClone(cwd, deps);
    expect("pushed" in r && r.verdict_by).toBe("kid-person");
  });

  scanned("[MUST-FAIL] a change to what judges changes lands only on a person's verdict", async () => {
    const { cwd, tree } = await change("scripts/substrate/gate/x.sh", "x\n");
    const diff = { id: "d3", shape: "gitDiff", role: "walk", repo: "demo", tree, input_refs: ["ask1"], typecheck: TC_OK } as Row;
    table = [ask, diff, { id: "v9", shape: "land_verdict", repo: "demo", tree, role: "described", r: 1, input_refs: ["ask1", "d3"] }];
    const r = await landClone(cwd, deps);
    expect(String((r as { error: string }).error)).toContain("only a person's verdict");
    expect((r as unknown as { needs_person: string[] }).needs_person).toEqual(["scripts/substrate/gate/x.sh"]);
  });

  scanned("[MUST-FAIL] a planted secret is refused by its rule, and the answer never carries its text", async () => {
    const secret = ["mb", "_", "Q".repeat(20), "z".repeat(20)].join("");
    const { cwd, tree } = await change("d.txt", `key = ${secret}\n`);
    table = [{ id: "v10", shape: "land_verdict", repo: "demo", tree, role: "person", r: 1 }];
    const r = await landClone(cwd, deps);
    expect(String((r as { error: string }).error)).toContain("secrets scan found");
    expect((r as unknown as { rules: string[] }).rules).toContain("substrate-api-key");
    expect(JSON.stringify(r)).not.toContain(secret);
  });

  scanned("[MUST-FAIL] a change that no longer fast-forwards origin, or holds a merge, is refused", async () => {
    const { cwd, tree } = await change("e.txt", "e\n");
    const elsewhere = join(T, "elsewhere");
    g(T, "clone", "-q", "-b", "dev", ORIGIN, elsewhere);
    writeFileSync(join(elsewhere, "z.txt"), "z\n"); commitAll(elsewhere, "moved on"); g(elsewhere, "push", "-q", "origin", "HEAD:dev");
    table = [{ id: "v11", shape: "land_verdict", repo: "demo", tree, role: "person", r: 1 }];
    expect(String((await landClone(cwd, deps) as { error: string }).error)).toContain("fast-forward");

    const m = await change("f.txt", "f\n");
    g(m.cwd, "checkout", "-q", "-b", "side", "HEAD~1");
    writeFileSync(join(m.cwd, "g.txt"), "g\n"); commitAll(m.cwd, "side");
    g(m.cwd, "checkout", "-q", "-");
    g(m.cwd, "merge", "-q", "--no-edit", "side");
    asOwner(m.cwd);
    table = [{ id: "v12", shape: "land_verdict", repo: "demo", tree: g(m.cwd, "rev-parse", "HEAD^{tree}"), role: "person", r: 1 }];
    expect(String((await landClone(m.cwd, deps) as { error: string }).error)).toContain("merge");
  });

  it("[MUST-FAIL] with no secrets scanner on the node, nothing lands", async () => {
    const { cwd, tree } = await change("h.txt", "h\n");
    table = [{ id: "v13", shape: "land_verdict", repo: "demo", tree, role: "person", r: 1 }];
    const before = originHead();
    process.env.PATH = "/usr/bin:/bin";
    try {
      expect(String((await landClone(cwd, deps) as { error: string }).error)).toContain("no secrets scanner");
    } finally { process.env.PATH = saved.PATH; }
    expect(originHead()).toBe(before);
  });

  scanned("[MUST-FAIL] a pre-push hook the clone sets up never runs: no hooks run beside the credential", async () => {
    const { cwd, tree } = await change("i.txt", "i\n");
    mkdirSync(join(cwd, "evil"));
    writeFileSync(join(cwd, "evil", "pre-push"), `#!/bin/sh\ntouch "${T}/PRE_PUSH_RAN"\n`, { mode: 0o755 });
    g(cwd, "config", "core.hooksPath", join(cwd, "evil"));
    asOwner(cwd);
    // and the node's own system hooks path (where the attempt ledger's hooks live) is not used beside the credential
    const sys = join(T, "gitconfig-system");
    writeFileSync(sys, `[core]\n\thooksPath = ${join(cwd, "evil")}\n`);
    const keep = process.env.GIT_CONFIG_SYSTEM;
    process.env.GIT_CONFIG_SYSTEM = sys;
    table = [{ id: "v14", shape: "land_verdict", repo: "demo", tree, role: "person", r: 1 }];
    try {
      expect("pushed" in (await landClone(cwd, deps))).toBe(true);
    } finally { if (keep === undefined) delete process.env.GIT_CONFIG_SYSTEM; else process.env.GIT_CONFIG_SYSTEM = keep; }
    expect(await Bun.file(join(T, "PRE_PUSH_RAN")).exists()).toBe(false);
  });

  it("[MUST-FAIL] git_diff of a made clone answers the committed change with the tree it would land as", async () => {
    const { cwd, tree } = await change("j.txt", "j\n");
    g(cwd, "config", "diff.external", "/bin/false"); // the clone's config is never read
    const r = await diffClone(cwd, made.get(cwd)!, ["file"]);
    if (!("tree" in r)) throw new Error(JSON.stringify(r));
    expect(r.tree).toBe(tree);
    expect(r.base).toBe(originHead());
    expect(r.diff).toContain("+j");
    expect(r.truncated).toBe(false);
    expect(r.repo).toBe("demo");
    expect(r.typecheck).toEqual({ ran: false, passed: true, why: "the base has no tsconfig.json: nothing to typecheck" });
  });

  /** A clone with these files committed as one change (null deletes one); its cwd and tree. */
  const changeOf = async (files: Record<string, string | null>): Promise<{ cwd: string; tree: string }> => {
    g(COPY, "pull", "-q", "origin", "dev");
    const w = await makeWorktree("demo");
    if ("error" in w) throw new Error(w.error);
    made.set(w.cwd, w);
    for (const [f, text] of Object.entries(files)) {
      if (text === null) { rmSync(join(w.cwd, f)); continue; }
      mkdirSync(join(w.cwd, f, ".."), { recursive: true });
      writeFileSync(join(w.cwd, f), text);
    }
    asOwner(w.cwd);
    const c = await commitInClone(w.cwd, "change", undefined, find);
    if (!("tree" in c)) throw new Error(JSON.stringify(c));
    return { cwd: w.cwd, tree: c.tree };
  };
  const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [], lib: ["es2022"] }, include: ["*.ts"] });
  // From here on the base has a TypeScript config, as a vessel's does: a change is checked under it.
  const baseConfig = () => {
    const seed = join(T, "seed");
    g(seed, "pull", "-q", "origin", "dev");
    writeFileSync(join(seed, "tsconfig.json"), TSCONFIG);
    commitAll(seed, "base config"); g(seed, "push", "-q", "origin", "HEAD:dev");
  };

  it("[MUST-FAIL] git_diff says whether the exact tree it names typechecks", async () => {
    baseConfig();
    const bad = await changeOf({ "m.ts": 'export const n: number = "not a number";\n' });
    const r = await diffClone(bad.cwd, made.get(bad.cwd)!, ["file"]);
    if (!("tree" in r)) throw new Error(JSON.stringify(r));
    expect(r.tree).toBe(bad.tree);
    expect(r.typecheck).toMatchObject({ ran: true, passed: false });
    expect((r.typecheck as { out: string }).out).toContain("m.ts");
    expect((r.typecheck as { out: string }).out).not.toContain(T); // paths are the tree's own
    const good = await changeOf({ "m.ts": "export const n: number = 1;\n" });
    const ok = await diffClone(good.cwd, made.get(good.cwd)!, ["file"]);
    expect("tree" in ok && ok.typecheck).toMatchObject({ ran: true, passed: true, exit_code: 0 });
  });

  it("[MUST-FAIL] a fix the clone has not committed does not make its tree pass", async () => {
    const { cwd } = await changeOf({ "m.ts": 'export const n: number = "x";\n' });
    writeFileSync(join(cwd, "m.ts"), "export const n: number = 1;\n"); // fixed in the clone, not in the tree that lands
    const r = await diffClone(cwd, made.get(cwd)!, ["file"]);
    expect("tree" in r && r.typecheck).toMatchObject({ ran: true, passed: false });
  });

  it("[MUST-FAIL] the typecheck runs nothing of the clone's: not a compiler it carries, committed or not", async () => {
    const marker = join(OUT, "CLONE_TSC_RAN");
    const evil = `require("fs").writeFileSync(${JSON.stringify(marker)}, "x");\n`;
    const { cwd } = await changeOf({
      "m.ts": "export const n: number = 1;\n", "node_modules/typescript/bin/tsc": evil,
    });
    mkdirSync(join(cwd, "node_modules", "typescript", "bin"), { recursive: true });
    writeFileSync(join(cwd, "node_modules", "typescript", "bin", "tsc"), evil, { mode: 0o755 });
    const r = await diffClone(cwd, made.get(cwd)!, ["file"]);
    expect("tree" in r && r.typecheck).toMatchObject({ ran: true, passed: true });
    expect(existsSync(marker)).toBe(false);
  });

  it("[MUST-FAIL] a change cannot pass by deleting, loosening or silencing its own check: the base's config decides", async () => {
    const red = 'export const n: number = "x";\n';
    const cases: Array<Record<string, string | null>> = [
      { "m.ts": red, "tsconfig.json": null },
      { "m.ts": red, "tsconfig.json": JSON.stringify({ compilerOptions: { noEmit: true, types: [] }, include: [], files: [] }) },
      { "m.ts": "export const n: number = 1;\n", "package.json": "{}" },
      // or by silencing it in the source: a directive on a line it adds, or a declaration file it adds
      { "m.ts": `// @ts-nocheck\n${red}` },
      { "m.ts": `// @ts-ignore\n${red}` },
      { "m.ts": `// @ts-expect-error\n${red}` },
      { "m.ts": "import { q } from \"anything\";\nexport const n: number = q;\n", "anything.d.ts": "declare module \"anything\";\n" },
    ];
    for (const files of cases) {
      const { cwd } = await changeOf(files);
      const r = await diffClone(cwd, made.get(cwd)!, ["file"]);
      expect("tree" in r && r.typecheck).toMatchObject({ passed: false });
    }
  });

  it("[MUST-FAIL] a change to any file on the landing path needs a person", async () => {
    const { judgesOf } = await import("./git-commit");
    const judges = await judgesOf(async () => null, { repo: "local-tools-vessel" });
    for (const p of ["src/git-land.ts", "src/git-commit.ts", "src/git-worktree.ts", "src/walk-rows.ts"]) {
      expect(judges.some((g) => new Bun.Glob(g).match(p))).toBe(true);
    }
    expect(judges.some((g) => new Bun.Glob(g).match("src/fs-read.ts"))).toBe(false);
  });
});
