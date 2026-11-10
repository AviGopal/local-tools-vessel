// shell-privilege — an agent-issued shell command runs as an unprivileged user.
//
// THE HOLE THIS CLOSES. agent-shell-env.ts keeps the fleet's credentials out of the child's
// env, and the unit makes /etc/substrate inaccessible to this vessel. Neither stops a ROOT
// child: this vessel runs as root with the env file loaded into its own process, so a shell
// it spawns as root (near-full capability set, no NoNewPrivileges) can read the parent's
// /proc/<pid>/environ, which holds the push credential, or undo the mount mask. Git's
// system-wide credential helper also falls back to that env. So "the walk pushes only through
// the push resolver, under its preconditions" held only for commands that chose to.
//
// THE RULE. When this vessel runs as root, both agent shell spawn sites (sh() and
// bounded_shell) start the command under setpriv as nobody:nogroup, with no supplementary
// groups, empty inheritable, ambient and bounding capability sets, and NoNewPrivs, so a
// setuid binary cannot win root back. Such a child cannot read a root process's environ, the
// env file, or root-only files. When this vessel does not run as root (a test run as a user),
// the child already has no more privilege than its parent and argv is unchanged.
//
// ROOT NEVER CHOWNS A PATH THE CHILD CAN NAME. Handing a directory to the shell user is a root
// act on a path, and a path the unprivileged user can replace (with a symlink to /root, the
// live clone, a /vessels tree) turns that act into giving the user the target. So a directory
// is handed over only when its PARENT is a root-owned directory nobody else can write (the
// child cannot rename, remove or replace an entry there), and only with lchown on what lstat
// shows is a real directory. Each command gets a fresh HOME made by mkdtemp inside such a
// parent, so nothing a command leaves in its HOME (a .gitconfig, a hook path) reaches the
// next; the HOME is emptied by the shell user, never by root walking it, then removed. That
// cleanup runs after the command has answered and is never awaited by it: the vessel's event
// loop serves every resolver. bun's install cache is the one thing shared between commands
// (BUN_INSTALL_CACHE_DIR, a directory beside the HOMEs), so a test or install run does not
// re-fetch and re-delete thousands of files each time; it holds packages, never config, and
// is written only by the shell user, so what it can affect is what that user already could.
//
// WHAT THE CHILD STILL NEEDS:
//   - a HOME it can write (bun's cache, git's config lookups): the per-command one above;
//   - git reads in repos root owns (the live clone, /vessels). Git refuses those as "dubious
//     ownership" for another user, so safe.directory=* is passed on the command scope
//     (GIT_CONFIG_*, a protected scope git honours for it). It widens nothing: the child can
//     only do there what its uid may, which is read;
//   - a writable default cwd for bounded_shell (agentWritableDir; /workspace/tmp is root 0755).
//
// FAILS CLOSED. Without setpriv the spawn fails, so the command does not run as root.
import { chmodSync, lchownSync, lstatSync, mkdirSync, mkdtempSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** nobody:nogroup, the account the image already carries. */
export const AGENT_SHELL_UID = 65534;
export const AGENT_SHELL_GID = 65534;

export const SETPRIV_ARGS: readonly string[] = [
  `--reuid=${AGENT_SHELL_UID}`, `--regid=${AGENT_SHELL_GID}`, "--clear-groups",
  "--inh-caps=-all", "--bounding-set=-all", "--no-new-privs",
];

export const runningAsRoot = (): boolean => process.getuid?.() === 0;

/** A real directory (not a symlink) owned by root that only root can write. */
function rootOnly(dir: string): boolean {
  try {
    const s = lstatSync(dir);
    return s.isDirectory() && !s.isSymbolicLink() && s.uid === 0 && (s.mode & 0o022) === 0;
  } catch { return false; }
}

/** Give a directory root just made, inside a root-only parent, to the shell user. */
function handOver(dir: string): string {
  if (!rootOnly(dirname(dir))) throw new Error(`refusing to hand ${dir} to the shell user: its parent is not a root-only directory`);
  const s = lstatSync(dir);
  if (!s.isDirectory() || s.isSymbolicLink()) throw new Error(`refusing to hand ${dir} to the shell user: not a real directory`);
  lchownSync(dir, AGENT_SHELL_UID, AGENT_SHELL_GID);
  return dir;
}

/**
 * Make `dir` (created if missing) writable by the shell user. As root its parent must be a
 * root-only directory, so the shell user cannot have planted or swapped the entry.
 */
export function agentWritableDir(dir: string, root = runningAsRoot()): string {
  if (!root) { mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; }
  if (!rootOnly(dirname(dir))) throw new Error(`refusing to hand ${dir} to the shell user: its parent is not a root-only directory`);
  try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  return handOver(dir);
}

let homesParent: string | undefined;

/** The root-only directory per-command HOMEs are made in: fresh (mkdtemp, never a symlink), 0755. */
function homes(tmp: string): string {
  if (homesParent && rootOnly(homesParent)) return homesParent;
  const d = mkdtempSync(join(tmp, "agent-shell-"));
  chmodSync(d, 0o755);
  homesParent = d;
  return d;
}

/**
 * The argv and env an agent shell command is spawned with, and what to do once it has exited.
 * `env` is the allowlisted env from agentShellEnv; nothing changes unless this vessel runs as root.
 */
export function agentShellSpawn(argv: string[], env: Record<string, string>, tmp: string, root = runningAsRoot()): { argv: string[]; env: Record<string, string>; done: () => Promise<void> } {
  if (!root) return { argv, env, done: async () => {} };
  const home = handOver(mkdtempSync(join(homes(tmp), "home-")));
  return {
    argv: ["setpriv", ...SETPRIV_ARGS, "--", ...argv],
    env: {
      ...env,
      HOME: home,
      BUN_INSTALL_CACHE_DIR: agentWritableDir(join(homes(tmp), "bun-cache"), root),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "*",
    },
    // Emptied as the shell user, so root never walks a tree the child shaped; the entry itself
    // sits in a root-only parent, so only root can remove it, and only once it is empty. Callers
    // do not await it (see above); the promise is there for tests.
    done: () => {
      const rmdir = () => { try { rmdirSync(home); } catch { /* something still in it (a process the command left): leave it */ } };
      try {
        return Bun.spawn(["setpriv", ...SETPRIV_ARGS, "--", "find", home, "-mindepth", "1", "-delete"], { stdout: "ignore", stderr: "ignore" }).exited.then(rmdir, () => {});
      } catch { return Promise.resolve(); } // a spawn that throws leaves the HOME; it must not escape a caller's finally
    },
  };
}
