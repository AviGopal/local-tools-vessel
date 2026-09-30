// The environment an agent-issued shell command runs with.
//
// Secrets live with the resolver that uses them and are never revealed to the
// agent. A shell command can run anything, so it must not see them: this vessel's
// own process env carries the fleet's credentials (token-signing secrets, the
// database password, provider keys, the push PAT) because systemd loads
// /etc/substrate/env into it, and both shell spawn sites used to hand the child
// `{ ...process.env }` — so every agent command inherited every credential.
//
// This is an ALLOWLIST, never a denylist: the env file's set of names is open
// (a new provider key is one line away), so anything not named here is dropped,
// however innocuous its name. What a command legitimately needs was established
// from the commands actually sent (git, bun test, bun run typecheck, curl to
// discovery, and the compose verify pipeline, which already runs its tests under
// `env -i PATH="$PATH" HOME="$HOME" ...`): they read PATH and HOME and nothing else
// from the inherited env. Endpoints are not passed either — a command that needs a
// shaped read should go through a resolver, which holds its own credential.

/** Exact names passed through from the vessel env when present. */
export const AGENT_SHELL_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "LANG",
  "LANGUAGE",
  "TERM",
  "TZ",
  "TMPDIR",
  "SUBSTRATE_EXECUTION_ID",
];

/** Name prefixes passed through (locale categories only). */
export const AGENT_SHELL_ENV_ALLOWED_PREFIXES: readonly string[] = ["LC_"];

function allowed(name: string): boolean {
  return AGENT_SHELL_ENV_ALLOWLIST.includes(name) ||
    AGENT_SHELL_ENV_ALLOWED_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Build the child env for an agent shell command. `base` is the vessel env (pass
 * `process.env`); `extra` carries per-request values such as SUBSTRATE_EXECUTION_ID.
 * The allowlist is applied to the MERGED result, so `extra` cannot smuggle in a
 * name the allowlist does not carry. PATH gets bun's directory prepended, because
 * bun lives only under $HOME/.bun/bin and `bun run typecheck` exits 127 without it.
 */
export function agentShellEnv(
  base: Record<string, string | undefined>,
  extra?: Record<string, string | undefined>,
): Record<string, string> {
  const merged: Record<string, string | undefined> = { ...base, ...(extra ?? {}) };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (typeof v === "string" && allowed(k)) out[k] = v;
  }
  const bunDir = `${base.HOME ?? "/root"}/.bun/bin`;
  out.PATH = `${bunDir}:${base.PATH ?? ""}`;
  return out;
}
