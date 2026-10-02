import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyLegacyDestination, looksLegacy, type DestinationFacts, type ReferenceFacts } from "./legacy-webhook-cleanup";

// Which leftover API webhook destinations may be removed (removal itself runs against Postgres).

const created = new Date("2026-09-30T10:00:00Z");
const legacy: DestinationFacts = {
  channel: "WEBHOOK",
  name: "API webhook (hooks.partner.test)",
  alertWebhookUrl: "https://hooks.partner.test/in/tok_abc",
  slackWebhookUrl: null,
  resendFromEmail: null,
  resendToEmails: null,
  createdAt: created,
  updatedAt: created,
};
const unused: ReferenceFacts = { monitors: 0, websites: 0, ownerHadApiKey: true };

test("an unused, unedited API-created destination is removed", () => {
  assert.deepEqual(classifyLegacyDestination(legacy, unused).remove, true);
  // host includes a port when the URL has one
  assert.equal(classifyLegacyDestination({ ...legacy, name: "API webhook (hooks.partner.test:8443)", alertWebhookUrl: "https://hooks.partner.test:8443/x" }, unused).remove, true);
});

test("anything in use is kept", () => {
  assert.deepEqual(classifyLegacyDestination(legacy, { ...unused, monitors: 2 }), { remove: false, reason: "used by 2 monitor(s)" });
  assert.deepEqual(classifyLegacyDestination(legacy, { ...unused, websites: 1 }), { remove: false, reason: "selected on 1 website(s)" });
});

test("user-made or user-edited destinations are kept", () => {
  const keep = (d: Partial<DestinationFacts>, refs: Partial<ReferenceFacts> = {}) => classifyLegacyDestination({ ...legacy, ...d }, { ...unused, ...refs });
  assert.match(keep({ updatedAt: new Date(created.getTime() + 1) }).reason, /edited/);
  assert.match(keep({ name: "API webhook (other.test)" }).reason, /does not match/, "renamed, or name for another host");
  assert.match(keep({ name: "API webhook (hooks.partner.test) " }).reason, /not a legacy/, "near-miss name");
  assert.match(keep({ name: "My API webhook (hooks.partner.test)" }).reason, /not a legacy/);
  assert.match(keep({ name: "api webhook (hooks.partner.test)" }).reason, /not a legacy/);
  assert.match(keep({ channel: "SLACK" }).reason, /not a legacy/);
  assert.match(keep({ resendToEmails: "a@b.test" }).reason, /Slack or email/);
  assert.match(keep({ alertWebhookUrl: null }).reason, /no webhook URL/);
  assert.match(keep({ alertWebhookUrl: "not a url" }).reason, /does not match/);
  assert.match(keep({}, { ownerHadApiKey: false }).reason, /no API key/);
});

test("only WEBHOOK destinations with the exact generated name are even considered", () => {
  assert.equal(looksLegacy({ channel: "WEBHOOK", name: "API webhook (x.test)" }), true);
  for (const [channel, name] of [["WEBHOOK", "API webhook"], ["WEBHOOK", "Partner webhook (x.test)"], ["EMAIL", "API webhook (x.test)"]]) {
    assert.equal(looksLegacy({ channel: channel!, name: name! }), false, `${channel} ${name}`);
  }
});
