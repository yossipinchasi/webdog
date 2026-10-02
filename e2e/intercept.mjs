// Preloaded into the app and worker: Slack, Resend and the OpenAI model list use fixed hosts,
// so route them to the local fakes.
const real = globalThis.fetch;
const routes = { "hooks.slack.com": "slack", "api.resend.com": "resend", "api.openai.com": "openai" };
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const m = /^https:\/\/([^/]+)(\/.*)$/.exec(url);
  if (!m || !routes[m[1]]) return real(input, init);
  return real(`http://127.0.0.1:4010/${routes[m[1]]}${m[2]}`, init);
};
