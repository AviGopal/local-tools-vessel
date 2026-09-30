// Confines this vessel's IN-PROCESS file tools (fs_read, fs_write, fs_edit, the
// code_* family) to the roots they serve.
//
// Secrets live with the resolver that uses them and are never revealed to the
// agent. These tools run inside this vessel's own process, as root, with the
// fleet's credentials in its env — so an absolute path passed straight through
// could read /etc/substrate/env, /workspace/.substrate-secrets or
// /proc/self/environ and hand the contents back to whoever asked. mapPath only
// rewrites `repos/…` and relative paths; it never refused anything.
//
// The rule is locality, not a path denylist: a tool touches a path only if its
// FULLY RESOLVED location (symlinks followed) lies under one of the roots the
// vessel already serves. Everything else is refused before any read or write.
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Locations that must never fall inside a tool root. A configured root that
 * equals, contains or lies inside one of these is dropped rather than trusted —
 * so a misconfigured root such as "/" or "/workspace" cannot silently re-open them.
 */
export const NEVER_INSIDE_A_ROOT: readonly string[] = ["/etc", "/proc", "/workspace/.substrate-secrets"];

function within(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve a path to where it really lives: realpath when it exists; otherwise
 * realpath of the nearest existing ancestor plus the not-yet-existing tail (a
 * new file for fs_write, possibly in new directories). Returns null only if
 * nothing on the way up can be resolved.
 */
export function realLocation(p: string): string | null {
  let cur = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
      const parent = dirname(cur);
      if (parent === cur) return null;
      tail.push(cur.slice(parent.length).replace(/^\/+/, ""));
      cur = parent;
    }
  }
}

/**
 * The tool roots, fully resolved, from the vessel's existing root configuration.
 * Unset/empty entries are skipped; a root that equals or contains a
 * NEVER_INSIDE_A_ROOT location is dropped.
 */
export function toolRoots(configured: Array<string | undefined>): string[] {
  const out: string[] = [];
  for (const r of configured) {
    if (!r || !isAbsolute(r)) continue;
    const real = realLocation(r) ?? resolve(r);
    // Drop a root that contains a protected location, or lies inside one.
    const protectedHit = NEVER_INSIDE_A_ROOT.some((n) => {
      const rn = realLocation(n) ?? n;
      return within(rn, real) || within(n, real) || within(real, rn) || within(real, n);
    });
    if (protectedHit) continue;
    if (!out.includes(real)) out.push(real);
  }
  return out;
}

/**
 * Returns the fully resolved path if it lies under one of `roots`, else null.
 * `resolved` should already be absolute (mapPath output); a relative value is
 * resolved against the process cwd, which lies under no root in production.
 */
export function confinePath(resolved: string | undefined, roots: readonly string[]): string | null {
  if (!resolved) return null;
  const real = realLocation(resolved);
  if (!real) return null;
  for (const root of roots) if (within(real, root)) return real;
  return null;
}

export const OUTSIDE_ROOTS_ERROR = "path outside the tool roots";

/**
 * Workspace data directories the file tools serve. There is no existing root
 * setting for these — callers name them as literal `/workspace/<dir>` paths
 * (activity templates writing reports, observations and pattern clusters) — so
 * the list is the measured inventory of what callers pass, not a guess. The
 * workspace itself is NOT a root: it also holds .substrate-secrets, keys/ and
 * env/, which no tool call needs.
 */
export const WORKSPACE_DATA_DIRS: readonly string[] = [
  "proposals", "observations", "patterns", "validation", "refinement", "openspec",
  "snapshots", "health-gap-closures", "findings", "gaps", "concept-ingest", "concepts",
  "repos", "scripts/substrate/units",
];

/**
 * The configured roots, from the settings the fleet already uses for them:
 * WORKSPACE_ROOT (this vessel's relative-path anchor), MITOSIS_RUNTIME_DIR (the
 * running vessel tree), MITOSIS_PUSH_CLONE_DIR and COMPOSE_WS_DIR (the clones and
 * compose worktrees /vessels symlinks point into; defaults as in
 * development-vessel's compose-workspace.ts), EXTRA_WORKSPACE_ROOTS (the fleet's
 * existing comma-separated extension), the temp dir, and the data dirs above.
 */
export function configuredToolRoots(env: Record<string, string | undefined>, tmp: string): string[] {
  const workspace = "/workspace";
  return toolRoots([
    env.WORKSPACE_ROOT ?? workspace,
    env.MITOSIS_RUNTIME_DIR ?? "/vessels",
    env.MITOSIS_PUSH_CLONE_DIR ?? `${workspace}/git/vessels`,
    env.COMPOSE_WS_DIR ?? `${workspace}/git/compose`,
    ...(env.EXTRA_WORKSPACE_ROOTS ?? "").split(",").map((s) => s.trim()),
    tmp,
    ...WORKSPACE_DATA_DIRS.map((d) => `${workspace}/${d}`),
  ]);
}

/**
 * What a file tool operates on: undefined when no path was given (the tool's own
 * "required" error applies), null when the path is outside every root (refuse
 * before any fs access), otherwise the mapped path unchanged.
 */
export function toolPathWithin(mapped: string | undefined, roots: readonly string[]): string | undefined | null {
  if (!mapped) return undefined;
  return confinePath(mapped, roots) === null ? null : mapped;
}
