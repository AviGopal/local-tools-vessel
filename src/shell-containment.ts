// shell-containment — the general shell must not write the LIVE super-repo clone.
//
// THE HOLE THIS CLOSES. Write containment (write-containment.ts) guards every file
// tool that writes at a `path`, and git_commit. The general shell (`shell` / `bash` /
// `shellResult`, and `bounded_shell`) was outside it: it runs `bash -c` with cwd =
// WORKSPACE_ROOT, which on a substrate IS the live super-repo clone
// (/workspace/git/super-repo). goal-host's universal-tool floor offered shellResult as
// a read-only "inspect" tool, so a floor run (27c1c600, 09-30) created
// /workspace/git/super-repo/GPT-5.md with a plain redirect — nothing between a
// model-authored command and the clone pull-sync installs from.
//
// THE POLICY, and why it is this one. Every shell caller was enumerated before choosing:
//   - goal-host's walk and floor (and its recipe / investigation / recompute seeds) run
//     READ commands with RELATIVE paths that only resolve because cwd is the clone
//     (`wc -l repos/x/src/a.ts`, `grep -rn … repos`). Relocating cwd to a scratch dir
//     would break all of them, so cwd is KEPT.
//   - The lane (development-vessel feature_compose, test_suite, perf_canary) carries no
//     grant on its shell calls and legitimately WRITES through the shell: `rm -rf`/`cp`/
//     `mkdir -p`/`ln -sfn` under the vessel runtime and compose staging, `git worktree
//     add/remove/prune`, `bun install`, `rm -rf "$BW"` with cwd = the super-repo clone.
//     Refusing every write in every protected zone would stop the lane, so the gate
//     covers the ONE zone write-containment already says no tool ever writes: the live
//     super-repo clone ("nothing lands there by a tool write").
// So: a command is REFUSED when it has a write whose LITERAL target resolves into a
// super-repo clone (a relative target against the effective cwd, or an absolute
// path), or a mutating git subcommand whose repository (cwd, `cd X`, or `git -C X`)
// is inside one. Read commands run unchanged, with the same cwd as before.
//
// A LANE GRANT bypasses the gate: a write grant (write-containment's HMAC, same key,
// same TTL) signed over the exact cwd string the request sends. No caller mints one
// yet; the lane's one call this refuses is feature_compose's in-tree materialization
// (`git -C <super> checkout origin/dev -- repos/<v>`), which needs one to keep working.
//
// RESIDUAL (stated, not hidden). This is a lexical check over the command text, not a
// sandbox: a target built from a variable or substitution (`> "$F"`, `$(…)`), or a
// write made by an interpreter (`bun -e "…writeFileSync…"`), is not seen. Writes into
// vessel runtime / push clones / compose worktrees through the shell are not gated
// (the lane writes there without grants). The primary fix is upstream: the floor no
// longer offers the shell at all.
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { containmentZones, verifyWriteGrant, WRITE_CONTAINMENT_ERROR, WRITE_GRANT_FIELD, type Env } from "./write-containment.js";

export { WRITE_GRANT_FIELD };

/** git subcommands that change a repository's index, refs, working tree or remote. */
export const MUTATING_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "commit", "push", "reset", "add", "rm", "mv", "checkout", "restore", "switch", "rebase", "merge",
  "stash", "clean", "cherry-pick", "revert", "am", "apply", "pull", "tag", "init", "clone", "update-ref",
]);

/** Commands every non-option argument of which is a write target. */
const ALL_ARG_WRITERS = new Set(["rm", "rmdir", "touch", "mkdir", "truncate", "shred", "unlink", "tee"]);
/** Commands whose LAST non-option argument (or `-t DIR`) is the write target. */
const LAST_ARG_WRITERS = new Set(["mv", "cp", "ln", "install", "rsync"]);
/** Commands whose first non-option argument is a mode/owner and the rest are targets. */
const MODE_WRITERS = new Set(["chmod", "chown", "chgrp"]);

export type ShellVerdict = { ok: true } | { ok: false; reason: string };

