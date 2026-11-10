/** The shell rules (command-guard.ts) and the guard loaded into pb_explore / pb_try (fresh-guard.ts). Unit-level. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { commandCap, explorerRefusal, isLongCommand, remoteWriteRefusal, scrubPrefix } from "../extensions/pb/command-guard.ts";
import freshGuard, { GUARD_ENV, type GuardSettings } from "../extensions/pb/fresh-guard.ts";

test("limits: the project's own long commands get the long limit, nothing outlasts its run, a shorter ask is kept, 0 is none", () => {
  const longs = ["npm test", "./mvnw -B -q test"];
  const cap = (command: string, o: { asked?: number; runLeftSec?: number; shellSec?: number; longSec?: number } = {}) =>
    commandCap({ command, shellSec: o.shellSec ?? 120, longSec: o.longSec ?? 1800, longCommands: longs, asked: o.asked, runLeftSec: o.runLeftSec });
  assert.equal(cap("ls -la"), 120, "an ordinary command: the shell limit");
  assert.equal(cap("npm test"), 1800, "the suite: the long limit");
  assert.equal(cap("npm test -- --grep orders"), 1800, "with arguments");
  assert.equal(cap("cd backend && ./mvnw -B -q test"), 1800, "behind a cd");
  assert.equal(cap("timeout 600 npm test"), 1800, "behind a timeout prefix");
  assert.equal(cap("npm testify"), 120, "a different command that merely starts alike");
  assert.equal(cap("npm test", { runLeftSec: 700 }), 700, "never longer than the run has left: the run limit stays the one contract");
  assert.equal(cap("npm test", { asked: 60 }), 60, "the model's stricter bound stays");
  assert.equal(cap("ls", { asked: 9999 }), 120, "a longer ask is clamped");
  assert.equal(cap("ls", { shellSec: 0 }), undefined, "0 = no limit");
  assert.equal(cap("ls", { shellSec: 0, asked: 30 }), 30);
  assert.ok(isLongCommand("timeout 5m cd x && npm test", longs), "both prefixes, in any order");
  assert.ok(!isLongCommand("nice npm test", longs), "only the prefixes pb knows are stripped");
});

test("explorer: only read-only inspection runs — databases, the network, scripts and writes are refused by not being on the list", () => {
  for (const ok of ["ls -la src", "rg -n 'cancel' src | head -20", "git log --oneline -5", "git diff HEAD~1 -- src", "find . -name '*.ts' -newer x", "cat a.ts | wc -l"]) assert.equal(explorerRefusal(ok), undefined, ok);
  for (const bad of [
    "psql -c 'select 1'",
    "curl https://api.example.com",
    "cat a > b",
    "ls; rm -rf x",
    "echo $(whoami)",
    "find . -delete",
    "find . -exec rm {} ;",
    "git push",
    "git checkout main",
    "sed -i s/a/b/ f",
    "python3 -c 'print(1)'",
    "kubectl get pods",
    "ls & sleep 1",
  ]) assert.ok(explorerRefusal(bad), bad);
});

test("probe: commands that write to a system outside this machine are refused; reads are not", () => {
  for (const ok of [
    "psql $LOCAL -c 'select count(*) from orders'",
    "curl -s https://api.example.com/health",
    "kubectl get pods -n shop",
    "terraform plan",
    "aws s3 ls",
    "python3 /tmp/probe.py",
    "git log -3",
    "npm test",
  ]) assert.equal(remoteWriteRefusal(ok), undefined, ok);
  for (const [bad, why] of [
    ["psql -c \"delete from orders where id = 1\"", "a write through a database client"],
    ["mysql -e 'DROP TABLE users'", "a write through a database client"],
    ["psql -f migrate.sql", "a script fed to a database client"],
    ["kubectl delete pod web-1", "a change to a Kubernetes cluster"],
    ["kubectl -n prod exec -it web -- sh", "a change to a Kubernetes cluster"],
    ["helm upgrade shop ./chart", "a Helm release change"],
    ["terraform apply -auto-approve", "an infrastructure change"],
    ["aws s3 rm s3://bucket/key", "a cloud write"],
    ["curl -X POST https://api.example.com/orders", "an HTTP request that changes something"],
    ["curl -d '{}' https://api.example.com/orders", "an HTTP request that changes something"],
    ["ssh prod-db 'ls'", "a remote shell or copy"],
    ["git push origin main", "a push"],
  ] as const)
    assert.equal(remoteWriteRefusal(bad), why, bad);
});

test("probe environment: credentials leave the model's shell, a kept name stays, credential files point at nothing, other variables are untouched", () => {
  const env = { DATABASE_URL: "postgres://prod", ORDERS_DATABASE_URL: "x", PGPASSWORD: "s", AWS_ACCESS_KEY_ID: "a", AWS_REGION: "eu", HOME: "/h", PATH: "/bin", LOCAL_DB: "postgres://localhost", ANTHROPIC_API_KEY: "k" };
  const prefix = scrubPrefix(env, ["LOCAL_*"], ["AWS_REGION"]);
  assert.match(prefix, /^unset AWS_ACCESS_KEY_ID DATABASE_URL LOCAL_DB ORDERS_DATABASE_URL PGPASSWORD; /);
  assert.match(prefix, /export KUBECONFIG=\/dev\/null AWS_CONFIG_FILE=\/dev\/null AWS_SHARED_CREDENTIALS_FILE=\/dev\/null PGPASSFILE=\/dev\/null PGSERVICEFILE=\/dev\/null CLOUDSDK_CONFIG=\/dev\/null; $/);
  for (const kept of ["AWS_REGION", "HOME", "PATH", "ANTHROPIC_API_KEY"]) assert.doesNotMatch(prefix.split(";")[0], new RegExp(`\\b${kept}\\b`), kept);
});

/** The guard as Pi loads it, against a stand-in that records its handlers. */
const loadGuard = (settings: GuardSettings | undefined) => {
  const handlers: Record<string, (e: any) => any> = {};
  const saved = process.env[GUARD_ENV];
  if (settings) process.env[GUARD_ENV] = JSON.stringify(settings);
  else delete process.env[GUARD_ENV];
  try {
    freshGuard({ on: (name: string, h: (e: any) => any) => (handlers[name] = h) } as any);
  } finally {
    if (saved === undefined) delete process.env[GUARD_ENV];
    else process.env[GUARD_ENV] = saved;
  }
  return handlers;
};
const settings = (o: Partial<GuardSettings>): GuardSettings => ({ role: "trier", shellSec: 1800, shellKey: "commandTimeoutSec", longSec: 1800, longKey: "commandTimeoutSec", longCommands: ["npm test"], runSec: 900, runKey: "probeTimeoutSec", drop: [], keep: [], configPath: ".pi/pb/config.json", ...o });

