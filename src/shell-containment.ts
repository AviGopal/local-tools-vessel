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
// path), or a git command that is not a read form whose repository (cwd, `cd X`,
// `git -C X`, `--git-dir`, GIT_DIR) is inside one. Read commands run unchanged, with
// the same cwd as before. In the other protected zones (vessel clones, compose worktrees,
// runtime), a git command that would set a program git runs there (a config write, -c,
// --config-env, a GIT_*/PAGER variable, a transport program option) is refused early,
// with a reason, while the lane's ordinary writes there stay allowed.
// WHAT CLOSES THAT CLASS IS NOT THIS CHECK. It is lexical and cannot be complete: a
// wrapper it does not unwrap, a file written under .git, an exported GIT_DIR or a linked
// worktree all reach the same config. What closes it is ownership: the zones, the super
// clone and their .git are root's, and the shell runs as an unprivileged user that cannot
// write them; a walk's clone is that user's own workspace, where every git a tool runs is
// git as that same user (git-commit.ts git()), so a program planted there gains nothing;
// and git as this vessel refuses a repository another user owns (git's ownership check,
// which vesselGit never widens: root-git-foreign-repo.test.ts). This check gives the
// early, explained refusal; it is not the boundary.
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
import { containmentZones, verifyWriteGrant, WRITE_CONTAINMENT_ERROR, WRITE_GRANT_FIELD, zoneOf, type Env } from "./write-containment.js";

export { WRITE_GRANT_FIELD };

/**
 * git subcommands that only read the repository. The gate's own definition of a read: anything else
 * in the live super-repo clone is refused, so a subcommand git adds later is refused until named here.
 */
const GIT_READS = new Set([
  "status", "log", "diff", "show", "rev-parse", "rev-list", "cat-file", "ls-files", "ls-tree", "blame", "grep",
  "describe", "shortlog", "merge-base", "show-ref", "for-each-ref", "diff-tree", "name-rev",
]);
/** Read-form options that still write a file or run a program. */
const GIT_READ_WRITERS = ["--output", "-O", "--open-files-in-pager"];
/** Options naming a program a transport runs. */
const GIT_EXEC_OPTIONS = ["--upload-pack", "--receive-pack", "--exec"];
/** xargs options that take the next word as their value. */
const XARGS_VALUE_OPTIONS = ["-I", "-E", "-a", "-d", "-P", "-n", "-s", "-L"];

