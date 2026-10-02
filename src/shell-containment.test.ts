// Pins shell containment: the general shell may READ the live super-repo clone but
// may not WRITE it. The incident: goal-host's floor offered shellResult as an
// "inspect" tool, and floor run 27c1c600 (09-30) created
// /workspace/git/super-repo/GPT-5.md through this vessel's shell handler, whose cwd
// defaults to WORKSPACE_ROOT = the live clone. The REAL server is spawned the way
// write-containment.test.ts does it, and the lane's own shell commands (enumerated
// from development-vessel) are replayed to prove they still pass.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { containShell, segments } from "./shell-containment";
import { signWriteGrant, WRITE_CONTAINMENT_ERROR } from "./write-containment";

const KEY = "test-fleet-key-0123456789";
let base: string, superRepo: string, vessels: string, scratch: string;
let env: Record<string, string>;

const put = (p: string, s: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "pipe" }).toString();

// No server is spawned here: under the pull-sync gate's parallel load a child `bun index.ts`
// can miss any readiness window and drop the whole file (7e98d5d4 was refused that way on 10-02).
// The policy is containShell's, tested directly; the wiring into every shell handler is pinned
// against the source below.
beforeAll(() => {
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
  env = {
    WORKSPACE_ROOT: superRepo, MITOSIS_RUNTIME_DIR: vessels, MITOSIS_PUSH_CLONE_DIR: join(base, "git", "vessels"), COMPOSE_WS_DIR: join(base, "git", "compose"),
    METABOB_API_KEY: KEY,
  };
});

afterAll(() => { rmSync(base, { recursive: true, force: true }); });

const gate = (command: string, cwd = superRepo, grant?: unknown) => containShell(command, cwd, grant === undefined ? { env } : { env, grant });

describe("the 27c1c600 incident: a floor shellResult writing the live super-repo clone", () => {
  it("refuses a redirect that creates a file in the clone (default cwd) with the containment error", () => {
    const r = gate("echo 'model output' > GPT-5.md");
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain(WRITE_CONTAINMENT_ERROR);
    expect(JSON.stringify(r)).toContain("live super-repo clone");
  });
  it("refuses the absolute form from any cwd (tee, touch, here-doc)", () => {
    const marker = join(superRepo, "docs", "MARKER.md");
    expect(gate(`printf hi | tee ${marker}`, scratch).ok).toBe(false);
    expect(gate(`touch ${marker}`).ok).toBe(false);
    expect(gate(`cat > ${JSON.stringify(marker)} <<'EOF'\nx\nEOF`).ok).toBe(false);
  });
  it("refuses git commit in the clone, and git add after cd into it", () => {
    expect(JSON.stringify(gate("git -c user.name=x -c user.email=x@x commit --allow-empty -m sneaked"))).toContain("'git commit'");
    expect(JSON.stringify(gate(`cd ${superRepo}/docs && git add -A`, scratch))).toContain("'git add'");
  });
});

describe("reads in the clone keep working, with the same cwd", () => {
  it("wc -l, ls, git log, grep and stderr/dev-null redirects are not writes", () => {
    expect(gate("wc -l < docs/x.md").ok).toBe(true);
    expect(gate("ls docs 2>/dev/null; git log --oneline | wc -l; grep -c two docs/x.md 2>&1; git status --porcelain >/dev/null").ok).toBe(true);
  });
  it("a write OUTSIDE the clone (scratch) is allowed", () => {
    expect(gate(`wc -l docs/x.md > ${join(scratch, "ok.txt")}`).ok).toBe(true);
  });
  it("a lane write grant bound to the cwd lets the write through; a forged one does not", () => {
    expect(gate("touch granted.txt", superRepo, signWriteGrant(KEY, superRepo)).ok).toBe(true);
    expect(gate("touch forged.txt", superRepo, signWriteGrant("wrong-key", superRepo)).ok).toBe(false);
  });
});

describe("wiring: every shell handler gates before it runs anything (source pin)", () => {
  const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
  it("shell / bash / bounded_shell all call containShell", () => {
    expect((src.match(/containShell\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
  it("codeSearchResult carries line_count (the floor's exact line-count read path)", () => {
    expect(src).toContain("line_count");
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
