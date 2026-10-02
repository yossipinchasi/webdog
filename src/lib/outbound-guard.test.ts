import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { checkOutboundUrl, guardedLookup, OutboundBlockedError, postJson } from "./outbound-guard";

// SSRF guard: validation at save time and enforcement at connection time.

const resolveTo = (...addresses: string[]) => async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
const strict = { allowPrivate: false };

test("check: http(s) only", async () => {
  for (const url of ["ftp://example.com/x", "file:///etc/passwd", "javascript:alert(1)", "not a url"]) {
    assert.equal((await checkOutboundUrl(url, { ...strict, resolve: resolveTo("93.184.216.34") })).ok, false, url);
  }
});

test("check: private and special IP literals are refused, including disguised forms", async () => {
  for (const url of [
    "http://127.0.0.1:8080/hook",
    "http://10.0.0.5/hook",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/hook",
    "http://[::ffff:127.0.0.1]/hook",
    "http://[fd12::1]:8080/hook",
    "http://2130706433/hook", // decimal 127.0.0.1, normalized by the URL parser
    "http://0x7f.0.0.1/hook", // hex/octal forms, also normalized
    "http://0/hook",
  ]) {
    const r = await checkOutboundUrl(url, { ...strict, resolve: resolveTo("93.184.216.34") });
    assert.equal(r.ok, false, url);
  }
  assert.deepEqual(await checkOutboundUrl("https://93.184.216.34/hook", strict), { ok: true });
});

test("check: a hostname is refused if ANY resolved address is non-public", async () => {
  const onlyPrivate = await checkOutboundUrl("https://intranet.example/hook", { ...strict, resolve: resolveTo("10.1.2.3") });
  assert.deepEqual(onlyPrivate, { ok: false, reason: "intranet.example resolves to 10.1.2.3, a private network address." });
  const mixed = await checkOutboundUrl("https://mixed.example/hook", { ...strict, resolve: resolveTo("93.184.216.34", "127.0.0.1") });
  assert.equal(mixed.ok, false);
  assert.equal((await checkOutboundUrl("https://localhost/hook", { ...strict, resolve: resolveTo("127.0.0.1", "::1") })).ok, false);
  assert.deepEqual(await checkOutboundUrl("https://hooks.example/x", { ...strict, resolve: resolveTo("93.184.216.34", "2606:4700::1") }), { ok: true });
});

test("check: unresolvable hosts are refused", async () => {
  const r = await checkOutboundUrl("https://nope.invalid/hook", {
    ...strict,
    resolve: async () => {
      throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    },
  });
  assert.deepEqual(r, { ok: false, reason: "nope.invalid does not resolve." });
  assert.equal((await checkOutboundUrl("https://empty.example/", { ...strict, resolve: resolveTo() })).ok, false);
});

test("check: the development override allows private targets", async () => {
  assert.deepEqual(await checkOutboundUrl("http://127.0.0.1:4789/hook", { allowPrivate: true }), { ok: true });
});

function lookupOnce(lookup: ReturnType<typeof guardedLookup>, host: string, options: object) {
  return new Promise<{ err: Error | null; address: unknown; family?: number }>((resolve) =>
    lookup(host, options as never, ((err: Error | null, address: unknown, family?: number) => resolve({ err, address, family })) as never),
  );
}

test("guarded lookup: refuses non-public results, returns public ones in both callback shapes", async () => {
  const blocked = await lookupOnce(guardedLookup(resolveTo("192.168.0.10")), "rebind.example", {});
  assert.ok(blocked.err instanceof OutboundBlockedError);
  assert.match(blocked.err!.message, /resolves to 192\.168\.0\.10/);

  const single = await lookupOnce(guardedLookup(resolveTo("93.184.216.34")), "ok.example", {});
  assert.deepEqual([single.err, single.address, single.family], [null, "93.184.216.34", 4]);

  const all = await lookupOnce(guardedLookup(resolveTo("93.184.216.34", "2606:4700::1")), "ok.example", { all: true });
  assert.equal(all.err, null);
  assert.equal((all.address as unknown[]).length, 2);

  const v6only = await lookupOnce(guardedLookup(resolveTo("93.184.216.34", "2606:4700::1")), "ok.example", { family: 6 });
  assert.deepEqual([v6only.address, v6only.family], ["2606:4700::1", 6]);
});

// A real local receiver, to prove what does and does not reach the network.
let server: http.Server;
let port = 0;
const received: { url: string; body: string }[] = [];
before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c));
    req.on("end", () => {
      received.push({ url: req.url ?? "", body });
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
      } else if (req.url === "/slow") {
        setTimeout(() => res.writeHead(200).end("late"), 2_000);
      } else if (req.url === "/busy") {
        res.writeHead(503, { "retry-after": "120" }).end("busy");
      } else if (req.url === "/big") {
        res.writeHead(500).end("x".repeat(200_000));
      } else {
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
after(() => server.close());

test("post: a private IP literal is refused before any request is sent", async () => {
  const before = received.length;
  await assert.rejects(postJson(`http://127.0.0.1:${port}/hook`, "{}", { timeoutMs: 2_000, allowPrivate: false }), OutboundBlockedError);
  assert.equal(received.length, before, "nothing reached the receiver");
});

test("post: DNS rebinding — a hostname resolving to loopback at connect time is refused", async () => {
  const before = received.length;
  await assert.rejects(
    postJson(`http://rebind.example:${port}/hook`, "{}", { timeoutMs: 2_000, allowPrivate: false, resolve: resolveTo("127.0.0.1") }),
    (err: Error) => err instanceof OutboundBlockedError && /resolves to 127\.0\.0\.1, a loopback address/.test(err.message),
  );
  assert.equal(received.length, before, "nothing reached the receiver");
});

test("post: allowed targets are delivered; status and body are returned", async () => {
  const res = await postJson(`http://127.0.0.1:${port}/hook`, '{"a":1}', {
    timeoutMs: 2_000,
    allowPrivate: true,
    headers: { "content-type": "application/json" },
  });
  assert.deepEqual(res, { status: 200, body: '{"ok":true}', retryAfter: null });
  assert.equal(received.at(-1)?.body, '{"a":1}');
});

test("post: the Retry-After header is returned as sent", async () => {
  const res = await postJson(`http://127.0.0.1:${port}/busy`, "{}", { timeoutMs: 2_000, allowPrivate: true });
  assert.deepEqual(res, { status: 503, body: "busy", retryAfter: "120" });
});

test("post: redirects are not followed", async () => {
  const res = await postJson(`http://127.0.0.1:${port}/redirect`, "{}", { timeoutMs: 2_000, allowPrivate: true });
  assert.equal(res.status, 302);
  assert.equal(received.filter((r) => r.url.includes("meta-data")).length, 0);
});

test("post: timeouts reject; oversized responses are capped", async () => {
  await assert.rejects(postJson(`http://127.0.0.1:${port}/slow`, "{}", { timeoutMs: 200, allowPrivate: true }), (err: Error) =>
    ["AbortError", "TimeoutError"].includes(err.name),
  );
  const big = await postJson(`http://127.0.0.1:${port}/big`, "{}", { timeoutMs: 2_000, allowPrivate: true });
  assert.equal(big.status, 500);
  assert.equal(big.body.length, 64 * 1024);
});
