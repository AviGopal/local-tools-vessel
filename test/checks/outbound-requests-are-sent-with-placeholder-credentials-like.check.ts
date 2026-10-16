import { afterAll, describe, expect, it } from "bun:test";

// This check reproduces the gap: outbound requests proceed even when the configured
// credential is an obvious placeholder value (e.g. "YOUR_API_KEY"). Evidence named
// symbol: apiKey (constructed in src/index.ts's webSearch resolver from OPENROUTER_API_KEY).
// We stub global fetch to avoid any real network and to capture calls. Then we invoke the
// resolver and assert that a placeholder should block the send — which currently fails.

// Make sure any module-load-time networking (discovery registration) is also caught by our stub.
const calls: Array<{ url: string; headers: Record<string, string> | Headers | undefined }> = [];
const origFetch: typeof fetch = globalThis.fetch;
const fakeFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  // Headers may be a Headers object or a plain Record; keep as-is for inspection.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const headers = (init?.headers as any) as Record<string, string> | Headers | undefined;
  calls.push({ url, headers });
  // Return a minimal OK response for any caller that awaits .json().
  return new Response(JSON.stringify({ choices: [{ message: { annotations: [] } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

// Pick a random high port before importing the module: index.ts starts a server at import time.
process.env["PORT"] = String(20000 + Math.floor(Math.random() * 10000));
// Discovery endpoint (if consulted) will be handled by our stubbed fetch; value here is irrelevant.
process.env["DISCOVERY_ENDPOINT"] = "http://127.0.0.1:0";
// Install the fetch stub before importing the module under test so all outbound calls are captured.
// The test itself will reset the calls array before invoking the resolver we exercise.
// This ensures no actual network is used by this file.
globalThis.fetch = fakeFetch;

import * as mod from "../../src/index";

afterAll(() => {
  globalThis.fetch = origFetch;
});

describe("outbound-requests-are-sent-with-placeholder-credentials-like", () => {
  it("MUST-FAIL refuses sending web_search when OPENROUTER_API_KEY='YOUR_API_KEY' (should block before fetch)", async () => {
    // Prepare: a clearly placeholder credential value.
    process.env.OPENROUTER_API_KEY = "YOUR_API_KEY";

    // Isolate only the resolver call we care about; ignore any module-load-time hits.
    calls.length = 0;

    // Find the web_search resolver from the module namespace. Prefer the resolver map if exported,
    // otherwise fall back to a direct export (both patterns are supported by index.ts in this codebase).
    const maybeMap = (mod as unknown as { resolvers?: Map<string, unknown> }).resolvers;
    const resolver: unknown = typeof maybeMap?.get === "function" ? maybeMap!.get("web_search") : (mod as any).webSearch;

    expect(typeof resolver).toBe("function");

    // Invoke with a minimal valid input (query is the only required pointer field).
    const ctx = { body: { impulse: { pointer: { query: "newsapi placeholder reproduction" } } } } as const;
    const out = await (resolver as (c: unknown) => Promise<unknown>)(ctx);
    void out; // We assert on side effects (attempted outbound call), not the returned shape.

    // The defect: a placeholder credential should be refused BEFORE any fetch() call is attempted.
    // Today it isn't — Authorization: Bearer YOUR_API_KEY is sent to openrouter.ai.
    // This assertion is intentionally expected to fail until the defect is fixed.
    const openrouterCalls = calls.filter(c => c.url.includes("openrouter.ai"));
    expect(openrouterCalls.length).toBe(0);

    // Diagnostic (non-failing) note: if you need to see what was actually sent during local runs,
    // uncomment below — it shows the leaked placeholder in headers.
    // console.error(openrouterCalls.map(c => ({ url: c.url, auth: (c.headers instanceof Headers) ? c.headers.get('authorization') : c.headers?.["Authorization"] || c.headers?.["authorization"] })));
  });
});
