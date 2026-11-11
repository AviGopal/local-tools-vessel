// git_land: push a change clone's commits to its origin, only when an independent verdict approved exactly this tree.
//
// A push to a vessel's origin is an install on every node at the next pull-sync tick, and a leaked secret can never be
// taken back, so nothing the clone says is trusted here: its owner, the shell user, can write its config, refs and
// index. The clone's commits leave it as a bundle the shell user makes (data, no config), and every check runs in a
// fresh repository this vessel owns:
//   - origin's branch is fetched afresh, over https only and with no credential;
//   - the change must fast-forward it, with no merge commits;
//   - the changed paths and which of them need a person are recomputed here (git-commit.ts's answer is advisory);
//   - a secrets scan must run (gitleaks is required: missing, the landing is refused), with the super base's config
//     and inline allow comments ignored. A finding is named by its rule, never its text;
//   - a verdict row must approve this tree: a person's r 1 (records stamps person rows from the person's own key), or,
//     when no path needs a person, a grader's r 1 made from exactly the request and the walk's gitDiff row of this tree.
//     Any grader's r 0 on the tree blocks it unless a person approves.
// Only then is the change pushed: from that repository, no force, with no hooks, and the only command here that
// carries the push credential (the node's system credential helper reads it from this vessel's env).
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, judgesOf } from "./git-commit.js";
import { agentWritableDir } from "./shell-privilege.js";
import { type Made, madeClone, type Query, readRows, type Row } from "./walk-rows.js";
import { containmentZones } from "./write-containment.js";

type Run = { stdout: string; stderr: string; exit_code: number };
export type Deps = {
  find: (cwd: string) => Promise<Made | { error: string }>;
  rows: (q: Query) => Promise<Row[] | { error: string }>;
  /** Transports origin may be fetched over; https only, except in a test with a local origin. */
  transports: string[];
};
const DEFAULTS: Deps = { find: madeClone, rows: readRows, transports: ["https"] };

