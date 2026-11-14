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
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentShellEnv } from "./agent-shell-env.js";
import { redactSecrets } from "./script-runner.js";
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

/**
 * git as this vessel, for a repository it owns (the node's own copies, the super-repo clone). The shell user may not read
 * those: git refuses a repository another user owns, and older git (the image's) ignores a safe.directory given in the
 * environment. No privilege drop, no user or global config (HOME points nowhere), no credential.
 */
export async function vesselGit(args: string[], cwd: string): Promise<Run> {
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent", XDG_CONFIG_HOME: "/nonexistent", GIT_TERMINAL_PROMPT: "0" };
  const p = Bun.spawn(["git", "-c", "credential.helper=", ...args], { cwd, env, stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(GIT_TIMEOUT_MS) });
  const [stdout, stderr, exit_code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, exit_code };
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
  // Every file on the landing path decides whether a change lands; and every file that bounds what the walk's tools may
  // reach (the file tools' roots, the shell's containment and privilege, the credentialed script runner) decides what any
  // change can do. A gap whose check those bounds make fail (a test asking for a path they refuse) would otherwise be
  // "fixed" by loosening them, on a grader's verdict alone.
  "local-tools-vessel": ["src/git-*.ts", "src/walk-rows.ts", "src/index.ts", "src/shell-containment.ts",
    "src/write-containment.ts", "src/agent-shell-env.ts", "src/shell-privilege.ts", "src/tool-roots.ts",
    "src/script-runner.ts", "src/script-runner-reaper.ts"],
  "records-vessel": ["src/**"],
};
// A repo without a gate policy names no accepted fixtures, so every fixture-like path counts.
const FIXTURES_WITHOUT_POLICY = ["validation/**", "test/fixtures/**", "src/**/fixtures/**"];

/** `show(path)` reads a file at the base, as whoever may read that repository. */
export async function judgesOf(show: (path: string) => Promise<string | null>, made: Pick<Made, "repo">): Promise<string[]> {
  const policy = await show("scripts/substrate/gate/gate-policy.json");
  let fixtures = FIXTURES_WITHOUT_POLICY;
  if (policy !== null) {
    try { fixtures = (JSON.parse(policy) as { fixture_paths?: string[] }).fixture_paths ?? []; } catch { /* unreadable: keep the broad set */ }
  }
  return [...JUDGES_EVERYWHERE, ...(JUDGES_BY_REPO[made.repo] ?? []), ...fixtures];
}