/** Is `git <sub> <rest>` a read form? config, remote, branch, submodule, symbolic-ref and worktree read only in some forms. */
function gitRead(sub: string, rest: string[]): boolean {
  const opts = rest.filter((a) => a.startsWith("-"));
  // an option's separate value (config's -f get: a file named "get") is not a word of the command
  const words = rest.filter((a, i) => !a.startsWith("-") && !(sub === "config" && ["-f", "--file", "--blob"].includes(rest[i - 1] ?? "")));
  const optIs = (o: string, names: string[]): boolean => names.some((n) => o === n || o.startsWith(`${n}=`));
  if (GIT_READS.has(sub)) return !opts.some((o) => optIs(o, GIT_READ_WRITERS) || (o.startsWith("-O") && o.length > 2));
  switch (sub) {
    case "config": return opts.some((o) => ["--get", "--get-all", "--get-regexp", "--list", "-l"].includes(o)) || ["get", "list"].includes(words[0] ?? "");
    case "remote": return words.length === 0 || words[0] === "get-url";
    case "branch":
      if (opts.includes("--list") || opts.includes("-l")) return true;
      return words.length === 0 && opts.every((o) => ["-a", "-r", "-v", "-vv", "--all", "--remotes", "--verbose", "--show-current"].includes(o));
    case "submodule": return words.length === 0 || words[0] === "status";
    case "symbolic-ref": return words.length === 1 && !opts.some((o) => o === "-d" || o === "--delete");
    case "worktree": return words[0] === "list";
    default: return false;
  }
}

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
  const zones = containmentZones(opts.env);
  const supers = zones.supers;
  if (supers.length === 0) return { ok: true };
  if (verifyWriteGrant(opts.env.METABOB_API_KEY, opts.rawCwd ?? cwd, opts.grant, opts.now)) return { ok: true };
  const superOf = (p: string): string | null => {
    for (const s of supers) if (within(p, s)) return s;
    return null;
  };
  // A backtick substitution runs its body as a command of its own: it is gated as one, wherever it sits in a word.
  for (const m of command.matchAll(/`([^`]*)`/g)) {
    const v = containShell(m[1]!, cwd, opts);
    if (!v.ok) return v;
  }
  // Opaque inline programs and command substitutions — fail closed inside the live super-repo clone.
  {
    const root = superOf(realCwd(cwd));
    if (root) {
      // Catch command substitutions that launch an inline interpreter program: echo $(python -c ...), backticks, etc.
      const inlineInterpSub = /\$\((?:[^)]*\b(python3?|ruby|perl|node|bun|php|lua|Rscript)\b[^)]*? -[cer]\b[^)]*)\)/;
      const backtickInterpSub = /`[^`]*\b(python3?|ruby|perl|node|bun|php|lua|Rscript)\b[^`]*? -[cer]\b[^`]*`/;
      if (inlineInterpSub.test(command) || backtickInterpSub.test(command)) {
        return { ok: false, reason: WRITE_CONTAINMENT_ERROR };
      }

      const segs2 = segments(command);
      const isAssign = (w: string): boolean => {
        const eq = w.indexOf("=");
        if (eq <= 0) return false;
        const name = w.slice(0, eq);
        return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
      };
      const refuse = (): ShellVerdict => ({ ok: false, reason: WRITE_CONTAINMENT_ERROR });

      for (const words of segs2) {
        if (words.length === 0) continue;
        // Skip any leading NAME=VALUE assignments; a pure-assignment segment is allowed.
        let i = 0;
        while (i < words.length && isAssign(words[i]!)) i++;
        if (i >= words.length) continue; // assignment-only segment (e.g., BASE_REF=$(git ...))

        const cmd = words[i]!;
        // Command word produced by substitution or tilde expansion? Fail closed in the live clone.
        if (!literal(cmd)) return refuse();

        const base = cmd.slice(cmd.lastIndexOf("/") + 1);
        const rest = words.slice(i + 1);
        const has = (f: string) => rest.includes(f);

        // Recurse minimal check through sh/bash -c '...'
        if (base === "sh" || base === "bash") {
          const ci = rest.findIndex((w) => w === "-c");
          if (ci !== -1 && rest[ci + 1]) {
            const inner = rest[ci + 1]!;
            const v = containShell(inner, cwd, { env: opts.env, rawCwd: opts.rawCwd, grant: opts.grant, now: opts.now });
            if (!v.ok) return v;
          }
        }

        // Inline program flags for common interpreters — fail closed in the live clone.
        if (["python", "python3", "ruby", "perl", "node", "bun", "php", "lua", "Rscript"].includes(base)) {
          if (has("-c") || has("-e") || has("-r")) return refuse();
        }

        // tclsh reading program from stdin (no script arg) — fail closed.
        if (base === "tclsh" && rest.length === 0) return refuse();

        // awk/gawk inline programs: refuse obvious writey forms (redirection, system()).
        if (base === "awk" || base === "gawk") {
          if (!rest.some((w) => w === "-f")) {
            let pj = 0;
            while (pj < rest.length && rest[pj]!.startsWith("-")) pj++;
            const prog = rest[pj];
            if (typeof prog === "string") {
              if (prog.includes(">") || /system\s*\(/.test(prog)) return refuse();
            }
          }
        }
      }
    }
  }
  // The directory relative words resolve against. Null once a `cd` goes somewhere we
  // cannot evaluate (`cd "$ROOT"`): relative targets are then unknown, not the clone.
  let dir: string | null = realCwd(cwd);
  // EARLY writer checks for unlisted commands: sort -o, find -delete/-exec, xargs writers, perl -i/-pi, and patch.
  // These run before the legacy path-based writers and redirection checks.
  const __checkPath = (w: string | undefined): { target: string; root: string } | null => {
    if (!w || !literal(w)) return null;
    const base = dir ?? realCwd(cwd);
    const abs = isAbsolute(w) ? w : resolve(base, w);
    let rp = abs;
    try { rp = realpathSync(abs); } catch { /* best-effort */ }
    const root = superOf(rp);
    return root ? { target: rp, root } : null;
  };
  const __earlyRefuse = (what: string, target: string, root: string): ShellVerdict => ({
    ok: false,
    reason: `${WRITE_CONTAINMENT_ERROR}: shell ${what} targets ${target}, inside the live super-repo clone ${root}; the shell may read there but nothing lands in the live clone by a tool write — land a change as a commit through the lane`,
  });
  const __segs = segments(command);
  for (const words of __segs) {
    if (words.length === 0) continue;
    const cmd0 = words[0]!;
    const base = cmd0.slice(cmd0.lastIndexOf("/") + 1);

    // patch: writes the working tree (optionally -d DIR)
    if (base === "patch") {
      const di = words.findIndex((w) => w === "-d");
      if (di !== -1) {
        const hit = __checkPath(words[di + 1]);
        if (hit) return __earlyRefuse("'patch -d'", hit.target, hit.root);
      } else if (dir) {
        const s = superOf(dir);
        if (s) return __earlyRefuse("'patch'", dir, s);
      }
    }

    // sort -o FILE
    if (base === "sort") {
      for (let i = 1; i < words.length; i++) {
        const w = words[i]!;
        if (w === "-o") {
          const hit = __checkPath(words[i + 1]);
          if (hit) return __earlyRefuse("'sort -o'", hit.target, hit.root);
          break;
        }
        if (w.startsWith("-o") && w.length > 2) {
          const hit = __checkPath(w.slice(2));
          if (hit) return __earlyRefuse("'sort -o'", hit.target, hit.root);
          break;
        }
      }
    }

    // perl -i / -pi (in-place)
    if (base === "perl") {
      let hasI = false;
      for (let i = 1; i < words.length; i++) {
        const w = words[i]!;
        if (w === "-i" || (w.startsWith("-") && /-.*i/.test(w))) { hasI = true; break; }
      }
      if (hasI) {
        for (let i = 1; i < words.length; i++) {
          const w = words[i]!;
          if (w.startsWith("-")) continue;
          const hit = __checkPath(w);
          if (hit) { return __earlyRefuse("'perl -i'", hit.target, hit.root); }
        }
        if (dir) {
          const s = superOf(dir);
          if (s) return __earlyRefuse("'perl -i'", dir, s);
        }
      }
    }

    // find -delete or -exec/-execdir writers
    if (base === "find") {
      const roots: string[] = [];
      let i = 1;
      while (i < words.length && !words[i]!.startsWith("-")) { roots.push(words[i]!); i++; }
      if (roots.length === 0) roots.push(".");
      const targetsInSuper = roots.some((r) => !!__checkPath(r));
      let destructive = false;
      for (let j = i; j < words.length; j++) {
        const w = words[j]!;
        if (w === "-delete") { destructive = true; break; }
        if (w === "-exec" || w === "-execdir") {
          const sub = words[j + 1];
          if (typeof sub === "string") {
            const b = sub.slice(sub.lastIndexOf("/") + 1);
            if (b === "rm" || b === "mv" || b === "cp") { destructive = true; break; }
            if (b === "sed") {
              let k = j + 2;
              while (k < words.length && words[k] !== ";") {
                const a = words[k]!;
                if (a === "-i" || a.startsWith("-i")) { destructive = true; break; }
                k++;
              }
              if (destructive) break;
            }
          }
        }
      }
      if (destructive && targetsInSuper) {
        for (const r of roots) {
          const hit = __checkPath(r);
          if (hit) return __earlyRefuse("'find'", hit.target, hit.root);
        }
      }
    }

    // xargs writers (rm/mv/cp or sed/perl with in-place)
    if (base === "xargs") {
      let i = 1;
      while (i < words.length && words[i]!.startsWith("-")) {
        const opt = words[i]!;
        if (XARGS_VALUE_OPTIONS.includes(opt) && i + 1 < words.length) { i += 2; continue; }
        i++;
      }
      const sub = words[i];
      if (typeof sub === "string") {
        const b = sub.slice(sub.lastIndexOf("/") + 1);
        let isWriter = b === "rm" || b === "mv" || b === "cp";
        let sedI = false, perlI = false;
        if (b === "sed" || b === "perl") {
          for (let j = i + 1; j < words.length; j++) {
            const a = words[j]!;
            if (a === ";") break;
            if (a === "{}" || a.includes("{}")) continue;
            if (a.startsWith("-")) {
              if (b === "sed" && (a === "-i" || a.startsWith("-i"))) sedI = true;
              if (b === "perl" && (a === "-i" || /-.*i/.test(a))) perlI = true;
              continue;
            }
            const hit = __checkPath(a);
            if (hit && (isWriter || sedI || perlI)) return __earlyRefuse(`'xargs ${b}'`, hit.target, hit.root);
          }
        }
        if (isWriter || sedI || perlI) {
          if (dir) {
            const s = superOf(dir);
            if (s) return __earlyRefuse(`'xargs ${b}'`, dir, s);
          }
        }
      }
    }
  }
  const refuse = (what: string, target: string, root: string): ShellVerdict => ({
    ok: false,
    reason: `${WRITE_CONTAINMENT_ERROR}: shell ${what} targets ${target}, inside the live super-repo clone ${root}; the shell may read there but nothing lands in the live clone by a tool write — land a change as a commit through the lane`,
  });
  const refuseExec = (what: string, repo: string): ShellVerdict => ({
    ok: false,
    reason: `${WRITE_CONTAINMENT_ERROR}: shell ${what} in ${repo} would set a program git runs there (a hook, pager, fsmonitor, editor or transport command), which every vessel's next git command in that clone would run; the shell may not change what git runs`,
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
    const assigned: string[] = [];
    for (;;) {
      while (k < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k]!) || ["sudo", "env", "nohup", "command", "exec", "time", "nice"].includes(words[k]!))) {
        if (words[k]!.includes("=")) assigned.push(words[k]!);
        k++;
      }
      if (k < words.length && words[k] === "timeout") { k++; while (k < words.length && words[k]!.startsWith("-")) k++; k++; continue; }
      if (k < words.length && words[k] === "xargs") {
        k++;
        while (k < words.length && words[k]!.startsWith("-")) k += XARGS_VALUE_OPTIONS.includes(words[k]!) ? 2 : 1;
        continue;
      }
      break;
    }
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
      const at = (p: string | undefined, from: string | null): string | null =>
        literal(p) && (from !== null || isAbsolute(p)) ? realCwd(resolve(from ?? "/", p)) : null;
      let repo: string | null = dir;
      // GIT_DIR / GIT_WORK_TREE choose the repository as --git-dir / --work-tree do; one that is not literal leaves it as it was
      const selects = (p: string): void => { if (literal(p)) repo = at(p, repo); };
      for (const w of assigned) if (/^GIT_(DIR|WORK_TREE)=/.test(w)) selects(w.slice(w.indexOf("=") + 1));
      let sub: string | undefined;
      let override = assigned.map((w) => w.slice(0, w.indexOf("="))).find((n) => n.startsWith("GIT_") || n === "PAGER");
      let i = 0;
      for (; i < args.length; i++) {
        const a = args[i]!;
        if (a === "-C") { repo = at(args[++i], repo); continue; }
        if (a === "--git-dir" || a === "--work-tree") { selects(args[++i] ?? ""); continue; }
        if (a.startsWith("--git-dir=") || a.startsWith("--work-tree=")) { selects(a.slice(a.indexOf("=") + 1)); continue; }
        if (a === "-c" || a === "--config-env") { override ??= a; i++; continue; }
        if (a.startsWith("--config-env=") || a.startsWith("--exec-path=")) { override ??= a.slice(0, a.indexOf("=")); continue; }
        if (a === "--namespace") { i++; continue; }
        if (a.startsWith("-")) continue;
        sub = a; break;
      }
      const rest = sub === undefined ? [] : args.slice(i + 1);
      const read = sub === undefined || gitRead(sub, rest);
      override ??= rest.find((o) => GIT_EXEC_OPTIONS.some((n) => o === n || o.startsWith(`${n}=`)))?.split("=")[0];
      // a config write lands where its file is: --file names it, --global/--system reach every clone at once
      let configAt: string | null = repo;
      if (sub === "config" && !read) {
        if (rest.some((o) => o === "--global" || o === "--system")) return refuseExec("'git config --global'", "the node's git configuration, which every clone reads");
        const f = rest.findIndex((o) => o === "--file" || o === "-f");
        const fEq = rest.find((o) => o.startsWith("--file="));
        if (f >= 0 || fEq) configAt = at(f >= 0 ? rest[f + 1] : fEq!.slice("--file=".length), repo);
      }
      const zoned = (p: string | null): boolean => p !== null && zoneOf(p, zones) !== null;
      if (repo !== null && superOf(repo) && !read) return refuse(`'git ${sub}'`, repo, superOf(repo)!);
      if (zoned(repo) && override !== undefined) return refuseExec(`'git ${override}'`, repo!);
      if (sub === "config" && !read && zoned(configAt)) return refuseExec("'git config'", configAt!);
      continue;
    }
    // Nested interpreter/inline eval forms are disallowed within a super-repo clone without a matching write grant.
    {
      const root = dir ? superOf(dir) : undefined;
      if (root && !verifyWriteGrant(opts.env.METABOB_API_KEY, root, opts.grant, opts.now)) {
        const isShellC = (base === "bash" || base === "sh" || base === "zsh") && args.some((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
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
