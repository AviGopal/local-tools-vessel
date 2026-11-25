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
//   - onto the super-repo, the change may not widen the node gate's authority, as origin's own widening rule says it;
//   - a verdict row must approve this tree: a person's r 1 (records stamps person rows from the person's own key), or,
//     when no path needs a person, a grader's r 1 made from exactly the request and the walk's gitDiff row of this tree.
//     Any grader's r 0 on the tree blocks it unless a person approves.
// Only then is the change pushed: from that repository, no force, with no hooks, and the only command here that
// carries the push credential (the node's system credential helper reads it from this vessel's env).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentProtectedList, git, protectedHits, protectedListAt, vesselGit } from "./git-commit.js";
import { AGENT_SHELL_UID, agentShellSpawn, agentWritableDir, runningAsRoot } from "./shell-privilege.js";
import { runBounded } from "./bounded-run.js";
import { baseHeld, baseRun, installIdentity } from "./base-cache.js";
import { addedErrors } from "./typecheck-base.js";
import { type Made, madeClone, type Query, readRows, type Row } from "./walk-rows.js";
import { containmentZones } from "./write-containment.js";
import { suiteBoundOf } from "./suite-bound.js";

type Run = { stdout: string; stderr: string; exit_code: number };
export type Deps = {
  find: (cwd: string) => Promise<Made | { error: string }>;
  rows: (q: Query) => Promise<Row[] | { error: string }>;
  /** Transports origin may be fetched over; https only, except in a test with a local origin. */
  transports: string[];
};
const DEFAULTS: Deps = { find: madeClone, rows: readRows, transports: ["https"] };

// How long one step here (a git command, the secrets scan, the typecheck) may take before it is stopped and counted as
// not passed.
const STEP_MS = 300_000;

/** git as this vessel, in a repository it owns, with a HOME of its own (no user config) and, unless asked, no credential. */
async function trusted(args: string[], cwd: string, home: string, opts: { credential?: boolean; transports?: string[] } = {}): Promise<Run> {
  const base = opts.credential ? process.env : { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  const env = { ...base, HOME: home, GIT_TERMINAL_PROMPT: "0" } as Record<string, string>;
  const allow = (opts.transports ?? []).flatMap((t) => ["-c", `protocol.${t}.allow=always`]);
  const pre = ["-c", "protocol.allow=never", ...allow, ...(opts.credential ? [] : ["-c", "credential.helper="])];
  const { stdout, stderr, exit_code } = await runBounded(["git", ...pre, ...args], { cwd, env, stepMs: STEP_MS });
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
  // The shell user must reach the directory handed to it, so `work` can be passed through (not listed or written).
  chmodSync(work, 0o711);
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
      verdict_ref: string; verdict_by: string; scan: { ran: true; rules: string[] }; pushed: true }
  | { error: string; stderr?: string; rules?: string[]; widening?: string[]; tree?: string; head?: string; out_of_reach?: string[]; unserved?: string;
      clone?: { shape: "gitWorktree"; cwd: string; repo: string; branch: string; base: string; head: string; tree: string } };

/**
 * Where the USER's protected list is read for a change: never from the change's own tree. A super-repo change is
 * judged by origin's copy (the fetched base it would move: the change may edit the list itself); a vessel's, by the
 * current list (currentProtectedList), never the super base its clone was made from (a vessel's tree holds no list).
 */
export function listSourceFor(made: Pick<Made, "repo">, origin: string): { in: "trusted"; ref: string; where: string } | { in: "current" } {
  return made.repo === "super" ? { in: "trusted", ref: origin, where: "origin" } : { in: "current" };
}

export async function landClone(cwd: string, deps: Partial<Deps> = {}): Promise<LandResult> {
  const d = { ...DEFAULTS, ...deps };
  const made = await d.find(cwd);
  if ("error" in made) return made;
  // THE BRANCH A REPOSITORY TAKES LANDINGS ON is the owner's to name (the USER: "dev only"): the newest owner repository
  // row for the clone's repo, not retired, names it. With none, nothing lands, and the refusal is the owner's gap (unserved:
  // no debit to the request); a clone made on another branch is refused, naming both. No branch is named here.
  const repos = await d.rows({ shape: "repository", where: { repo: made.repo } });
  if (!Array.isArray(repos)) return repos;
  const owned = repos.filter((r) => r.role === "owner").sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0)).at(-1);
  const branch = owned !== undefined && owned.retired !== true && typeof owned.branch === "string" && owned.branch !== "" ? owned.branch : undefined;
  if (branch === undefined) return { error: `no repository row names a working branch for ${made.repo}: nothing lands`, unserved: "repository" };
  if (made.branch !== branch) return { error: `the clone is on ${made.branch}; ${made.repo} takes landings on ${branch} only` };
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
    // The USER's protected list: for a super-repo change, origin's (the fetched base this change would move, never the
    // change's own tree); for a vessel's, the current one. A path it names is out of the walk's reach: refused whatever
    // any verdict says (git_commit's answer is advisory, so it is judged again here).
    const src = listSourceFor(made, origin);
    const list = src.in === "trusted" ? await protectedListAt((path) => out(["show", `${src.ref}:${path}`]), src.where) : await currentProtectedList(superDir);
    if ("error" in list) return { error: list.error, tree, ...("unserved" in list && typeof list.unserved === "string" ? { unserved: list.unserved } : {}) };
    const out_of_reach = protectedHits(changed, made.repo, list.excluded);
    if (out_of_reach.length > 0) return { error: `the change touches paths outside the walk's reach (${out_of_reach.join(", ")}): nothing lands it`, out_of_reach, tree };

    // The scan, with the super base's config, over exactly the commits that would be pushed.
    const cfg = await vesselGit(["show", `${made.super_base}:scripts/git-hooks/.gitleaks.toml`], superDir);
    if (cfg.exit_code !== 0) return { error: "the super base has no scan config" };
    writeFileSync(join(work, "gitleaks.toml"), cfg.stdout);
    const report = join(work, "leaks.json");
    const scan = Bun.spawn([gitleaks, "detect", "--source", repo, "--log-opts", range, "--config", join(work, "gitleaks.toml"),
      "--redact", "--no-banner", "--exit-code", "3", "--report-format", "json", "--report-path", report, "--ignore-gitleaks-allow"],
    { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: work }, stdout: "ignore", stderr: "ignore", signal: AbortSignal.timeout(STEP_MS) });
    const sc = await scan.exited;
    if (sc === 3) {
      let rules: string[] = [];
      try { rules = [...new Set((JSON.parse(readFileSync(report, "utf8")) as Array<{ RuleID?: string }>).map((f) => String(f.RuleID)))]; } catch { /* unreadable */ }
      return { error: "the secrets scan found something in the change", rules };
    }
    if (sc !== 0) return { error: `the secrets scan did not run cleanly (exit ${sc})` };
    if (made.repo === "super") {
      const widened = await widening(t, work);
      if (widened !== undefined) return { ...widened, tree };
    }

    const verdict = await approved(d, made, tree);
    // refused: where the clone is now, as a row the walk records (its newest tree, read by no words), so the next move is a
    // diff of this tree rather than the land asked again
    if ("error" in verdict) return { ...verdict, tree,
      clone: { shape: "gitWorktree", cwd, repo: made.repo, branch: made.branch, base: made.base, head, tree } };

    // No hooks run beside the credential: an empty directory this vessel owns.
    const hooksDir = mkdtempSync(join(work, "hooks-"));
    chmodSync(hooksDir, 0o555);
    const push = await t.step(["-c", `core.hooksPath=${hooksDir}`, "push", "--quiet", made.origin_url, `refs/land/head:refs/heads/${made.branch}`],
      "the push", { credential: true, transports: d.transports });
    if ("error" in push) return { ...push, tree, head };
    return { shape: "gitLand", cwd, repo: made.repo, branch: made.branch, head, tree, changed, verdict_ref: verdict.id, verdict_by: verdict.by,
      scan: { ran: true, rules: [] }, pushed: true };
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch { /* a temp dir */ }
  }
}

