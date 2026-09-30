import { test } from "node:test";
import assert from "node:assert/strict";
import { snapshotBelongsToTarget } from "./snapshot-ownership";

const page = { id: "tgt_a", kind: "PAGE_CONTENT" as const, pageUrl: "https://x.test/jobs" };
const twin = { id: "tgt_b", kind: "PAGE_CONTENT" as const, pageUrl: "https://x.test/jobs" };
const links = { id: "tgt_l", kind: "SITEMAP_LINKS" as const, pageUrl: null };

test("tagged snapshots belong only to their own monitor, even on a shared URL", () => {
  const s = { targetId: "tgt_a", kind: "MARKDOWN" as const, targetUrl: "https://x.test/jobs" };
  assert.equal(snapshotBelongsToTarget(s, page), true);
  assert.equal(snapshotBelongsToTarget(s, twin), false);
});

test("untagged (legacy/orphaned) snapshots fall back to kind + URL", () => {
  const s = { targetId: null, kind: "MARKDOWN" as const, targetUrl: "https://x.test/jobs" };
  assert.equal(snapshotBelongsToTarget(s, page), true);
  assert.equal(snapshotBelongsToTarget({ ...s, targetUrl: "https://x.test/other" }, page), false);
  assert.equal(snapshotBelongsToTarget({ targetId: null, kind: "SITEMAP", targetUrl: null }, links), true);
});

test("kind must match the monitor type", () => {
  assert.equal(snapshotBelongsToTarget({ targetId: "tgt_a", kind: "PRODUCT", targetUrl: page.pageUrl }, page), false);
  assert.equal(snapshotBelongsToTarget({ targetId: null, kind: "MARKDOWN", targetUrl: null }, links), false);
});
