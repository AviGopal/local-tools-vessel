// Pins write containment end to end: the REAL server (src/index.ts, spawned in a
// child with its own env) is asked to write, the way goal-host's walk asked on
// 10-01 when an injected fs_edit of "scripts/substrate/substrate-pull-sync.sh"
// landed in the live super-repo clone and pull-sync installed it.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { containWrite, readCommittedScope, signWriteGrant, WRITE_CONTAINMENT_ERROR } from "./write-containment";

const KEY = "test-fleet-key-0123456789";
const PULL_SYNC = "#!/usr/bin/env bash\necho committed pull-sync\n";
const SCOPE = { autonomyScope: { excluded_paths: ["scripts/substrate/", "repos/development-vessel/src/resolvers/gap-to-feature.ts", "repos/discovery-vessel/"] } };

let base: string, superRepo: string, vessels: string, clones: string, compose: string, data: string;
let env: Record<string, string>;
let child: ReturnType<typeof Bun.spawn> | undefined;
let url = "";

const put = (p: string, s: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "pipe" });

async function call(type: string, pointer: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ impulse: { pointer: { type, ...pointer } } }) });
  return (await r.json()) as Record<string, unknown>;
}

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "write-containment-")));
  superRepo = join(base, "git", "super-repo");
  vessels = join(base, "vessels");
  clones = join(base, "git", "vessels");
  compose = join(base, "git", "compose");
  data = join(base, "data");
  put(join(superRepo, "scripts", "substrate", "autonomy-scope.json"), JSON.stringify(SCOPE));
  put(join(superRepo, "scripts", "substrate", "substrate-pull-sync.sh"), PULL_SYNC);
  put(join(superRepo, "docs", "x.md"), "doc one\n");
  put(join(superRepo, ".gitmodules"), "");
  git(superRepo, "init", "-q");
  git(superRepo, "add", "-A");
  git(superRepo, "commit", "-qm", "base");
  put(join(vessels, "development-vessel", "src", "resolvers", "gap-to-feature.ts"), "export const g = 1;\n");
  put(join(vessels, "demo", "src", "a.ts"), "export const a = 1;\n");
  put(join(clones, "demo", "src", "a.ts"), "export const a = 1;\n");
  put(join(compose, "fc-1", "demo", "src", "a.ts"), "export const a = 1;\n");
  put(join(compose, "fc-1", "development-vessel", "src", "resolvers", "gap-to-feature.ts"), "export const g = 1;\n");
  put(join(data, "report.md"), "report one\n");
  symlinkSync(join(superRepo, "scripts", "substrate"), join(data, "sublink"));
  symlinkSync(join(superRepo, "scripts", "substrate", "substrate-pull-sync.sh"), join(data, "ps-link.sh"));

  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? base, PORT: String(port),
    WORKSPACE_ROOT: superRepo, MITOSIS_RUNTIME_DIR: vessels, MITOSIS_PUSH_CLONE_DIR: clones, COMPOSE_WS_DIR: compose,
    METABOB_API_KEY: KEY, DISCOVERY_ENDPOINT: "http://127.0.0.1:9", LOCAL_TOOLS_GC_INTERVAL_MS: "600000",
  };
  child = Bun.spawn(["bun", join(import.meta.dir, "index.ts")], { env, stdout: "ignore", stderr: "ignore" });
  url = `http://127.0.0.1:${port}/resolve`;
  for (let i = 0; i < 100; i++) {
    try { const h = await fetch(`http://127.0.0.1:${port}/health`); if (h.ok) break; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
});

afterAll(() => { child?.kill(); rmSync(base, { recursive: true, force: true }); });

