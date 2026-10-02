/**
 * SSRF protection for requests sent to user-supplied URLs (watch callbacks, the
 * webhook test endpoint, dashboard WEBHOOK destinations).
 *
 * Two layers:
 *  1. `checkOutboundUrl` validates a URL when it is saved: http(s) only, and its host
 *     (an IP literal, or every address its hostname resolves to) must be public.
 *  2. `postJson` enforces the same rule while connecting: DNS resolution goes through a
 *     filtering lookup, so a hostname that resolved to a public address at save time
 *     but to an internal one now (DNS rebinding) is refused before any bytes are sent.
 *     Redirects are never followed.
 *
 * WEBHOOK_ALLOW_PRIVATE_ADDRESSES=true disables the address rule, for local development
 * and tests whose receivers run on localhost. It must stay unset in production.
 */

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { blockedAddressReason } from "./ip-address-policy";

const MAX_RESPONSE_BYTES = 64 * 1024;

export class OutboundBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundBlockedError";
  }
}

export function allowPrivateAddresses(): boolean {
  return process.env.WEBHOOK_ALLOW_PRIVATE_ADDRESSES?.trim().toLowerCase() === "true";
}

type Resolve = (hostname: string) => Promise<{ address: string; family: number }[]>;

const systemResolve: Resolve = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

function hostOf(url: URL): string {
  // URL keeps IPv6 literals bracketed ("[::1]").
  return url.hostname.replace(/^\[|\]$/g, "");
}

function describeBlocked(host: string, address: string, reason: string): string {
  return host === address ? `${host} is a ${reason} address` : `${host} resolves to ${address}, a ${reason} address`;
}

/**
 * Whether `urlStr` may be used as an outbound webhook target. Returns a user-facing
 * reason when it may not. Resolves DNS for hostnames.
 */
export async function checkOutboundUrl(
  urlStr: string,
  options: { resolve?: Resolve; allowPrivate?: boolean } = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let url: URL;
  try {
    url = new URL(urlStr.trim());
  } catch {
    return { ok: false, reason: "Not a valid URL." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "Only http(s) URLs are allowed." };
  if (!url.hostname) return { ok: false, reason: "The URL has no host." };
  if (options.allowPrivate ?? allowPrivateAddresses()) return { ok: true };

  const host = hostOf(url);
  const literalReason = /^[\d.]+$|:/.test(host) ? blockedAddressReason(host) : undefined;
  if (literalReason !== undefined) {
    return literalReason ? { ok: false, reason: `${describeBlocked(host, host, literalReason)}.` } : { ok: true };
  }

  let addresses: { address: string }[];
  try {
    addresses = await (options.resolve ?? systemResolve)(host);
  } catch {
    return { ok: false, reason: `${host} does not resolve.` };
  }
  if (addresses.length === 0) return { ok: false, reason: `${host} does not resolve.` };
  for (const { address } of addresses) {
    const reason = blockedAddressReason(address);
    if (reason) return { ok: false, reason: `${describeBlocked(host, address, reason)}.` };
  }
  return { ok: true };
}

/**
 * A `lookup` for http(s).request that refuses hostnames resolving to any non-public
 * address. Exported for tests; `resolve` is injectable.
 */
export function guardedLookup(resolve: Resolve = systemResolve): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        const blocked = addresses.map((a) => [a, blockedAddressReason(a.address)] as const).find(([, r]) => r);
        if (blocked) {
          callback(new OutboundBlockedError(describeBlocked(hostname, blocked[0].address, blocked[1]!)), "", 4);
          return;
        }
        const family = typeof options === "object" ? options.family : undefined;
        const usable = family === 4 || family === 6 ? addresses.filter((a) => a.family === family) : addresses;
        if (usable.length === 0) {
          const err = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
          callback(err, "", 4);
          return;
        }
        if (typeof options === "object" && options.all) {
          (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, usable);
        } else {
          callback(null, usable[0]!.address, usable[0]!.family);
        }
      },
      (err: NodeJS.ErrnoException) => callback(err, "", 4),
    );
  };
}

/** `retryAfter`: the raw `Retry-After` response header, if any (the caller decides whether it applies). */
export type PostResult = { status: number; body: string; retryAfter: string | null };

/**
 * POST a JSON body with SSRF protection. Resolves with the response status and up to
 * 64 KB of its body (any status, no redirects followed). Rejects with
 * `OutboundBlockedError` when the target is not allowed, or with the network/timeout error.
 */
export function postJson(
  urlStr: string,
  body: string,
  options: { headers?: Record<string, string>; timeoutMs: number; resolve?: Resolve; allowPrivate?: boolean },
): Promise<PostResult> {
  return new Promise((resolvePromise, reject) => {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      reject(new OutboundBlockedError("Not a valid URL."));
      return;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      reject(new OutboundBlockedError("Only http(s) URLs are allowed."));
      return;
    }
    const allowPrivate = options.allowPrivate ?? allowPrivateAddresses();
    const host = hostOf(url);
    // IP literals never reach `lookup`, so check them here.
    if (!allowPrivate && /^[\d.]+$|:/.test(host)) {
      const reason = blockedAddressReason(host);
      if (reason) {
        reject(new OutboundBlockedError(describeBlocked(host, host, reason)));
        return;
      }
    }

    const signal = AbortSignal.timeout(options.timeoutMs);
    const req = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method: "POST",
        headers: { ...options.headers, "Content-Length": Buffer.byteLength(body) },
        ...(allowPrivate ? {} : { lookup: guardedLookup(options.resolve) }),
        signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          if (size < MAX_RESPONSE_BYTES) chunks.push(chunk.subarray(0, MAX_RESPONSE_BYTES - size));
          size += chunk.length;
        });
        const retryAfter = res.headers["retry-after"];
        res.on("end", () =>
          resolvePromise({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            retryAfter: typeof retryAfter === "string" ? retryAfter : null,
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", (err: Error) => {
      // Surface the SSRF refusal itself rather than a wrapped socket error.
      const cause = (err as { cause?: unknown }).cause;
      reject(cause instanceof OutboundBlockedError ? cause : err);
    });
    req.end(body);
  });
}
