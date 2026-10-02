// Pins shell containment: the general shell may READ the live super-repo clone but
// may not WRITE it. The incident: goal-host's floor offered shellResult as an
// "inspect" tool, and floor run 27c1c600 (09-30) created
// /workspace/git/super-repo/GPT-5.md through this vessel's shell handler, whose cwd
// defaults to WORKSPACE_ROOT = the live clone. The REAL server is spawned the way
// write-containment.test.ts does it, and the lane's own shell commands (enumerated
// from development-vessel) are replayed to prove they still pass.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { containShell, segments } from "./shell-containment";
import { signWriteGrant, WRITE_CONTAINMENT_ERROR } from "./write-containment";

const KEY = "test-fleet-key-0123456789";
let base: string, superRepo: string, vessels: string, scratch: string;
let env: Record<string, string>;
let child: ReturnType<typeof Bun.spawn> | undefined;
let url = "";

const put = (p: string, s: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "pipe" }).toString();

async function call(type: string, pointer: Record<string, unknown>): Promise<Record<string, any>> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ impulse: { pointer: { type, ...pointer } } }) });
  const j = (await r.json()) as Record<string, any>;
  return (j && typeof j === "object" && "content" in j ? j.content : j?.body ?? j) as Record<string, any>;
}
const refusedText = (r: Record<string, any>) => JSON.stringify(r);

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "shell-containment-")));
  superRepo = join(base, "git", "super-repo");
  vessels = join(base, "vessels");
  scratch = join(base, "scratch");
  put(join(superRepo, "scripts", "substrate", "autonomy-scope.json"), JSON.stringify({ autonomyScope: { excluded_paths: ["scripts/substrate/"] } }));
  put(join(superRepo, "docs", "x.md"), "one\ntwo\nthree\n");
  put(join(superRepo, ".gitmodules"), "");
  git(superRepo, "init", "-q");
  git(superRepo, "add", "-A");
  git(superRepo, "commit", "-qm", "base");
  put(join(vessels, "demo", "src", "a.ts"), "export const a = 1;\n");
  mkdirSync(scratch, { recursive: true });

  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? base, PORT: String(port),
    WORKSPACE_ROOT: superRepo, MITOSIS_RUNTIME_DIR: vessels, MITOSIS_PUSH_CLONE_DIR: join(base, "git", "vessels"), COMPOSE_WS_DIR: join(base, "git", "compose"),
    METABOB_API_KEY: KEY, DISCOVERY_ENDPOINT: "http://127.0.0.1:9", LOCAL_TOOLS_GC_INTERVAL_MS: "600000",
  };
  child = Bun.spawn(["bun", join(import.meta.dir, "index.ts")], { env, stdout: "ignore", stderr: "ignore" });
  url = `http://127.0.0.1:${port}/resolve`;
  let up = false;
  for (let i = 0; i < 250 && !up; i++) {
    try { const h = await fetch(`http://127.0.0.1:${port}/health`); up = h.ok; } catch { /* not up yet */ }
    if (!up) await Bun.sleep(100);
  }
  if (!up) throw new Error(`local-tools server (src/index.ts) never became healthy on port ${port}; exit code ${child.exitCode}`);
}, 30_000);

afterAll(() => { child?.kill(); rmSync(base, { recursive: true, force: true }); });

