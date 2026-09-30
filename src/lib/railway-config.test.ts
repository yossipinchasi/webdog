import { test } from "node:test";
import assert from "node:assert/strict";
import { createRailwayContext, project, RAILWAY_GRAPH_VERSION, validateGraph, type ResourceNode, type ServiceNode } from "railway/iac";
import program from "../../.railway/railway";

// Offline checks of the production Railway definition (`railway config plan` needs a
// linked project). These pin the deployment decisions that are easy to break by editing
// the file: manual deploys, lock-protected migrations on both services, and the worker's
// auth wiring.

async function load() {
  const def = await program(createRailwayContext({ environment: "production" }), project);
  // Typed as optional and possibly nested; project() flattens it at runtime.
  const resources = (def.resources ?? []).flat() as ResourceNode[];
  const byAddress = new Map(resources.map((r) => [r.address, r]));
  const svc = (name: string) => {
    const r = byAddress.get(`service.${name}`);
    assert.ok(r && r.type === "service", `service ${name} is declared`);
    return r as ServiceNode;
  };
  return { def, resources, byAddress, web: svc("web"), worker: svc("worker") };
}

test("declares exactly postgres, web, and worker; references resolve; graph validates", async () => {
  const { def, resources, byAddress } = await load();
  assert.equal(def.name, "webdog");
  assert.deepEqual([...byAddress.keys()].sort(), ["database.postgres", "service.web", "service.worker"]);

  const edges = [];
  for (const r of resources) {
    for (const [key, v] of Object.entries((r as ServiceNode).variables ?? {})) {
      if (v.type === "reference") {
        assert.ok(byAddress.has(v.resource), `${r.address}.${key} references a declared resource (${v.resource})`);
        edges.push({ from: v.resource, to: r.address, type: "variable" as const, key });
      }
    }
  }
  assert.deepEqual(validateGraph({ version: RAILWAY_GRAPH_VERSION, resources, edges } as never), []);
});

test("deploys are manual: no service has a source that deploys on push", async () => {
  const { web, worker } = await load();
  assert.equal(web.source, undefined);
  assert.equal(worker.source, undefined);
  assert.equal(web.kind, "empty");
  assert.equal(worker.kind, "empty");
});

test("both services run the lock-protected migration before starting", async () => {
  const { web, worker } = await load();
  assert.deepEqual(web.deploy?.preDeployCommand, ["npm run db:migrate:deploy"]);
  assert.deepEqual(worker.deploy?.preDeployCommand, ["npm run db:migrate:deploy"]);
});

test("web: Next.js build, start, health check, default restart policy, one replica", async () => {
  const { web } = await load();
  assert.equal(web.build?.buildCommand, "npm run build");
  assert.equal(web.deploy?.startCommand, "npm run start");
  assert.equal(web.deploy?.healthcheckPath, "/api/health");
  assert.equal(web.deploy?.healthcheckTimeout, 300);
  // Railway's default ("On Failure", max 10). Declaring it causes permanent plan drift.
  assert.equal(web.deploy?.restartPolicyType, undefined);
  assert.equal(web.deploy?.restartPolicyMaxRetries, undefined);
  assert.equal(web.deploy?.numReplicas, 1);
});

test("worker: no Next.js build, worker start, always restarted, one replica, no health check or domain", async () => {
  const { worker } = await load();
  assert.doesNotMatch(worker.build?.buildCommand ?? "", /next|npm run build/);
  assert.equal(worker.deploy?.startCommand, "npm run worker");
  assert.equal(worker.deploy?.restartPolicyType, "ALWAYS");
  assert.equal(worker.deploy?.numReplicas, 1, "a single worker");
  assert.equal(worker.deploy?.healthcheckPath, undefined);
  assert.equal(worker.networking, undefined, "no public domain");
});

test("environment: shared database + secrets on both; the worker gets the web app's public URL", async () => {
  const { web, worker } = await load();
  for (const s of [web, worker]) {
    const v = s.variables ?? {};
    assert.deepEqual(v.DATABASE_URL, { type: "reference", resource: "database.postgres", output: "DATABASE_URL" }, s.name);
    assert.deepEqual(v.NODE_ENV, { type: "literal", value: "production" }, s.name);
    for (const secret of ["BETTER_AUTH_SECRET", "CONTEXT_DEV_API_KEY", "OPENAI_API_KEY", "AI_GATEWAY_API_KEY", "RESEND_API_KEY"]) {
      assert.deepEqual(v[secret], { type: "preserve" }, `${s.name}.${secret} is set in the dashboard, never in code`);
    }
  }
  assert.deepEqual(worker.variables?.BETTER_AUTH_URL, { type: "literal", value: "https://${{web.RAILWAY_PUBLIC_DOMAIN}}" });
  assert.equal(web.variables?.BETTER_AUTH_URL, undefined, "web derives it from its own RAILWAY_PUBLIC_DOMAIN");
  assert.deepEqual(worker.variables?.SNAPSHOT_RETENTION_DAYS, { type: "literal", value: "90" });
});

test("no secret values are written in the file", async () => {
  const { resources } = await load();
  const literals = resources.flatMap((r) =>
    Object.entries((r as ServiceNode).variables ?? {}).filter(([, v]) => v.type === "literal").map(([k, v]) => [k, (v as { value?: string }).value]),
  );
  for (const [k, value] of literals) {
    assert.doesNotMatch(String(k), /SECRET|API_KEY|TOKEN|PASSWORD/, `${k} must use preserve(), not a literal`);
    assert.doesNotMatch(String(value), /^(sk|wk|whsec|re)_|^sk-/, `${k} looks like a credential`);
  }
});
