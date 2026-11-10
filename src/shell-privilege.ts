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
// WHAT THE CHILD STILL NEEDS:
//   - a HOME it can write (bun's cache, git's config lookups). It gets its own directory under
//     tmp, owned by the shell user, never the vessel's /root;
//   - git reads in repos root owns (the live clone, /vessels). Git refuses those as "dubious
//     ownership" for another user, so safe.directory=* is passed on the command scope
//     (GIT_CONFIG_*, a protected scope git honours for it). It widens nothing: the child can
//     only do there what its uid may, which is read;
//   - a writable default cwd for bounded_shell; see agentWritableDir.
//
// FAILS CLOSED. Without setpriv the spawn fails, so the command does not run as root.
import { chownSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** nobody:nogroup, the account the image already carries. */
export const AGENT_SHELL_UID = 65534;
export const AGENT_SHELL_GID = 65534;

export const SETPRIV_ARGS: readonly string[] = [
  `--reuid=${AGENT_SHELL_UID}`, `--regid=${AGENT_SHELL_GID}`, "--clear-groups",
  "--inh-caps=-all", "--bounding-set=-all", "--no-new-privs",
];

export const runningAsRoot = (): boolean => process.getuid?.() === 0;

/** Make `dir` (created if missing) owned by the shell user, so the dropped child can write it. */
export function agentWritableDir(dir: string, root = runningAsRoot()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (root) chownSync(dir, AGENT_SHELL_UID, AGENT_SHELL_GID);
  return dir;
}

/**
 * The argv and env an agent shell command is spawned with. `env` is the allowlisted env from
 * agentShellEnv; the result is unchanged unless this vessel runs as root.
 */
export function agentShellSpawn(argv: string[], env: Record<string, string>, tmp: string, root = runningAsRoot()): { argv: string[]; env: Record<string, string> } {
  if (!root) return { argv, env };
  return {
    argv: ["setpriv", ...SETPRIV_ARGS, "--", ...argv],
    env: {
      ...env,
      HOME: agentWritableDir(join(tmp, "agent-shell-home"), root),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "*",
    },
  };
}