describe("the 10-01 breach: a walk's fs_edit of an excluded path in the live clone", () => {
  it("refuses the relative incident form with a scope reason, and leaves the file untouched", async () => {
    const r = await call("fs_edit", { path: "scripts/substrate/substrate-pull-sync.sh", old_string: "committed", new_string: "UNCOMMITTED" });
    expect(String(r.error)).toContain(WRITE_CONTAINMENT_ERROR);
    expect(String(r.error)).toContain("autonomy-scope excluded path 'scripts/substrate/'");
    expect(readFileSync(join(superRepo, "scripts", "substrate", "substrate-pull-sync.sh"), "utf8")).toBe(PULL_SYNC);
  });

  it("refuses the absolute form, and through every other writer", async () => {
    const p = join(superRepo, "scripts", "substrate", "substrate-pull-sync.sh");
    const asks: Array<[string, Record<string, unknown>]> = [
      ["fs_edit", { path: p, old_string: "committed", new_string: "UNCOMMITTED" }],
      ["fs_write", { path: p, content: PULL_SYNC + "# x\n" }],
      ["fileEditResult", { path: p, old_string: "committed", new_string: "UNCOMMITTED" }],
      ["code_replace_lines", { path: p, start_line: 2, end_line: 2, text: "echo UNCOMMITTED" }],
      ["code_insert_after_line", { path: p, after_line: 1, text: "echo UNCOMMITTED" }],
      ["code_add_import", { path: p, module: "x", specifier: "{ y }" }],
      ["fs_write", { path: join(superRepo, "scripts", "substrate", "new-script.sh"), content: "x" }],
    ];
    for (const [type, ptr] of asks) {
      const r = await call(type, ptr);
      expect(`${type}: ${String(r.error)}`).toContain("autonomy-scope excluded path 'scripts/substrate/'");
    }
    expect(readFileSync(p, "utf8")).toBe(PULL_SYNC);
  });

  it("refuses a symlink into the clone (existing file, symlinked file, and a new file under a symlinked dir)", async () => {
    for (const [type, ptr] of [
      ["fs_edit", { path: join(data, "sublink", "substrate-pull-sync.sh"), old_string: "committed", new_string: "UNCOMMITTED" }],
      ["fs_edit", { path: join(data, "ps-link.sh"), old_string: "committed", new_string: "UNCOMMITTED" }],
      ["fs_write", { path: join(data, "sublink", "planted.sh"), content: "x" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = await call(type, ptr);
      expect(String(r.error)).toContain("autonomy-scope excluded path 'scripts/substrate/'");
    }
    expect(readFileSync(join(superRepo, "scripts", "substrate", "substrate-pull-sync.sh"), "utf8")).toBe(PULL_SYNC);
  });

  it("refuses a NON-excluded file in the live clone too (nothing lands there by a tool write)", async () => {
    const r = await call("fs_edit", { path: "docs/x.md", old_string: "one", new_string: "two" });
    expect(String(r.error)).toContain("the live super-repo clone");
    expect(readFileSync(join(superRepo, "docs", "x.md"), "utf8")).toBe("doc one\n");
  });

  it("refuses git_commit in the live clone (its default cwd)", async () => {
    // git_commit reads `message` from the top level only, so send the direct form.
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "git_commit", message: "planted" }) });
    const r = (await res.json()) as Record<string, unknown>;
    expect(String(r.error)).toContain(WRITE_CONTAINMENT_ERROR);
    expect(String(r.error)).toContain("git_commit is not grantable in a protected zone (super");
  });

  it("git_commit stays refused in a lane zone EVEN WITH a valid grant, and says it is not grantable (not 'no grant')", async () => {
    const cwd = join(clones, "demo");
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "git_commit", message: "planted", impulse: { pointer: { cwd, write_grant: signWriteGrant(KEY, cwd) } } }) });
    const r = (await res.json()) as Record<string, unknown>;
    expect(String(r.error)).toContain("git_commit is not grantable in a protected zone (clone");
    expect(String(r.error)).not.toContain("no lane write grant");
  });
});

describe("zone precedence and what counts as a super-repo clone", () => {
  it("a lane zone nested under a super-repo setting is classified as the lane zone, so a grant still works there", () => {
    // A deployment whose compose root lives inside the clone's tree: the compose zone must win.
    const nested = join(superRepo, "compose-ws");
    put(join(nested, "fc-9", "demo", "src", "a.ts"), "export const a = 1;\n");
    const e = { WORKSPACE_ROOT: superRepo, MITOSIS_RUNTIME_DIR: vessels, MITOSIS_PUSH_CLONE_DIR: clones, COMPOSE_WS_DIR: nested, METABOB_API_KEY: KEY };
    const p = join(nested, "fc-9", "demo", "src", "a.ts");
    const granted = containWrite(p, { env: e, grant: signWriteGrant(KEY, p) });
    expect(granted.ok && granted.zone).toBe("compose");
    const bare = containWrite(p, { env: e });
    expect(!bare.ok && bare.zone).toBe("compose");
    expect(!bare.ok && bare.reason).toContain("no lane write grant");
  });

  it("a super-repo setting that is not a git checkout (an ancestor such as the workspace) protects nothing by itself", () => {
    const e = { SUPER_REPO_DIR: base, MITOSIS_RUNTIME_DIR: vessels, MITOSIS_PUSH_CLONE_DIR: clones, COMPOSE_WS_DIR: compose, METABOB_API_KEY: KEY };
    // base has no .git: a data file under it is not "the live super-repo clone".
    const v = containWrite(join(data, "report.md"), { env: e });
    expect(v.ok).toBe(true);
    // ...while the real clone (it has .git) beneath the same ancestor is still refused when named.
    const real = containWrite(join(superRepo, "docs", "x.md"), { env: { ...e, SUPER_REPO_DIR: superRepo } });
    expect(!real.ok && real.zone).toBe("super");
  });
});

