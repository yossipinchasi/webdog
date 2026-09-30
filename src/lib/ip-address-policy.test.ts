import { test } from "node:test";
import assert from "node:assert/strict";
import { blockedAddressReason, ipv6ToBytes, isPublicAddress } from "./ip-address-policy";

// Outbound webhooks may only reach publicly routable addresses.

test("IPv4: private, loopback, link-local/metadata, CGNAT, multicast, and reserved ranges are blocked", () => {
  const blocked: Record<string, RegExp> = {
    "0.0.0.0": /reserved/,
    "10.0.0.5": /private/,
    "10.255.255.255": /private/,
    "100.64.0.1": /carrier-grade/,
    "100.127.255.254": /carrier-grade/,
    "127.0.0.1": /loopback/,
    "127.10.20.30": /loopback/,
    "169.254.169.254": /metadata/,
    "172.16.0.1": /private/,
    "172.31.255.255": /private/,
    "192.0.0.8": /reserved/,
    "192.0.2.10": /documentation/,
    "192.168.1.1": /private/,
    "198.18.0.1": /benchmark/,
    "198.51.100.7": /documentation/,
    "203.0.113.9": /documentation/,
    "224.0.0.251": /multicast/,
    "255.255.255.255": /reserved/,
  };
  for (const [ip, reason] of Object.entries(blocked)) assert.match(blockedAddressReason(ip) ?? "", reason, ip);
});

test("IPv4: public addresses (including range edges) are allowed", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.0", "100.63.255.255", "100.128.0.0", "11.0.0.1", "223.255.255.255", "192.169.0.1"]) {
    assert.equal(blockedAddressReason(ip), null, ip);
  }
});

test("IPv6: loopback, unspecified, unique-local (incl. Railway fd12::), link-local, multicast, reserved are blocked", () => {
  const blocked: Record<string, RegExp> = {
    "::1": /loopback/,
    "::": /unspecified/,
    "fd12:3456::1": /unique local/,
    "fc00::1": /unique local/,
    "fe80::1": /link-local/,
    "fe80::1%en0": /link-local/,
    "ff02::1": /multicast/,
    "2001:db8::1": /documentation/,
    "2001:0:53aa:64c::1": /Teredo/,
    "2002:c000:0204::1": /6to4/,
    "3fff::1": /documentation/,
    "100::1": /not global unicast/,
    "4000::1": /not global unicast/,
  };
  for (const [ip, reason] of Object.entries(blocked)) assert.match(blockedAddressReason(ip) ?? "", reason, ip);
});

test("IPv6 carrying IPv4 is judged by the IPv4 address", () => {
  assert.match(blockedAddressReason("::ffff:127.0.0.1") ?? "", /loopback/);
  assert.match(blockedAddressReason("::ffff:7f00:1") ?? "", /loopback/, "hex form of mapped loopback");
  assert.match(blockedAddressReason("::ffff:169.254.169.254") ?? "", /metadata/);
  assert.match(blockedAddressReason("::ffff:a00:5") ?? "", /private/);
  assert.match(blockedAddressReason("::10.0.0.1") ?? "", /private/, "IPv4-compatible");
  assert.match(blockedAddressReason("64:ff9b::a00:1") ?? "", /private/, "NAT64 of 10.0.0.1");
  assert.equal(blockedAddressReason("::ffff:8.8.8.8"), null);
  assert.equal(blockedAddressReason("64:ff9b::808:808"), null, "NAT64 of 8.8.8.8");
});

test("IPv6 global unicast is allowed", () => {
  for (const ip of ["2606:4700:4700::1111", "2a00:1450:4001:82a::200e", "2001:4860:4860::8888"]) {
    assert.equal(blockedAddressReason(ip), null, ip);
  }
});

test("non-addresses are refused", () => {
  for (const s of ["", "localhost", "example.com", "999.1.1.1", "1.2.3", "::gg"]) assert.equal(isPublicAddress(s), false, s);
});

test("ipv6ToBytes expands :: and embedded IPv4", () => {
  assert.deepEqual(ipv6ToBytes("::1"), [...Array(15).fill(0), 1]);
  assert.deepEqual(ipv6ToBytes("::ffff:1.2.3.4")?.slice(10), [0xff, 0xff, 1, 2, 3, 4]);
  assert.deepEqual(ipv6ToBytes("1:2:3:4:5:6:7:8")?.slice(0, 4), [0, 1, 0, 2]);
  assert.equal(ipv6ToBytes("1.2.3.4"), null);
});
