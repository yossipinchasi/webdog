/**
 * Which IP addresses outbound webhooks may connect to. Only publicly routable
 * addresses are allowed: private networks, loopback, link-local (including the
 * 169.254.169.254 cloud-metadata endpoint), carrier-grade NAT, multicast, and other
 * special-purpose ranges are refused, so a user-supplied URL can't reach the host's
 * own network. IPv4 carried inside IPv6 (mapped, compatible, NAT64) is judged as IPv4.
 * Pure — no I/O.
 */

import { isIP } from "node:net";

type V4Range = readonly [a: number, b: number, c: number, d: number, prefix: number, reason: string];

// IANA IPv4 special-purpose registry: everything not globally reachable.
const BLOCKED_V4: readonly V4Range[] = [
  [0, 0, 0, 0, 8, "reserved (\"this network\")"],
  [10, 0, 0, 0, 8, "private network"],
  [100, 64, 0, 0, 10, "carrier-grade NAT"],
  [127, 0, 0, 0, 8, "loopback"],
  [169, 254, 0, 0, 16, "link-local (includes the cloud metadata endpoint)"],
  [172, 16, 0, 0, 12, "private network"],
  [192, 0, 0, 0, 24, "reserved (IETF protocol assignments)"],
  [192, 0, 2, 0, 24, "reserved (documentation)"],
  [192, 88, 99, 0, 24, "reserved (6to4 relay)"],
  [192, 168, 0, 0, 16, "private network"],
  [198, 18, 0, 0, 15, "reserved (benchmarking)"],
  [198, 51, 100, 0, 24, "reserved (documentation)"],
  [203, 0, 113, 0, 24, "reserved (documentation)"],
  [224, 0, 0, 0, 4, "multicast"],
  [240, 0, 0, 0, 4, "reserved"],
];

type V6Range = readonly [prefixBytes: readonly number[], prefixBits: number, reason: string];

// Inside global unicast (2000::/3), sub-ranges that are still not globally reachable.
const BLOCKED_V6_GLOBAL: readonly V6Range[] = [
  [[0x20, 0x01, 0x00, 0x00], 23, "reserved (IETF protocol assignments, incl. Teredo)"],
  [[0x20, 0x01, 0x0d, 0xb8], 32, "reserved (documentation)"],
  [[0x20, 0x02], 16, "reserved (6to4)"],
  [[0x3f, 0xff], 20, "reserved (documentation)"],
];

function v4Bytes(ip: string): number[] {
  return ip.split(".").map(Number);
}

function inPrefix(bytes: readonly number[], prefix: readonly number[], bits: number): boolean {
  for (let i = 0; i < bits; i++) {
    const byte = i >> 3;
    const mask = 0x80 >> (i & 7);
    if (((bytes[byte] ?? 0) & mask) !== ((prefix[byte] ?? 0) & mask)) return false;
  }
  return true;
}

function blockedV4Reason(bytes: readonly number[]): string | null {
  for (const [a, b, c, d, prefix, reason] of BLOCKED_V4) {
    if (inPrefix(bytes, [a, b, c, d], prefix)) return reason;
  }
  return null;
}

/** Parse an IPv6 literal (optionally with an embedded dotted IPv4 tail or %zone) to 16 bytes. */
export function ipv6ToBytes(ip: string): number[] | null {
  const addr = ip.split("%")[0]!.toLowerCase();
  if (isIP(addr) !== 6) return null;
  let head = addr;
  let tail: number[] = [];
  const lastColon = addr.lastIndexOf(":");
  if (addr.slice(lastColon + 1).includes(".")) {
    const v4 = addr.slice(lastColon + 1);
    tail = v4Bytes(v4);
    head = addr.slice(0, lastColon + 1) + "0:0"; // placeholder hextets, overwritten below
  }
  const [left, right] = head.includes("::") ? head.split("::") : [head, undefined];
  const leftParts = left ? left.split(":").filter(Boolean) : [];
  const rightParts = right !== undefined && right ? right.split(":").filter(Boolean) : [];
  const missing = 8 - leftParts.length - rightParts.length;
  const hextets = [...leftParts, ...Array(right !== undefined ? missing : 0).fill("0"), ...rightParts];
  if (hextets.length !== 8) return null;
  const bytes = hextets.flatMap((h) => {
    const n = parseInt(h, 16);
    return [(n >> 8) & 0xff, n & 0xff];
  });
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes;
}

/**
 * Why `ip` must not be contacted, or null when it is a public address. Anything that
 * isn't a valid IP literal is refused.
 */
export function blockedAddressReason(ip: string): string | null {
  const family = isIP(ip.split("%")[0]!);
  if (family === 4) return blockedV4Reason(v4Bytes(ip));
  if (family !== 6) return "not an IP address";

  const b = ipv6ToBytes(ip);
  if (!b) return "not an IP address";
  const first10Zero = b.slice(0, 10).every((x) => x === 0);
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible, incl. :: and ::1): judge the IPv4.
  if (first10Zero && ((b[10] === 0xff && b[11] === 0xff) || (b[10] === 0 && b[11] === 0))) {
    if (b.every((x) => x === 0)) return "reserved (unspecified address)";
    if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return "loopback";
    return blockedV4Reason(b.slice(12));
  }
  // 64:ff9b::/96 (well-known NAT64): judge the embedded IPv4.
  if (inPrefix(b, [0x00, 0x64, 0xff, 0x9b], 32) && b.slice(4, 12).every((x) => x === 0)) {
    return blockedV4Reason(b.slice(12));
  }
  if (inPrefix(b, [0xfc], 7)) return "private network (unique local IPv6)";
  if (inPrefix(b, [0xfe, 0x80], 10)) return "link-local";
  if (inPrefix(b, [0xff], 8)) return "multicast";
  if (!inPrefix(b, [0x20], 3)) return "reserved (not global unicast)";
  for (const [prefix, bits, reason] of BLOCKED_V6_GLOBAL) {
    if (inPrefix(b, prefix, bits)) return reason;
  }
  return null;
}

export function isPublicAddress(ip: string): boolean {
  return blockedAddressReason(ip) === null;
}