/** The pre-commit hook as of the super base, in a fresh directory the agent cannot write; that directory. */
async function pinnedHooks(superDir: string, made: Made): Promise<string | { error: string }> {
  const path = made.repo === "super" ? HOOK_FOR_SUPER : HOOK_FOR_VESSEL;
  const hook = await vesselGit(["show", `${made.super_base}:${path}`], superDir);
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
  const r = Bun.spawnSync(["git", "config", "--system", "--get", "core.hooksPath"], { env: process.env as Record<string, string>, stdout: "pipe", stderr: "ignore", timeout: GIT_TIMEOUT_MS });
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
  | { error: string; stderr?: string; stderr_withheld?: string; exit_code?: number };

// What a refused commit printed, as the reason the walk is shown: git's stderr, where git also sends everything a hook
// prints (its stdout too). A hook may print what it read (a test's output, a scan's finding, a file in the tree), and
// that can quote a secret. So, before the cut and in this order, using what this vessel already has:
//   - every value this process holds that an agent's shell would not be given (the complement of agentShellEnv's
//     allowlist, so a credential added to the env is covered when it arrives) is redacted with script-runner's
//     redactSecrets, except values shorter than its window and values that are only a place: a bare absolute path
//     (letters, digits, ".", "_", "-" and "/"), or exactly scheme://host[:port] with at most a trailing "/". Those stay,
//     so a failure keeps the file and line it names (a redacted window of "/workspace" would cut every path). A URL
//     with anything more (a user, a path, a query, a fragment) is redacted: a webhook keeps its secret there;
//   - the rest is scanned with the super base's secrets config (gitleaks over a private temp file, as a landing scans
//     its range). Each line a finding names is replaced by "[REDACTED: secrets scan, rules ...]", placed by the
//     report's rule ids and line numbers, never by matching its text; the replaced text is scanned again and must come
//     back clean;
//   - then it is cut to its last TAIL characters.
// If the scan cannot run or cannot be trusted (no scanner, no config, an error, a report it cannot read, a finding
// outside the text, a second scan that still finds something), nothing of the output is kept: the answer says it was
// withheld and why. Only a refused commit is scanned; a commit that lands is scanned by the landing. SCAN_MS bounds
// each scan.
const TAIL = 2000;
const SCAN_MS = 60_000;
const SHORTEST = 8;
const isPlace = (v: string): boolean => /^\/[A-Za-z0-9._/-]+$/.test(v) || /^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9.-]+(:\d+)?\/?$/.test(v);
const hidden = (): string[] => {
  const given = new Set(Object.keys(agentShellEnv(process.env)));
  return Object.entries(process.env)
    .filter(([k, v]) => !given.has(k) && typeof v === "string" && v.length >= SHORTEST && !isPlace(v))
    .map(([, v]) => v as string);
};
type Scan = { clean: true } | { found: Array<{ RuleID?: string; StartLine?: number; EndLine?: number }> } | { failed: string };
async function scanText(text: string, scanner: string, config: string, work: string, n: number): Promise<Scan> {
  const input = join(work, `in-${n}`);
  mkdirSync(input, { mode: 0o700 });
  writeFileSync(join(input, "said.txt"), text, { mode: 0o600 });
  const report = join(work, `leaks-${n}.json`);
  let sc: number;
  try {
    const scan = Bun.spawn([scanner, "detect", "--no-git", "--source", input, "--config", config,
      "--redact", "--no-banner", "--exit-code", "3", "--report-format", "json", "--report-path", report],
    { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: work }, stdout: "ignore", stderr: "ignore", signal: AbortSignal.timeout(SCAN_MS) });
    sc = await scan.exited;
  } catch { return { failed: "the secrets scan could not start" }; }
  if (sc === 0) return { clean: true };
  if (sc !== 3) return { failed: `the secrets scan did not run cleanly (exit ${sc})` };
  try {
    const found = JSON.parse(readFileSync(report, "utf8"));
    return Array.isArray(found) && found.length > 0 ? { found } : { failed: "the secrets scan's report named nothing" };
  } catch { return { failed: "the secrets scan's report could not be read" }; }
}
async function refusedSaying(c: Run, superDir: string, made: Made, scanner: string | null): Promise<{ stderr: string } | { stderr_withheld: string }> {
  const known = redactSecrets(c.stderr, hidden()).text;
  if (!scanner) return { stderr_withheld: "no secrets scanner on this node" };
  const work = mkdtempSync(join(tmpdir(), "commit-said-"));
  try {
    const cfg = await vesselGit(["show", `${made.super_base}:scripts/git-hooks/.gitleaks.toml`], superDir);
    if (cfg.exit_code !== 0) return { stderr_withheld: "the super base has no secrets scan config" };
    const config = join(work, "gitleaks.toml");
    writeFileSync(config, cfg.stdout, { mode: 0o600 });
    const first = await scanText(known, scanner, config, work, 1);
    if ("failed" in first) return { stderr_withheld: first.failed };
    if ("clean" in first) return { stderr: known.slice(-TAIL) };
    const lines = known.split("\n");
    for (const f of first.found) {
      const from = Number(f.StartLine);
      const to = Number(f.EndLine ?? f.StartLine);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > lines.length) {
        return { stderr_withheld: "the secrets scan found something it could not place" };
      }
      for (let i = from; i <= to; i++) lines[i - 1] = `[REDACTED: secrets scan, rules ${String(f.RuleID)}]`;
    }
    const replaced = lines.join("\n");
    const again = await scanText(replaced, scanner, config, work, 2);
    if (!("clean" in again)) return { stderr_withheld: "the secrets scan still found something after its findings were replaced" };
    return { stderr: replaced.slice(-TAIL) };
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch { /* a temp dir */ }
  }
}

export async function commitInClone(
  cwd: string, message: string, extraEnv?: Record<string, string>,
  find: (cwd: string) => Promise<Made | { error: string }> = madeClone,
  scanner: string | null = Bun.which("gitleaks", { PATH: process.env.PATH ?? "" }),
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
    const judges = await judgesOf((path) => out(["show", `${made.base}:${path}`], cwd), made);
    const needs_person = changed.filter((p) => judges.some((g) => new Bun.Glob(g).match(p)));

    const c = await git(["-c", `core.hooksPath=${hooks}`, "commit", "-F", "-"], cwd, { stdin: message, extraEnv, timeoutMs: COMMIT_TIMEOUT_MS });
    if (c.exit_code !== 0) {
      const said = await refusedSaying(c, superDir, made, scanner);
      return { error: "the commit was refused (the pinned hook, or git)", ...said, exit_code: c.exit_code };
    }
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