function within(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Split a command into simple-command segments, each a list of shell words (quotes honoured). Redirections are kept as their own words. */
export function segments(command: string): string[][] {
  const out: string[][] = [];
  let words: string[] = [];
  let cur = "";
  let has = false;
  let q: '"' | "'" | null = null;
  const pushWord = () => { if (has) words.push(cur); cur = ""; has = false; };
  const pushSeg = () => { pushWord(); if (words.length) out.push(words); words = []; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (q) {
      if (c === q) { q = null; continue; }
      if (c === "\\" && q === '"' && i + 1 < command.length) { cur += command[++i]; continue; }
      cur += c; continue;
    }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (c === "\\" && i + 1 < command.length) { cur += command[++i]; has = true; continue; }
    if (c === " " || c === "\t") { pushWord(); continue; }
    if (c === "\n" || c === ";" || c === "(" || c === ")" || c === "{" || c === "}") { pushSeg(); continue; }
    if (c === "&" && command[i + 1] === "&") { pushSeg(); i++; continue; }
    if (c === "|") { pushSeg(); if (command[i + 1] === "|") i++; continue; }
    if (c === ">" || (c === "&" && command[i + 1] === ">")) {
      // A redirection operator: `>`, `>>`, `>|`, `&>`, `&>>`, `N>`, `>&N`. Emit it as its own word.
      let op = "";
      if (has && /^\d+$/.test(cur)) { op = cur; cur = ""; has = false; } else pushWord();
      if (c === "&") { op += "&"; i++; }
      op += ">";
      if (command[i + 1] === ">") { op += ">"; i++; }
      if (command[i + 1] === "|") { op += "|"; i++; }
      if (command[i + 1] === "&") { op += "&"; i++; }
      words.push(op);
      continue;
    }
    if (c === "&") { pushSeg(); continue; }
    cur += c; has = true;
  }
  pushSeg();
  return out;
}

/** A literal path word: no expansion we cannot evaluate. */
const literal = (w: string | undefined): w is string => typeof w === "string" && w.length > 0 && !/[$`~]/.test(w);

function realCwd(dir: string): string {
  try { return realpathSync(dir); } catch { return resolve(dir); }
}

/**
 * Should this shell command be refused? `cwd` is the directory the shell will start in
 * (absolute). Pure apart from realpath on directories.
 */
export function containShell(command: string, cwd: string, opts: { env: Env; rawCwd?: string; grant?: unknown; now?: number }): ShellVerdict {
  const supers = containmentZones(opts.env).supers;
  if (supers.length === 0) return { ok: true };
  if (verifyWriteGrant(opts.env.METABOB_API_KEY, opts.rawCwd ?? cwd, opts.grant, opts.now)) return { ok: true };
  const superOf = (p: string): string | null => {
    for (const s of supers) if (within(p, s)) return s;
    return null;
  };
  // The directory relative words resolve against. Null once a `cd` goes somewhere we
  // cannot evaluate (`cd "$ROOT"`): relative targets are then unknown, not the clone.
  let dir: string | null = realCwd(cwd);
  const refuse = (what: string, target: string, root: string): ShellVerdict => ({
    ok: false,
    reason: `${WRITE_CONTAINMENT_ERROR}: shell ${what} targets ${target}, inside the live super-repo clone ${root}; the shell may read there but nothing lands in the live clone by a tool write — land a change as a commit through the lane`,
  });
  const checkTarget = (what: string, w: string | undefined): ShellVerdict | null => {
    if (!literal(w) || w.startsWith("-")) return null;
    if (dir === null && !isAbsolute(w)) return null;
    const t = resolve(dir ?? "/", w);
    if (t.startsWith("/dev/")) return null;
    const root = superOf(t);
    return root ? refuse(what, t, root) : null;
  };
  for (const seg of segments(command)) {
    // Redirections anywhere in the segment.
    const words: string[] = [];
    for (let i = 0; i < seg.length; i++) {
      const w = seg[i]!;
      if (/^\d*&?>{1,2}\|?&?$/.test(w)) {
        // `>&2`, `2>&1`, `>&-`: an fd (or close), not a file. Only a digit run or `-` is an fd;
        // `>& f` / `>&f` write the file f (qa 10-02), so anything else is checked as a target.
        if (w.endsWith("&") && /^(\d+|-)$/.test(seg[i + 1] ?? "")) { i++; continue; }
        const r = checkTarget(`redirect '${w}'`, seg[i + 1]);
        if (r) return r;
        i++;
        continue;
      }
      words.push(w);
    }
    // Skip leading env assignments and wrappers that only run the next word.
    let k = 0;
    while (k < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k]!) || ["sudo", "env", "nohup", "command", "exec", "time", "nice"].includes(words[k]!))) k++;
    if (k < words.length && words[k] === "timeout") { k++; while (k < words.length && words[k]!.startsWith("-")) k++; k++; }
    const cmd = words[k];
    if (!cmd) continue;
    const base = cmd.slice(cmd.lastIndexOf("/") + 1);
    const args = words.slice(k + 1);
    const nonOpt = args.filter((a) => !a.startsWith("-") || a === "-");
    if (base === "cd") {
      const to = args[0];
      dir = literal(to) && (dir !== null || isAbsolute(to)) ? realCwd(resolve(dir ?? "/", to)) : null;
      continue;
    }
    if (base === "git") {
      let repo: string | null = dir;
      let sub: string | undefined;
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (a === "-C") { const p = args[++i]; repo = literal(p) && (repo !== null || isAbsolute(p)) ? realCwd(resolve(repo ?? "/", p)) : null; continue; }
        if (a === "-c" || a === "--git-dir" || a === "--work-tree" || a === "--namespace") { i++; continue; }
        if (a.startsWith("-")) continue;
        sub = a; break;
      }
      if (sub && MUTATING_GIT_SUBCOMMANDS.has(sub) && repo) {
        const root = superOf(repo);
        if (root) return refuse(`'git ${sub}'`, repo, root);
      }
      continue;
    }
    // Nested interpreter/inline eval forms are disallowed within a super-repo clone without a matching write grant.
    {
      const root = dir ? superOf(dir) : undefined;
      if (root && !verifyWriteGrant(opts.grant as string | undefined, root, dir ?? root)) {
        const isShellC = (base === "bash" || base === "sh" || base === "zsh") && args.some((a) => a === "-c");
        const isEval = base === "eval";
        const isNodeEval = (base === "bun" || base === "node") && args.some((a) => a === "-e" || a === "--eval");
        const isPyPerlEval = (base === "python" || base === "python3" || base === "perl") && args.some((a) => a === "-e");
        const isSource = base === "source" || base === ".";
        if (isShellC || isEval || isNodeEval || isPyPerlEval || isSource) {
          return refuse(`'${base}'`, dir ?? root, root);
        }
      }
    }
    if (ALL_ARG_WRITERS.has(base)) {
      for (const a of nonOpt) { const r = checkTarget(`'${base}'`, a); if (r) return r; }
      continue;
    }
    if (LAST_ARG_WRITERS.has(base)) {
      const tIdx = args.findIndex((a) => a === "-t" || a === "--target-directory");
      const tEq = args.find((a) => a.startsWith("--target-directory="));
      const target = tIdx >= 0 ? args[tIdx + 1] : tEq ? tEq.slice("--target-directory=".length) : nonOpt[nonOpt.length - 1];
      if (nonOpt.length >= 2 || tIdx >= 0 || tEq) { const r = checkTarget(`'${base}'`, target); if (r) return r; }
      continue;
    }
    if (MODE_WRITERS.has(base)) {
      for (const a of nonOpt.slice(1)) { const r = checkTarget(`'${base}'`, a); if (r) return r; }
      continue;
    }
    if (base === "sed" && args.some((a) => a === "-i" || a.startsWith("-i") && !a.startsWith("--") || a.startsWith("--in-place"))) {
      const scripted = args.some((a) => a === "-e" || a === "-f" || a === "--expression" || a === "--file");
      for (const a of scripted ? nonOpt : nonOpt.slice(1)) { const r = checkTarget("'sed -i'", a); if (r) return r; }
      continue;
    }
    if (base === "dd") {
      for (const a of args) if (a.startsWith("of=")) { const r = checkTarget("'dd of='", a.slice(3)); if (r) return r; }
      continue;
    }
    if (base === "curl" || base === "wget") {
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if ((base === "curl" && (a === "-o" || a === "--output")) || (base === "wget" && (a === "-O" || a === "--output-document"))) {
          const r = checkTarget(`'${base} ${a}'`, args[i + 1]); if (r) return r;
        }
      }
      continue;
    }
  }
  return { ok: true };
}