describe("what still writes", () => {
  it("an allowed data path succeeds", async () => {
    const r = await call("fs_edit", { path: join(data, "report.md"), old_string: "one", new_string: "two" });
    expect(r.ok).toBe(true);
    expect(readFileSync(join(data, "report.md"), "utf8")).toBe("report two\n");
  });

  it("the lane, with a grant, writes the runtime, a push clone and a compose worktree — excluded files included", async () => {
    for (const p of [
      join(vessels, "demo", "src", "a.ts"),
      join(clones, "demo", "src", "a.ts"),
      join(compose, "fc-1", "demo", "src", "a.ts"),
      join(compose, "fc-1", "development-vessel", "src", "resolvers", "gap-to-feature.ts"),
      join(vessels, "development-vessel", "src", "resolvers", "gap-to-feature.ts"),
    ]) {
      const old = readFileSync(p, "utf8").includes("= 1") ? "= 1" : "= 2";
      const r = await call("fs_edit", { path: p, old_string: old, new_string: "= 3", write_grant: signWriteGrant(KEY, p) });
      expect(`${p}: ${String(r.error ?? "ok")}`).toBe(`${p}: ok`);
    }
  });

  it("without a grant, the same vessel trees are refused (and an excluded one says so)", async () => {
    const a = await call("fs_edit", { path: join(vessels, "demo", "src", "a.ts"), old_string: "= 3", new_string: "= 4" });
    expect(String(a.error)).toContain("no lane write grant");
    const g = await call("fs_edit", { path: "repos/development-vessel/src/resolvers/gap-to-feature.ts", old_string: "= 3", new_string: "= 4" });
    expect(String(g.error)).toContain("autonomy-scope excluded path 'repos/development-vessel/src/resolvers/gap-to-feature.ts'");
    const c = await call("fs_write", { path: join(compose, "fc-1", "demo", "src", "b.ts"), content: "x" });
    expect(String(c.error)).toContain("no lane write grant");
  });

  it("a forged, misdirected or expired grant is no grant", async () => {
    const p = join(vessels, "demo", "src", "a.ts");
    for (const grant of [
      signWriteGrant("not-the-key", p),
      signWriteGrant(KEY, join(vessels, "demo", "src", "other.ts")),
      signWriteGrant(KEY, p, Date.now() - 10 * 60_000),
      { exp: Date.now() + 60_000, sig: "00".repeat(32) },
      { exp: Date.now() + 365 * 86_400_000, sig: signWriteGrant(KEY, p).sig },
    ]) {
      const r = await call("fs_edit", { path: p, old_string: "= 3", new_string: "= 4", write_grant: grant });
      expect(String(r.error)).toContain(WRITE_CONTAINMENT_ERROR);
    }
  });
});

describe("the scope is the COMMITTED one, read at use time, and fails closed", () => {
  it("a working-tree edit that drops the exclusions does not change the verdict", () => {
    const f = join(superRepo, "scripts", "substrate", "autonomy-scope.json");
    const before = readFileSync(f, "utf8");
    writeFileSync(f, JSON.stringify({ autonomyScope: { unrestricted: true } }));
    try {
      const s = readCommittedScope([superRepo], join(base, "no-image-copy.json"));
      expect(s.readable && s.excluded).toContain("scripts/substrate/");
    } finally { writeFileSync(f, before); }
  });

  it("no readable scope: protected roots refuse as unreadable, the lane and data dirs still write", () => {
    const bare = join(base, "bare-super");
    put(join(bare, "scripts", "substrate", "README"), "x");
    git(bare, "init", "-q"); git(bare, "add", "-A"); git(bare, "commit", "-qm", "no scope");
    const e = { WORKSPACE_ROOT: bare, MITOSIS_RUNTIME_DIR: vessels, MITOSIS_PUSH_CLONE_DIR: clones, COMPOSE_WS_DIR: compose, METABOB_API_KEY: KEY };
    const img = join(base, "no-image-copy.json");
    const rt = join(vessels, "demo", "src", "a.ts");
    const v = containWrite(rt, { env: e, imageScopeFile: img });
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reason).toContain("autonomy scope unreadable");
    expect(containWrite(rt, { env: e, imageScopeFile: img, grant: signWriteGrant(KEY, rt) }).ok).toBe(true);
    expect(containWrite(join(data, "report.md"), { env: e, imageScopeFile: img }).ok).toBe(true);
    const sv = containWrite(join(bare, "scripts", "substrate", "README"), { env: e, imageScopeFile: img, grant: signWriteGrant(KEY, join(bare, "scripts", "substrate", "README")) });
    expect(sv.ok).toBe(false);
  });

  it("never a secret location, grant or not", () => {
    for (const p of ["/etc/substrate/env", "/proc/self/environ", "/workspace/.substrate-secrets"]) {
      expect(containWrite(p, { env: { METABOB_API_KEY: KEY }, grant: signWriteGrant(KEY, p) }).ok).toBe(false);
    }
  });
});

describe("every writer in index.ts is wired", () => {
  it("each ResolverHandler that calls Bun.write resolves its target through writePath", () => {
    const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    const blocks = src.split(/\nconst (\w+): ResolverHandler = /).slice(1);
    const writers: string[] = [];
    for (let i = 0; i < blocks.length; i += 2) {
      const name = blocks[i]!, body = blocks[i + 1]!.split(/\n(?:const|function|export) /)[0]!;
      if (/Bun\.write\(/.test(body)) {
        writers.push(name);
        expect(`${name}: ${/writePath\(ctx, rawPath\)/.test(body)}`).toBe(`${name}: true`);
      }
    }
    expect(writers.sort()).toEqual(["codeAddImport", "codeInsertAfterLine", "codeReplaceLines", "fsEdit", "fsWrite"]);
  });
});
