import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { errorOf, useTestApp } from "../helpers/api";

/** A stand-in for `npm run build:web` output: the shell, hashed assets and a public file. */
const dist = mkdtempSync(join(tmpdir(), "fdfs-web-"));
mkdirSync(join(dist, "assets"));
const INDEX =
  '<!doctype html><title>FDFS</title><script type="module" src="/app/assets/index-a1b2c3.js"></script>';
writeFileSync(join(dist, "index.html"), INDEX);
writeFileSync(join(dist, "assets", "index-a1b2c3.js"), "export const x = 1;\n");
writeFileSync(join(dist, "assets", "index-d4e5f6.css"), "body{margin:0}\n");
writeFileSync(join(dist, "favicon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
afterAll(() => rmSync(dist, { recursive: true, force: true }));

describe("the built UI under /app/", () => {
  // MAX_QUEUE=1 so the admission test below can fill the only slot.
  const t = useTestApp({ WEB_DIST_DIR: dist, MAX_QUEUE: "1" });
  const get = (url: string) => t.app.inject({ url });

  const expectShell = (res: Awaited<ReturnType<typeof get>>, url: string) => {
    expect(res.statusCode, url).toBe(200);
    expect(res.headers["content-type"], url).toMatch(/^text\/html/);
    expect(res.body, url).toBe(INDEX);
    expect(res.headers["cache-control"], url).toBe("no-cache");
    expect(res.headers["x-content-type-options"], url).toBe("nosniff");
    const csp = String(res.headers["content-security-policy"]);
    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
    ]) {
      expect(csp, url).toContain(directive);
    }
    expect(csp, url).not.toMatch(/script-src[^;]*unsafe/);
  };

  it("redirects / and /app to /app/", async () => {
    for (const url of ["/", "/app"]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(302);
      expect(res.headers.location, url).toBe("/app/");
    }
  });

  it("serves the shell at /app/ and /app/index.html, never cached, with a strict CSP", async () => {
    for (const url of ["/app/", "/app/index.html"]) expectShell(await get(url), url);
    expect((await get("/app/")).headers["referrer-policy"]).toBe("same-origin");
  });

  it("serves the shell for client routes (paths without an extension)", async () => {
    for (const url of [
      "/app/login",
      "/app/shows",
      "/app/shows/new",
      "/app/shows/7b0c2f8e-1d0a-4c55-9a62-2f1f0d1e2a3b",
      "/app/shows?tab=live",
      "/app/deep/nested/route/",
    ]) {
      expectShell(await get(url), url);
    }
  });

  it("serves hashed assets as immutable with the right content type and no CSP", async () => {
    const js = await get("/app/assets/index-a1b2c3.js");
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toMatch(/javascript/);
    expect(js.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(js.headers["x-content-type-options"]).toBe("nosniff");
    expect(js.headers["content-security-policy"]).toBeUndefined();
    expect(js.body).toBe("export const x = 1;\n");

    const css = await get("/app/assets/index-d4e5f6.css");
    expect(css.statusCode).toBe(200);
    expect(css.headers["content-type"]).toMatch(/^text\/css/);
    expect(css.headers["cache-control"]).toMatch(/immutable/);
  });

  it("serves public files outside assets/ uncached", async () => {
    const svg = await get("/app/favicon.svg");
    expect(svg.statusCode).toBe(200);
    expect(svg.headers["content-type"]).toMatch(/^image\/svg\+xml/);
    expect(svg.headers["cache-control"]).toBe("no-cache");
  });

  it("a missing file is a JSON 404, not the shell (a stale script tag must fail loudly)", async () => {
    for (const url of ["/app/assets/index-old999.js", "/app/robots.txt", "/app/shows/x.png"]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.headers["content-type"], url).toMatch(/application\/json/);
      expect(errorOf(res), url).toMatchObject({
        code: "not_found",
        request_id: expect.any(String),
      });
    }
  });

  it("never serves files outside the build directory", async () => {
    for (const url of [
      "/app/../package.json",
      "/app/%2e%2e/package.json",
      "/app/..%2fpackage.json",
      "/app/assets/..%2f..%2fpackage.json",
      "/app/%2e%2e%2f%2e%2e%2f.env.example",
    ]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.body, url).not.toContain("firstdayfirstshow");
      expect(res.body, url).not.toContain("DATABASE_URL");
    }
  });

  it("leaves the API's own routes alone", async () => {
    const res = await get("/shows?limit=1");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["content-security-policy"]).toBeUndefined();
  });

  /**
   * Holds the only admission slot with a POST whose headers are sent but whose body never ends
   * (onRequest has run, the handler never will). Retries if the hold itself was shed.
   */
  async function holdSlot(): Promise<() => void> {
    const base = new URL(await t.listen());
    for (let attempt = 0; attempt < 5; attempt++) {
      let shed = false;
      const held = httpRequest({
        host: base.hostname,
        port: base.port,
        method: "POST",
        path: "/shows",
        headers: { "content-type": "application/json", "content-length": "1000", ...t.admin },
      });
      held.on("error", () => {});
      held.on("response", () => (shed = true));
      held.write("{");
      await new Promise((resolve) => held.once("socket", (s) => s.once("connect", resolve)));
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!shed && (await get("/shows?limit=1")).statusCode === 429) return () => held.destroy();
      held.destroy();
    }
    throw new Error("could not hold the admission slot");
  }

  it("is never shed by admission control while the API is at capacity", async () => {
    const release = await holdSlot();
    try {
      for (const url of ["/", "/app", "/app/", "/app/shows/new", "/app/assets/index-a1b2c3.js"]) {
        expect((await get(url)).statusCode, url).toBeLessThan(400);
      }
      expect((await get("/shows?limit=1")).statusCode).toBe(429);
    } finally {
      release();
    }
    await expect
      .poll(async () => (await get("/shows?limit=1")).statusCode, { timeout: 5_000 })
      .toBe(200);
  });
});

describe("an API-only process (no UI build)", () => {
  const t = useTestApp({ WEB_DIST_DIR: join(dist, "does-not-exist") });

  it("still redirects / to /app/, which explains the UI is not built", async () => {
    const root = await t.app.inject({ url: "/" });
    expect(root.statusCode).toBe(302);
    expect(root.headers.location).toBe("/app/");

    for (const url of ["/app/", "/app/shows", "/app/assets/index-a1b2c3.js"]) {
      const res = await t.app.inject({ url });
      expect(res.statusCode, url).toBe(404);
      expect(errorOf(res), url).toMatchObject({
        code: "not_found",
        message: expect.stringMatching(/npm run build/),
      });
    }
  });
});