// THE GATE'S AUTHORITY MAY ONLY NARROW ON A LANDING. A super-repo change that edits an accepted gate fixture, drops a
// gate path, or loosens the gate policy is refused here, before the push, whatever any verdict says: a person's approval
// of a change to what judges changes is not approval to widen what the gate accepts, and the node gate refuses such a
// change only at install, after it is already on a public branch. What counts as a widening is stated once, in the
// super-repo's widening.sh; the copy that judges is origin's (the branch the change would move), run with origin's gate
// policy, never the change's own, so a change cannot rewrite the rule it is judged by. Its answer is read by exit
// status: 1 is a widening (each line names one), 0 none, and anything else, or no rule at origin, refuses: what cannot
// be judged does not land.
const WIDENING_RULE = "scripts/substrate/gate/widening.sh";
const GATE_POLICY = "scripts/substrate/gate/gate-policy.json";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
async function widening(t: Trusted, work: string): Promise<{ error: string; widening?: string[] } | undefined> {
  const rule = await t.out(["show", `${t.origin}:${WIDENING_RULE}`]);
  const policy = await t.out(["show", `${t.origin}:${GATE_POLICY}`]);
  if (rule === null || policy === null) {
    return { error: `origin's super-repo has no ${rule === null ? WIDENING_RULE : GATE_POLICY}: nothing would tell a widening of the gate, so nothing lands` };
  }
  const dir = mkdtempSync(join(work, "widening-"));
  writeFileSync(join(dir, "widening.sh"), `${rule}\n`);
  writeFileSync(join(dir, "gate-policy.json"), `${policy}\n`);
  // Every git the rule runs is as isolated as the land's own steps: no system config (twice over: none read, and the one
  // named is empty) and no user config (HOME is this land's fresh directory), no credential, no transport, no hooks, no
  // fsmonitor, and no attributes (a diff driver or textconv the change names never runs).
  const hooks = mkdtempSync(join(work, "widening-hooks-"));
  chmodSync(hooks, 0o555);
  const config: Array<[string, string]> = [["protocol.allow", "never"], ["credential.helper", ""], ["core.hooksPath", hooks],
    ["core.fsmonitor", "false"], ["core.attributesFile", "/dev/null"], ["attr.tree", EMPTY_TREE]];
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: work, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_COUNT: String(config.length) };
  config.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
  const r = await runBounded(["bash", join(dir, "widening.sh"), "--policy", join(dir, "gate-policy.json"), "--super", t.repo, "--base", t.origin, "--head", "refs/land/head"],
    { cwd: dir, env, stepMs: STEP_MS });
  if (r.exit_code === 0) return undefined;
  const said = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 20);
  if (r.exit_code === 1) return { error: `authority_widening: ${said.join("; ")}`, widening: said };
  return { error: `the gate-widening rule could not judge the change (exit ${r.exit_code}${said.length > 0 ? `: ${said.join("; ")}` : ""}): nothing lands` };
}

// A request is what a person, the owner or an operator asked (the roles records reads asks from): an exogenous row that is
// not a grade and not the owner's configuration.
// Or a gap a detector opened: records refuses a gap row under any key but the node's own, so a gap is the node's own
// observation, trusted as the owner is; a change made for one lands on a grader's verdict only when the gap's own check
// passes on its tree (approved, below). Named debt: these shape and role names are literals here, not read from the
// owner's rows.
const OWNER_CONFIG = new Set(["channel", "shape_schema", "arm", "prior"]);
const isGap = (r: Row): boolean => r.role === "detector" && r.shape === "gap";
const isRequest = (r: Row): boolean =>
  ((r.role === "person" || r.role === "owner" || r.role === "operator") && r.shape !== "outcome" && !OWNER_CONFIG.has(String(r.shape))) || isGap(r);

/** The verdict row that lets this tree land, or why none does. */
// The verdict's writer (records stamps it: a person row's writer is its key id) goes into the answer, so a count of
// autonomous landings can tell a person's approval from an operator agent's key: any key that is not the node's counts as
// a person here.
async function approved(d: Deps, made: Made, tree: string): Promise<{ id: string; by: string } | { error: string }> {
  const verdicts = await d.rows({ shape: "land_verdict", where: { tree } });
  if (!Array.isArray(verdicts)) return verdicts;
  const mine = verdicts.filter((v) => v.repo === made.repo);
  const diffs = await d.rows({ shape: "gitDiff", where: { tree } });
  if (!Array.isArray(diffs)) return diffs;
  // A person's verdict on this exact tree: a person's Wrong blocks it, and only a later Right by a person lifts it (a
  // grader's r 1 never overrides a person).
  // When the code changes (a new tree, a rebase among them) the new version needs its own verdict, and nothing carries
  // over or blocks. A Wrong counts whatever diff it cites, cut or not (a big change the person rejected is not landed
  // because its diff was too big to show whole). A Right counts only on the walk's whole diff of this tree: a build
  // choice, not ruled, so that a Right is approval of what the person saw. The latest counting person mark decides: r 0
  // refuses the tree, r 1 lands it.
  const shown = (v: Row): boolean => diffs.some((x) => x.role === "walk" && x.repo === made.repo && x.truncated !== true
    && [v.input_refs].flat().map(String).includes(x.id));
  const counts = mine.filter((v) => v.role === "person" && String(v.tree) === tree && (Number(v.r) === 0 || (Number(v.r) === 1 && shown(v))));
  const latest = counts.map((v, i) => ({ v, i })).sort((a, b) => (Number(a.v.seq ?? 0) - Number(b.v.seq ?? 0)) || a.i - b.i).at(-1)?.v;
  if (latest !== undefined && Number(latest.r) === 0) return { error: "a person judged this tree r 0: it does not land unless a person marks it right again; a changed version needs its own verdict" };
  const person = latest !== undefined && Number(latest.r) === 1 ? latest : undefined;
  if (person) return { id: person.id, by: String(person.writer ?? "") };
  // No change waits on a person: a grader's r 0 stands until a later grader's r 1 that meets every rule below.
  const graderNo = Math.max(-1, ...mine.filter((v) => v.role === "described" && Number(v.r) === 0).map((v) => Number(v.seq ?? 0)))
  // A grader's r 1 counts only when it was made from exactly two rows: the request, and the walk's record of this tree's
  // diff made for that request (its input_refs hold the request). Anything more and what it judged is not only the
  // change; anything less and it did not see the change; a diff made for another request is not this request's change.
  let suiteWhy: string | undefined;
  for (const v of mine.filter((x) => x.role === "described" && Number(x.r) === 1 && Number(x.seq ?? 0) > graderNo)) {
    const refs = [...new Set([v.input_refs].flat().map(String))];
    if (refs.length !== 2) continue;
    const diff = diffs.find((x) => x.role === "walk" && x.repo === made.repo && refs.includes(x.id));
    if (!diff) continue;
    // What the grader saw must say the tree typechecks (git_diff's own check of it): a grader told a tree does not
    // compile may still answer r 1, and a diff made before the check existed says nothing.
    if ((diff.typecheck as { passed?: unknown } | undefined)?.passed !== true) continue;
    const asked = await d.rows({ ids: refs.filter((id) => id !== diff.id) });
    if (!Array.isArray(asked)) return asked;
    const request = asked.length === 1 ? asked[0] : undefined;
    if (!request || !isRequest(request)) continue;
    if (![diff.input_refs].flat().map(String).includes(request.id)) continue;
    // Nor when a test of the repository's whole suite that passed on the base fails on this tree: a change that makes
    // its own request's test pass can turn another red, and a grader reading the diff need not see it.
    const suite = diff.suite as { passed?: unknown; regressed?: unknown; why?: unknown } | undefined;
    if (suite?.passed !== true) { suiteWhy = suiteRefusal(suite); continue; }
    // A gap's change lands on a grader's verdict only when the gap's own check passed on this tree, for this gap.
    const check = diff.check as { passed?: unknown; gap_id?: unknown } | undefined;
    if (isGap(request) && (check?.passed !== true || String(check.gap_id) !== String(request.gap_id))) continue;
    return { id: v.id, by: String(v.writer ?? "") };
  }
  if (suiteWhy !== undefined) return { error: `a grader's r 1 does not land this tree: ${suiteWhy}` };
  if (graderNo >= 0) return { error: "a grader judged this tree r 0, and no later grader's r 1 lands it" };
  return { error: "no verdict approves this tree: a person's r 1 on the walk's whole diff of it, or a grader's r 1 from exactly the request and this tree's gitDiff, which says the tree typechecks, that no test of the whole suite that passed on the base fails on it (and, for a gap, that its check passes)" };
}

