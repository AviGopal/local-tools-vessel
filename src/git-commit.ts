// git_commit: commit a change in a clone git_worktree made for it, checked by hooks the change cannot edit.
//
// A commit is the write pull-sync trusts most, so three things the shell resolver does not need are held here:
//   - no shell: git runs from argv, and the message reaches it on stdin (`commit -F -`), so text such as $(...) in a
//     message is committed as written, never run;
//   - no credentials: the child gets the agent-shell allowlist env (agent-shell-env.ts), never this vessel's own env,
//     which carries the push credential. Only a push may hold it;
//   - hooks from the super-repo as of the clone's making: the pre-commit hook (the super-repo's own for a super-repo
//     change, its vessel-pre-commit for a vessel's) is exported from the super base into a directory the command cannot
//     write, and git is pointed at it. The clone's own files never decide which hook runs.
// Only a clone the walk's row says git_worktree made, and has not landed, is committed in (walk-rows.ts); its base comes
// from that row, which the shell user cannot write. A change touching what judges changes (hooks, gate scripts,
// accepted fixtures, tests the pinned hook runs from the change's own tree, this vessel's containment and landing code,
// the records writer code, the walk's owner seed) is committed but marked needs_person: a landing then takes only a
// person's verdict for it. Whether the hook's secrets scan ran is reported as scan, for the landing to require.
//
// NOT A TRUST BOUNDARY. git here runs as the shell user, in a clone the shell user owns, so the shell user could commit
// without the pinned hook, or make this answer wrong (replace refs on the base, an fsmonitor, a rewritten index). That
// gains it nothing it does not already have, but every value answered here (changed, needs_person, tree, scan) is
// advisory: a landing recomputes all of it in a repository of its own before anything is pushed.
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentShellEnv } from "./agent-shell-env.js";
import { agentShellSpawn } from "./shell-privilege.js";
import { type Made, madeClone } from "./walk-rows.js";
import { containmentZones } from "./write-containment.js";

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

// The super-repo's hooks: the one that judges a super-repo commit, and the one that judges a vessel's.
const HOOK_FOR_SUPER = "scripts/git-hooks/pre-commit";
const HOOK_FOR_VESSEL = "scripts/git-hooks/vessel-pre-commit";

// Paths whose change needs a person's verdict, by repository. Patterns are matched against repo-relative paths.
const JUDGES_EVERYWHERE = ["scripts/git-hooks/**", ".git-hooks/**", "scripts/substrate/gate/**", "validation/scripts/gate/**",
  "scripts/substrate/walk-owner-seed.ts"];
const JUDGES_BY_REPO: Record<string, string[]> = {
  // The super-repo pre-commit runs the glue tests from the change's own tree.
  super: ["validation/scripts/**"],
  "local-tools-vessel": ["src/git-commit.ts", "src/git-worktree.ts", "src/walk-rows.ts", "src/index.ts", "src/shell-containment.ts",
    "src/write-containment.ts", "src/agent-shell-env.ts", "src/shell-privilege.ts"],
  "records-vessel": ["src/**"],
};
// A repo without a gate policy names no accepted fixtures, so every fixture-like path counts.
const FIXTURES_WITHOUT_POLICY = ["validation/**", "test/fixtures/**", "src/**/fixtures/**"];

async function judgesOf(cwd: string, made: Made): Promise<string[]> {
  const policy = await out(["show", `${made.base}:scripts/substrate/gate/gate-policy.json`], cwd);
  let fixtures = FIXTURES_WITHOUT_POLICY;
  if (policy !== null) {
    try { fixtures = (JSON.parse(policy) as { fixture_paths?: string[] }).fixture_paths ?? []; } catch { /* unreadable: keep the broad set */ }
  }
  return [...JUDGES_EVERYWHERE, ...(JUDGES_BY_REPO[made.repo] ?? []), ...fixtures];
}

