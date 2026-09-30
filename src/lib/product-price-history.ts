import type { Snapshot, Target } from "./db/schema";
import { snapshotBelongsToTarget } from "./snapshot-ownership";

export type ProductSnapshotData = {
  is_product_page: boolean;
  platform: string | null;
  productName: string | null;
  price: number | null;
  currency: string | null;
};

export type ProductPricePoint = {
  id: string;
  createdAt: number;
  price: number | null;
  currency: string | null;
  isProductPage: boolean;
  productName: string | null;
};

export function parseProductSnapshotPayload(payload: string): ProductSnapshotData | null {
  try {
    return JSON.parse(payload) as ProductSnapshotData;
  } catch {
    return null;
  }
}

export function formatProductPrice(price: number | null, currency: string | null): string {
  if (price === null || price === undefined) return "—";
  const c = currency?.trim();
  if (c) return `${c} ${price}`;
  return String(price);
}

/**
 * All PRODUCT snapshots for this target’s page, oldest first (time series for the chart).
 */
export function buildProductPriceSeries(target: Target, snapshots: Snapshot[]): ProductPricePoint[] {
  if (target.kind !== "PRODUCT_PRICE" || !target.pageUrl) return [];
  const rows = snapshots
    .filter((s) => snapshotBelongsToTarget(s, target))
    .sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
  return rows.map((s) => {
    const p = parseProductSnapshotPayload(s.payload);
    if (!p) {
      return {
        id: s.id,
        createdAt: Number(s.createdAt),
        price: null,
        currency: null,
        isProductPage: false,
        productName: null,
      };
    }
    return {
      id: s.id,
      createdAt: Number(s.createdAt),
      price: p.price,
      currency: p.currency,
      isProductPage: p.is_product_page,
      productName: p.productName,
    };
  });
}
