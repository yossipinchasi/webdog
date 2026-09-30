import type { Snapshot, Target, TargetKind } from "./db/schema";

export const SNAPSHOT_KIND_BY_TARGET_KIND: Record<TargetKind, Snapshot["kind"]> = {
  SITEMAP_LINKS: "SITEMAP",
  PAGE_CONTENT: "MARKDOWN",
  PRODUCT_PRICE: "PRODUCT",
};

/**
 * Whether a stored snapshot belongs to a monitor's history. Snapshots written by the
 * worker carry the monitor's id; untagged rows (orphaned by a deleted monitor) fall
 * back to the old match on kind + page URL.
 */
export function snapshotBelongsToTarget(
  s: Pick<Snapshot, "targetId" | "kind" | "targetUrl">,
  target: Pick<Target, "id" | "kind" | "pageUrl">,
): boolean {
  if (s.kind !== SNAPSHOT_KIND_BY_TARGET_KIND[target.kind]) return false;
  if (s.targetId != null) return s.targetId === target.id;
  if (target.kind === "SITEMAP_LINKS") return s.targetUrl == null;
  return target.pageUrl != null && s.targetUrl === target.pageUrl;
}