/** The pre-commit hook as of the super base, in a fresh directory the agent cannot write; that directory. */
async function pinnedHooks(superDir: string, made: Made): Promise<string | { error: string }> {
  const path = made.repo === "super" ? HOOK_FOR_SUPER : HOOK_FOR_VESSEL;
  const hook = await git(["show", `${made.super_base}:${path}`], superDir);
  if (hook.exit_code !== 0) return { error: `the super base ${made.super_base.slice(0, 12)} has no ${path}: nothing trusted would check this commit` };
  const dir = mkdtempSync(join(tmpdir(), "pinned-hooks-"));
  // The node's own record-only hooks (the attempt ledger, set as the system hooks path) are kept, so a commit made here is
  // recorded like any other. Only from a directory no one but this vessel's owner can write, and never its pre-commit:
  // that one chains to the clone's own hook, which the change may have written.
  const ledger = systemHooksDir();
  if (ledger) {
    for (const name of readdirSync(ledger)) {
      if (name === "pre-commit") continue;
      const from = join(ledger, name);
      if (statSync(from).isFile()) writeFileSync(join(dir, name), readFileSync(from), { mode: 0o555 });
    }
  }
  writeFileSync(join(dir, "pre-commit"), hook.stdout, { mode: 0o555 });
  chmodSync(dir, 0o555);
  return dir;
}

/** The system hooks directory, when this vessel's owner alone can write it; null otherwise. */
function systemHooksDir(): string | null {
  const r = Bun.spawnSync(["git", "config", "--system", "--get", "core.hooksPath"], { env: process.env as Record<string, string>, stdout: "pipe", stderr: "ignore" });
  const dir = r.exitCode === 0 ? r.stdout.toString().trim() : "";
  if (!dir) return null;
  try {
    const s = statSync(dir);
    const uid = process.getuid?.() ?? -1;
    return s.isDirectory() && s.uid === uid && (s.mode & 0o022) === 0 ? dir : null;
  } catch { return null; }
}

export type CommitResult =
  | { shape: "gitCommitResult"; sha: string; tree: string; base: string; changed: string[]; needs_person: string[]; scan: "ran" | "skipped" }
  | { error: string; stderr?: string; exit_code?: number };

export async function commitInClone(
  cwd: string, message: string, extraEnv?: Record<string, string>,
  find: (cwd: string) => Promise<Made | { error: string }> = madeClone,
): Promise<CommitResult> {
  const made = await find(cwd);
  if ("error" in made) return made;
  const superDir = containmentZones(process.env).supers[0];
  if (!superDir) return { error: "this node has no super-repo clone: nothing would judge a commit" };
  const hooks = await pinnedHooks(superDir, made);
  if (typeof hooks !== "string") return hooks;
  try {
    const add = await git(["add", "-A"], cwd);
    if (add.exit_code !== 0) return { error: "git add failed", stderr: add.stderr.slice(-2000), exit_code: add.exit_code };
    const changed = (await out(["diff", "--cached", "--name-only", "--no-renames", made.base], cwd) ?? "").split("\n").filter(Boolean);
    if (changed.length === 0) return { error: "nothing to commit: the clone does not differ from its base" };
    const judges = await judgesOf(cwd, made);
    const needs_person = changed.filter((p) => judges.some((g) => new Bun.Glob(g).match(p)));

    const c = await git(["-c", `core.hooksPath=${hooks}`, "commit", "-F", "-"], cwd, { stdin: message, extraEnv, timeoutMs: COMMIT_TIMEOUT_MS });
    if (c.exit_code !== 0) return { error: "the commit was refused (the pinned hook, or git)", stderr: c.stderr.slice(-2000), exit_code: c.exit_code };
    const sha = await out(["rev-parse", "HEAD"], cwd);
    const tree = await out(["rev-parse", "HEAD^{tree}"], cwd);
    if (!sha || !tree) return { error: "committed, but HEAD could not be read" };
    // The hooks print this when gitleaks is missing and their scan did not run.
    const scan = /secrets scan skipped|gitleaks not installed/i.test(c.stdout + c.stderr) ? "skipped" : "ran";
    return { shape: "gitCommitResult", sha, tree, base: made.base, changed, needs_person, scan };
  } finally {
    try { chmodSync(hooks, 0o700); rmSync(hooks, { recursive: true, force: true }); } catch { /* best effort: a temp dir */ }
  }
}
