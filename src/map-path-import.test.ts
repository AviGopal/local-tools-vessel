// CHECK-FIRST, ENVIRONMENT-INDEPENDENT: importing ./index for mapPath has no side effects.
//
// src/map-path.test.ts imports mapPath from ./index, and index.ts runs
// `await new VesselDaemon({ port: PORT, ... }).start()` at module top level. So the import binds
// port 8230, registers with discovery and keeps the process alive. That suite therefore went red
// only where something already held 8230 (the lane, beside the live vessel) and green on any host
// with the port free — its verdict measured the venue, not the defect, and it asserts nothing
// about the side effect itself.
//
// This file measures the side effect directly and makes the venue irrelevant: each case runs the
// import in a CHILD process (never in this one, which would start a daemon here), with PORT set to
// a port this test controls and DISCOVERY_ENDPOINT pointed at a recording fake, so no request can
// reach a real discovery. The "port held" case holds the port itself instead of hoping someone
// else does.
//
// CONTROL: an over-broad repair that deletes the daemon start (or its discovery registration)
// passes the import cases, so running index.ts AS THE ENTRYPOINT must still serve /health on PORT
// and register with discovery.
import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const INDEX = pathToFileURL(join(import.meta.dir, "index.ts")).href;
const INDEX_PATH = join(import.meta.dir, "index.ts");

type Fake = { url: string; hits: string[]; stop: () => void };

function fakeDiscovery(): Fake {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      hits.push(`${req.method} ${new URL(req.url).pathname}`);
      return Response.json({ ok: true });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, hits, stop: () => server.stop(true) };
}

function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: "0.0.0.0", fetch: () => new Response("x") });
  const p = s.port as number;
  s.stop(true);
  return p;
}

function childEnv(port: number, discovery: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    PORT: String(port),
    DISCOVERY_ENDPOINT: discovery,
    // A dummy key: the daemon only registers with discovery when it has one.
    METABOB_API_KEY: "map-path-import-test-key",
    LOCAL_TOOLS_GC_INTERVAL_MS: "3600000",
  };
}

type Run = { code: number | null; out: string; err: string; timedOut: boolean };

async function runChild(args: string[], env: Record<string, string>, budgetMs: number): Promise<Run> {
  const p = Bun.spawn([process.execPath, ...args], { env, stdout: "pipe", stderr: "pipe", cwd: import.meta.dir });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; p.kill("SIGKILL"); }, budgetMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { code: timedOut ? null : code, out, err, timedOut };
}

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) { try { cleanups.pop()!(); } catch { /* best effort */ } } });

describe("importing src/index for mapPath has no side effects (venue-independent)", () => {
  it("MUST-FAIL: importing ./index while its PORT is already held still yields mapPath (the import starts no server)", async () => {
    const disco = fakeDiscovery(); cleanups.push(disco.stop);
    const holder = Bun.serve({ port: 0, hostname: "0.0.0.0", fetch: () => new Response("held") });
    cleanups.push(() => holder.stop(true));
    const script = `const m = await import(${JSON.stringify(INDEX)}); console.log("MAPPED=" + JSON.stringify(m.mapPath("repos/goal-host-vessel/src/index.ts"))); process.exit(0);`;
    const r = await runChild(["-e", script], childEnv(holder.port as number, disco.url), 20_000);
    expect({ code: r.code, mapped: r.out.split("\n").find((l) => l.startsWith("MAPPED=")) ?? null })
      .toEqual({ code: 0, mapped: `MAPPED="/vessels/goal-host-vessel/src/index.ts"` });
  }, 30_000);

  it("MUST-FAIL: importing ./index binds no listener, contacts no discovery, and lets the process exit on its own", async () => {
    const disco = fakeDiscovery(); cleanups.push(disco.stop);
    const port = freePort();
    // After the import the child tries to bind PORT itself, then simply returns: a module with
    // no side effects leaves nothing holding the event loop open.
    const script = [
      `const m = await import(${JSON.stringify(INDEX)});`,
      `if (typeof m.mapPath !== "function") throw new Error("mapPath not exported");`,
      `let state = "PORT_FREE";`,
      `try { const s = Bun.serve({ port: ${port}, hostname: "0.0.0.0", fetch: () => new Response("x") }); s.stop(true); } catch { state = "PORT_HELD"; }`,
      `console.log(state);`,
    ].join("\n");
    const r = await runChild(["-e", script], childEnv(port, disco.url), 15_000);
    // Give any in-flight registration a moment to land before reading the fake's log.
    await Bun.sleep(200);
    expect({
      exitedOnItsOwn: !r.timedOut,
      code: r.code,
      port: r.out.includes("PORT_FREE") ? "free" : r.out.includes("PORT_HELD") ? "held" : "unknown",
      discoveryRequests: disco.hits,
    }).toEqual({ exitedOnItsOwn: true, code: 0, port: "free", discoveryRequests: [] });
  }, 30_000);

  it("CONTROL: running src/index.ts as the entrypoint still serves /health on PORT and registers with discovery", async () => {
    const disco = fakeDiscovery(); cleanups.push(disco.stop);
    const port = freePort();
    const p = Bun.spawn([process.execPath, INDEX_PATH], { env: childEnv(port, disco.url), stdout: "ignore", stderr: "ignore", cwd: import.meta.dir });
    // SIGKILL, not SIGTERM: SIGTERM starts the daemon's bounded drain (minutes by default).
    cleanups.push(() => p.kill("SIGKILL"));
    let health: { status?: string; vesselId?: string } | null = null;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && health === null) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) });
        if (res.ok) health = (await res.json()) as { status?: string; vesselId?: string };
      } catch { /* not up yet */ }
      if (health === null) await Bun.sleep(250);
    }
    const regDeadline = Date.now() + 5_000;
    while (Date.now() < regDeadline && disco.hits.length === 0) await Bun.sleep(100);
    expect({ status: health?.status ?? null, vesselId: health?.vesselId ?? null, registered: disco.hits.length > 0 })
      .toEqual({ status: "healthy", vesselId: "local-tools-vessel", registered: true });
  }, 40_000);
});
