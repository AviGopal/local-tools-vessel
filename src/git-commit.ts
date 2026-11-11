// git_commit: commit a change in a worktree made for it, checked by hooks the change cannot edit.
//
// A commit is the write pull-sync trusts most, so three things the shell resolver does not need are held here:
//   - no shell: git runs from argv, and the message reaches it on stdin (`commit -F -`), so text such as $(...) in a
//     message is committed as written, never run;
//   - no credentials: the child gets the agent-shell allowlist env (agent-shell-env.ts), never this vessel's own env,
//     which carries the push credential. Only a push may hold it;
//   - hooks from the base, not the worktree: core.hooksPath is relative, so git would run the worktree's own copy of
//     the hooks, which the change being judged may have edited. The hook directory is exported from the base commit
//     (the worktree's upstream) into a directory the command cannot write, and git is pointed at it.
// Only a linked worktree is committed in, never a main clone. A change touching what judges changes (hooks, gate
// scripts, accepted fixtures, this vessel's containment and landing code, the records writer code, the walk's owner
// seed) is committed but marked needs_person: a landing then takes only a person's verdict for it.
import { chmodSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { agentShellEnv } from "./agent-shell-env.js";
import { agentShellSpawn } from "./shell-privilege.js";

type Run = { stdout: string; stderr: string; exit_code: number };

// Hooks may run a repo's whole test gate; the shell resolver's own ceiling bounds it.
const COMMIT_TIMEOUT_MS = 900_000;
const GIT_TIMEOUT_MS = 60_000;

/** One git command from argv, with the agent-shell env: never a shell, never this vessel's credentials. */
export async function git(args: string[], cwd: string, opts: { stdin?: string; extraEnv?: Record<string, string>; timeoutMs?: number } = {}): Promise<Run> {
  const run = agentShellSpawn(["git", ...args], agentShellEnv(process.env, opts.extraEnv), tmpdir());
  try {
    const p = Bun.spawn(run.argv, {
      cwd, env: run.env, stdout: "pipe", stderr: "pipe",
      stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
      signal: AbortSignal.timeout(opts.timeoutMs ?? GIT_TIMEOUT_MS),
    });
    const [stdout, stderr, exit_code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { stdout, stderr, exit_code };
  } finally {
    void run.done();
  }
}

const out = async (args: string[], cwd: string): Promise<string | null> => {
  const r = await git(args, cwd);
  return r.exit_code === 0 ? r.stdout.trim() : null;
};

// Paths whose change needs a person's verdict, by repository. Patterns are matched against repo-relative paths.
const JUDGES_EVERYWHERE = ["scripts/git-hooks/**", ".git-hooks/**", "scripts/substrate/gate/**", "validation/scripts/gate/**",
  "scripts/substrate/walk-owner-seed.ts"];
const JUDGES_BY_REPO: Record<string, string[]> = {
  "local-tools-vessel": ["src/git-commit.ts", "src/index.ts", "src/shell-containment.ts", "src/write-containment.ts",
    "src/agent-shell-env.ts", "src/shell-privilege.ts"],
  "records-vessel": ["src/**"],
};
// A repo without a gate policy names no accepted fixtures, so every fixture-like path counts.
const FIXTURES_WITHOUT_POLICY = ["validation/**", "test/fixtures/**", "src/**/fixtures/**"];

const repoName = (url: string | null): string => basename((url ?? "").replace(/\/+$/, "")).replace(/\.git$/, "");

async function judgesOf(cwd: string, base: string, hooksRel: string): Promise<string[]> {
  const repo = repoName(await out(["config", "--get", "remote.origin.url"], cwd));
  const policy = await out(["show", `${base}:scripts/substrate/gate/gate-policy.json`], cwd);
  let fixtures = FIXTURES_WITHOUT_POLICY;
  if (policy !== null) {
    try { fixtures = (JSON.parse(policy) as { fixture_paths?: string[] }).fixture_paths ?? []; } catch { /* unreadable: keep the broad set */ }
  }
  return [`${hooksRel.replace(/\/+$/, "")}/**`, ...JUDGES_EVERYWHERE, ...(JUDGES_BY_REPO[repo] ?? []), ...fixtures];
}

/** Export the hook directory as of `base` into a fresh directory the agent cannot write; its absolute path. */
async function pinnedHooks(cwd: string, base: string, hooksRel: string): Promise<string | { error: string }> {
  if ((await git(["cat-file", "-e", `${base}:${hooksRel}`], cwd)).exit_code !== 0) {
    return { error: `the base ${base.slice(0, 12)} has no ${hooksRel}: nothing trusted would check this commit` };
  }
  const dir = mkdtempSync(join(tmpdir(), "pinned-hooks-"));
  const run = agentShellSpawn(["git", "archive", "--format=tar", base, "--", hooksRel], agentShellEnv(process.env), tmpdir());
  try {
    const a = Bun.spawn(run.argv, { cwd, env: run.env, stdout: "pipe", stderr: "ignore", signal: AbortSignal.timeout(GIT_TIMEOUT_MS) });
    // Extracted by this vessel, not the shell user, so the directory stays the vessel's.
    const x = Bun.spawn(["tar", "-x", "-C", dir], { stdin: a.stdout, stdout: "ignore", stderr: "ignore", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    if ((await a.exited) !== 0 || (await x.exited) !== 0) return { error: "the base's hooks could not be exported" };
  } finally {
    void run.done();
  }
  // Readable and runnable by the shell user, writable only by this vessel.
  const seal = (p: string) => {
    const s = statSync(p);
    chmodSync(p, s.isDirectory() ? 0o755 : (s.mode & 0o111 ? 0o555 : 0o444));
    if (s.isDirectory()) for (const e of readdirSync(p)) seal(join(p, e));
  };
  seal(dir);
  return join(dir, hooksRel);
}

export type CommitResult =
  | { shape: "gitCommitResult"; sha: string; tree: string; base: string; changed: string[]; needs_person: string[] }
  | { error: string; stderr?: string; exit_code?: number };

export async function commitInWorktree(cwd: string, message: string, extraEnv?: Record<string, string>): Promise<CommitResult> {
  const gitDir = await out(["rev-parse", "--path-format=absolute", "--git-dir"], cwd);
  const common = await out(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  if (!gitDir || !common) return { error: `${cwd} is not a git repository` };
  if (gitDir === common) return { error: `${cwd} is a main clone, not a worktree: git_commit commits only in a worktree made for the change` };
  const base = await out(["rev-parse", "--verify", "@{upstream}^{commit}"], cwd);
  if (!base) return { error: `${cwd} tracks no upstream: there is no base to judge the change against` };
  const hooksRel = await out(["config", "--get", "core.hooksPath"], cwd);
  if (!hooksRel) return { error: `${cwd} configures no hooks: nothing would check this commit` };
  if (isAbsolute(hooksRel)) return { error: `core.hooksPath is absolute (${hooksRel}); only a repo-relative hook directory can be taken from the base` };
  const hooks = await pinnedHooks(cwd, base, hooksRel);
  if (typeof hooks !== "string") return hooks;

  const add = await git(["add", "-A"], cwd);
  if (add.exit_code !== 0) return { error: "git add failed", stderr: add.stderr.slice(-2000), exit_code: add.exit_code };
  const changed = (await out(["diff", "--cached", "--name-only", "--no-renames", base], cwd) ?? "").split("\n").filter(Boolean);
  if (changed.length === 0) return { error: "nothing to commit: the worktree does not differ from its base" };
  const judges = await judgesOf(cwd, base, hooksRel);
  const needs_person = changed.filter((p) => judges.some((g) => new Bun.Glob(g).match(p)));

  const c = await git(["-c", `core.hooksPath=${hooks}`, "commit", "-F", "-"], cwd, { stdin: message, extraEnv, timeoutMs: COMMIT_TIMEOUT_MS });
  if (c.exit_code !== 0) return { error: "the commit was refused (the base's hooks, or git)", stderr: c.stderr.slice(-2000), exit_code: c.exit_code };
  const sha = await out(["rev-parse", "HEAD"], cwd);
  const tree = await out(["rev-parse", "HEAD^{tree}"], cwd);
  if (!sha || !tree) return { error: "committed, but HEAD could not be read" };
  return { shape: "gitCommitResult", sha, tree, base, changed, needs_person };
}