/** git as this vessel, in a repository it owns, with a HOME of its own (no user config) and, unless asked, no credential. */
async function trusted(args: string[], cwd: string, home: string, opts: { credential?: boolean; transports?: string[] } = {}): Promise<Run> {
  const base = opts.credential ? process.env : { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  const env = { ...base, HOME: home, GIT_TERMINAL_PROMPT: "0" } as Record<string, string>;
  const allow = (opts.transports ?? []).flatMap((t) => ["-c", `protocol.${t}.allow=always`]);
  const pre = ["-c", "protocol.allow=never", ...allow, ...(opts.credential ? [] : ["-c", "credential.helper="])];
  const p = Bun.spawn(["git", ...pre, ...args], { cwd, env, stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(300_000) });
  const [stdout, stderr, exit_code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, exit_code };
}

export type Trusted = {
  repo: string; origin: string; head: string; tree: string;
  out: (args: string[]) => Promise<string | null>;
  step: (args: string[], what: string, opts?: { credential?: boolean; transports?: string[] }) => Promise<Run | { error: string }>;
};

/**
 * The clone's commits since its base, in a fresh bare repository this vessel owns under `work`, beside origin's branch
 * fetched afresh: refs/remotes/origin/<branch> and refs/land/head. The commits leave the clone only as a bundle the
 * shell user writes (data, no config), so nothing of the clone's config, refs or index is read here.
 */
export async function intoTrusted(cwd: string, made: Made, work: string, transports: string[]): Promise<Trusted | { error: string; stderr?: string }> {
  const drop = agentWritableDir(join(work, "drop"));
  const bundle = join(drop, "change.bundle");
  const b = await git(["bundle", "create", bundle, `${made.base}..HEAD`], cwd);
  if (b.exit_code !== 0) return { error: "the clone's commits could not be bundled", stderr: b.stderr.slice(-500) };
  const repo = join(work, "repo.git");
  const step = async (args: string[], what: string, opts: { credential?: boolean; transports?: string[] } = {}): Promise<Run | { error: string }> => {
    const r = await trusted(args, repo, work, opts);
    return r.exit_code === 0 ? r : { error: `${what} failed`, stderr: r.stderr.slice(-500) } as { error: string };
  };
  const init = await trusted(["init", "--quiet", "--bare", repo], work, work);
  if (init.exit_code !== 0) return { error: "a repository to check the change in could not be made" };
  const origin = `refs/remotes/origin/${made.branch}`;
  for (const [args, what, opts] of [
    [["fetch", "--quiet", made.origin_url, `refs/heads/${made.branch}:${origin}`], `fetching ${made.branch} from origin`, { transports }],
    [["bundle", "verify", bundle], "verifying the bundle", { transports: ["file"] }],
    [["fetch", "--quiet", bundle, "HEAD:refs/land/head"], "reading the bundle", { transports: ["file"] }],
  ] as Array<[string[], string, { transports: string[] }]>) {
    const r = await step(args, what, opts);
    if ("error" in r) return r;
  }
  const out = async (args: string[]) => { const r = await trusted(args, repo, work); return r.exit_code === 0 ? r.stdout.trim() : null; };
  const head = await out(["rev-parse", "refs/land/head"]);
  const tree = await out(["rev-parse", "refs/land/head^{tree}"]);
  if (!head || !tree) return { error: "the bundle carried no commit" };
  return { repo, origin, head, tree, out, step };
}

export type LandResult =
  | { shape: "gitLand"; cwd: string; repo: string; branch: string; head: string; tree: string; changed: string[];
      needs_person: string[]; verdict_ref: string; scan: { ran: true; rules: string[] }; pushed: true }
  | { error: string; stderr?: string; rules?: string[]; tree?: string; head?: string; needs_person?: string[] };

export async function landClone(cwd: string, deps: Partial<Deps> = {}): Promise<LandResult> {
  const d = { ...DEFAULTS, ...deps };
  const made = await d.find(cwd);
  if ("error" in made) return made;
  const gitleaks = Bun.which("gitleaks", { PATH: process.env.PATH ?? "" });
  if (!gitleaks) return { error: "no secrets scanner (gitleaks) on this node: nothing would stop a leak, so nothing lands" };
  const superDir = containmentZones(process.env).supers[0];
  if (!superDir) return { error: "this node has no super-repo clone: the scan's config cannot be read" };

  const work = mkdtempSync(join(tmpdir(), "land-"));
  try {
    const t = await intoTrusted(cwd, made, work, d.transports);
    if ("error" in t) return t;
    const { repo, origin, head, tree, out } = t;
    if ((await trusted(["merge-base", "--is-ancestor", origin, "refs/land/head"], repo, work)).exit_code !== 0) {
      return { error: `the change does not fast-forward origin's ${made.branch}: it moved since the clone was made` };
    }
    const range = `${origin}..refs/land/head`;
    if (((await out(["rev-list", "--merges", range])) ?? "x") !== "") return { error: "the change holds a merge commit; only a straight line of commits lands" };
    const changed = ((await out(["diff", "--name-only", "--no-renames", origin, "refs/land/head"])) ?? "").split("\n").filter(Boolean);
    if (changed.length === 0) return { error: "nothing to land: the change does not differ from origin" };
    const judges = await judgesOf(repo, { base: origin, repo: made.repo });
    const needs_person = changed.filter((p) => judges.some((g) => new Bun.Glob(g).match(p)));

    // The scan, with the super base's config, over exactly the commits that would be pushed.
    const cfg = await git(["show", `${made.super_base}:scripts/git-hooks/.gitleaks.toml`], superDir);
    if (cfg.exit_code !== 0) return { error: "the super base has no scan config" };
    writeFileSync(join(work, "gitleaks.toml"), cfg.stdout);
    const report = join(work, "leaks.json");
    const scan = Bun.spawn([gitleaks, "detect", "--source", repo, "--log-opts", range, "--config", join(work, "gitleaks.toml"),
      "--redact", "--no-banner", "--exit-code", "3", "--report-format", "json", "--report-path", report, "--ignore-gitleaks-allow"],
    { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: work }, stdout: "ignore", stderr: "ignore", signal: AbortSignal.timeout(300_000) });
    const sc = await scan.exited;
    if (sc === 3) {
      let rules: string[] = [];
      try { rules = [...new Set((JSON.parse(readFileSync(report, "utf8")) as Array<{ RuleID?: string }>).map((f) => String(f.RuleID)))]; } catch { /* unreadable */ }
      return { error: "the secrets scan found something in the change", rules };
    }
    if (sc !== 0) return { error: `the secrets scan did not run cleanly (exit ${sc})` };

    const verdict = await approved(d, made, tree, needs_person);
    if ("error" in verdict) return { ...verdict, tree, needs_person };

    // No hooks run beside the credential: an empty directory this vessel owns.
    const hooksDir = mkdtempSync(join(work, "hooks-"));
    chmodSync(hooksDir, 0o555);
    const push = await t.step(["-c", `core.hooksPath=${hooksDir}`, "push", "--quiet", made.origin_url, `refs/land/head:refs/heads/${made.branch}`],
      "the push", { credential: true, transports: d.transports });
    if ("error" in push) return { ...push, tree, head };
    return { shape: "gitLand", cwd, repo: made.repo, branch: made.branch, head, tree, changed, needs_person, verdict_ref: verdict.id,
      scan: { ran: true, rules: [] }, pushed: true };
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch { /* a temp dir */ }
  }
}