// Why a diff's suite does not let a grader's r 1 land it, naming the tests it turned red (the drafter's next attempt is
// shown this refusal), or what kept the suite from saying.
const suiteRefusal = (suite: { passed?: unknown; regressed?: unknown; why?: unknown } | undefined): string => {
  const red = Array.isArray(suite?.regressed) ? suite.regressed.map(String) : [];
  if (red.length > 0) return `tests that passed on the base fail on it: ${red.slice(0, 20).join("; ")}${red.length > 20 ? `; and ${red.length - 20} more` : ""}`;
  if (typeof suite?.why === "string") return `the whole test suite did not say it passes: ${suite.why}`;
  return suite === undefined ? "its gitDiff says nothing of the whole test suite" : "the whole test suite did not pass on it";
};

// What a grader reads to judge a change: the diff that would land, with the tree it lands as. A diff bigger than this
// is cut and says so, so a grader never judges a part it was not shown as if it were the whole.
const DIFF_MAX = 64 * 1024;

// What the typecheck said, cut like the diff: a grader reads errors, not a whole log.
const CHECK_OUT_MAX = 4 * 1024;
// A test run's output, kept within max: whole when it fits; otherwise the first failing test's block whole (its error,
// the assertion and what was received, which the runner prints just before its "(fail)" line; a block longer than max
// keeps its end), then as much of the end (the summary) as the rest of max holds. A plain tail cut lost the assertion whenever later output passed max (5 of 7
// diffs on one gap); the one who fixes it reads this. With no failing test, the end, as before.
export const keptCheckOut = (out: string, max: number): string => {
  if (out.length <= max) return out;
  const lines = out.split("\n");
  const failed = lines.findIndex((l) => l.startsWith("(fail) "));
  if (failed < 0) return out.slice(-max);
  let from = failed;
  while (from > 0 && !/^\((pass|fail|skip|todo)\) /.test(lines[from - 1])) from--;
  const block = lines.slice(from, failed + 1).join("\n");
  if (block.length >= max) return block.slice(-max); // its end says how it failed: the assertion and the "(fail)" line
  const gap = "\n…\n";
  const rest = max - block.length - gap.length;
  return rest > 0 ? block + gap + out.slice(-rest) : block;
};

// A whole-suite run whose tests regressed, kept within max: each regressed test's own assertion, read from the tree's
// report under the very name regressed gives (the run's output prints no file with a failing test, so two files' tests
// of one name read alike there), in order, as many as fit, none taking more than half; then the run's output kept as
// above in the room left, so its summary still shows. Quoting only the first failing test showed one assertion of many,
// the same on every attempt, and the one who fixes it fixed that one alone.
export const regressedOut = (regressed: string[], failed: Map<string, string>, out: string, max: number): string => {
  // none of them in the report (it did not parse, or names them otherwise): the run's output, kept as it always was
  if (!regressed.some((n) => failed.has(n))) return keptCheckOut(out, max);
  const parts: string[] = [];
  let used = 0;
  for (const name of regressed) {
    const said = failed.get(name);
    const entry = `(fail) ${name}\n${said === undefined ? "(no failure under this name in the tree's report: skipped there, or not run)" : said.trim().slice(0, Math.floor(max / 2))}`;
    if (used + entry.length + 2 > max) break;
    parts.push(entry);
    used += entry.length + 2;
  }
  const more = regressed.length - parts.length;
  const head = parts.join("\n\n") + (more > 0 ? `\n\n…and ${more} more regressed, named in regressed` : "");
  const gap = "\n…\n";
  const rest = max - head.length - gap.length;
  return (rest > 0 ? head + gap + keptCheckOut(out, rest) : head).slice(0, max);
};

/** Whether the tree typechecks: ran and passed, ran and did not (or ran out of time), or did not run, and why. passed is
 * what git_land reads: true only when the compiler passed, or when the base has no TypeScript config to check by.
 * checked false: no project could be compiled on this node at all, so nothing was compiled and nothing is said of the
 * change (ran false, no passed: a check that did not run is not one that failed), with each project's why. */
export type Typecheck =
  | { ran: true; passed: boolean; exit_code: number; out: string; truncated: boolean; projects?: ProjectRun[]; uncovered?: string[] } & ErrorCounts
  | { ran: false; passed: boolean; why: string }
  | { ran: false; checked: false; why: string; projects: ProjectRun[]; uncovered?: string[] };
/** One TypeScript project the check ran: its directory in the tree ("." for the root); whether the change passed it
 * (it adds no error the base did not already have); and the base's own errors there, which are the base's, not the
 * change's. checked false: the project cannot be compiled on this node at all (the base does not compile either), so
 * nothing is said of the change there. */
/** Over the projects checked: the errors the base already had (the base's, not the change's) and those the change
 * added, so a reader tells a change that broke a clean base from one that inherited a broken one. */
export type ErrorCounts = { base_error_count: number; added_error_count: number };
export type ProjectRun = { dir: string; passed: boolean; exit_code: number; checked?: false; why?: string; base_errors?: number };

// A source a TypeScript project compiles.
const TS_SOURCE = /\.(ts|tsx|mts|cts)$/;

// What the typecheck reads besides the source: a change to any of these would choose how it is checked, so a tree that
// changes one is not checked under it, and does not pass.
const CHECK_CONFIG = /(^|\/)(tsconfig[^/]*\.json|jsconfig[^/]*\.json|package\.json|bunfig\.toml|bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;
// What tells the compiler not to check: a directive on a line the change adds, or a declaration file it adds (an
// ambient module declares anything into existence). Such a change passes only by silencing the check, so it does not pass.
const SUPPRESS = /@ts-(nocheck|ignore|expect-error)\b/;
const DECLARATIONS = /\.d\.[cm]?ts$/;

/** The files where a change silences the check: lines it adds with a suppression directive, and declaration files it adds. */
function silenced(patch: string, added: string[]): string[] {
  const out = new Set(added.filter((p) => DECLARATIONS.test(p)));
  let file = "";
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) file = line.slice(4).replace(/^b\//, "");
    else if (line.startsWith("+") && SUPPRESS.test(line)) out.add(file);
  }
  return [...out].sort();
}

/** The gap a clone was made to fix: its id and the check that says it is fixed (the detector's own). With no test_file
 * the check is the repository's whole suite (a gap the suite found, its named tests anywhere in it). */
export type GapRef = { gap_id: string; test_file?: string; vessel?: string; only_tests: string[]; lever?: string };

/** Whether that gap's check passes on the tree: the named tests pass when the test file runs alone, as the detector's
 * closer runs it, and no test of the file that passed on the base fails on the tree (regressed names them). passed is
 * what git_land reads; anything that keeps the check from running does not pass. */
export type GapCheck =
  | { gap_id: string; test_file?: string; ran: true; passed: boolean; exit_code: number; out: string; truncated: boolean; regressed: string[] }
  | ({ gap_id?: string; test_file?: string; ran: false; passed: false; why: string; base?: BaseRead } & Partial<Bound>);

/** The base's run as the check read it, kept on a refusal that the gap's tests already pass there: its exit, the tests
 * of its report each named test matched as passed by the rule that refusal decided with (the test file's: its exact name;
 * the suite's: a name without its file can match a test of another file), its output's end, and the user it ran as. The gap's closer reads the same tests as it runs them, as its own user; when the
 * two disagree, the rows show both runs, not a refusal's words alone. */
