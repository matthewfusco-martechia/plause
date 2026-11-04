import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";

// This integration fixture never reads app env files or provider credentials.
const run = promisify(execFile);
const app = new URL("../../", import.meta.url);
const artifacts = new URL("../.local/agent-hosting/", app);
const image = process.argv[2] ?? "plause-cloudflare-linq-review:20261103";
assert.match(image, /^plause-cloudflare-(?:linq-)?review:\d{8}$/u);
assert.equal(process.argv.length <= 3, true);
const fixtureId = randomUUID();
const name = `plause-hosting-smoke-${fixtureId}`;
const network = "plause-hosting-linq-fixture-20261103";
const checkSchema = z.object({
  check: z.string(),
  passed: z.boolean(),
  status: z.number().optional(),
  expected: z.number().optional(),
});
const report = {
  fictionalOnly: true,
  messagesSent: 0,
  liveModelCalls: 0,
  checks: z.array(checkSchema).parse([]),
  passed: false,
  error: "",
};
async function docker(args: string[], timeout = 30_000) {
  return (
    await run("docker", args, { timeout, maxBuffer: 2 * 1024 * 1024 })
  ).stdout.trim();
}

try {
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  assert.equal(
    await docker(["network", "inspect", "--format", "{{.Internal}}", network]),
    "true"
  );
  const architecture = await docker([
    "image",
    "inspect",
    "--format",
    "{{.Architecture}}",
    image,
  ]);
  assert.equal(architecture, "amd64");
  const hash = await docker([
    "run",
    "--rm",
    "--pull=never",
    "--platform",
    "linux/amd64",
    "--network",
    "none",
    "--memory",
    "128m",
    "--cpus",
    "1",
    "--entrypoint",
    "/usr/bin/caddy",
    image,
    "hash-password",
    "--plaintext",
    "fictional-hosting-password",
    "--bcrypt-cost",
    "10",
  ]);
  assert.match(hash, /^\$2[aby]\$10\$/u);
  const values = {
    DATABASE_URL:
      "postgres://world:fictional-hosting-fixture@postgres:5432/world",
    WORKFLOW_POSTGRES_URL:
      "postgres://world:fictional-hosting-fixture@postgres:5432/world",
    KERNEL_API_KEY: "fictional-disabled-key",
    BETTER_AUTH_SECRET: "fictional-auth-secret-0123456789abcdef",
    BETTER_AUTH_URL: "https://agent.plause.si",
    SECRET_ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
    INTERNAL_SERVICE_SECRET: "fictional-internal-secret-0123456789abcdef",
    PLAUSE_ACCESS_HASH: hash,
    PLAUSE_EDGE_INTERNAL_TOKEN: "fictional-edge-token-0123456789abcdef",
    LIVE_MODEL_ENABLED: "false",
    MESSAGING_PROVIDER: "linq",
    LINQ_API_KEY: "fictional-disabled-linq-key",
    LINQ_PHONE_NUMBER: "+15005550001",
    LINQ_WEBHOOK_SIGNING_SECRET: `whsec_${Buffer.alloc(32, 7).toString("base64")}`,
    WORKFLOW_POSTGRES_WORKER_CONCURRENCY: "4",
    WORKFLOW_POSTGRES_MAX_POOL_SIZE: "10",
    WORKFLOW_POSTGRES_POLL_INTERVAL_MS: "2000",
  };
  const args = [
    "run",
    "--detach",
    "--pull=never",
    "--name",
    name,
    "--label",
    `si.plause.fixture-run=${fixtureId}`,
    "--platform",
    "linux/amd64",
    "--network",
    network,
    "--memory",
    "1g",
    "--cpus",
    "0.25",
  ];
  for (const [key, value] of Object.entries(values))
    args.push("--env", `${key}=${value}`);
  args.push(image);
  await docker(args);

  // Compare runtime inputs to the checkout, not merely the image's tag/date.
  const expected = Object.fromEntries(
    await Promise.all(
      [
        "ops/cloudflare/Caddyfile",
        "ops/cloudflare/start.mjs",
        "agent/agent.ts",
        "agent/channels/linq.ts",
        "shared/environment/env.ts",
        "pnpm-lock.yaml",
      ].map(
        async (file) =>
          [
            file,
            createHash("sha256")
              .update(await readFile(new URL(file, app)))
              .digest("hex"),
          ] as const
      )
    )
  );
  const provenance = await docker([
    "exec",
    name,
    "node",
    "-e",
    `const fs=require('node:fs'),crypto=require('node:crypto');const expected=JSON.parse(process.argv[1]);console.log(JSON.stringify(Object.entries(expected).every(([p,h])=>crypto.createHash('sha256').update(fs.readFileSync('/app/'+p)).digest('hex')===h)));`,
    JSON.stringify(expected),
  ]);
  assert.equal(
    provenance,
    "true",
    "Image inputs differ from the checkout; rebuild first"
  );
  report.checks.push({ check: "current image inputs", passed: true });

  const probe = `
import {createHmac} from 'node:crypto';
const basic='Basic '+Buffer.from('plause:fictional-hosting-password').toString('base64');
const token='Bearer fictional-edge-token-0123456789abcdef';
async function status(path,authorization,method='GET') {
 try {return (await fetch('http://127.0.0.1:8080'+path,{method,headers:authorization?{authorization}:{},redirect:'manual',signal:AbortSignal.timeout(10000),...(method==='POST'?{body:'{}'}:{})})).status;}catch{return 0;}
}
async function ready(path,auth) {
 const deadline=Date.now()+90000;
 while(Date.now()<deadline) {if(await status(path,auth)===200)return;await new Promise(r=>setTimeout(r,500));}
 throw Error('Timed out waiting for private runtime');
}
await ready('/sign-in',basic);await ready('/_plause/runtime-ready',token);
const checks=[];
for(const [check,path,auth,method,expected] of [
 ['anonymous password gate','/sign-in',null,'GET',401],
 ['wrong password gate','/sign-in','Basic YmFkOmJhZA==','GET',401],
 ['private sign-in page','/sign-in',basic,'GET',200],
 ['public workflow route blocked','/.well-known/workflow/v1/flow',basic,'POST',404],
 ['public workflow manifest blocked','/.well-known/workflow/v1/manifest',null,'GET',404],
 ['health requires edge token','/_plause/runtime-ready',null,'GET',401],
 ['private Eve runtime health','/_plause/runtime-ready',token,'GET',200],
 ['unsigned Linq closed','/webhooks/linq',null,'POST',401],
 ['unconfigured Inkbox closed','/webhooks/inkbox',null,'POST',503],
 ['Linq relay requires app HMAC','/internal/linq/dispatch',null,'POST',401],
 ['unselected Inkbox relay closed','/internal/inkbox/dispatch',null,'POST',503],
 ['unlisted internal route stays private','/internal/unknown',null,'POST',401],
]) {const actual=await status(path,auth,method);checks.push({check,status:actual,expected,passed:actual===expected});}
for(const [check,owner,expected] of [
 ['signed unlinked sender is safely ignored','+15005550001',200],
 ['signed wrong receiving line rejected','+15005550099',401],
]) {
 const payload=JSON.stringify({webhook_version:'2026-02-03',event_type:'message.received',event_id:'evt_hosting',data:{id:'msg_hosting',direction:'inbound',sender_handle:{handle:'+15005550002',is_me:false},chat:{id:'chat_hosting',is_group:false,owner_handle:{handle:owner,is_me:true}}}});
 const timestamp=String(Math.floor(Date.now()/1000));
 const signature=createHmac('sha256',Buffer.alloc(32,7)).update('evt_hosting.'+timestamp+'.'+payload).digest('base64');
 const actual=(await fetch('http://127.0.0.1:8080/webhooks/linq',{method:'POST',headers:{'content-type':'application/json','webhook-id':'evt_hosting','webhook-timestamp':timestamp,'webhook-signature':'v1,'+signature},body:payload,redirect:'manual',signal:AbortSignal.timeout(10000)})).status;
 checks.push({check,status:actual,expected,passed:actual===expected});
}
console.log(JSON.stringify(checks));
`;
  const checks = z
    .array(checkSchema)
    .parse(
      JSON.parse(
        await docker(
          ["exec", name, "node", "--input-type=module", "-e", probe],
          210_000
        )
      )
    );
  report.checks.push(...checks);
  assert.equal(
    checks.every((check) => check.passed),
    true
  );
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error =
    error instanceof Error ? error.message.slice(0, 1500) : "Fixture failed";
  process.exitCode = 1;
} finally {
  try {
    const owner = await docker([
      "inspect",
      "--format",
      '{{index .Config.Labels "si.plause.fixture-run"}}',
      name,
    ]);
    if (owner === fixtureId) {
      try {
        await writeFile(
          new URL("container-http-smoke.log", artifacts),
          await docker(["logs", name]),
          { mode: 0o600 }
        );
      } finally {
        // Log collection must never prevent removal of the owned fixture.
        await docker(["rm", "--force", name]);
      }
    }
  } catch {
    // A failed create has no container; never remove someone else's resource.
  }
  await writeFile(
    new URL("container-http-smoke.json", artifacts),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 }
  );
  console.log(JSON.stringify(report));
}