/** The verdict row that lets this tree land, or why none does. */
async function approved(d: Deps, made: Made, tree: string, needsPerson: string[]): Promise<{ id: string } | { error: string }> {
  const verdicts = await d.rows({ shape: "land_verdict", where: { tree } });
  if (!Array.isArray(verdicts)) return verdicts;
  const mine = verdicts.filter((v) => v.repo === made.repo);
  const person = mine.find((v) => v.role === "person" && Number(v.r) === 1);
  if (person) return { id: person.id };
  if (mine.some((v) => v.role === "described" && Number(v.r) === 0)) return { error: "a grader judged this tree r 0, and no person has approved it" };
  if (needsPerson.length > 0) return { error: `the change touches what judges changes (${needsPerson.join(", ")}): only a person's verdict lands it` };
  // A grader's r 1 counts only when it was made from exactly two rows: the request and the walk's record of this tree's
  // diff. Anything more and what it judged is not only the change; anything less and it did not see the change.
  const diffs = await d.rows({ shape: "gitDiff", where: { tree } });
  if (!Array.isArray(diffs)) return diffs;
  for (const v of mine.filter((x) => x.role === "described" && Number(x.r) === 1)) {
    const refs = [...new Set([v.input_refs].flat().map(String))];
    if (refs.length !== 2) continue;
    const diff = diffs.find((x) => x.role === "walk" && x.repo === made.repo && refs.includes(x.id));
    if (!diff) continue;
    const asked = await d.rows({ ids: refs.filter((id) => id !== diff.id) });
    if (!Array.isArray(asked)) return asked;
    if (asked.length === 1 && (asked[0].role === "person" || asked[0].role === "owner")) return { id: v.id };
  }
  return { error: "no verdict approves this tree: a person's r 1, or a grader's r 1 from exactly the request and this tree's gitDiff" };
}

// What a grader reads to judge a change: the diff that would land, with the tree it lands as. A diff bigger than this
// is cut and says so, so a grader never judges a part it was not shown as if it were the whole.
const DIFF_MAX = 64 * 1024;

export type DiffResult =
  | { shape: "gitDiff"; cwd: string; repo: string; base: string; head: string; tree: string; diff: string; truncated: boolean }
  | { error: string; stderr?: string };

/** The committed change of a clone git_worktree made, against origin's branch, computed where the clone cannot reach. */
export async function diffClone(cwd: string, made: Made, transports: string[] = DEFAULTS.transports): Promise<DiffResult> {
  const work = mkdtempSync(join(tmpdir(), "diff-"));
  try {
    const t = await intoTrusted(cwd, made, work, transports);
    if ("error" in t) return t;
    const base = await t.out(["rev-parse", t.origin]);
    const diff = await t.out(["diff", "--no-renames", t.origin, "refs/land/head"]);
    if (base === null || diff === null) return { error: "the change's diff could not be read" };
    return { shape: "gitDiff", cwd, repo: made.repo, base, head: t.head, tree: t.tree, diff: diff.slice(0, DIFF_MAX), truncated: diff.length > DIFF_MAX };
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch { /* a temp dir */ }
  }
}