export type BaseRead = { exit_code: number; matched: Record<string, string[]>; out: string; truncated: boolean; uid: number };
const baseRead = (run: { passed: Set<string> | null; failed: Map<string, string>; exit_code: number; out: string }, names: string[],
  hit: (x: string, n: string) => boolean): BaseRead => ({
  exit_code: run.exit_code,
  matched: Object.fromEntries(names.map((n) => [n, [...(run.passed ?? [])].filter((x) => hit(x, n)).sort()])),
  out: keptCheckOut(run.out, CHECK_OUT_MAX), truncated: run.out.length > CHECK_OUT_MAX,
  // the checks run as the agent shell user when this vessel is root (asShellUser), as itself otherwise
  uid: runningAsRoot() ? AGENT_SHELL_UID : process.getuid?.() ?? -1,
});

/** What the repository's whole test suite says of the tree: every test the runner finds, run on the base and then on the
 * tree as the gap's check runs its one file; regressed names each test that passed on the base and does not on the tree
 * (a test red on both is the base's, not the change's). passed is what git_land reads; a run that did not finish, or
 * wrote no report, does not pass. */
export type SuiteCheck =
  | { ran: true; passed: boolean; exit_code: number; out: string; truncated: boolean; regressed: string[] } & SuiteSize
  | ({ ran: false; passed: false; why: string } & Partial<Bound>);
/** A run stopped at the suite's bound, said as fields: which run, and the bound it was stopped at. */
export type Bound = { status: "bound"; run: "base" | "tree"; ms: number };
/** How many tests each run reported, and how long each took (base_cached: the base's run read was one made for an
 * earlier diff of the same base, so base_ms is not its run's; base_rerun: a kept run read a regression, and the base was
 * run again to judge it, replacing the kept run; base_failed_kept: the tests that do not pass on the tree and were read
 * as the base's own from a kept run, not run again, so a kept flaky failure that hides a regression can be read;
 * tree_cached: the tree's run read was one made for an earlier diff of the same tree, so tree_ms is not its run's;
 * tree_rerun: a kept tree run read a regression, and the tree was run again to judge it, replacing the kept run):
 * recorded so the bound, and how often a kept base is wrong either way, can be read. */
export type SuiteSize = { base_count: number; tree_count: number; base_ms: number; tree_ms: number; base_cached: boolean; base_rerun: boolean; base_failed_kept: string[];
  tree_cached: boolean; tree_rerun: boolean };

export type DiffResult =
  | { shape: "gitDiff"; cwd: string; repo: string; base: string; head: string; tree: string; diff: string; truncated: boolean;
      fast_forward: boolean; typecheck: Typecheck; suite: SuiteCheck; check?: GapCheck; uncommitted?: string[]; uncommitted_any?: boolean }
  | { error: string; stderr?: string; uncommitted?: string[]; uncommitted_any?: boolean };

// What a change could write to make a check it fails read as passing: the runner's own result words, an exit before the
// runner reports, where its report goes. A change adding any of these does not pass the gap's check, whatever else it
// does. A pattern, so it raises the cost of forging a result rather than closing it (the tested code runs in the
// runner's process); the grader and the typecheck stand in front of it.
const FORGES = /\((pass|fail)\)|\bprocess\s*\.\s*(exit|reallyExit|abort|kill)\b|\bBun\s*\.\s*exit\b|\/proc\/self|reporter-outfile|junit/;

/** What a junit report says of each test, by its "describe > test" names: the tests that passed (a test case with no
 * failure, error or skip), and each failed one's message, its assertion as the runner wrote it. */
export function reportOf(xml: string, withFile = false): { passed: Set<string>; failed: Map<string, string> } {
  const text = (v: string) => v.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&");
  const passed = new Set<string>();
  const failed = new Map<string, string>();
  const suites: string[] = [];
  let open: string | null = null;
  let bad = false;
  let why: string | null = null;
  for (const m of xml.matchAll(/<(\/?)(testsuite|testcase|failure|error|skipped)\b([^>]*?)(\/?)>/g)) {
    const [, close, tag, attrs, self] = m;
    const name = text(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? "");
    if (tag === "testsuite") {
      if (close) suites.pop();
      else if (!self) suites.push(name);
    } else if (tag === "testcase") {
      if (close) {
        if (open !== null && !bad) passed.add(open);
        else if (open !== null && why !== null) failed.set(open, why);
        open = null;
        continue;
      }
      // the outermost suite is the file: the name starts at the first describe, or at the file when several are run
      const full = [...suites.slice(withFile ? 0 : 1), name].join(" > ");
      if (self) passed.add(full);
      else { open = full; bad = false; why = null; }
    } else if (!close) {
      bad = true;
      if (tag !== "skipped" && why === null) why = text(/\bmessage="([^"]*)"/.exec(attrs)?.[1] ?? "");
    }
  }
  return { passed, failed };
}

/** The tests a junit report says passed, by their "describe > test" names: a test case with no failure, error or skip. */
export const passedIn = (xml: string, withFile = false): Set<string> => reportOf(xml, withFile).passed;

// What a test leans on besides the source it tests: a change to any of these could make the check pass without fixing
// anything, so a tree that changes one does not pass the gap's check.
const TEST_SUPPORT = /(^|\/)(tests?|__tests__|fixtures?|__fixtures__|__mocks__)\/|\.(test|spec)\.[^/]+$/;

/**
 * Whether a path (relative to the repository) is part of a gap's check: its test file, what tests lean on
 * (TEST_SUPPORT) or what chooses how code is checked (CHECK_CONFIG). The one rule for it: git_diff's gap check refuses
 * a change that touches one, and fs_edit refuses the edit itself on a clone made for that gap.
 */
export function isGapCheckFile(path: string, gap: Pick<GapRef, "test_file">): boolean {
  return (gap.test_file !== undefined && path === gap.test_file) || TEST_SUPPORT.test(path) || CHECK_CONFIG.test(path);
}

/**
 * The gap the call was made for, when its selection's root is a detector's gap: read from records by the selection the
 * walk names on every call (its root is the request the clone is for). No selection: not the walk's call, no gap. The gap
 * row says what checks it (meta.evidence_resolve): a test file, or a test_suite of its vessel naming no file, whose check
 * is then the whole suite of that vessel (named as a repository is: any "repos/" prefix removed). A row that cannot be read, or a gap row naming neither, is an error: the check then does not
 * pass.
 */
