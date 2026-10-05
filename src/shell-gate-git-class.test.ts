// Check-first (class, not examples): in the super-repo clone the shell gate must refuse every git
// invocation that mutates the repo OR can execute a program, by any channel, and allow only plain
// read forms with no config/exec overrides. The original check named 4 example strings and the
// landed patch (2720323) blocked exactly those 4; qa's probe then found the classes below still
// ALLOWED, including full containment bypasses (git -c core.fsmonitor=<cmd> status runs <cmd>).
// The grid is generated so a patch cannot special-case a short list; a held-out probe set kept
// outside the repo is run at landing as well.
import { beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containShell } from "./shell-containment";

let superRepo: string;
let env: Record<string, string>;
beforeAll(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "shell-gate-class-")));
  superRepo = join(base, "git", "super-repo");
  mkdirSync(join(superRepo, "scripts", "substrate"), { recursive: true });
  writeFileSync(join(superRepo, ".gitmodules"), "");
  writeFileSync(join(superRepo, "scripts", "substrate", "autonomy-scope.json"), "{}");
  writeFileSync(join(superRepo, "notes.txt"), "b\na\n");
  execFileSync("git", ["-C", superRepo, "init", "-q"]);
  env = { WORKSPACE_ROOT: superRepo, MITOSIS_RUNTIME_DIR: join(base, "vessels"), MITOSIS_PUSH_CLONE_DIR: join(base, "git", "vessels"), COMPOSE_WS_DIR: join(base, "git", "compose"), METABOB_API_KEY: "k" };
});
const ok = (c: string) => containShell(c, superRepo, { env }).ok;
const leaks = (cmds: string[]) => cmds.filter((c) => ok(c));

// How git is invoked: the gate must not key on words[0] === "git" alone.
const INVOKE = (rest: string): string[] => [
  `git ${rest}`,
  `/usr/bin/git ${rest}`,
  `command git ${rest}`,
  `env git ${rest}`,
  `env GIT_TRACE=0 git ${rest}`,
  `echo x | xargs git ${rest}`,
];
// Global options that select the repository or inject config before the subcommand.
const PREFIX = ["", "-C . ", "--git-dir=.git ", "-c user.name=x ", "--no-pager "];
const ENVPREFIX = ["", "GIT_DIR=.git "];

const MUTATING = [
  "config core.hooksPath /tmp/h", "config --unset user.name", "config --add x.y z", "config --replace-all x.y z",
  "remote add evil https://e/", "remote rm origin", "remote remove origin", "remote rename origin o2",
  "remote set-url origin https://e/", "remote -v set-url origin https://e/", "remote set-head origin dev", "remote prune origin",
  "branch newbranch", "branch -d dev", "branch -D dev", "branch -m dev x", "branch -M dev", "branch -c dev x",
  "branch -f dev HEAD~1", "branch --set-upstream-to=origin/dev",
  "submodule add https://e/ sub", "submodule deinit -f sub", "submodule sync", "submodule set-url sub https://e/",
  "submodule set-branch -b dev sub", "submodule update --init", "submodule foreach git reset --hard",
  "tag v9", "tag -d v9", "update-ref refs/heads/dev HEAD", "symbolic-ref HEAD refs/heads/x",
  "reset --hard", "checkout -b x", "switch -c x", "commit --allow-empty -m x", "push origin dev",
  "fetch origin", "pull origin dev", "merge origin/dev", "rebase origin/dev", "am x.patch", "apply x.patch",
  "stash", "gc", "prune", "worktree add ../w", "worktree remove ../w",
];

// Read forms that are fine ONLY without overrides.
const READS = ["status", "log -1", "diff", "show HEAD", "rev-parse HEAD", "config --get user.name", "config --list",
  "remote -v", "branch --list", "submodule status", "symbolic-ref HEAD"];
// Config keys that make git execute a program, injected through any channel.
const EXEC_KEYS = ["core.fsmonitor=/tmp/x", "core.pager=/tmp/x", "core.editor=/tmp/x", "core.sshCommand=/tmp/x",
  "core.hooksPath=/tmp/h", "alias.st=!/tmp/x", "diff.external=/tmp/x", "diff.foo.textconv=/tmp/x",
  "filter.foo.clean=/tmp/x", "filter.foo.smudge=/tmp/x", "filter.foo.process=/tmp/x",
  "credential.helper=!/tmp/x", "sequence.editor=/tmp/x", "gpg.program=/tmp/x"];
const EXEC_ENV = ["GIT_PAGER=/tmp/x", "PAGER=/tmp/x", "GIT_EXTERNAL_DIFF=/tmp/x", "GIT_SSH_COMMAND=/tmp/x",
  "GIT_EDITOR=/tmp/x", "GIT_CONFIG_PARAMETERS='core.fsmonitor=/tmp/x'"];

describe("shell gate: git in the super-repo clone (class)", () => {
  it("refuses every mutating subcommand under every invocation form and global prefix", () => {
    const cmds: string[] = [];
    for (const m of MUTATING) for (const p of PREFIX) for (const e of ENVPREFIX) for (const c of INVOKE(p + m)) cmds.push(e + c);
    expect(leaks(cmds)).toEqual([]);
  });
  it("refuses read forms that carry an exec-capable config key via -c or --config-env", () => {
    const cmds: string[] = [];
    for (const r of READS) for (const k of EXEC_KEYS) {
      cmds.push(`git -c ${k} ${r}`);
      cmds.push(`git -c ${k} -C . ${r}`);
      cmds.push(`git --config-env=${k.split("=")[0]}=HOME ${r}`);
    }
    cmds.push("git -c alias.x='!/tmp/x' x");
    expect(leaks(cmds)).toEqual([]);
  });
  it("refuses read forms run with an exec-capable environment variable", () => {
    const cmds: string[] = [];
    for (const r of READS) for (const v of EXEC_ENV) { cmds.push(`${v} git ${r}`); cmds.push(`env ${v} git ${r}`); }
    expect(leaks(cmds)).toEqual([]);
  });
  it("refuses qa's original bypass probe forms", () => {
    expect(leaks([
      "git -c a=b config core.hooksPath /tmp/h", "git remote -v set-url origin https://e/",
      "git remote --verbose set-url origin https://e/", "git remote add evil https://e/", "git remote rm origin",
      "git branch newbranch", "git branch -D dev", "git branch -M dev", "git --git-dir=.git config core.hooksPath /tmp/h",
      "git config --get x && git config core.hooksPath /tmp/h", "GIT_DIR=.git git config core.hooksPath /tmp/h",
      "git submodule foreach git reset --hard", "git submodule set-url sub https://e/",
    ])).toEqual([]);
  });
  it("still allows plain read forms with no overrides (control)", () => {
    // Prefixed plain reads too, so refusing everything with a prefix is not a passing fix.
    const blocked = [...READS.map((r) => `git ${r}`), "git -C . status", "git --no-pager log -1"].filter((c) => !ok(c));
    expect(blocked).toEqual([]);
  });
});