test("guard: the explorer is refused anything but inspection, a probe any remote write; both shells lose credentials; a command never outlasts its run", () => {
  const explorer = loadGuard(settings({ role: "explorer", shellSec: 120, shellKey: "explorer.commandTimeoutSec", longCommands: [], runSec: 1800, runKey: "explorer.timeoutSec" }));
  const refused = explorer.tool_call({ toolName: "bash", toolCallId: "1", input: { command: "psql -c 'select 1'" } });
  assert.equal(refused.block, true);
  assert.match(refused.reason, /The explorer only inspects: `psql` is not on the explorer's read-only list[\s\S]*belongs in pb_try/);
  const call = { toolName: "bash", toolCallId: "2", input: { command: "rg -n cancel src" } as { command: string; timeout?: number } };
  assert.equal(explorer.tool_call(call), undefined);
  assert.equal(call.input.timeout, 120);
  assert.match(call.input.command, /^(unset [^;]*; )?export KUBECONFIG=\/dev\/null [^;]*; rg -n cancel src$/, "inspected first, then run without credentials");

  const trier = loadGuard(settings({}));
  assert.match(trier.tool_call({ toolName: "bash", toolCallId: "3", input: { command: "kubectl delete pod web" } }).reason, /A probe never writes to a system outside this machine, and this looks like a change to a Kubernetes cluster/);
  const suite = { toolName: "bash", toolCallId: "4", input: { command: "npm test" } as { command: string; timeout?: number } };
  trier.tool_call(suite);
  assert.ok(suite.input.timeout! <= 900 && suite.input.timeout! >= 899, "the suite's long limit, but never past the probe's 900 s");
  // A timeout names the limit that fired, and how to raise it.
  const note = trier.tool_result({ toolName: "bash", toolCallId: "4", content: [{ type: "text", text: "Command timed out after 900 seconds" }] });
  assert.match(note.content.at(-1).text, /pb stopped this command at its limit \(probeTimeoutSec\)[\s\S]*raises probeTimeoutSec in \.pi\/pb\/config\.json \(0 = no limit\)/);
  const ordinary = { toolName: "bash", toolCallId: "5", input: { command: "sleep 10" } };
  loadGuard(settings({ runSec: 0, shellSec: 60 })).tool_call(ordinary);
  assert.equal((ordinary.input as { timeout?: number }).timeout, 60);
});

test("guard: without its settings it fails closed — no shell at all", () => {
  const guard = loadGuard(undefined);
  assert.deepEqual(guard.tool_call({ toolName: "bash", toolCallId: "1", input: { command: "ls" } }), { block: true, reason: "pb's guard has no settings, so this run has no shell." });
  assert.equal(guard.tool_call({ toolName: "read", toolCallId: "2", input: { path: "a" } }), undefined, "the read tools are not the guard's");
});
