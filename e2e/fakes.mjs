// Local fakes: Context.dev, OpenAI, Resend, Slack (via intercept.mjs) and webhook receivers.
// Control: POST /_state (merge), GET /_log, POST /_reset-log.
import http from "node:http";
const state = { pages: {}, products: {}, fail: {}, delay: {}, headers: {}, aiReply: '{"matched":true,"reason":"The requested item is listed.","evidence":[]}' };
let log = [];
const json = (res, status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    if (p === "/_state") {
      // Merge maps key by key, so setting one page never drops another.
      for (const [k, v] of Object.entries(JSON.parse(body))) state[k] = v && typeof v === "object" ? { ...state[k], ...v } : v;
      return json(res, 200, state);
    }
    if (p === "/_log") return json(res, 200, log);
    if (p === "/_reset-log") { log = []; return json(res, 200, {}); }
    const entry = { at: Date.now(), method: req.method, path: p, query: Object.fromEntries(u.searchParams), headers: req.headers, body };
    log.push(entry);
    // Optional response delay per receiver token or scraped URL (race tests).
    const delayMs = state.delay[p.startsWith("/recv/") ? p.slice(6) : u.searchParams.get("url") ?? ""] ?? 0;
    if (delayMs > 0) return void setTimeout(() => respond(p, u, body, entry, res), delayMs);
    respond(p, u, body, entry, res);
  });
}).listen(4010, "127.0.0.1", () => console.log("fakes on 4010"));

function respond(p, u, body, entry, res) {
  {
    if (p.startsWith("/recv/")) {
      const tok = p.slice(6);
      const status = state.fail[tok] ?? 200;
      entry.status = status;
      res.writeHead(status, { "content-type": "application/json", ...(state.headers[tok] ?? {}) });
      return res.end(JSON.stringify({ ok: status < 300 }));
    }
    if (p.startsWith("/slack/")) { res.writeHead(200); return res.end("ok"); }
    if (p.startsWith("/resend/")) return json(res, 200, { id: "email_fake_1" });
    if (p.startsWith("/ctx/")) {
      const route = p.slice(4);
      if (route === "/web/scrape/markdown") {
        const page = state.pages[u.searchParams.get("url")];
        if (page === undefined || page?.error) return json(res, page?.error ?? 404, { message: "fake: page unavailable" });
        return json(res, 200, { success: true, markdown: page, url: u.searchParams.get("url") });
      }
      if (route === "/brand/ai/product") {
        const { url } = JSON.parse(body || "{}");
        const prod = state.products[url];
        if (!prod) return json(res, 404, { message: "fake: no product" });
        if (prod.error) return json(res, prod.error, { message: "fake: product error" });
        return json(res, 200, { is_product_page: true, platform: "shopify", product: { name: "Widget", description: "A widget", price: prod.price, currency: "USD", url } });
      }
      if (route === "/brand/retrieve") {
        const domain = u.searchParams.get("domain");
        return json(res, 200, { status: "ok", brand: { domain, title: "Fake Shop", description: "", logos: [], backdrops: [], colors: [] } });
      }
      if (route === "/web/screenshot") return json(res, 200, { status: "ok", domain: u.searchParams.get("domain") ?? "", screenshot: "", screenshotType: "viewport", code: 200 });
      if (route === "/web/scrape/sitemap") return json(res, 200, { success: true, domain: u.searchParams.get("domain"), urls: [], meta: { sitemapsDiscovered: 0, sitemapsFetched: 0, sitemapsSkipped: 0, errors: 0 } });
      return json(res, 404, { message: `fake ctx: unhandled ${route}` });
    }
    if (p.startsWith("/openai/v1/responses")) {
      return json(res, 200, {
        id: "resp_fake", object: "response", created_at: Math.floor(Date.now() / 1000), model: "gpt-fake", status: "completed",
        output: [{ type: "message", id: "msg_fake", role: "assistant", status: "completed", content: [{ type: "output_text", text: state.aiReply, annotations: [] }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, incomplete_details: null,
      });
    }
    if (p.startsWith("/openai/v1/chat/completions")) {
      return json(res, 200, { id: "c", object: "chat.completion", created: 1, model: "gpt-fake", choices: [{ index: 0, message: { role: "assistant", content: state.aiReply }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }
    if (p.startsWith("/openai/v1/models")) return json(res, 200, { object: "list", data: [{ id: "gpt-fake", object: "model" }] });
    json(res, 404, { message: `fake: unhandled ${p}` });
  }
}
