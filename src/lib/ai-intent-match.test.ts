import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildIntentChangeInput,
  CHANGE_SYSTEM_PROMPT,
  changedLines,
  matchIntentChange,
  matchIntentState,
  parseIntentDecision,
  STATE_SYSTEM_PROMPT,
  type GenerateFn,
} from "./ai-intent-match";

// The matcher is strict about what counts as a match, but never turns a failure
// to get an answer into a silent "no": those are `error`, which callers deliver.

const site = { name: "Acme", domain: "acme.test", url: "https://acme.test", title: null, description: null };
const source = "ADDED lines (1):\n- Investment Banking Summer Intern (NYC)\n\nREMOVED lines (0):\n(none)";

test("explicit match keeps only evidence that really occurs in the change", () => {
  const d = parseIntentDecision(
    JSON.stringify({
      matched: true,
      reason: "An investment internship was posted.",
      evidence: ["Investment Banking Summer Intern (NYC)", "Private Equity Intern (made up)", 42],
    }),
    source,
  );
  assert.equal(d.status, "matched");
  assert.equal(d.reason, "An investment internship was posted.");
  assert.deepEqual(d.evidence, ["Investment Banking Summer Intern (NYC)"], "hallucinated quote dropped");
});

test("evidence matching tolerates whitespace and case differences", () => {
  const d = parseIntentDecision('{"matched":true,"evidence":["investment   banking summer intern (nyc)"]}', source);
  assert.equal(d.evidence.length, 1);
});

test("explicit no-match is not_matched and carries no evidence", () => {
  const d = parseIntentDecision('{"matched": false, "reason": "Only an engineering role", "evidence": ["x"]}', source);
  assert.deepEqual(d, { status: "not_matched", reason: "Only an engineering role", evidence: [] });
});

test("JSON inside prose or code fences is read", () => {
  assert.equal(parseIntentDecision('Sure:\n```json\n{"matched": true, "reason": "ok"}\n```', source).status, "matched");
});

test("anything without a boolean `matched` is an error, not a silent no", () => {
  for (const reply of ["", null, undefined, "yes", "{not json", "[true]", '{"matched":"true"}', '{"matched":1}', '{"reason":"x"}']) {
    assert.equal(parseIntentDecision(reply, source).status, "error", String(reply));
  }
});

test("changedLines: set semantics, blank lines ignored", () => {
  assert.deepEqual(changedLines("a\nb\n\nc", "a\nc\nd\n\n"), { added: ["d"], removed: ["b"] });
});

test("page change input labels added/removed lines and keeps the page as context", () => {
  const { changeText, contextText } = buildIntentChangeInput(
    "PAGE_CONTENT",
    { beforeMarkdown: "# Jobs\n- Engineer", afterMarkdown: "# Jobs\n- Engineer\n- Investment Intern" },
    "t",
  );
  assert.match(changeText, /ADDED lines \(1\):\n- Investment Intern/);
  assert.match(changeText, /REMOVED lines \(0\):\n\(none\)/);
  assert.equal(contextText, "# Jobs\n- Engineer\n- Investment Intern");
});

test("price/link changes use the structured change payload", () => {
  const { changeText, contextText } = buildIntentChangeInput(
    "PRODUCT_PRICE",
    { productName: "Widget", previousPrice: 219, previousCurrency: "USD", newPrice: 189, newCurrency: "USD" },
    "Price change",
  );
  assert.match(changeText, /Previous price: USD 219\nNew price: USD 189/);
  assert.equal(contextText, null);
});

test("matchIntentChange sends the intent, the change, and context with the change prompt", async () => {
  let seen: { system: string; prompt: string } | null = null;
  const generate: GenerateFn = async (args) => {
    seen = args;
    return '{"matched":true,"reason":"New investment internship","evidence":["- Investment Intern"]}';
  };
  const out = await matchIntentChange({
    config: null,
    intent: "Tell me when an investment internship appears",
    website: site,
    alertKind: "PAGE_CONTENT",
    title: "t",
    details: { beforeMarkdown: "# Jobs", afterMarkdown: "# Jobs\n- Investment Intern" },
    generate,
  });
  assert.equal(out.status, "matched");
  assert.deepEqual(out.evidence, ["- Investment Intern"]);
  assert.equal(seen!.system, CHANGE_SYSTEM_PROMPT);
  assert.match(seen!.prompt, /User's request: "Tell me when an investment internship appears"/);
  assert.match(seen!.prompt, /ADDED lines \(1\):\n- Investment Intern/);
  assert.match(seen!.prompt, /Current page \(context only\):/);
});

test("matchIntentState uses the state prompt and the page text", async () => {
  let seen: { system: string; prompt: string } | null = null;
  const out = await matchIntentState({
    config: null,
    intent: "availability opens",
    website: site,
    stateText: "Status: Sold out",
    generate: async (args) => {
      seen = args;
      return '{"matched":false,"reason":"Still sold out"}';
    },
  });
  assert.equal(out.status, "not_matched");
  assert.equal(seen!.system, STATE_SYSTEM_PROMPT);
  assert.match(seen!.prompt, /Page:\nStatus: Sold out/);
});

test("model failures and missing config are errors", async () => {
  const failing = await matchIntentChange({
    config: null,
    intent: "x",
    website: site,
    alertKind: "PAGE_CONTENT",
    title: "t",
    details: {},
    generate: async () => {
      throw new Error("timeout");
    },
  });
  assert.equal(failing.status, "error");
  const unconfigured = await matchIntentState({ config: null, intent: "x", website: site, stateText: "page" });
  assert.equal(unconfigured.status, "error");
  assert.match(unconfigured.reason, /No AI provider/);
});