describe("the 27c1c600 incident: a floor shellResult writing the live super-repo clone", () => {
  it("refuses a redirect that creates a file in the clone (default cwd), and the file does not exist afterwards", async () => {
    const r = await call("shellResult", { command: "echo 'model output' > GPT-5.md" });
    expect(refusedText(r)).toContain(WRITE_CONTAINMENT_ERROR);
    expect(refusedText(r)).toContain("live super-repo clone");
    expect(existsSync(join(superRepo, "GPT-5.md"))).toBe(false);
  });

  it("refuses the absolute form from any cwd, and through the bash / bounded_shell aliases", async () => {
    const marker = join(superRepo, "docs", "MARKER.md");
    for (const [type, pointer] of [
      ["shell", { command: `printf hi | tee ${marker}`, cwd: scratch }],
      ["bash", { command: `touch ${marker}` }],
      ["bounded_shell", { command: `cat > ${JSON.stringify(marker)} <<'EOF'\nx\nEOF` }],
    ] as const) {
      const r = await call(type, pointer);
      expect(refusedText(r)).toContain(WRITE_CONTAINMENT_ERROR);
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses a git commit through the shell in the clone, and HEAD does not move", async () => {
    const head = git(superRepo, "rev-parse", "HEAD").trim();
    const r = await call("shellResult", { command: "git -c user.name=x -c user.email=x@x commit --allow-empty -m sneaked" });
    expect(refusedText(r)).toContain("'git commit'");
    const r2 = await call("shellResult", { command: `cd ${superRepo}/docs && git add -A`, cwd: scratch });
    expect(refusedText(r2)).toContain("'git add'");
    expect(git(superRepo, "rev-parse", "HEAD").trim()).toBe(head);
  });
});

describe("reads in the clone keep working, with the same cwd", () => {
  it("wc -l on a relative path answers the line count", async () => {
    const r = await call("shellResult", { command: "wc -l < docs/x.md" });
    expect(r.error).toBeUndefined();
    expect(String(r.stdout).trim()).toBe("3");
    expect(r.exit_code).toBe(0);
  });
  it("ls, git log, grep, and stderr/dev-null redirects are not writes", async () => {
    const r = await call("shellResult", { command: "ls docs 2>/dev/null; git log --oneline | wc -l; grep -c two docs/x.md 2>&1; git status --porcelain >/dev/null" });
    expect(r.error).toBeUndefined();
    expect(String(r.stdout)).toContain("x.md");
  });
  it("the floor's remaining read path counts lines: codeSearchResult carries line_count (= wc -l)", async () => {
    const r = await call("codeSearchResult", { path: "docs/x.md", pattern: "two" });
    expect(r.line_count).toBe(3);
    expect(r.match_count).toBe(1);
  });
  it("a write OUTSIDE the clone (scratch) still runs", async () => {
    const out = join(scratch, "ok.txt");
    const r = await call("shellResult", { command: `wc -l docs/x.md > ${out}` });
    expect(r.error).toBeUndefined();
    expect(existsSync(out)).toBe(true);
  });
  it("a lane write grant bound to the cwd lets the write through", async () => {
    const r = await call("shellResult", { command: "touch granted.txt", cwd: superRepo, write_grant: signWriteGrant(KEY, superRepo) });
    expect(r.error).toBeUndefined();
    expect(existsSync(join(superRepo, "granted.txt"))).toBe(true);
    rmSync(join(superRepo, "granted.txt"));
    const bad = await call("shellResult", { command: "touch forged.txt", cwd: superRepo, write_grant: signWriteGrant("wrong-key", superRepo) });
    expect(refusedText(bad)).toContain(WRITE_CONTAINMENT_ERROR);
    expect(existsSync(join(superRepo, "forged.txt"))).toBe(false);
  });
});

describe("the lane's own shell commands (development-vessel, enumerated) still pass the gate", () => {
  const ok = (command: string, cwd: string) => expect(containShell(command, cwd, { env }).ok).toBe(true);
  it("test_suite's base-ref worktree command, cwd = the super-repo clone", () => {
    const root = `${superRepo}/repos/demo`;
    ok(`ROOT=${JSON.stringify(join(base, "git", "vessels", "demo"))}; [ -d "$ROOT" ] || ROOT=${JSON.stringify(root)}; git -C "$ROOT" worktree prune >/dev/null 2>&1; BW="$(mktemp -d /tmp/test-suite-base-XXXXXX)"; if [ -d "$ROOT/node_modules" ] && git -C "$ROOT" worktree add -q --detach "$BW" origin/dev >/dev/null 2>&1; then ln -s "$ROOT/node_modules" "$BW/node_modules"; echo "VERIFIED_ROOT=$BW"; (cd "$BW" && env -i PATH="$PATH" HOME="$HOME" WORKSPACE_ROOT="$(mktemp -d)" timeout 60 bun test 2>&1 || true); fi; git -C "$ROOT" worktree remove --force "$BW" >/dev/null 2>&1; rm -rf "$BW"; git -C "$ROOT" worktree prune >/dev/null 2>&1; true`, superRepo);
    ok(`ROOT=${JSON.stringify(root)}; echo "VERIFIED_HEAD=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"; cd "$ROOT" && ([ -d node_modules ] || timeout 120 bun install >/dev/null 2>&1; bun test 2>&1 || true)`, superRepo);
  });
  it("feature_compose's runtime writes and super-repo reads", () => {
    ok(`git -C ${JSON.stringify(superRepo)} fetch origin dev 2>&1 >/dev/null; git -C ${JSON.stringify(superRepo)} status --porcelain -- "repos/demo"`, superRepo);
    ok(`ln -sfn ${JSON.stringify(`${superRepo}/repos/demo`)} ${JSON.stringify(`${vessels}/demo`)}`, superRepo);
    ok(`rm -rf ${JSON.stringify(`${vessels}/demo-mitosis-resume-1`)}`, vessels);
    ok(`mkdir -p ${JSON.stringify(`${vessels}/demo/src`)} && cp ${JSON.stringify(`${base}/git/vessels/demo/src/a.ts`)} ${JSON.stringify(`${vessels}/demo/src/a.ts`)}`, vessels);
    ok(`cd ${JSON.stringify(`${vessels}/demo`)} && timeout 300 bunx tsc --noEmit -p . 2>&1 | tail -20; echo TC_EXIT=\${PIPESTATUS[0]}`, vessels);
    ok(`grep -rEn "\\bfoo\\b" ${JSON.stringify(`${vessels}/demo`)} 2>/dev/null | head -8 || true`, vessels);
  });
  it("names the one lane call it refuses without a grant: in-tree materialization's checkout into the live clone", () => {
    const cmd = `git -C ${JSON.stringify(superRepo)} checkout origin/dev -- "repos/demo" 2>&1`;
    expect(containShell(cmd, superRepo, { env }).ok).toBe(false);
    expect(containShell(cmd, superRepo, { env, grant: signWriteGrant(KEY, superRepo) }).ok).toBe(true);
  });
});

describe("the parser", () => {
  it("splits segments and keeps redirections as words", () => {
    expect(segments(`a "b c" > 'd e'; f 2>&1 | g && h`)).toEqual([["a", "b c", ">", "d e"], ["f", "2>&", "1"], ["g"], ["h"]]);
  });
  it("sed -i, mv, and dd into the clone are refused; their read forms are not", () => {
    const no = (c: string) => expect(containShell(c, superRepo, { env }).ok).toBe(false);
    const yes = (c: string) => expect(containShell(c, superRepo, { env }).ok).toBe(true);
    no("sed -i s/one/ONE/ docs/x.md");
    yes("sed -n 1,2p docs/x.md");
    no(`mv ${scratch}/ok.txt docs/`);
    yes(`cp docs/x.md ${scratch}/copy.md`);
    no("dd if=/dev/zero of=docs/z bs=1 count=1");
    no("curl -s -o docs/page.html http://example.invalid");
    yes("curl -s http://example.invalid | head -1");
  });
});

describe("fd redirects vs file redirects (qa 10-02)", () => {
  it("refuses `>& f` and `>&f` into the super-repo, and still allows `2>&1` / `>&2` / `>&-`", () => {
    expect(containShell("echo x >& f", superRepo, { env }).ok).toBe(false);
    expect(containShell("echo x >&f", superRepo, { env }).ok).toBe(false);
    expect(containShell("echo x 2>&1", superRepo, { env }).ok).toBe(true);
    expect(containShell("echo x >&2", superRepo, { env }).ok).toBe(true);
    expect(containShell("echo x >&-", superRepo, { env }).ok).toBe(true);
  });
});
