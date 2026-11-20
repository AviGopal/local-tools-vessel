// In the protected zones, not only the live super-repo clone, a git command that would set a program git runs
// there is refused early, with a reason, in the invocation forms named here, while the lane's ordinary writes
// there stay allowed and a scratch directory outside every zone is not gated at all. This is the lexical check's
// share only: ownership is the boundary (see shell-containment.ts), so these legs pin the early refusal, not a
// closure of every form.
import { beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containShell } from "./shell-containment";

let superRepo: string, clone: string, scratch: string;
let env: Record<string, string>;
beforeAll(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "shell-gate-exec-")));
  superRepo = join(base, "git", "super-repo");
  clone = join(base, "git", "vessels", "demo");
  scratch = join(base, "scratch");
  mkdirSync(join(superRepo, "scripts", "substrate"), { recursive: true });
  writeFileSync(join(superRepo, ".gitmodules"), "");
  writeFileSync(join(superRepo, "scripts", "substrate", "autonomy-scope.json"), "{}");
  execFileSync("git", ["-C", superRepo, "init", "-q"]);
  mkdirSync(clone, { recursive: true });
  execFileSync("git", ["-C", clone, "init", "-q"]);
  mkdirSync(scratch, { recursive: true });
  env = { WORKSPACE_ROOT: superRepo, MITOSIS_RUNTIME_DIR: join(base, "vessels"), MITOSIS_PUSH_CLONE_DIR: join(base, "git", "vessels"), COMPOSE_WS_DIR: join(base, "git", "compose"), METABOB_API_KEY: "k" };
});
const ok = (c: string, cwd: string) => containShell(c, cwd, { env }).ok;
const leaks = (cmds: string[], cwd: string) => cmds.filter((c) => ok(c, cwd));

const INVOKE = (rest: string): string[] => [
  `git ${rest}`, `/usr/bin/git ${rest}`, `command git ${rest}`, `env git ${rest}`, `echo x | xargs git ${rest}`,
];

describe("shell gate: what git runs, in a vessel clone", () => {
  it("[MUST-FAIL] refuses writing an exec-capable config key, in each invocation form named", () => {
    const cmds = ["config core.hooksPath /tmp/h", "config core.fsmonitor /tmp/x", "config core.sshCommand /tmp/x",
      "config core.pager /tmp/x", "config --add alias.x '!/tmp/x'", "config --file .git/config core.hooksPath /tmp/h"].flatMap(INVOKE);
    expect(leaks(cmds, clone)).toEqual([]);
  });
  it("[MUST-FAIL] refuses -c / --config-env, a GIT_* or PAGER variable, and a transport program option on any git command", () => {
    expect(leaks([
      "git -c core.hooksPath=/tmp/h commit -m x", "git -c core.fsmonitor=/tmp/x status", "git --config-env=core.pager=HOME log",
      "GIT_SSH_COMMAND=/tmp/x git fetch origin", "env GIT_PAGER=/tmp/x git log", "PAGER=/tmp/x git log",
      "git fetch --upload-pack=/tmp/x origin", "git push --receive-pack /tmp/x origin dev", "git --exec-path=/tmp git status",
    ], clone)).toEqual([]);
  });
  it("[MUST-FAIL] a config write is placed by its file, or refused outright when it reaches every clone", () => {
    expect(ok(`git config --file ${join(clone, ".git", "config")} core.hooksPath /tmp/h`, scratch)).toBe(false);
    expect(ok("git config --global core.hooksPath /tmp/h", scratch)).toBe(false);
    expect(ok("git config --system core.pager /tmp/x", scratch)).toBe(false);
  });
  it("[MUST-FAIL] --git-dir / GIT_DIR naming the live super clone from outside it is still the super clone", () => {
    expect(ok(`git --git-dir=${join(superRepo, ".git")} config core.hooksPath /tmp/h`, scratch)).toBe(false);
    expect(ok(`GIT_DIR=${join(superRepo, ".git")} git branch evil`, scratch)).toBe(false);
    expect(ok(`git --git-dir ${join(superRepo, ".git")} branch evil`, scratch)).toBe(false);
  });
  it("[MUST-FAIL] in the live super clone a read form that writes a file or opens a pager program is not a read", () => {
    expect(leaks(["git diff --output=x.patch", "git log --output x.txt", "git grep -O/tmp/x foo", "git grep --open-files-in-pager=/tmp/x foo", "git symbolic-ref -d HEAD",
      "git config -f get core.hooksPath /tmp/h", "git config --file list core.pager /tmp/x"], superRepo)).toEqual([]);
  });
  it("[MUST-FAIL] in the live super clone the narrower read forms stay allowed (the parent refused config get)", () => {
    const blocked = ["git worktree list", "git branch -a", "git branch --show-current", "git remote get-url origin", "git config get user.name",
      "git submodule", "git rev-list -1 HEAD", "git --version"].filter((c) => !ok(c, superRepo));
    expect(blocked).toEqual([]);
  });
  it("[GUARD] the lane's ordinary writes in a vessel clone are allowed", () => {
    const blocked = ["git add -A", "git commit -m x", "git fetch origin", "git push origin dev", "git checkout -b x",
      "git config --get user.name", "git -C . status", "git worktree add ../w"].filter((c) => !ok(c, clone));
    expect(blocked).toEqual([]);
  });
  it("[GUARD] outside every zone the gate does not narrow git", () => {
    const blocked = ["git -c core.pager=cat log", "GIT_PAGER=cat git log", "git config user.name x"].filter((c) => !ok(c, scratch));
    expect(blocked).toEqual([]);
  });
});