export async function gapOf(rows: Deps["rows"], selectionRef: string | undefined): Promise<GapRef | null | { error: string }> {
  if (!selectionRef) return null;
  const sel = await rows({ ids: [selectionRef] });
  if (!Array.isArray(sel)) return sel;
  const root = sel[0]?.root;
  if (typeof root !== "string") return { error: "the call's selection names no root" };
  const r = await rows({ ids: [root] });
  if (!Array.isArray(r)) return r;
  const g = r[0];
  if (!g || g.shape !== "gap" || g.role !== "detector") return null;
  const evidence = (g.meta as { evidence_resolve?: { shape?: unknown; input?: Record<string, unknown> } } | undefined)?.evidence_resolve;
  const input = evidence?.input ?? {};
  const suite = evidence?.shape === "test_suite" && typeof input.vessel === "string" && input.vessel !== "" && input.test_file === undefined;
  if (!suite && (typeof input.test_file !== "string" || input.test_file === "")) return { error: `gap ${String(g.gap_id)} names no test file` };
  // Where the fix belongs, as the gap row says it (meta.sources: what the check imports, which the detector writes):
  // named when an edit of the check itself is refused, so the refusal says where to edit instead.
  const sources = ((g.meta ?? {}) as { sources?: unknown }).sources;
  const lever = Array.isArray(sources) && sources.length > 0 ? sources.map(String).join(", ") : undefined;
  return { gap_id: String(g.gap_id), ...(suite ? { vessel: String(input.vessel).replace(/^repos\//, "") } : { test_file: String(input.test_file) }), only_tests: [input.only_tests ?? []].flat().map(String),
    ...(lever ? { lever } : {}) };
}

/**
 * Typechecks exactly the tree the diff names, in the same call, so a pass can never belong to another tree: the walk can
 * edit its clone between calls, never inside this one. The check is the base's, never the change's: the tree is
 * compiled under origin's tsconfig.json (none there, nothing to check), and a change to anything that chooses how it is
 * checked (CHECK_CONFIG) does not pass, since otherwise a change could pass by deleting or loosening its own check.
 * Nothing of the clone runs: the tree is written out of the trusted repository by this vessel into a directory of its
 * own, its node_modules (if the change carried one) is replaced by the repository's installed one on this node, and the
 * TypeScript compiler is that install's, run by this vessel's bun. Only the compiler runs as the shell user, with
 * nothing in its env but PATH, so a config that names a file only root may read cannot show it in the row.
 */
async function typecheckTree(t: Trusted, made: Made, dir: string | { why: string }, baseOut: () => Promise<string | { why: string }>): Promise<Typecheck> {
  const changed = await t.out(["diff", "--no-renames", "--name-only", t.origin, "refs/land/head"]);
  if (changed === null) return { ran: false, passed: false, why: "the change's paths could not be read" };
  const chosen = changed.split("\n").filter((p) => CHECK_CONFIG.test(p));
  if (chosen.length > 0) return { ran: false, passed: false, why: `the change edits what chooses how it is checked: ${chosen.join(", ")}` };
  const ts = changed.split("\n").filter((p) => TS_SOURCE.test(p));
  // which project each changed file belongs to: a file of a project that could not be checked is that project's, never
  // "covered by no project"
  const ownerOf = new Map<string, string>();
  const projects = await projectsOf(t, ts, ownerOf);
  if (projects.size === 0) {
    if (ts.length === 0) return { ran: false, passed: true, why: "the change touches no TypeScript file and the base has no root tsconfig.json: nothing to typecheck" };
    // a file the change deletes has nothing to compile: only a file the tree still holds needs a project
    const held = typeof dir === "string" ? ts.filter((f) => existsSync(join(dir, f))) : ts;
    return held.length === 0
      ? { ran: false, passed: true, why: "the change only deletes TypeScript files no project of the base compiles: nothing to typecheck" }
      : { ran: false, passed: false, why: `no TypeScript project of the base covers ${held.join(", ")}` };
  }
  const installed = join(containmentZones(process.env).runtime, made.repo, "node_modules");
  const tsc = join(installed, "typescript", "bin", "tsc");
  if (!existsSync(tsc)) return { ran: false, passed: false, why: `no TypeScript is installed for ${made.repo} on this node` };
  const patch = await t.out(["diff", "--no-renames", "--no-ext-diff", "-U0", t.origin, "refs/land/head"]);
  const added = await t.out(["diff", "--no-renames", "--name-only", "--diff-filter=A", t.origin, "refs/land/head"]);
  if (patch === null || added === null) return { ran: false, passed: false, why: "the change's lines could not be read" };
  const quiet = silenced(patch, added.split("\n").filter(Boolean));
  if (quiet.length > 0) return { ran: false, passed: false, why: `the change silences the check in ${quiet.join(", ")}` };
  if (typeof dir !== "string") return { ran: false, passed: false, why: dir.why };
  // Each project is compiled twice, under the base's own config there: on the base and on the change, each with the
  // node's installed modules for its directory when there are any (resolution otherwise climbs to the root's), and any
  // node_modules the change carried removed. The change is judged by the errors it ADDS: an error the base already has
  // is the base's (counted on the row, never laid on the change). A project whose own package.json names packages this
  // node has not installed for it, or whose base has an error that belongs to no file (the project as a whole cannot be
  // compiled here: a type root or a dependency missing), is not checked: said so, with why, and not passed.
  // --listFiles says which files the change's compile read, so a changed file no project compiles is named.
  const baseDir = await baseOut();
  const runs: ProjectRun[] = [];
  const covered = new Set<string>();
  const skipped = new Set<string>();
  const said: string[] = [];
  const counts: ErrorCounts = { base_error_count: 0, added_error_count: 0 };
  for (const [d, config] of projects) {
    const name = d === "" ? "." : d.replace(/\/$/, "");
    const own = join(containmentZones(process.env).runtime, made.repo, d, "node_modules");
    if (d !== "" && (await t.out(["show", `${t.origin}:${d}package.json`])) !== null && !existsSync(own)) {
      const why = `${name}'s modules are not installed on this node: its project cannot be compiled here`;
      runs.push({ dir: name, passed: false, exit_code: -1, checked: false, why });
      said.push(`[${name}] not checked: ${why}`);
      skipped.add(d);
      continue;
    }
    if (typeof baseDir !== "string") {
      runs.push({ dir: name, passed: false, exit_code: -1, checked: false, why: baseDir.why });
      said.push(`[${name}] not checked: ${baseDir.why}`);
      skipped.add(d);
      continue;
    }
    // A base whose project read no source of its own (the change adds the project's first file) had nothing to compile:
    // that is not a base that cannot compile, so it is taken as having no errors.
    const compiled = await compileProject(tsc, baseDir, d, config, own);
    const before = compiled.listed.some((f) => !f.split("/").includes("node_modules")) ? compiled : { ...compiled, errors: [], unplaced: [], exit_code: 0 };
    const after = await compileProject(tsc, dir, d, config, own);
    for (const f of after.listed) covered.add(f);
    if (before.unplaced.length > 0) {
      const why = `the base does not compile here either: ${before.unplaced[0]}`;
      runs.push({ dir: name, passed: false, exit_code: after.exit_code, checked: false, why });
      said.push(`[${name}] not checked: ${why}`);
      skipped.add(d);
      continue;
    }
    const added = addedErrors(before.errors, after.errors);
    counts.base_error_count += before.errors.length;
    counts.added_error_count += added.length;
    const passed = added.length === 0 && after.unplaced.length === 0 && (after.exit_code === 0 || before.exit_code !== 0) && !after.signalled;
    runs.push({ dir: name, passed, exit_code: after.exit_code, ...(before.errors.length > 0 ? { base_errors: before.errors.length } : {}) });
    const mine = [...after.unplaced, ...added];
    if (mine.length > 0) said.push(`[${name}]\n${mine.join("\n")}`);
    else if (!passed) said.push(`[${name}] the compiler ended ${after.signalled ? "by a signal" : `with ${after.exit_code}`}`);
  }
  const uncovered = ts.filter((f) => existsSync(join(dir, f)) && !covered.has(f) && !skipped.has(ownerOf.get(f) ?? "\0"));
  const out = [...(uncovered.length > 0 ? [`not compiled by any TypeScript project of the base: ${uncovered.join(", ")}`] : []), ...said].join("\n");
  // Nothing compiled: every project the change touches could not be compiled here. That is a check that did not run, not
  // one that failed (a land grader read d929's passed false as "does not compile", agf_4x6rwwvu871p): ran false, checked
  // false, no passed, and each project's why. git_land still lands only on passed true.
  if (runs.length > 0 && runs.every((x) => x.checked === false)) {
    return { ran: false, checked: false, why: said.join("; "), projects: runs, ...(uncovered.length > 0 ? { uncovered } : {}) };
  }
  const failed = runs.find((x) => !x.passed);
  // the compiler's errors lead its output: keep the start
  return { ran: true, passed: failed === undefined && uncovered.length === 0, exit_code: failed?.exit_code ?? 0,
    out: out.slice(0, CHECK_OUT_MAX), truncated: out.length > CHECK_OUT_MAX, projects: runs, ...counts, ...(uncovered.length > 0 ? { uncovered } : {}) };
}

/** One project of a written-out tree compiled under the base's config: the files it read, its errors that name a file
 * (as the compiler wrote them, line and column included, so a reader can find each one), and those that name none. */
async function compileProject(tsc: string, tree: string, d: string, config: string, own: string): Promise<{ listed: string[]; errors: string[]; unplaced: string[]; exit_code: number; signalled: boolean }> {
  const at = join(tree, d);
  mkdirSync(at, { recursive: true, mode: 0o755 });
  writeFileSync(join(at, "tsconfig.json"), config);
  if (d !== "") {
    rmSync(join(at, "node_modules"), { recursive: true, force: true });
    if (existsSync(own)) symlinkSync(own, join(at, "node_modules"));
  }
  const r = await asShellUser([realpathSync(process.execPath), tsc, "--noEmit", "--listFiles", "-p", at], tree);
  const lines = r.out.split("\n").map((l) => l.trimEnd()).filter((l) => l !== "");
  const listed = lines.filter((l) => l.startsWith("./")).map((l) => l.slice(2));
  // every error the compiler gives counts, an installed package's included: one the base shares cancels in the comparison
  const errs = lines.filter((l) => !l.startsWith("./") && /\berror TS\d+:/.test(l));
  const errors = errs.filter((l) => /^[^\s(]+\(\d+,\d+\): error TS/.test(l));
  const unplaced = errs.filter((l) => !/^[^\s(]+\(\d+,\d+\): error TS/.test(l));
  return { listed, errors, unplaced, exit_code: r.exit_code, signalled: r.signalled };
}

/** The TypeScript projects that check a change, as each directory ("" for the root, else "a/b/") with the base's config
 * there: for each changed TypeScript file, the nearest directory upward that holds a tsconfig.json in the base. A change
 * with no TypeScript file is checked by the root project, when the base has one, as before. */
async function projectsOf(t: Trusted, files: string[], ownerOf = new Map<string, string>()): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const none = new Set<string>();
  const has = async (d: string): Promise<boolean> => {
    if (found.has(d)) return true;
    if (none.has(d)) return false;
    const c = await t.out(["show", `${t.origin}:${d}tsconfig.json`]);
    if (c === null) none.add(d); else found.set(d, c);
    return c !== null;
  };
  if (files.length === 0) await has("");
  for (const f of files) {
    const parts = f.split("/").slice(0, -1);
    for (let i = parts.length; i >= 0; i--) {
      const d = parts.slice(0, i).map((x) => `${x}/`).join("");
      if (await has(d)) { ownerOf.set(f, d); break; }
    }
  }
  return found;
}

/**
 * A command run in `dir` as the shell user, env PATH only, within the step time; its output, with dir shown as ".".
 * What it runs is the walk's tree (its tests, the code they import), so it can start something that outlives it; it is
 * run bounded as a whole (bounded-run.ts), and killed says the bound ended it.
 */
export async function asShellUser(argv: string[], dir: string, stepMs = STEP_MS): Promise<{ exit_code: number; signalled: boolean; out: string; killed: boolean }> {
  const s = agentShellSpawn(argv, { PATH: process.env.PATH ?? "/usr/bin:/bin" }, tmpdir());
  try {
    const r = await runBounded(s.argv, { cwd: dir, env: s.env, stepMs });
    return { exit_code: r.exit_code, signalled: r.signalled, out: `${r.stdout}${r.stderr}`.split(dir).join("."), killed: r.killed };
  } finally {
    void s.done();
  }
}

/**
 * The tree, written out of the trusted repository by this vessel into a directory of its own that the shell user can
 * read, with the repository's installed node_modules on this node in place of any the change carried: what both checks
 * run on, so nothing of the clone's is run and nothing it installed is resolved.
 */
async function writeOut(t: Trusted, made: Made, work: string, ref = "refs/land/head", name = "check"): Promise<string | { why: string }> {
  const tar = join(work, `${name}.tar`);
  const a = await trusted(["archive", "--format=tar", "-o", tar, ref], t.repo, work);
  if (a.exit_code !== 0) return { why: "the tree could not be written out" };
  const dir = join(work, name);
  mkdirSync(dir, { mode: 0o755 });
  const x = Bun.spawnSync(["tar", "-xf", tar, "-C", dir, "--no-same-owner"], { stdout: "ignore", stderr: "ignore", timeout: STEP_MS });
  if (x.exitCode !== 0) return { why: "the tree could not be written out" };
  rmSync(join(dir, "node_modules"), { recursive: true, force: true });
  symlinkSync(join(containmentZones(process.env).runtime, made.repo, "node_modules"), join(dir, "node_modules"));
  return dir;
}

/** The gap's test file run alone in a written-out tree as the shell user (or, with none, every test the runner finds
 * there, named with their files), judged from the runner's report into a directory made for this run: the tests the
 * report says passed, or null when the run wrote no report. */
async function runCheck(dir: string, testFile: string | null, report_ = "report", stepMs = STEP_MS): Promise<{ passed: Set<string> | null; failed: Map<string, string>; exit_code: number; signalled: boolean; killed: boolean; out: string }> {
  // Judged from the runner's own report, not from its output, which the tested code shares: a run that exits before the
  // runner reports leaves no report, and does not pass.
  const report = join(agentWritableDir(`${dir}-${report_}`), "junit.xml");
  const r = await asShellUser([realpathSync(process.execPath), "test", ...(testFile === null ? [] : [`./${testFile}`]), "--timeout", "20000",
    "--reporter=junit", `--reporter-outfile=${report}`], dir, stepMs);
  const read = existsSync(report) ? reportOf(readFileSync(report, "utf8"), testFile === null) : null;
  return { ...r, passed: read?.passed ?? null, failed: read?.failed ?? new Map() };
}

/**
 * Why the whole suite cannot judge this change, or null: it edits what chooses how the suite runs (CHECK_CONFIG: a
 * bunfig preload, a package's test settings), or its added lines write what the suite's report is read from (FORGES, as
 * the gap's check refuses them). The report is written by the runner in the tested code's own process, so no file
 * permission keeps that code from writing it; the pattern raises the cost of a forged report, and the grader and the
 * typecheck stand in front of it.
 */
export async function suiteRefuses(t: Trusted): Promise<string | null> {
  const changed = await t.out(["diff", "--no-renames", "--name-only", t.origin, "refs/land/head"]);
  if (changed === null) return "the change's paths could not be read";
  const chosen = changed.split("\n").filter((p) => CHECK_CONFIG.test(p));
  if (chosen.length > 0) return `the change edits what chooses how the suite runs: ${chosen.join(", ")}`;
  const patch = await t.out(["diff", "--no-renames", "--no-ext-diff", "-U0", t.origin, "refs/land/head"]);
  if (patch === null) return "the change's lines could not be read";
  const forged = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++") && FORGES.test(l));
  return forged.length > 0 ? `the change writes what the suite's report is read from: ${forged[0].slice(1, 200)}` : null;
}

/**
 * The repository's whole test suite on exactly this tree, against the base, in the same call: every test the runner finds
 * (its own discovery, under the base's config, which a change cannot edit and pass), run on the base first and then on
 * the tree, each within the step bound. A test that passed on the base and does not on the tree is regressed, and any
 * regressed test means it does not pass; a test red on the base is not the change's. A run killed at the bound, or one
 * that wrote no report, does not pass, and says which.
 */
export async function suiteCheck(dir: string | { why: string }, base: string | { why: string }, stepMs = STEP_MS, key?: readonly unknown[],
  treeKey?: readonly unknown[]): Promise<SuiteCheck> {
  return suiteOf(await suiteRuns(dir, base, stepMs, key, treeKey));
}

// The whole suite's two runs, base then tree, as suiteCheck reads them; a suite-form gap's check reads the same runs.
type CheckRun = Awaited<ReturnType<typeof runCheck>>;
type SuiteRuns = { before: Set<string>; base: CheckRun; tree: CheckRun & { passed: Set<string> }; size: SuiteSize } | ({ why: string } & Partial<Bound>);
// With a key (git_diff gives one: the repository, the base's sha, the install, the runner), the base's run is the one
// kept for that key, made once (base-cache.ts); with none, it is run here. A test that passed in a kept run and does not
// pass on the tree is judged on a fresh run of the base, which replaces the kept one: a flaky pass kept would otherwise
// refuse every diff of the base, and so every land that would move it.
// With a tree key (git_diff gives one: the tree's sha in place of the base's), the tree's run is kept the same way, so a
// diff asked again of an unchanged tree runs nothing; a regression read from a kept tree run is judged on a fresh run of
// the tree, as one read against a kept base is, so a flaky failure kept is never what refuses the change.
async function suiteRuns(dir: string | { why: string }, base: string | { why: string }, stepMs = STEP_MS, key?: readonly unknown[],
  treeKey?: readonly unknown[]): Promise<SuiteRuns> {
  if (typeof dir !== "string") return { why: dir.why };
  if (typeof base !== "string") return { why: base.why };
  const timedRun = async (at: string, kept?: readonly unknown[], fresh = false) => {
    const t0 = performance.now();
    const live = () => runCheck(at, null, "suite-report", stepMs);
    const r = kept === undefined ? await live() : await baseRun(kept, live, fresh);
    return { r, ms: Math.round(performance.now() - t0) };
  };
  const stopped = (run: "base" | "tree") => ({ why: `the suite did not finish on the ${run} within the step bound (${stepMs} ms)`, status: "bound" as const, run, ms: stepMs });
  let base_cached = key !== undefined && baseHeld(key);
  let { r: b, ms: base_ms } = await timedRun(base, key);
  if (b.killed) return stopped("base");
  if (b.passed === null) return { why: "the suite's run on the base wrote no report" };
  let tree_cached = treeKey !== undefined && baseHeld(treeKey);
  let { r, ms: tree_ms } = await timedRun(dir, treeKey);
  if (r.killed) return stopped("tree");
  if (r.passed === null) return { why: "the suite's run on the tree wrote no report" };
  const tree_rerun = tree_cached && [...b.passed].some((n) => !r.passed!.has(n));
  if (tree_rerun) {
    ({ r, ms: tree_ms } = await timedRun(dir, treeKey, true));
    tree_cached = false;
    if (r.killed) return stopped("tree");
    if (r.passed === null) return { why: "the suite's run on the tree wrote no report" };
  }
  const treePassed = r.passed;
  const base_rerun = base_cached && [...b.passed].some((n) => !treePassed.has(n));
  if (base_rerun) {
    ({ r: b, ms: base_ms } = await timedRun(base, key, true));
    base_cached = false;
    if (b.killed) return stopped("base");
    if (b.passed === null) return { why: "the suite's run on the base wrote no report" };
  }
  const before = b.passed;
  const base_failed_kept = base_cached ? [...b.failed.keys()].filter((n) => !treePassed.has(n)).sort() : [];
  return { before, base: b, tree: { ...r, passed: treePassed }, size: { base_count: before.size + b.failed.size, tree_count: treePassed.size + r.failed.size, base_ms, tree_ms, base_cached, base_rerun, base_failed_kept, tree_cached, tree_rerun } };
}
// a run stopped at the bound says so as fields, beside its why
const boundOf = (s: Partial<Bound>): Partial<Bound> => s.status === "bound" ? { status: s.status, run: s.run, ms: s.ms } : {};
const suiteOf = (s: SuiteRuns): SuiteCheck => {
  if ("why" in s) return { ran: false, passed: false, why: s.why, ...boundOf(s) };
  const regressed = [...s.before].filter((n) => !s.tree.passed.has(n)).sort();
  return { ran: true, passed: regressed.length === 0, exit_code: s.tree.exit_code, out: regressedOut(regressed, s.tree.failed, s.tree.out, CHECK_OUT_MAX),
    truncated: s.tree.out.length > CHECK_OUT_MAX, regressed, ...s.size };
};

// A gap's named test, in a whole suite's report: there every name starts at its file, and the detector writes it
// without one, so a name is matched whole or as the whole end of a name ("file > describe > test" ends with
// " > describe > test"). Such a name can match tests in more than one file: it is green on a run only when some test it
// matches passed and none it matches failed.
const matches = (x: string, n: string): boolean => x === n || x.endsWith(` > ${n}`);
const greenIn = (run: { passed: Set<string> | null; failed: Map<string, string> }, n: string): boolean =>
  [...(run.passed ?? [])].some((x) => matches(x, n)) && ![...run.failed.keys()].some((x) => matches(x, n));

/**
 * Whether the gap's own check passes on exactly this tree, in the same call: its test file run alone, as the detector's
 * closer runs it, every named test passing and no test of the file that passed on the base failing (a fix that turns a
 * sibling red, a confinement test say, does not pass). The base is run first, in the same call, from origin's branch:
 * when no named test fails there, the gap's check has nothing to tell, so it does not run, and says so. That is all it
 * says of the gap: the closer that closes gaps judges the same file elsewhere, and may still read it red. The base's
 * result is read before anything of the change runs. The check is the base's: a change to its test file, to what tests lean on
 * (TEST_SUPPORT) or to what chooses how code is checked (CHECK_CONFIG) does not pass, so a change cannot pass by editing
 * the check. It runs as the shell user, in the tree written out with the installed node_modules.
 */
async function gapCheck(t: Trusted, repo: string, dir: string | { why: string }, gap: GapRef | { error: string }, base: string | { why: string },
  runs?: SuiteRuns): Promise<GapCheck> {
  if ("error" in gap) return { ran: false, passed: false, why: gap.error };
  const id = { gap_id: gap.gap_id, ...(gap.test_file === undefined ? {} : { test_file: gap.test_file }) };
  if (typeof dir !== "string") return { ...id, ran: false, passed: false, why: dir.why };
  if (typeof base !== "string") return { ...id, ran: false, passed: false, why: base.why };
  const changed = await t.out(["diff", "--no-renames", "--name-only", t.origin, "refs/land/head"]);
  if (changed === null) return { ...id, ran: false, passed: false, why: "the change's paths could not be read" };
  const edits = changed.split("\n").filter((p) => p !== "" && isGapCheckFile(p, gap));
  if (edits.length > 0) return { ...id, ran: false, passed: false, why: `the change edits the check: ${edits.join(", ")}` };
  if (gap.test_file !== undefined && !existsSync(join(dir, gap.test_file))) return { ...id, ran: false, passed: false, why: `${gap.test_file} is not in the tree` };
  const patch = await t.out(["diff", "--no-renames", "--no-ext-diff", "-U0", t.origin, "refs/land/head"]);
  if (patch === null) return { ...id, ran: false, passed: false, why: "the change's lines could not be read" };
  const forged = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++") && FORGES.test(l));
  if (forged.length > 0) return { ...id, ran: false, passed: false, why: `the change writes what the check reads: ${forged[0].slice(1, 200)}` };
  if (gap.test_file === undefined) {
    // a suite is its vessel's: another repository's suite says nothing of the gap, whatever names the two share
    if (gap.vessel !== repo) return { ...id, ran: false, passed: false, why: `the gap's suite is ${gap.vessel}'s, and this clone is of ${repo}` };
    // the gap's check is the whole suite: its named tests red on the base and green on the tree, and no test that
    // passed on the base red on the tree (a fix that turns the named tests green by breaking others does not pass)
    if (runs === undefined) return { ...id, ran: false, passed: false, why: "the whole suite was not run" };
    if ("why" in runs) return { ...id, ran: false, passed: false, why: runs.why, ...boundOf(runs) };
    const was = gap.only_tests.length === 0 ? runs.base.exit_code !== 0 : gap.only_tests.some((n) => !greenIn(runs.base, n));
    if (!was) return { ...id, ran: false, passed: false, why: "the gap's tests already pass on the base", base: baseRead(runs.base, gap.only_tests, matches) };
    const s = suiteOf(runs);
    if (!s.ran) return { ...id, ran: false, passed: false, why: s.why, ...boundOf(s) };
    const now = gap.only_tests.length === 0 ? runs.tree.exit_code === 0 : gap.only_tests.every((n) => greenIn(runs.tree, n));
    return { ...id, ran: true, passed: now && s.regressed.length === 0 && !runs.tree.signalled, exit_code: s.exit_code, out: s.out,
      truncated: s.truncated, regressed: s.regressed };
  }
  const b = await runCheck(base, gap.test_file);
  if (b.passed === null) return { ...id, ran: false, passed: false, why: "the test run on the base wrote no report" };
  const before = b.passed;
  const red = gap.only_tests.length === 0 ? b.exit_code !== 0 : gap.only_tests.some((n) => !before.has(n));
  if (!red) return { ...id, ran: false, passed: false, why: "the gap's test already passes on the base", base: baseRead(b, gap.only_tests, (x, n) => x === n) };
  const r = await runCheck(dir, gap.test_file);
  const tail = { exit_code: r.exit_code, out: keptCheckOut(r.out, CHECK_OUT_MAX), truncated: r.out.length > CHECK_OUT_MAX };
  if (r.passed === null) return { ...id, ran: true, passed: false, ...tail, out: `the test run wrote no report\n${tail.out}`, regressed: [] };
  const passed = r.passed;
  const named = gap.only_tests.length === 0 ? r.exit_code === 0 : gap.only_tests.every((n) => passed.has(n));
  const regressed = [...before].filter((n) => !passed.has(n)).sort();
  return { ...id, ran: true, passed: named && regressed.length === 0 && !r.signalled, ...tail, regressed };
}

// How long each step of a git_diff took, said once per call on this vessel's output (step names and milliseconds only,
// never a path, a name or a diff): a caller that gives up on the call (discovery's forward) sees only that it gave up,
// so this is where the step that overruns is read.
const timed = async <T>(steps: Array<[string, number]>, step: string, f: () => Promise<T>): Promise<T> => {
  const t0 = performance.now();
  try { return await f(); } finally { steps.push([step, Math.round(performance.now() - t0)]); }
};

/**
 * The paths the clone holds changed and not committed (modified, added, deleted, untracked), relative to it; null when
 * they cannot be read. git_diff describes the committed change, which is what lands; a walk that edited without
 * committing was shown a diff and a typecheck that do not have its edits, and nothing said so. Read as the shell user
 * (the clone is the walk's), with core.fsmonitor off. That closes the monitor only: a clean filter the clone's config and
 * .gitattributes name still runs on a changed file, so the read is bounded as a whole (git(), bounded-run.ts), and one
 * that blocks or outlives git costs the step's bound at most, never the call.
 */
async function uncommitted(cwd: string): Promise<string[] | null> {
  const r = await git(["-c", "core.fsmonitor=false", "-C", cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], tmpdir());
  if (r.exit_code !== 0) return null;
  return r.stdout.split("\0").filter((e) => e.length > 3).map((e) => e.slice(3));
}

/** git_diff on a clone git_worktree made: its diff, the whole suite's runs bounded by the owner's suite_bound row for the
 * clone's repository when there is one (suite-bound.ts); a row that cannot be read leaves the step bound. The rows are
 * records' own unless a caller gives others, so the handler names no row source it could get wrong. */
export async function diffMade(made: Made, gap: GapRef | null | { error: string }, transports?: string[],
  rows: (q: Query) => Promise<Row[] | { error: string }> = readRows): Promise<DiffResult> {
  const suiteBound = await suiteBoundOf(rows, made.repo).catch(() => undefined);
  return diffClone(made.cwd, made, transports, gap, suiteBound);
}

/** The committed change of a clone git_worktree made, against origin's branch, computed where the clone cannot reach. */
export async function diffClone(cwd: string, made: Made, transports: string[] = DEFAULTS.transports, gap: GapRef | null | { error: string } = null,
  suiteBound?: number): Promise<DiffResult> {
  // the whole suite's two runs take the owner's bound (suite-bound.ts) when it sets one; every other step keeps STEP_MS
  const suiteMs = suiteBound ?? STEP_MS;
  const modules = join(containmentZones(process.env).runtime, made.repo, "node_modules");
  const work = mkdtempSync(join(tmpdir(), "diff-"));
  const steps: Array<[string, number]> = [];
  const t0 = performance.now();
  try {
    const pending = await timed(steps, "status", () => uncommitted(cwd));
    // uncommitted_any says the same as a flat boolean, so a requires row (which can only test a field's equality) can
    // offer git_commit only when there is something to commit; absent with uncommitted, when the clone could not be read.
    const said = pending === null ? {} : { uncommitted: pending, uncommitted_any: pending.length > 0 };
    // A clone with no commit since it was made has no change to diff; said so, with what it holds uncommitted, rather
    // than the bundle's "could not be bundled".
    const ahead = await git(["-C", cwd, "rev-list", "--count", `${made.base}..HEAD`], tmpdir());
    if (ahead.exit_code === 0 && ahead.stdout.trim() === "0") {
      return { error: "the clone has no commit since it was made: there is no change to diff; git_commit commits what it holds", ...said };
    }
    const t = await timed(steps, "into_trusted", () => intoTrusted(cwd, made, work, transports));
    if ("error" in t) return { ...t, ...said };
    const base = await t.out(["rev-parse", t.origin]);
    // The change is what the clone's commits do: diffed from where they leave origin's branch. When origin has moved on
    // since the clone was made, a diff from origin's tip would show every later commit on it undone, as if the change
    // made it (a gate's own tightening shown as loosened). Such a change cannot land as it is (git_land takes a
    // fast-forward only), so it is shown as it is, said not to fast-forward, and checked as not passing: what makes it
    // land is a fresh clone with the edits made again.
    const from = await t.out(["merge-base", t.origin, "refs/land/head"]);
    if (base === null || from === null) return { error: "the change's diff could not be read" };
    const ff = from === base;
    const diff = await timed(steps, "diff", () => t.out(["diff", "--no-renames", from, "refs/land/head"]));
    if (diff === null) return { error: "the change's diff could not be read" };
    const behind = "the clone's base is behind origin's branch: this change cannot land as it is; ask for a fresh clone and make the edits again";
    const dir = ff ? await timed(steps, "write_out", () => writeOut(t, made, work)) : { why: behind };
    const typecheck: Typecheck = ff
      ? await timed(steps, "typecheck", () => typecheckTree(t, made, dir, () => writeOut(t, made, work, t.origin, "base-typecheck")))
      : { ran: false, passed: false, why: behind };
    const baseDir = ff ? await timed(steps, "base_out", () => writeOut(t, made, work, t.origin, "base")) : { why: behind };
    const refused = typeof dir === "string" ? await suiteRefuses(t) : null;
    // the base's suite run is reused by every diff of the same base, against the same packages and runner
    const key = [made.repo, base, installIdentity(modules), Bun.version] as const;
    // the tree's run is kept by its tree's sha the same way, under a name of its own, so the repository's one kept tree
    // run never replaces its kept base run
    const treeKey = [`${made.repo}#tree`, t.tree, key[2], key[3]] as const;
    const suiteDir = refused === null ? dir : { why: refused };
    // a gap whose check is the whole suite runs it once, in its check, and the suite's own verdict reads the same runs
    let runs: SuiteRuns | undefined;
    const check = gap === null ? {} : { check: await timed(steps, "gap_check", async () => {
      if (!("error" in gap) && gap.test_file === undefined) runs = await suiteRuns(suiteDir, baseDir, suiteMs, key, treeKey);
      return gapCheck(t, made.repo, dir, gap, baseDir, runs);
    }) };
    const suite = await timed(steps, "suite", async () => suiteOf(runs ?? await suiteRuns(suiteDir, baseDir, suiteMs, key, treeKey)));
    // what judged the tree before the diff itself: a reader that keeps a row's start (the walk cuts a long answer) keeps
    // why it did not pass, and the diff, the longest field, is what is cut
    return { shape: "gitDiff", cwd, repo: made.repo, base, head: t.head, tree: t.tree, fast_forward: ff, typecheck, suite, ...check,
      diff: diff.slice(0, DIFF_MAX), truncated: diff.length > DIFF_MAX, ...said };
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch { /* a temp dir */ }
    console.log(`[git_diff] ${steps.map(([s, ms]) => `${s}=${ms}ms`).join(" ")} total=${Math.round(performance.now() - t0)}ms`);
  }
}
