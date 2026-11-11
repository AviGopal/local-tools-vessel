// The walk's record of a change clone, read from records through discovery. git_worktree's answer is the output of the
// walk's ended hop for that call, so what a clone's base is lives in a row the shell user cannot write (it holds no
// records key), not in a file beside the clone. A commit or a landing in a clone takes its base from that row.
//
// The read goes through discovery, the one configured endpoint, and under METABOB_API_KEY, which on a node is the node
// key every vessel there holds: the same identity and route as every other service. With no discovery endpoint
// configured the read is refused rather than sent to an address written here (index.ts and script-runner.ts still carry
// such a fallback: named debt). A row with role walk is trusted as far as the node key is: any vessel on the node could
// write one, a person key or the shell user (which holds no key) cannot.

export type Made = { cwd: string; repo: string; branch: string; base: string; super_base: string; origin_url: string };
export type Row = { id: string; shape?: string; role?: string; pointer_type?: string; phase?: string; output?: Record<string, unknown>; [k: string]: unknown };

export type Query = { shape?: string; where?: Record<string, unknown>; ids?: string[] };

/** Rows matching a records query (a shape, top-level field equality, ids), read from records through discovery. */
export const readRows = async (q: Query): Promise<Row[] | { error: string }> => {
  const discovery = process.env.DISCOVERY_ENDPOINT?.trim();
  if (!discovery) return { error: "no discovery endpoint is configured: the walk's rows cannot be read" };
  const key = process.env.METABOB_API_KEY ?? "";
  try {
    const r = await fetch(new URL("/resolve", discovery).href, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `ApiKey ${key}` } : {}) },
      body: JSON.stringify({ pointer: { type: "record_read", ...q } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return { error: `records answered ${r.status} for ${q.shape ?? "the"} rows` };
    const body = (await r.json()) as unknown;
    const rows = Array.isArray(body) ? body : (body as { content?: unknown })?.content;
    return Array.isArray(rows) ? (rows as Row[]) : { error: `records answered no list for ${q.shape ?? "the"} rows` };
  } catch (e) {
    return { error: `records could not be read: ${(e as Error).name}` };
  }
};

const readHops = (pointerType: string) => readRows({ shape: "hop", where: { pointer_type: pointerType, phase: "ended" } });

/**
 * The one change clone the walk made at `cwd` and has not landed. A walk-written git_worktree row must name it: none
 * means git_worktree did not make it, and is refused. Several may, since git_worktree hands an unchanged clone out again
 * rather than making another; they must agree on the repo, branch, base and origin (rows that disagree are a collision,
 * refused), and the latest one's super_base, the super-repo HEAD whose hooks judge, is the one that holds. `where`
 * matches top-level fields only, so the rows are git_worktree's ended hops and their cwd is matched here: a bounded set,
 * the clones made, not every hop.
 */
export async function madeClone(cwd: string): Promise<Made | { error: string }> {
  const made = await readHops("git_worktree");
  if (!Array.isArray(made)) return made;
  const mine = made.filter((r) => r.role === "walk" && r.output?.cwd === cwd).sort((a, b) => Number(a.seq) - Number(b.seq))
  if (mine.length === 0) return { error: `no walk row records a clone made at ${cwd}: a commit or landing needs one` };
  const same = (k: string) => new Set(mine.map((r) => String(r.output?.[k] ?? ""))).size === 1;
  if (!["repo", "branch", "base", "origin_url"].every(same)) {
    return { error: `${mine.length} walk rows record different clones made at ${cwd}: a commit or landing needs one` };
  }
  const landed = await readHops("git_land");
  if (!Array.isArray(landed)) return landed;
  if (landed.some((r) => r.role === "walk" && r.output?.cwd === cwd)) return { error: `the clone at ${cwd} has already landed` };
  const o = mine[mine.length - 1].output ?? {};
  const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
  if (!s("base") || !s("super_base") || !s("repo") || !s("branch") || !s("origin_url")) {
    return { error: `the row for ${cwd} lacks its base, repo, branch or origin` };
  }
  return { cwd, repo: s("repo"), branch: s("branch"), base: s("base"), super_base: s("super_base"), origin_url: s("origin_url") };
}

/** The roots records lists as open for each walk (by its arm rows), or why they could not be read. */
export async function openRoots(walks: string[]): Promise<Set<string> | { error: string }> {
  const discovery = process.env.DISCOVERY_ENDPOINT?.trim();
  if (!discovery) return { error: "no discovery endpoint is configured: the open roots cannot be read" };
  const key = process.env.METABOB_API_KEY ?? "";
  const open = new Set<string>();
  for (const episode of walks) {
    try {
      const r = await fetch(new URL("/resolve", discovery).href, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(key ? { Authorization: `ApiKey ${key}` } : {}) },
        body: JSON.stringify({ pointer: { type: "record_read", episode, roots: "all" } }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) return { error: `records answered ${r.status} for the open roots` };
      const body = (await r.json()) as { roots?: unknown; content?: { roots?: unknown } };
      const roots = Array.isArray(body?.roots) ? body.roots : body?.content?.roots;
      if (!Array.isArray(roots)) return { error: "records answered no list of open roots" };
      for (const x of roots as Array<{ root?: { id?: unknown } }>) if (typeof x?.root?.id === "string") open.add(x.root.id);
    } catch (e) {
      return { error: `the open roots could not be read: ${(e as Error).name}` };
    }
  }
  return open;
}
