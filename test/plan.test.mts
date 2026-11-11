/** Planning: /pb:plan and its protections, the baseline, standards, pb_ask, pb_explore and pb_try. */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { briefOf, diligent, PLANNING, setup, SPEC, until, written, repairLap } from "./harness.mts";

test("plan: investigation is free, project files are protected until /pb:plan off; spec asks for pb_write_spec", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.run("plan", "let admins cancel pending orders");
  assert.equal(t.names.get(path.join(t.repo, "planning-session.jsonl")), "plan: let admins cancel pending orders");
  assert.match(t.posts.at(-1)!, /back to it any time with \/resume, or `pi --session planning-session`/);
  assert.match(t.instructions.at(-1)!, /\[pb:plan\] let admins cancel pending orders[\s\S]*curl, one-off scripts in a temp directory[\s\S]*project map in AGENTS\.md[\s\S]*call pb_explore[\s\S]*whole repo[\s\S]*pb_explore and pb_try calls[\s\S]*raising a grep limit past ~15[\s\S]*Grep narrow[\s\S]*Run `true` once[\s\S]*pb_ask/);
  const scratch = path.join(os.tmpdir(), "pb-scratch.py");
  assert.equal((await t.callTool("write", { path: scratch, content: "print(1)" })).error, undefined); // outside the project: fine
  assert.match((await t.callTool("write", { path: "src/Order.java", content: "x" })).error!, /Planning mode: the project's files stay untouched/);
  assert.match((await t.callTool("edit", { path: path.join(t.repo, "README"), edits: [] })).error!, /Planning mode/);
  await t.run("plan", "off");
  assert.equal((await t.callTool("write", { path: "src/Order.java", content: "x" })).error, undefined);
  await t.run("plan");
  assert.match(t.notes.at(-1)!, /Describe what you want, in your own words/);
  await t.run("spec");
  assert.match(t.instructions.at(-1)!, /with the pb_write_spec tool[\s\S]*Not doing X, because[\s\S]*as tasks titled "\(refactor\) …" that keep behaviour/);
});

test("plan: a cancelled /pb:plan off says planning is still on, and the writes stay blocked", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.run("plan", "let admins cancel pending orders");
  fs.writeFileSync(path.join(t.repo, "notes.txt"), "x"); // a project file changed while planning
  t.selects.push("Cancel");
  await t.run("plan", "off");
  assert.match(t.notes.at(-1)!, /Planning is still on: the files changed while planning were neither kept nor restored/);
  assert.match((await t.callTool("write", { path: "src/Order.java", content: "y" })).error!, /Planning mode/);
  t.selects.push("Keep them");
  await t.run("plan", "off");
  assert.match(t.notes.at(-1)!, /Planning mode off/);
  assert.equal((await t.callTool("write", { path: "src/Order.java", content: "y" })).error, undefined);
});

test("plan: the marker keeps the full request verbatim, and the record keeps it for the checkpoint", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  const asked = "let admins cancel pending orders\nand notify the customer by mail";
  await t.run("plan", asked);
  assert.match(t.posts.at(-1)!, /> let admins cancel pending orders\n> and notify the customer by mail/);
  const session = t.runtime().ctx.sessionManager.getSessionFile();
  assert.equal(new Store(t.repo).planning(session)?.request, asked);
  // Re-saving without an explicit request preserves it (snapshots refresh, the seed survives).
  new Store(t.repo).setPlanning(session, true, "abc123");
  assert.equal(new Store(t.repo).planning(session)?.request, asked);
});

test("plan: the checkpoint summary keeps the original request", async () => {
  const { checkpointSummary } = await import("../extensions/pb/prompts.ts");
  const specs = [{ name: "x", markdown: "# X\n\n## Goal\ng\n" }];
  assert.match(checkpointSummary(specs, undefined, "cancel pending orders"), /Original request: cancel pending orders/);
  assert.doesNotMatch(checkpointSummary(specs), /Original request/);
});

test("plan mode stays with its session, not with the build session", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.run("plan", "x");
  await written(t);
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T1")) assert.equal((await tool("write", { path: "T1.src", content: "x" })).error, undefined); // editing works in the build
    return diligent(text, tool);
  };
  await t.run("build");
  assert.equal(t.progress("order-cancellation").phase, "built");
});

test("plan: a turn that changed a project file is named in the chat right away", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  t.selects.push("No thanks"); // the standards offer
  t.agent.script = async () => {
    fs.writeFileSync(path.join(t.repo, "stray.txt"), "written by a shell command");
  };
  await t.run("plan", "x");
  assert.ok(t.posts.some((x) => /^\*\*Changed while planning\*\* — these project files differ from when planning began: stray\.txt/.test(x)));
  // One note per change set: a second settle with nothing new doesn't repeat it.
  const notes = () => t.posts.filter((x) => x.startsWith("**Changed while planning**")).length;
  const before = notes();
  await t.fire("agent_settled", {});
  assert.equal(notes(), before);
  // A further change is named again.
  t.agent.script = async () => {
    fs.writeFileSync(path.join(t.repo, "second.txt"), "x");
  };
  await t.runtime().pi.sendMessage({ content: "Another turn.", display: false }, { triggerTurn: true });
  await t.settle();
  assert.equal(notes(), before + 1);
});

test("plan: files changed while planning (e.g. through bash) are shown before the build: keep or restore", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  t.selects.push("No thanks"); // the standards offer
  await t.run("plan", "x");
  fs.writeFileSync(path.join(t.repo, "stray.txt"), "written by a shell command");
  fs.writeFileSync(path.join(t.repo, "README"), "changed");
  await written(t);
  t.agent.script = diligent;
  t.selects.push("Restore them to how they were when planning began");
  await t.run("build");
  assert.match(t.selectTitles[1], /These project files changed while planning: (README, stray\.txt|stray\.txt, README)/);
  assert.ok(!fs.existsSync(path.join(t.repo, "stray.txt")));
  assert.equal(t.read("README"), "hi\n");
  assert.equal(t.progress("order-cancellation").phase, "built");
});

test("plan: the baseline runs in the background (no tokens) and a red suite warns before building", async () => {
  const t = setup({ verify: "exit 1", baseline: true });
  process.chdir(t.repo);
  await t.run("plan", "cancel orders");
  assert.match(t.instructions.at(-1)!, /The harness is running `exit 1` in the background/);
  assert.match(t.posts.find((p) => p.startsWith("▶ /pb:plan"))!, /running `exit 1` in the background for a baseline/);
  await until(() => t.posts.some((p) => p.startsWith("**Baseline**")));
  assert.match(t.posts.find((p) => p.startsWith("**Baseline**"))!, /FAIL \(exit 1\)[\s\S]*the final check runs the whole suite/i);
  assert.equal(JSON.parse(t.read(".pi/pb/baseline.json")).ok, false);
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  assert.ok(t.selectTitles.some((x) => /^Build order-cancellation\?\n- ⚠ the test suite already failed when planning began \(`exit 1` → FAIL/.test(x)));
});

test("plan: a baseline from an older commit doesn't block the build", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  fs.writeFileSync(
    path.join(t.repo, ".pi/pb/baseline.json"),
    JSON.stringify({ ok: false, command: "true", summary: "FAIL (exit 1)", at: "2026-10-01 09:00:00", head: "0000000000000000000000000000000000000000" }),
  );
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  assert.ok(!t.selectTitles.some((x) => x.startsWith("The test suite already failed")));
  assert.equal(t.progress("order-cancellation").phase, "built");
});

test("plan: re-planning the same session while its baseline is running doesn't start a second one", async () => {
  const where = path.join(os.tmpdir(), `pb-baseline-count-${process.pid}`);
  const flag = `${where}-flag`;
  fs.rmSync(where, { force: true });
  fs.rmSync(flag, { force: true });
  const t = setup({ verify: `while [ ! -f ${flag} ]; do sleep 0.05; done; echo x >> ${where}`, baseline: true });
  process.chdir(t.repo);
  await t.run("plan", "cancel orders");
  await new Promise((r) => setTimeout(r, 300)); // let the baseline get into its loop
  await t.run("plan", "cancel orders, delete first"); // same session: must not double-run
  fs.writeFileSync(flag, "");
  await until(() => t.posts.filter((p) => p.startsWith("**Baseline**")).length === 1);
  assert.equal(fs.readFileSync(where, "utf8").trim().split("\n").length, 1);
});

test("standards: a Java project gets the Java preset with pb's section, named as opinionated before it is accepted", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  fs.writeFileSync(path.join(t.repo, "pom.xml"), "<project/>");
  await t.run("plan", "x");
  const agents = fs.readFileSync(path.join(t.repo, "AGENTS.md"), "utf8");
  assert.match(agents, /even where the surrounding code doesn't[\s\S]*- Java: the current LTS release, with records, sealed types, pattern matching, virtual threads and scoped values; no Lombok\.\n<!-- \/pb:standards -->/);
  assert.match(t.notes.find((n) => n.startsWith("Added to"))!, /\(the backend ones, with Java\)/);
  // The preset's opinions are named in the offer, with where your own goes instead, and again once it's written.
  const offer = t.selectTitles.find((x) => x.startsWith("Engineering standards"))!;
  assert.match(offer, /pb's java preset is opinionated: Java's current LTS with records, sealed types and virtual threads, no Lombok\. To use your own instead, put it in .*pb\/standards\/java\.md\./);
  assert.match(t.notes.find((n) => n.startsWith("Added to"))!, /\/pb:standards rewrites pb's section, so a change of yours inside it lasts until then; pb's java preset is opinionated/);
});

test("standards: a Vue project gets the frontend section, without the database rules", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  fs.writeFileSync(path.join(t.repo, "package.json"), JSON.stringify({ dependencies: { vue: "^3.5.0" } }));
  await t.run("plan", "x");
  const agents = fs.readFileSync(path.join(t.repo, "AGENTS.md"), "utf8");
  assert.match(agents, /- Quality: [\s\S]*- One source of truth: every rule lives in the backend[\s\S]*- Backend refusals: RFC 9457[\s\S]*- Vue: Vue 3 Composition API[\s\S]*a double click, a session that expires mid-edit, a URL from the query string\. Search for existing copies of any rule you touched\.\n<!-- \/pb:standards -->/);
  assert.doesNotMatch(agents, /Consistency and concurrency|- Java:|Compare against the database/);
  assert.ok(t.selectTitles.some((x) => /^Engineering standards \(.*browser security, Vue\)\. pb's vue preset is opinionated: the backend decides every rule; an HttpOnly session cookie with CSRF tokens; RFC 9457 problem details/.test(x)));
  assert.match(t.notes.find((n) => n.startsWith("Added to"))!, /the frontend ones, for a Vue project/);
});

test("standards: a Java project that also has a Vue package.json keeps the backend section", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  fs.writeFileSync(path.join(t.repo, "pom.xml"), "<project><dependencies><dependency><artifactId>postgresql</artifactId></dependency></dependencies></project>");
  fs.writeFileSync(path.join(t.repo, "package.json"), JSON.stringify({ devDependencies: { vue: "^3.5.0" } }));
  await t.run("plan", "x");
  const agents = fs.readFileSync(path.join(t.repo, "AGENTS.md"), "utf8");
  assert.match(agents, /Consistency and concurrency[\s\S]*- Java: the current LTS/);
  assert.doesNotMatch(agents, /Frontend role/);
});

test("standards: a Rust project gets the Rust lines; the database rules come only with a database", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  fs.writeFileSync(path.join(t.repo, "Cargo.toml"), '[package]\nname = "x"\n\n[dependencies]\nserde = "1"\n');
  await t.run("plan", "x");
  const agents = t.read("AGENTS.md");
  assert.match(agents, /- No overengineering: build for the needs you have[\s\S]*- Rust: the stable toolchain and the current edition\.[\s\S]*`\/\/ SAFETY:`[\s\S]*- Rust async and tooling: [^\n]*\n<!-- \/pb:standards -->/);
  assert.doesNotMatch(agents, /Consistency and concurrency|Database rules|- Java:/);
  assert.ok(t.selectTitles.some((x) => /^Engineering standards \(quality, no overengineering, [^)]*, Rust\)\. pb's rust preset is opinionated: thiserror in libraries/.test(x)));
  assert.match(t.notes.find((n) => n.startsWith("Added to"))!, /\(the backend ones, with Rust\)/);

  const u = setup({ verify: "true" });
  process.chdir(u.repo);
  fs.writeFileSync(path.join(u.repo, "Cargo.toml"), '[package]\nname = "x"\n\n[dependencies]\nsqlx = { version = "0.8", features = ["postgres"] }\n');
  await u.run("plan", "x");
  assert.match(u.read("AGENTS.md"), /- Database rules: [\s\S]*- Consistency and concurrency come from the database[\s\S]*- Rust: /);
  assert.ok(u.selectTitles.some((x) => /database consistency, Rust\)\. pb's rust preset is opinionated/.test(x)));
});

test("standards: a project with no stack and no database gets the core alone", async () => {
  const t = setup();
  process.chdir(t.repo);
  await t.run("standards");
  const agents = t.read("AGENTS.md");
  assert.match(agents, /- No overengineering: build for the needs you have, not ones you might\./);
  assert.match(agents, /- One source of truth: a rule or canonical form that already exists \(a shared helper, a type, a constraint\)/);
  assert.doesNotMatch(agents, /database|SQL|ON CONFLICT/i); // nothing a project without one can act on
  fs.mkdirSync(path.join(t.repo, "db/migrations"), { recursive: true });
  await t.run("standards");
  assert.match(t.read("AGENTS.md"), /compare against the database's own form in SQL[\s\S]*ON CONFLICT/);
  assert.match(t.notes.at(-1)!, /\(the plain ones, with the database rules\)/);
});

test("standards: a database project under a shared core section is offered its own, never the all-projects file", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const { agentDir, DEFAULT_STANDARDS } = await import("../extensions/pb/standards.ts");
  const global = path.join(agentDir(), "AGENTS.md");
  fs.mkdirSync(agentDir(), { recursive: true });
  fs.writeFileSync(global, DEFAULT_STANDARDS);
  try {
    fs.writeFileSync(path.join(t.repo, "package.json"), JSON.stringify({ dependencies: { pg: "^8.0.0" } }));
    t.selects.push("<timeout>");
    await t.run("plan", "x");
    assert.match(t.selectTitles[0], /only gets the standards in .*AGENTS\.md, not its own/);
    assert.deepEqual(t.selectOptions[0], ["Add pb's engineering standards to this project's AGENTS.md", "No thanks"]);
    assert.equal(fs.readFileSync(global, "utf8"), DEFAULT_STANDARDS); // the shared core carries no database rules

    const u = setup({ verify: "true" });
    process.chdir(u.repo);
    u.selects.push("<timeout>");
    await u.run("plan", "x"); // no stack, no database: the shared core is enough
    assert.equal(u.selectTitles.length, 0);
  } finally {
    fs.rmSync(global, { force: true });
  }
});

test("standards: a SQL database is detected from its driver, ORM or migrations, in each ecosystem", async () => {
  const { usesDatabase } = await import("../extensions/pb/standards.ts");
  const project = (files: Record<string, string>, dirs: string[] = []) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-db-"));
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    for (const d of dirs) fs.mkdirSync(path.join(dir, d), { recursive: true });
    return dir;
  };
  assert.equal(usesDatabase(project({ "package.json": JSON.stringify({ devDependencies: { "drizzle-orm": "1" } }) })), true);
  assert.equal(usesDatabase(project({ "package.json": JSON.stringify({ dependencies: { express: "5", "pg-format": "1" } }) })), false); // a name only near a driver's
  assert.equal(usesDatabase(project({ "package.json": "{not json" })), false);
  assert.equal(usesDatabase(project({ "Cargo.toml": '[dependencies]\ndiesel = { version = "2" }\n' })), true);
  assert.equal(usesDatabase(project({ "Cargo.toml": '[dependencies]\nserde = "1" # postgres someday\n' })), false);
  assert.equal(usesDatabase(project({ "pom.xml": "<artifactId>spring-boot-starter-data-jpa</artifactId>" })), true);
  assert.equal(usesDatabase(project({ "pom.xml": "<artifactId>netty-codec-http2</artifactId>" })), false);
  assert.equal(usesDatabase(project({ "go.mod": "module x\nrequire github.com/jackc/pgx/v5 v5.7.0\n" })), true);
  assert.equal(usesDatabase(project({ "pyproject.toml": '[project]\ndependencies = ["SQLAlchemy>=2"]\n' })), true);
  assert.equal(usesDatabase(project({ "requirements.txt": "flask\npsycopg2-binary==2.9\n" })), true);
  assert.equal(usesDatabase(project({}, ["src/main/resources/db/migration"])), true);
  assert.equal(usesDatabase(project({ migrations: "a file, not a directory" })), false);
  assert.equal(usesDatabase(project({})), false);
  if (process.platform !== "win32") {
    const fifo = project({});
    execSync("mkfifo Cargo.toml", { cwd: fifo }); // a planted pipe must not hang the offer
    assert.equal(usesDatabase(fifo), false);
  }
});

test("standards: /pb:build without a /pb:plan first offers them too, once", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const r = await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  assert.equal(r.error, undefined);
  t.agent.script = diligent;
  await t.run("build");
  assert.match(t.selectTitles[0], /^Engineering standards \(/);
  assert.match(t.read("AGENTS.md"), /<!-- pb:standards -->/);
  assert.equal(t.progress("order-cancellation").phase, "built");
  const asked = t.selectTitles.length;
  await t.run("plan", "next");
  assert.equal(t.selectTitles.length, asked); // not asked again
});

test("standards: a Vue project under shared standards is offered its frontend section; stack sections never go global", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const { agentDir, DEFAULT_STANDARDS } = await import("../extensions/pb/standards.ts");
  const global = path.join(agentDir(), "AGENTS.md");
  fs.mkdirSync(agentDir(), { recursive: true });
  fs.writeFileSync(global, DEFAULT_STANDARDS);
  try {
    fs.writeFileSync(path.join(t.repo, "package.json"), JSON.stringify({ dependencies: { vue: "^3.5.0" } }));
    await t.run("plan", "x");
    assert.match(t.selectTitles[0], /only gets the standards in .*AGENTS\.md, not its own \(the frontend ones, for a Vue project\)[\s\S]*keep the shared AGENTS\.md free of stack-specific rules/);
    assert.match(t.read("AGENTS.md"), /- Frontend role:/);
    assert.equal(fs.readFileSync(global, "utf8"), DEFAULT_STANDARDS); // untouched

    const u = setup({ verify: "true" });
    process.chdir(u.repo);
    fs.writeFileSync(path.join(u.repo, "pom.xml"), "<project/>");
    fs.rmSync(global);
    u.selects.push("<timeout>");
    await u.run("plan", "x");
    assert.deepEqual(u.selectOptions[0], ["Add pb's engineering standards to this project's AGENTS.md", "No thanks"]); // no "all projects" for a Java section
    assert.ok(!fs.existsSync(global));
  } finally {
    fs.rmSync(global, { force: true });
  }
});

test("/pb:standards: creates AGENTS.md, replaces only pb's section, and recovers from a missing file", async () => {
  const t = setup();
  process.chdir(t.repo);
  const { DEFAULT_STANDARDS, FRONTEND_STANDARDS } = await import("../extensions/pb/standards.ts");
  const agents = path.join(t.repo, "AGENTS.md");

  await t.run("standards");
  assert.equal(fs.readFileSync(agents, "utf8"), DEFAULT_STANDARDS); // created, plain: no stack detected
  assert.match(t.notes.at(-1)!, /^Created .*AGENTS\.md \(the plain ones\), with pb's standards\./);
  const asked = t.selectTitles.length;
  await t.run("plan", "x");
  assert.equal(t.selectTitles.length, asked); // the offer counts as answered

  const before = "# Shop\n\nOur notes.\n\n";
  const after = "\n<!-- pb:map -->\n## Project map\n- `src/`\n<!-- /pb:map -->\n";
  fs.writeFileSync(agents, `${before}<!-- pb:standards -->\n## Engineering standards\n\n- Old rule.\n<!-- /pb:standards -->\n${after}`);
  await t.run("standards", "vue");
  assert.equal(fs.readFileSync(agents, "utf8"), `${before}${FRONTEND_STANDARDS}${after}`); // the rest, byte for byte
  assert.match(t.notes.at(-1)!, /^Replaced pb's standards in .*\(the frontend ones, for a Vue project\)\. The rest of the file is untouched\./);
  await t.run("standards", "vue");
  assert.match(t.notes.at(-1)!, /^pb's standards are already current in/);

  fs.writeFileSync(agents, "# Shop\n");
  fs.writeFileSync(path.join(t.repo, "pom.xml"), "<project/>");
  await t.run("standards");
  assert.match(fs.readFileSync(agents, "utf8"), /^# Shop\n\n<!-- pb:standards -->[\s\S]*- Java: [^\n]*\n<!-- \/pb:standards -->\n$/);
  assert.match(t.notes.at(-1)!, /^Added pb's standards to .*\(the backend ones, with Java\)/);

  const broken = "# Shop\n<!-- pb:standards -->\n- mine\n";
  fs.writeFileSync(agents, broken);
  await t.run("standards");
  assert.equal(fs.readFileSync(agents, "utf8"), broken); // left alone
  assert.match(t.notes.at(-1)!, /without its "<!-- \/pb:standards -->"/);

  await t.run("standards", "react");
  assert.match(t.notes.at(-1)!, /takes java, vue, rust, plain \(default: detected from the project\)/);
});

test("standards templates: yours are detected before pb's, replace a built-in of the same name, and /pb:standards takes them", async () => {
  const { templatesDir, stackNames } = await import("../extensions/pb/standards.ts");
  const dir = templatesDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "go.md"), "detect: go.mod\n- Go 1.25: errors wrapped with %w; no panics across packages.\n");
  fs.writeFileSync(path.join(dir, "java.md"), "## Our Java rules\n\n- Java 25 and Spring Boot 4.\n");
  try {
    assert.deepEqual(stackNames(), ["go", "java", "vue", "rust", "plain"]);
    const t = setup({ verify: "true" });
    process.chdir(t.repo);
    fs.writeFileSync(path.join(t.repo, "go.mod"), "module x\n");
    await t.run("plan", "x");
    assert.equal(t.selectTitles[0], "Engineering standards (your go template)");
    assert.equal(t.read("AGENTS.md"), "<!-- pb:standards -->\n## Engineering standards\n\n- Go 1.25: errors wrapped with %w; no panics across packages.\n<!-- /pb:standards -->\n");
    assert.match(t.notes.find((n) => n.startsWith("Added to"))!, /\(your go template\)/);

    fs.writeFileSync(path.join(t.repo, "pom.xml"), "<project/>");
    await t.run("standards", "java"); // yours replaces pb's java, and keeps its detection
    assert.equal(t.read("AGENTS.md"), "<!-- pb:standards -->\n## Our Java rules\n\n- Java 25 and Spring Boot 4.\n<!-- /pb:standards -->\n");
    await t.run("standards", "cobol"); // a stack nobody defined
    assert.match(t.notes.at(-1)!, /takes go, java, vue, rust, plain[\s\S]*Your own go in .*pb\/standards/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("plan: the baseline runs in a separate worktree, so it can't collide with builds in the working copy", async () => {
  const where = path.join(os.tmpdir(), `pb-baseline-pwd-${process.pid}`);
  const t = setup({ verify: `pwd > ${where}`, baseline: true });
  process.chdir(t.repo);
  await t.run("plan", "x");
  await until(() => t.posts.some((p) => p.startsWith("**Baseline**")));
  const dir = fs.readFileSync(where, "utf8").trim();
  assert.match(dir, /pb-worktree-[^/]+\/tree$/); // not the working copy
  assert.ok(!fs.existsSync(dir)); // removed afterwards
  assert.doesNotMatch(execSync("git worktree list", { cwd: t.repo, encoding: "utf8" }), /pb-worktree-/);
});

test("pb_explore answers from a separate context; its usage is reported and counted", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.run("plan", "cancel orders");
  const r = await t.callTool("pb_explore", { question: "How are order transitions built?" });
  assert.match(r.content![0].text, /OrderService applies transitions\. \(asked: How are order transitions built\?\)/);
  assert.equal(r.usage!.totalTokens, 3400);
  const d = (r as { details?: any }).details;
  assert.equal(d.tokens, 3400);
  assert.equal(typeof d.ms, "number");
  // Anything the explorer changes in the project is put back.
  process.env.MOCK_EXPLORE_WRITE = path.join(t.repo, "EXPLORE_WAS_HERE");
  try {
    await t.callTool("pb_explore", { question: "Where else?" });
    assert.ok(!fs.existsSync(path.join(t.repo, "EXPLORE_WAS_HERE")));
  } finally {
    delete process.env.MOCK_EXPLORE_WRITE;
  }
  // A stopped run tells the planner how to retry.
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(t.runtime().tools.pb_explore.execute("call", { question: "Where else?" }, stopped.signal, undefined, t.runtime().ctx), /Narrow the question/);
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  await t.run("stats");
  assert.match(t.posts.at(-1)!, /Explorer +3 calls · in 6\.0k · out 800( @ [\d.]+k? tok\/s)? · \$0\.04/);
});

test("explore: a session replaced mid-run still puts back what the run changed", async () => {
  const t = setup();
  process.chdir(t.repo);
  await t.run("plan", "cancel orders");
  process.env.MOCK_EXPLORE_WRITE = path.join(t.repo, "EXPLORE_WAS_HERE");
  process.env.MOCK_HOLD_MS = "1000"; // the explorer writes only after the hold: switch sessions while it waits
  try {
    const homeCtx = t.runtime().ctx;
    const pending = t.callTool("pb_explore", { question: "How are order transitions built?" });
    const freshSessions = path.join(t.repo, ".pi/pb/sessions/explorer");
    await until(() => fs.existsSync(freshSessions) && fs.readdirSync(freshSessions).length > 0);
    // You start a new session while the explorer is still running: its ctx goes stale, but the
    // teardown must not read through it or the guard restore is skipped.
    await homeCtx.newSession({});
    await pending;
    assert.ok(!fs.existsSync(path.join(t.repo, "EXPLORE_WAS_HERE")));
  } finally {
    delete process.env.MOCK_EXPLORE_WRITE;
    delete process.env.MOCK_HOLD_MS;
  }
});

test("explore: a file you edited while it ran is named, and recoverable from the post-run snapshot", async () => {
  const t = setup();
  process.chdir(t.repo);
  await t.run("plan", "cancel orders");
  process.env.MOCK_HOLD_MS = "1000"; // the explorer is alive while you edit
  try {
    const pending = t.callTool("pb_explore", { question: "How are order transitions built?" });
    const freshSessions = path.join(t.repo, ".pi/pb/sessions/explorer");
    await until(() => fs.existsSync(freshSessions) && fs.readdirSync(freshSessions).length > 0);
    fs.writeFileSync(path.join(t.repo, "README"), "my edit during the explorer\n");
    await pending;
  } finally {
    delete process.env.MOCK_HOLD_MS;
  }
  assert.equal(t.read("README"), "hi\n"); // the read-only guarantee still wins...
  const note = t.notes.find((n) => /Files changed while the explorer ran were put back/.test(n))!;
  assert.match(note, /README/); // ...but the edit is named, not lost silently
  const after = /\bthe post-run tree is in ([0-9a-f]{40})/.exec(note)![1];
  const before = /git diff ([0-9a-f]{40})/.exec(note)![1];
  assert.equal(execSync(`git show ${after}:README`, { cwd: t.repo }).toString(), "my edit during the explorer\n"); // the post-run tree kept it
  assert.match(execSync(`git diff ${before} ${after} -- README`, { cwd: t.repo }).toString(), /\+my edit during the explorer/);
});

test("pb_explore keeps the answer when it arrives across messages", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.run("plan", "cancel orders");
  process.env.MOCK_SPLIT_TEXT = "1";
  try {
    const r = await t.callTool("pb_explore", { question: "Where is the model?" });
    assert.match(r.content![0].text, /holds the model[\s\S]*applies transitions/);
  } finally {
    delete process.env.MOCK_SPLIT_TEXT;
  }
});

test("pb_try probes by running in a separate context; project changes are put back", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.run("plan", "cancel orders");
  const r = await t.callTool("pb_try", { goal: "Is probing fast enough for 10k rows?" });
  assert.match(r.content![0].text, /## Conclusion[\s\S]*fast enough\. \(goal: Is probing fast enough/);
  assert.equal(r.usage!.totalTokens, 3400);
  const d = (r as { details?: any }).details;
  assert.match(d.session, /^\.pi\/pb\/sessions\/try\/.+\.jsonl$/);
  assert.equal(execSync("git status --porcelain --untracked-files=no", { cwd: t.repo, encoding: "utf8" }).trim(), "");
  // Anything the probe changes in the project is put back.
  process.env.MOCK_TRY_WRITE = path.join(t.repo, "TRY_WAS_HERE");
  try {
    await t.callTool("pb_try", { goal: "Does the probe leave files behind?" });
    assert.ok(!fs.existsSync(path.join(t.repo, "TRY_WAS_HERE")));
  } finally {
    delete process.env.MOCK_TRY_WRITE;
  }
  // A stopped probe tells the planner how to retry.
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(t.runtime().tools.pb_try.execute("call", { goal: "Is it still fast?" }, stopped.signal, undefined, t.runtime().ctx), /Split the goal/);
});

test("pb_try stops a probe that outlives probeTimeoutSec and says how to bound the rerun", async () => {
  const t = setup({ verify: "true", probeTimeoutSec: 1 });
  process.chdir(t.repo);
  await t.run("plan", "cancel orders");
  process.env.MOCK_HOLD_MS = "10000"; // the trier would run four times past the limit
  const started = Date.now();
  const r = await t.callTool("pb_try", { goal: "Run until stopped" }).finally(() => {
    delete process.env.MOCK_HOLD_MS;
  });
  assert.ok(Date.now() - started < 8000, `the probe was stopped after ${Date.now() - started}ms`);
  assert.match(r.error!, /Probe stopped after 1s \(probeTimeoutSec\)/);
  assert.match(r.error!, /size the input[\s\S]*`timeout <seconds>`/);
});

test("explorer and trier check the project map before reading code", async () => {
  const { EXPLORER_SYSTEM, TRY_SYSTEM } = await import("../extensions/pb/prompts.ts");
  assert.match(EXPLORER_SYSTEM, /project map in AGENTS\.md/);
  assert.match(TRY_SYSTEM, /project map in AGENTS\.md/);
});

test("/pb:deps investigates dependencies as a change of its own, in planning mode", async () => {
  const t = setup();
  process.chdir(t.repo);
  fs.writeFileSync(path.join(t.repo, "pom.xml"), "<project/>\n");
  fs.writeFileSync(path.join(t.repo, "package.json"), "{}\n");
  fs.writeFileSync(path.join(t.repo, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n");
  await t.run("deps", "jackson");
  const prompt = t.instructions.at(-1)!;
  assert.match(prompt, /^\[pb:deps\] jackson\n\nReview these dependencies: jackson: versions, deprecated APIs we call, known vulnerabilities, and the runtime itself/);
  assert.match(prompt, /don't change the project's files: that is blocked until \/pb:build\. Never install, update or "fix" anything into the project/);
  // The stack's own read-only commands, for every ecosystem the manifests show.
  assert.match(prompt, /- Node \(pnpm\): `pnpm outdated` · `pnpm audit`\n- Java \(Maven\): `mvn -q versions:display-dependency-updates versions:display-plugin-updates` · `mvn -q org\.owasp:dependency-check-maven:check` \(the audit downloads/);
  // Planning's frame: investigation, the evidence rule, the reply shape built for upgrades, and the next step.
  assert.match(prompt, /How to investigate:\n1\. Check the project map/);
  assert.match(prompt, /cites its source \(the changelog or migration-guide entry\) and our call site \(path:line\)[\s\S]*whether our code reaches the vulnerable path/);
  assert.match(prompt, /- Proposed changes — the upgrades grouped into changes I would merge on their own, in order \(patch and minor together, each major alone, a framework before its plugins\)/);
  assert.match(prompt, /- Pinned by a host — [\s\S]*never upgraded on their own/);
  assert.match(prompt, /\/pb:build writes one spec per chosen change and builds the first\. End your first reply with this block, verbatim:\n\n\*\*What now\*\*/);
  assert.match((await t.callTool("write", { path: "pom.xml", content: "x" })).error!, /Planning mode/);
});

test("plan: a red lint baseline warns before building but never blocks alone", async () => {
  const t = setup({ verify: "true", lint: "false", baseline: true });
  process.chdir(t.repo);
  await t.run("plan", "cancel orders");
  await until(() => t.posts.some((p) => p.startsWith("**Baseline**")));
  assert.match(t.posts.find((p) => p.startsWith("**Baseline**"))!, /lint `false`/);
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  assert.ok(t.notes.some((n) => /Lint\/project checks already failed when planning began/.test(n))); // warning, no dialog
  assert.ok(!t.selectTitles.some((x) => x.startsWith("The test suite already failed"))); // the suite was green
  assert.equal(t.progress("order-cancellation").phase, "paused"); // the final gate still fails on lint
});

test("pb_ask runs one at a time: two questions in one message come as two dialogs, not one dismissing the other", async () => {
  const t = setup();
  process.chdir(t.repo);
  assert.equal(t.runtime().tools.pb_ask.executionMode, "sequential");
  assert.match(t.runtime().tools.pb_ask.description, /ask a question that depends on another's answer only after you have that answer/);
});

test("standards: offered once into AGENTS.md; repeated in a message only when the session hasn't loaded them", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.run("plan", "x"); // default choice: this project's AGENTS.md
  const agents = path.join(t.repo, "AGENTS.md");
  assert.match(fs.readFileSync(agents, "utf8"), /<!-- pb:standards -->[\s\S]*Dependencies: current, non-deprecated APIs and versions only[\s\S]*Comments: concise, and only where they add what the code can't say[\s\S]*written to current best practice for this stack even where existing tests aren't[\s\S]*<!-- \/pb:standards -->/);
  assert.doesNotMatch(fs.readFileSync(agents, "utf8"), /even when it is more work|latest stable versions|inconsistent with its surroundings/);
  assert.match(fs.readFileSync(agents, "utf8"), /even where the surrounding code doesn't[\s\S]*refactor it to current practice, planned as a task of its own/);
  assert.match(t.instructions.at(-1)!, /Engineering standards \(from AGENTS\.md\)[\s\S]*a proper fix, never a workaround/); // this session started before they existed
  fs.writeFileSync(agents, fs.readFileSync(agents, "utf8").replace("Tests: test behaviour", "Java 21: records, no Lombok. Tests: test behaviour"));

  await t.run("plan", "y"); // asked once only; now the session has them loaded
  t.runtime().contextFiles = [{ path: agents, content: fs.readFileSync(agents, "utf8") }];
  await t.run("plan", "z");
  assert.doesNotMatch(t.instructions.at(-1)!, /Engineering standards \(from AGENTS\.md\)/);
  assert.equal((fs.readFileSync(agents, "utf8").match(/<!-- pb:standards -->/g) ?? []).length, 1); // not added twice

  t.runtime().contextFiles = [];
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  assert.match(t.instructions.find((i) => /\[pb:build order-cancellation\]/.test(i))!, /Java 21: records, no Lombok/);
});

test("/pb:plan <spec> continues planning in a fresh session seeded from the spec", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: PLANNING });
  const before = t.runtime();
  before.model = { provider: "p", id: "big", contextWindow: 262000 };
  await t.run("plan", "order-cancellation");
  const r = t.runtime();
  assert.notEqual(r, before);
  const session = r.ctx.sessionManager.getSessionFile();
  assert.equal(t.names.get(session), "plan: order-cancellation");
  assert.equal(r.model.id, "big");
  assert.match(t.instructions.at(-1)!, /^\[pb:plan order-cancellation\] Let's continue planning this[\s\S]*Don't redo the analysis or reopen rejected ideas[\s\S]*project map in AGENTS\.md[\s\S]*Start with the open questions[\s\S]*## Open questions/);
  assert.equal(t.progress("order-cancellation").writtenIn, session); // it knows the spec now
  assert.match((await t.callTool("write", { path: "x.java", content: "x" })).error!, /Planning mode/); // planning mode in the new session
});

test("/pb:plan refuses to start while Pi is mid-turn", async () => {
  const t = setup();
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  t.agent.script = async () => {
    await gate;
  };
  const first = t.run("plan", "cancel orders");
  await until(() => t.instructions.length === 1);
  const rt = t.runtime();
  await rt.cmds["pb:plan"].handler("a second idea", rt.ctx);
  assert.match(t.notes.at(-1)!, /Pi is busy\. Wait for the current turn to finish\./);
  assert.equal(t.instructions.length, 1); // nothing was instructed mid-turn
  release();
  await first;
});

test("/pb:plan refuses to start without a session file instead of promising protection it can't keep", async () => {
  const t = setup();
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  const rt = t.runtime();
  const original = rt.ctx.sessionManager.getSessionFile;
  rt.ctx.sessionManager.getSessionFile = () => undefined;
  try {
    await rt.cmds["pb:plan"].handler("cancel orders", rt.ctx);
  } finally {
    rt.ctx.sessionManager.getSessionFile = original;
  }
  assert.match(t.notes.at(-1)!, /No session file.*planning protections can't run/);
  assert.equal(t.instructions.length, 0);
});

test("/pb:plan with checkpoints off warns that planning changes can't be listed", async () => {
  const t = setup({ checkpoints: false });
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  await t.run("plan", "cancel orders");
  assert.match(t.notes.at(-1)!, /Checkpoints are off, so pb can't list what changed while planning/);
  assert.equal(t.instructions.length, 1); // planning still starts, degraded
});

test("/pb:plan <spec> with checkpoints off warns in the fresh session too", async () => {
  const t = setup({ checkpoints: false });
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: PLANNING });
  await t.run("plan", "order-cancellation");
  assert.match(t.notes.at(-1)!, /Checkpoints are off, so pb can't list what changed while planning/);
  assert.match(t.instructions.at(-1)!, /^\[pb:plan order-cancellation\] Let's continue planning this/);
});

test("/pb:plan outside git warns that the tree couldn't be snapshotted", async () => {
  const t = setup();
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  fs.rmSync(path.join(t.repo, ".git"), { recursive: true, force: true });
  await t.run("plan", "cancel orders");
  assert.match(t.notes.at(-1)!, /Could not snapshot the working tree, so pb can't list what changed while planning/);
  assert.equal(t.instructions.length, 1);
});

test("/pb:deps refuses while Pi is mid-turn, and otherwise plans like /pb:plan", async () => {
  const t = setup();
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  t.agent.script = async () => {
    await gate;
  };
  const first = t.run("deps", "all");
  await until(() => t.instructions.length === 1);
  const rt = t.runtime();
  await rt.cmds["pb:deps"].handler("all", rt.ctx);
  assert.match(t.notes.at(-1)!, /Pi is busy\. Wait for the current turn to finish\./);
  assert.equal(t.instructions.length, 1);
  release();
  await first;

  const u = setup();
  process.chdir(u.repo);
  const { writeMap } = await import("../extensions/pb/map.ts");
  writeMap(u.repo, "- `src/gone.ts`: gone");
  await u.run("deps", "all"); // standards offered (no preselect needed: first option applies), map staleness warned
  assert.ok(u.selectTitles.some((x) => /^Engineering standards/.test(x)));
  assert.ok(fs.existsSync(path.join(u.repo, "AGENTS.md")));
  assert.match((await u.callTool("write", { path: "x.ts", content: "x" })).error!, /Planning mode/);
  assert.ok(u.notes.some((n) => /The project map in AGENTS\.md names 1 path\(s\) that no longer exist \(src\/gone\.ts\)/.test(n)));
});

test("/pb:plan without a session file leaves the session name alone", async () => {
  const t = setup();
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  const rt = t.runtime();
  const original = rt.ctx.sessionManager.getSessionFile;
  rt.ctx.sessionManager.getSessionFile = () => undefined;
  try {
    await rt.cmds["pb:plan"].handler("cancel orders", rt.ctx);
  } finally {
    rt.ctx.sessionManager.getSessionFile = original;
  }
  assert.equal(t.names.size, 0); // rename happens only once planning actually starts
});

test("/pb:plan <spec> re-checks the project map in the fresh session", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  const { writeMap } = await import("../extensions/pb/map.ts");
  writeMap(t.repo, "- `src/gone.ts`: gone");
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: PLANNING });
  await t.run("plan", "order-cancellation");
  assert.ok(t.notes.some((n) => /The project map in AGENTS\.md names 1 path\(s\) that no longer exist \(src\/gone\.ts\)/.test(n)));
});

test("planning guard: absolute paths inside the project are blocked, outside are fine", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  await t.run("plan", "x");
  assert.match((await t.callTool("write", { path: path.join(t.repo, "inside.txt"), content: "x" })).error!, /Planning mode/);
  assert.equal((await t.callTool("write", { path: path.join(os.tmpdir(), "pb-outside.txt"), content: "x" })).error, undefined);
});

test("planning guard: the same directory spelled in another path form is still inside", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  await t.run("plan", "x");
  // /var/... is a symlink to /private/var/... on macOS: a target spelled the other way must not
  // read as "outside the project" and slip the block.
  const other = fs.realpathSync(t.repo);
  assert.notEqual(other, t.repo, "this test needs a repo whose path resolves through a symlink");
  assert.match((await t.callTool("write", { path: path.join(other, "inside.txt"), content: "x" })).error!, /Planning mode/);
  assert.ok(!fs.existsSync(path.join(t.repo, "inside.txt")));
});

test("/pb:plan outside git warns the baseline shares the working copy", async () => {
  const t = setup({ verify: "true", baseline: true });
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  fs.rmSync(path.join(t.repo, ".git"), { recursive: true, force: true });
  await t.run("plan", "cancel orders");
  assert.ok(t.notes.some((n) => /Not a git repo, so the baseline runs in the working copy/.test(n)));
  await until(() => t.posts.some((p) => p.startsWith("**Baseline**")));
});

test("baselines run per session: a second planning session doesn't wait for the first one's", async () => {
  const where = path.join(os.tmpdir(), `pb-baseline-two-${process.pid}`);
  const flag = `${where}-flag`;
  fs.rmSync(where, { force: true });
  fs.rmSync(flag, { force: true });
  const t = setup({ verify: `while [ ! -f ${flag} ]; do sleep 0.05; done; echo x >> ${where}`, baseline: true });
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  await t.run("plan", "cancel orders"); // baseline 1 starts in session 1, gated on the flag
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: PLANNING });
  await t.run("plan", "order-cancellation"); // fresh session 2: its own baseline starts, not deduped against session 1's
  fs.writeFileSync(flag, "");
  await until(() => fs.existsSync(where) && fs.readFileSync(where, "utf8").trim().split("\n").length === 2);
  assert.equal(fs.readFileSync(where, "utf8").trim().split("\n").length, 2); // both ran: one global slot would have run one
  await until(() => t.posts.some((p) => p.startsWith("**Baseline**"))); // session 2's result lands in the live session
});

test("/pb:plan one-lines a long multi-line arg for display and caps the model copy", async () => {
  const t = setup();
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  const arg = `add cancel\n**bold** line ${"x".repeat(20000)}`;
  await t.run("plan", arg);
  const name = t.names.get(path.join(t.repo, "planning-session.jsonl"))!;
  assert.ok(!name.includes("\n"), "session name is one line");
  assert.ok(name.length <= "plan: ".length + 60, `session name capped (${name.length})`);
  const marker = t.posts.at(-1)!;
  assert.ok(!marker.includes("\n**bold**"), "marker carries no raw newline from the arg");
  assert.match(t.instructions.at(-1)!, /…\[truncated \d+ chars\]/); // the cut is disclosed, not silent
});

test("/pb:plan near-miss spec names redirect instead of starting a silent new plan", async () => {
  const t = setup();
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: PLANNING });
  const before = t.instructions.length;
  for (const miss of ["order_cancellation", "Order-Cancellation", "order-cancellation."]) {
    await t.run("plan", miss);
    assert.match(t.notes.at(-1)!, new RegExp(`Did you mean \`order-cancellation\`\\? \`\\/pb:plan order-cancellation\``));
  }
  assert.equal(t.instructions.length, before); // nothing was instructed, no session renamed
  assert.equal(t.names.get(path.join(t.repo, "planning-session.jsonl")), undefined);
});

test("planning sessions are per-session files: interleaved writes don't clobber", async () => {
  const t = setup();
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  const s = new Store(t.repo);
  s.setPlanning("/s/a.jsonl", true, "snap-a");
  s.setPlanning("/s/b.jsonl", true, "snap-b"); // a second writer must not drop the first entry (the old read-modify-write did)
  assert.deepEqual(s.planningSessions().sort(), ["/s/a.jsonl", "/s/b.jsonl"]);
  assert.equal(s.planning("/s/a.jsonl")?.snapshot, "snap-a");
  assert.ok(!fs.existsSync(path.join(t.repo, ".pi/pb/planning.json"))); // no shared file to race on
  s.setPlanning("/s/a.jsonl", false);
  assert.deepEqual(s.planningSessions(), ["/s/b.jsonl"]);
  assert.equal(s.planning("/s/b.jsonl")?.snapshot, "snap-b");
  s.setPlanning("/s/b.jsonl", true, undefined, "cancel orders");
  assert.equal(s.planning("/s/b.jsonl")?.request, "cancel orders");
  assert.equal(s.planning("/s/b.jsonl")?.snapshot, "snap-b"); // merge preserved
});

test("legacy planning.json migrates to per-session files on first write", async () => {
  const t = setup();
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  fs.writeFileSync(path.join(t.repo, ".pi/pb/planning.json"), JSON.stringify({ "/s/old.jsonl": { snapshot: "s0" } }));
  const s = new Store(t.repo);
  assert.deepEqual(s.planningSessions(), ["/s/old.jsonl"]); // legacy still read
  s.setPlanning("/s/new.jsonl", true);
  assert.deepEqual(s.planningSessions().sort(), ["/s/new.jsonl", "/s/old.jsonl"]);
  assert.ok(!fs.existsSync(path.join(t.repo, ".pi/pb/planning.json"))); // migrated away
  assert.equal(s.planning("/s/old.jsonl")?.snapshot, "s0");
});

test("planning widget is set on /pb:plan and cleared on off", async () => {
  const t = setup();
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  await t.run("plan", "cancel orders");
  assert.deepEqual(t.widgets.get("pb-plan"), ["planning · /pb:plan off"]);
  await t.run("plan", "off");
  assert.equal(t.widgets.get("pb-plan"), undefined);
});

test("/pb:plan while the baseline is still running says so instead of claiming a fresh one", async () => {
  const where = path.join(os.tmpdir(), `pb-baseline-shared-${process.pid}`);
  const flag = `${where}-flag`;
  fs.rmSync(where, { force: true });
  fs.rmSync(flag, { force: true });
  const t = setup({ verify: `while [ ! -f ${flag} ]; do sleep 0.05; done; echo x >> ${where}`, baseline: true });
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  try {
    await t.run("plan", "first idea"); // baseline starts, gated on the flag
    await t.run("plan", "second idea"); // same session, still in flight: shared, not restarted
    const markers = t.posts.filter((p) => p.startsWith("▶ /pb:plan"));
    assert.equal(markers.length, 2);
    assert.match(markers[0], /running `while .*` in the background for a baseline/);
    assert.match(markers[1], /baseline already running — its result lands here/);
  } finally {
    fs.writeFileSync(flag, "");
  }
  await until(() => t.posts.some((p) => p.startsWith("**Baseline**")));
});

test("plan: cancelling a fresh planning session drops its handover instead of leaking it", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: PLANNING });
  process.env.MOCK_NEW_SESSION_CANCEL = "1";
  try {
    await t.run("plan", "order-cancellation");
  } finally {
    delete process.env.MOCK_NEW_SESSION_CANCEL;
  }
  assert.match(t.notes.at(-1)!, /Cancelled\./);
  assert.ok(!fs.existsSync(path.join(t.repo, ".pi/pb/carry.json")));
});

test("/pb:plan off without planning mode says so instead of confirming", async () => {
  const t = setup();
  process.chdir(t.repo);
  await t.run("plan", "off");
  assert.match(t.notes.at(-1)!, /Not in planning mode\./);
});

test("/pb:plan <spec> sets a ready spec back to planning while it is replanned", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() }); // no Status line: ready
  await t.run("plan", "order-cancellation");
  assert.match(t.read(".pi/pb/specs/order-cancellation/spec.md"), /Status: planning/);
  assert.ok(t.events("order-cancellation").some((e) => e.type === "spec" && e.update === "status"));
  assert.match(t.notes.at(-1)!, /set back to planning/);
  assert.match(t.instructions.at(-1)!, /^\[pb:plan order-cancellation\] Let's continue planning this/);
});

test("/pb:plan <spec> points finished specs at review, unfinished ones at build", async () => {
  const t = setup();
  process.chdir(t.repo);
  await written(t);
  const instructionsBefore = t.instructions.length;
  fs.writeFileSync(
    path.join(t.repo, ".pi/pb/specs/order-cancellation/progress.json"),
    JSON.stringify({ ...t.progress("order-cancellation"), phase: "paused" }),
  );
  await t.run("plan", "order-cancellation");
  assert.match(t.notes.at(-1)!, /its phase is paused\): `\/pb:build order-cancellation` continues the unfinished build/);
  fs.writeFileSync(
    path.join(t.repo, ".pi/pb/specs/order-cancellation/progress.json"),
    JSON.stringify({ ...t.progress("order-cancellation"), phase: "built" }),
  );
  await t.run("plan", "order-cancellation");
  assert.match(t.notes.at(-1)!, /its phase is built\): `\/pb:review order-cancellation` reviews it/);
  assert.equal(t.instructions.length, instructionsBefore); // warnings only, no planning started
});

test("/pb:plan <spec> warns instead of treating the name as a new idea when the spec already passed planning", async () => {
  const t = setup();
  process.chdir(t.repo);
  await written(t);
  fs.writeFileSync(
    path.join(t.repo, ".pi/pb/specs/order-cancellation/progress.json"),
    JSON.stringify({ ...t.progress("order-cancellation"), phase: "paused" }),
  );
  const instructionsBefore = t.instructions.length;
  await t.run("plan", "order-cancellation");
  assert.match(t.notes.at(-1)!, /`order-cancellation` is not being planned \(its phase is paused\)/);
  assert.equal(t.instructions.length, instructionsBefore); // no new planning instruction was sent
});

test("/pb:plan <spec> first asks about files the old planning session changed, and baselines the new one", async () => {
  const t = setup({ verify: "true", baseline: true });
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  await t.run("plan", "cancel orders");
  await until(() => t.posts.some((p) => p.startsWith("**Baseline**"))); // the old session's baseline
  fs.writeFileSync(path.join(t.repo, "stray.txt"), "written by a shell command");
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: PLANNING });
  t.selects.push("Restore them to how they were when planning began");
  await t.run("plan", "order-cancellation");
  assert.ok(t.selectTitles.some((x) => x.startsWith("These project files changed while planning:")));
  assert.ok(!fs.existsSync(path.join(t.repo, "stray.txt")));
  await until(() => t.posts.filter((p) => p.startsWith("**Baseline**")).length === 2); // a fresh one for the new session
});

test("pb_explore shows what it's doing: the question, its live steps, then a one-line summary (all of it expanded)", async () => {
  const { exploreLines } = await import("../extensions/pb/render.ts");
  const details = { steps: ["grep transition src/order", "read src/order/OrderService.java", "read src/order/Order.java"], count: 7, files: ["src/order/OrderService.java", "src/order/Order.java"], started: 1000 };
  assert.deepEqual(
    exploreLines({ details, answer: "", partial: true, expanded: false, now: 19_000 }).map((l) => l.text),
    ["↳ grep transition src/order", "↳ read src/order/OrderService.java", "↳ read src/order/Order.java", "7 steps · 18s"],
  );
  const answer = "OrderService applies the transitions.\nOrder holds the state.";
  const done = { ...details, ms: 34_000, tokens: 3200 };
  assert.deepEqual(exploreLines({ details: done, answer, partial: false, expanded: false }).map((l) => l.text), ["explored in 34s · 2 files read · 3.2k tokens", "OrderService applies the transitions."]);
  assert.deepEqual(
    exploreLines({ details: { ...done, tokens: undefined, tokensIn: 3000, tokensOut: 200 }, answer, partial: false, expanded: false }).map((l) => l.text),
    ["explored in 34s · 2 files read · 3.0k in · 200 out @ 5.9 tok/s", "OrderService applies the transitions."],
  );
  assert.deepEqual(
    exploreLines({ details: { ...done, ms: undefined, tokens: undefined, tokensIn: 3000, tokensOut: 200 }, answer, partial: false, expanded: false }).map((l) => l.text),
    ["explored in 0s · 2 files read · 3.0k in · 200 out", "OrderService applies the transitions."],
  );
  const all = exploreLines({ details: done, answer, partial: false, expanded: true }).map((l) => l.text);
  assert.deepEqual(all, ["explored in 34s · 2 files read · 3.2k tokens", "OrderService applies the transitions.", "Order holds the state.", "files read:", "  src/order/OrderService.java", "  src/order/Order.java"]);
  assert.deepEqual(exploreLines({ answer: "Exploration stopped.", partial: false, expanded: false, error: true }).map((l) => l.kind), ["error"]);
});

test("pb_explore live view keeps a wider, bounded window over bursts", async () => {
  const { exploreLines, LIVE_STEPS, LIVE_WRITING_LINES } = await import("../extensions/pb/render.ts");
  assert.equal(LIVE_STEPS, 8);
  assert.equal(LIVE_WRITING_LINES, 4);
  const steps = Array.from({ length: 12 }, (_, i) => `grep hit${i} src/`);
  const writing = ["l1", "l2", "l3", "l4", "l5", "l6"];
  const lines = exploreLines({ details: { steps, count: 12, files: [], started: 1000, writing }, answer: "", partial: true, expanded: false, now: 19_000 }).map((l) => l.text);
  assert.deepEqual(lines, [...steps.slice(-8).map((s) => `↳ ${s}`), ...writing.slice(-4).map((l) => `│ ${l}`), "12 steps · 18s"]);
});

test("map: it asks only when something looks off (unanswered: it is written and the flags are posted); /pb:plan warns about paths that vanished", async () => {
  const t = setup({ verify: "true", askTimeoutSec: 0.001 });
  fs.mkdirSync(path.join(t.repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(t.repo, "src/order.ts"), "export {}\n");
  process.chdir(t.repo);
  process.env.MOCK_MAP_STUBBORN = "1"; // the cartographer doesn't fix src/gone.ts
  t.selects.push("Keep the current map");
  await t.run("map");
  assert.match(t.selectTitles.at(-1)!, /The proposed project map needs a look: `auth\/Login` doesn't resolve; `src\/gone\.ts` doesn't resolve/);
  assert.ok(!fs.existsSync(path.join(t.repo, "AGENTS.md"))); // kept on purpose: nothing written
  // Nobody answers: a run is not thrown away; it is written, and what it was flagged for is said where you'll look.
  t.selects.push("<timeout>");
  await t.run("map");
  delete process.env.MOCK_MAP_STUBBORN;
  assert.match(t.read("AGENTS.md"), /gone\.ts/);
  assert.match(t.posts.at(-1)!, /^\*\*The project map was written without your answer\*\*, with what it was flagged for:\n- `auth\/Login` doesn't resolve\n- `src\/gone\.ts` doesn't resolve\n\n`\/pb:map undo` puts the previous map back\.$/);

  const u = setup({ verify: "true", mapOnArchive: false });
  await written(u);
  u.agent.script = diligent;
  await u.run("build");
  await u.run("archive");
  assert.ok(!fs.existsSync(path.join(u.repo, "AGENTS.md")));

  const { writeMap } = await import("../extensions/pb/map.ts");
  writeMap(u.repo, "- `README`: readme\n- `src/billing/Invoice.java`: invoices");
  process.chdir(u.repo);
  u.selects.push("No thanks");
  await u.run("plan", "next feature");
  assert.ok(u.notes.some((n) => /The project map in AGENTS\.md names 1 path\(s\) that no longer exist \(src\/billing\/Invoice\.java\): \/pb:map refreshes it/.test(n)));
});

test("map: a dismissed proposal is kept for /pb:map apply, written only onto the map it was made against; a deliberate keep drops it", async () => {
  const t = setup({ verify: "true", askTimeoutSec: 600 });
  fs.mkdirSync(path.join(t.repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(t.repo, "src/order.ts"), "export {}\n");
  process.chdir(t.repo);
  process.env.MOCK_MAP_STUBBORN = "1";
  try {
    await t.run("map", "apply");
    assert.match(t.notes.at(-1)!, /No proposed map is waiting/);
    // Dismissed (Esc, not a timeout): nothing written, the run's result kept, and the human told how to take it.
    t.selects.push("<timeout>");
    await t.run("map");
    assert.ok(!fs.existsSync(path.join(t.repo, "AGENTS.md")));
    assert.match(t.notes.at(-1)!, /Map not changed\. The proposal is kept: `\/pb:map apply` writes it as it is\./);
    await t.run("map", "apply");
    assert.match(t.read("AGENTS.md"), /gone\.ts/);
    assert.match(t.notes.at(-1)!, /The proposed project map \(made .+ ago\) is now in AGENTS\.md, with what it was flagged for: `auth\/Login` doesn't resolve/);
    await t.run("map", "apply");
    assert.match(t.notes.at(-1)!, /No proposed map is waiting/, "applied once, then gone");
    await t.run("map", "undo");
    assert.ok(!fs.existsSync(path.join(t.repo, "AGENTS.md")) || !/gone\.ts/.test(t.read("AGENTS.md")), "undo puts the map before the apply back");

    // A map changed since the proposal was made is never overwritten by it.
    t.selects.push("<timeout>");
    await t.run("map");
    const { writeMap } = await import("../extensions/pb/map.ts");
    writeMap(t.repo, "### Layout\n- `src/order.ts`: written by hand meanwhile");
    const before = t.read("AGENTS.md");
    await t.run("map", "apply");
    assert.match(t.notes.at(-1)!, /The project map changed since this proposal was made, so pb didn't write it over your changes/);
    assert.equal(t.read("AGENTS.md"), before);

    // A deliberate "Keep the current map" drops it.
    t.selects.push("<timeout>");
    await t.run("map");
    assert.ok(fs.existsSync(path.join(t.repo, ".pi/pb/map-proposed.json")));
    t.selects.push("Keep the current map");
    await t.run("map");
    assert.equal(t.notes.at(-1), "Map not changed.");
    assert.ok(!fs.existsSync(path.join(t.repo, ".pi/pb/map-proposed.json")));
  } finally {
    delete process.env.MOCK_MAP_STUBBORN;
  }
});

test("extra instructions: added to each role's prompt, global ones first, pb's own kept", async () => {
  const { agentDir } = await import("../extensions/pb/standards.ts");
  const global = path.join(agentDir(), "pb", "config.json");
  fs.mkdirSync(path.dirname(global), { recursive: true });
  fs.writeFileSync(global, JSON.stringify({ extra: { plan: "Global: think about rollout.", build: "Global: keep functions short." } }));
  try {
    const t = setup({ verify: "true", reviewer: { security: "always" }, extra: { plan: "Project: mind the i18n keys.", spec: "Always include a rollout task.", review: "Check the i18n keys.", adversarial: "Try the admin API." } });
    process.chdir(t.repo);
    t.selects.push("No thanks");
    await t.run("plan", "x");
    // The planner's extra lives with its role, in the system section every planning turn carries.
    assert.match(t.systemSections.at(-1)!.pb_planner, /no Open questions remain\.[\s\S]*\n\nAlso, from your pb config:\nGlobal: think about rollout\.\nProject: mind the i18n keys\.$/);
    assert.doesNotMatch(t.instructions.at(-1)!, /Also, from your pb config/);
    await t.run("spec");
    assert.match(t.instructions.at(-1)!, /Name: short kebab-case\.[\s\S]*Also, from your pb config:\nAlways include a rollout task\./);
    await written(t);
    t.agent.script = diligent;
    await t.run("build");
    assert.match(t.instructions.find((i) => /\[pb:build order-cancellation\]/.test(i))!, /Finish each task with pb_task_done[^\n]*\n\nAlso, from your pb config:\nGlobal: keep functions short\./);
    const abuseSystem = path.join(os.tmpdir(), `pb-abuse-system-${process.pid}.md`);
    process.env.MOCK_SYSTEM_OUT = abuseSystem;
    try {
      await t.run("review");
    } finally {
      delete process.env.MOCK_SYSTEM_OUT;
    }
    assert.match(briefOf(t), /You are an independent REVIEWER[\s\S]*Also, from your pb config:\nCheck the i18n keys\./);
    assert.match(fs.readFileSync(abuseSystem, "utf8"), /You are an ATTACKER[\s\S]*Also, from your pb config:\nTry the admin API\./);
    fs.rmSync(abuseSystem);
  } finally {
    fs.rmSync(global, { force: true });
  }
  const u = setup({ verify: "true", extra: { map: "List the Kafka topics." } });
  process.chdir(u.repo);
  const sys = path.join(os.tmpdir(), `pb-map-system-${process.pid}.md`);
  process.env.MOCK_SYSTEM_OUT = sys;
  try {
    await u.run("map");
  } finally {
    delete process.env.MOCK_SYSTEM_OUT;
  }
  assert.match(fs.readFileSync(sys, "utf8"), /^You are a CARTOGRAPHER[\s\S]*report_map tool[\s\S]*\n\nAlso, from your pb config:\nList the Kafka topics\.$/);
  fs.rmSync(sys);
  const { Store } = await import("../extensions/pb/store.ts");
  assert.equal(new Store(u.repo).extra("plan"), ""); // nothing set: nothing added
});

test("pb_ask counts down while planning too: unanswered, the question stays open and planning stays incomplete", async () => {
  const t = setup({ askTimeoutSec: 0.001 });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  t.selects.push("<timeout>");
  const r = await t.callTool("pb_ask", { question: "Mail or event?", options: ["mail", "event"], recommended: "event" });
  assert.equal(t.dialogTimeouts.at(-1), 1);
  assert.match(r.content![0].text, /No answer in time: it stays open — do not take a reading or tag it assumed\. Record it under Open questions; planning stays incomplete until it is answered\./);
  assert.doesNotMatch(r.content![0].text, /recorded as an assumption/);
  // The dialog is gone, the question isn't: it stays in the chat with its options, lettered for a short answer — and nothing was decided.
  assert.equal(t.posts.at(-1), "**Unanswered question** (no answer within 1 min; nothing was decided — the question stays open):\n\nMail or event?\n\nA. mail\nB. event (recommended)\n\nTo answer, type it here any time (a letter is enough): if Pi is working, it reads it after its current step.");
});

test("pb_ask questions are phrased in plain words, with trade-offs and a reasoned recommendation", async () => {
  const { ASK_DESCRIPTION } = await import("../extensions/pb/index.ts");
  assert.match(ASK_DESCRIPTION, /plain words/);
  assert.match(ASK_DESCRIPTION, /one line per option.*trade-off|trade-off.*one line per option/);
  assert.match(ASK_DESCRIPTION, /recommendation.*plain reason|plain reason.*recommendation/);
});

test("pb_ask: a dialog closed before its time is kept in the chat too; an answered one isn't", async () => {
  const t = setup();
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  const posted = t.posts.length;
  t.selects.push("mail");
  assert.match((await t.callTool("pb_ask", { question: "Mail or event?", options: ["mail", "event"] })).content![0].text, /^The human answered: mail$/);
  assert.equal(t.posts.length, posted);
  t.selects.push("<timeout>");
  const r = await t.callTool("pb_ask", { question: "Which name?", options: ["a", "b"] });
  assert.match(r.content![0].text, /^The human dismissed the question: it stays open — do not take a reading or tag it assumed\.[\s\S]*The question stays in the chat/);
  assert.match(t.posts.at(-1)!, /^\*\*Unanswered question\*\* \(the dialog was closed; nothing was decided — the question stays open\):\n\nWhich name\?\n\nA\. a\nB\. b\n/);
});

test("pb_ask: terminal activity restarts the countdown — idle time, not wall time", async () => {
  const t = setup({ askTimeoutSec: 2 });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  (t.runtime().ctx as any).mode = "tui";
  t.selects.push("<hang>");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let settled = false;
  const p = t.callTool("pb_ask", { question: "Mail or event?", options: ["mail", "event"], recommended: "event" }).then((r) => {
    settled = true;
    return r;
  });
  await sleep(1000);
  t.key();
  await sleep(500);
  t.key();
  await sleep(1000);
  assert.equal(settled, false); // 2.5s elapsed but 1s idle: an absolute timeout would have fired
  const r = await p;
  assert.equal(settled, true);
  assert.match(r.content![0].text, /No answer in time: it stays open/);
  assert.ok(t.posts.some((x) => x.startsWith("**Unanswered question**")));
});

test("pb_ask: silence still times out the dialog", async () => {
  const t = setup({ askTimeoutSec: 1 });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  (t.runtime().ctx as any).mode = "tui";
  t.selects.push("<hang>");
  const r = await t.callTool("pb_ask", { question: "Mail or event?", options: ["mail", "event"], recommended: "event" });
  assert.match(r.content![0].text, /No answer in time: it stays open/);
  assert.ok(t.posts.some((x) => x.startsWith("**Unanswered question**")));
});

test("pb_ask: picking Something else keeps the options visible while typing", async () => {
  const t = setup();
  process.chdir(t.repo);
  t.selects.push("Something else (type it)", "event, but only for refunds");
  const r = await t.callTool("pb_ask", { question: "Mail or event?", options: ["mail", "event"], recommended: "event" });
  assert.match(r.content![0].text, /^The human answered: event, but only for refunds$/);
  const posted = t.posts.find((x) => x.startsWith("**Answering with your own words:**"));
  assert.ok(posted);
  assert.match(posted!, /Mail or event\?[\s\S]*A\. mail[\s\S]*B\. event \(recommended\)/);
});

test("plan continue clears the old session when it has no specs left", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  await t.run("plan", "cancel orders");
  const oldFile = t.runtime().ctx.sessionManager.getSessionFile();
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: PLANNING });
  await t.run("plan", "order-cancellation");
  const newFile = t.runtime().ctx.sessionManager.getSessionFile();
  assert.notEqual(newFile, oldFile);
  const s = new Store(t.repo);
  assert.ok(s.planning(newFile));
  assert.equal(s.planning(oldFile), undefined);
});

test("baselines are per session: parallel planners don't clobber", async () => {
  const t = setup({ verify: "true", baseline: true });
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  await t.run("plan", "cancel orders");
  await until(() => t.posts.some((p) => p.startsWith("**Baseline**")));
  const sess1 = t.runtime().ctx.sessionManager.getSessionFile();
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: PLANNING });
  await t.run("plan", "order-cancellation");
  await until(() => t.posts.filter((p) => p.startsWith("**Baseline**")).length === 2);
  const sess2 = t.runtime().ctx.sessionManager.getSessionFile();
  assert.notEqual(sess1, sess2);
  const dir = path.join(t.repo, ".pi/pb/baselines");
  assert.ok(fs.existsSync(dir));
  assert.equal(fs.readdirSync(dir).length, 2);
  const s = new Store(t.repo);
  assert.ok(s.baseline(sess1));
  assert.ok(s.baseline(sess2));
});

test("plan continue tracks a spec that has no progress yet", async () => {
  const t = setup();
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  fs.mkdirSync(path.join(t.repo, ".pi/pb/specs/manual"), { recursive: true });
  fs.writeFileSync(path.join(t.repo, ".pi/pb/specs/manual/spec.md"), PLANNING);
  await t.run("plan", "manual");
  const sess = t.runtime().ctx.sessionManager.getSessionFile();
  const s = new Store(t.repo);
  const p = s.progress("manual");
  assert.ok(p);
  assert.equal(p.writtenIn, sess);
  assert.ok(s.specsOfPlanning(sess).includes("manual"));
});

test("large-file warning only lists files changed while planning", async () => {
  const t = setup();
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  const oldBig = path.join(t.repo, "old-big.bin");
  fs.writeFileSync(oldBig, Buffer.alloc(21 * 1024 * 1024, 1));
  const oldTime = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(oldBig, oldTime, oldTime);
  await t.run("plan", "x");
  fs.writeFileSync(path.join(t.repo, "new-big.bin"), Buffer.alloc(21 * 1024 * 1024, 1));
  const before = t.notes.length;
  await t.run("plan", "off");
  const warnings = t.notes.slice(before).filter((n) => /Large files/.test(n));
  assert.ok(warnings.length > 0);
  assert.match(warnings.at(-1)!, /new-big\.bin/);
  assert.doesNotMatch(warnings.at(-1)!, /old-big\.bin/);
});

test("/pb:approach needs a planning session and waits for Pi to be idle", async () => {
  const t = setup();
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  await t.run("approach", "event-driven");
  assert.match(t.notes.at(-1)!, /is for planning sessions: run \/pb:plan first/);
  assert.equal(t.instructions.length, 0);

  const { Store: S2 } = await import("../extensions/pb/store.ts");
  new S2(t.repo).markAsked("standards");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  t.agent.script = async () => {
    await gate;
  };
  const first = t.run("plan", "cancel orders");
  await until(() => t.instructions.length === 1);
  const rt = t.runtime();
  await rt.cmds["pb:approach"].handler("event-driven", rt.ctx);
  assert.match(t.notes.at(-1)!, /Pi is busy\. Wait for the current turn to finish\./);
  assert.equal(t.instructions.length, 1);
  release();
  await first;
});

test("/pb:approach expands the named idea without writing anything or asking", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  await t.run("plan", "cancel orders");
  await t.run("approach", "event-driven notifications");
  assert.match(t.posts.at(-1)!, /▶ \/pb:approach — event-driven notifications \(chat only: nothing is written\)/);
  assert.match(
    t.instructions.at(-1)!,
    /^\[pb:approach\] event-driven notifications[\s\S]*Expand this idea: event-driven notifications[\s\S]*Understanding[\s\S]*Approach[\s\S]*Non-goals[\s\S]*Test strategy[\s\S]*Alternatives[\s\S]*Risks[\s\S]*Assumptions[\s\S]*Open questions[\s\S]*List them only: do not call pb_ask[\s\S]*No code, no task breakdown/,
  );
  assert.deepEqual(new Store(t.repo).specNames(), []);
});

test("/pb:approach without an idea infers it from the discussion", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  await t.run("plan", "cancel orders");
  await t.run("approach");
  assert.match(t.posts.at(-1)!, /▶ \/pb:approach \(chat only: nothing is written\)/);
  assert.match(t.instructions.at(-1)!, /^\[pb:approach\][\s\S]*Infer the idea from our discussion/);
});

test("planning prompts push back like a senior engineer", async () => {
  const { PLANNER_ROLE, planPrompt, continuePlanPrompt, approachPrompt } = await import("../extensions/pb/prompts.ts");
  assert.match(PLANNER_ROLE, /Push back like a senior engineer/);
  assert.match(PLANNER_ROLE, /disagree when the idea is second-best/);
  assert.match(PLANNER_ROLE, /never taste/);
  assert.match(PLANNER_ROLE, /blocker, suggestion, or nit/);
  assert.match(PLANNER_ROLE, /what would change your mind/);
  assert.match(PLANNER_ROLE, /When you know better, teach: the trade-off and the principle behind your alternative, and where this codebase already applies it/);
  assert.match(PLANNER_ROLE, /rabbit holes/);
  // The stance lives in the planner's system section only: no first message repeats it.
  for (const p of [planPrompt("x", "true", "", "none"), continuePlanPrompt("s", "# S", ""), approachPrompt("y", "")]) assert.doesNotMatch(p, /Push back like a senior engineer/);
});

test("planner role: who it is, the problem before the solution, expertise as evidence, the whole system walked, and a ledger", async () => {
  const { PLANNER_ROLE, planPrompt, specPrompt } = await import("../extensions/pb/prompts.ts");
  assert.match(PLANNER_ROLE, /^You are the senior engineer who owns this change end to end, from the need behind it to running it in production\. Your job is the best plan for what I actually need, not agreement with what I first asked for\./);
  // P2: the problem first, and a right idea gets one line, not a debate.
  assert.match(PLANNER_ROLE, /Before any solution, state the goal in a line or two and how we'll know it worked\. Challenge the request itself when it deserves it: the need behind it, something that already does it, the cleanest thing that meets it\. Build for the needs this change has, not ones it might have:[\s\S]*more work now beats debt later\. When my idea is already right, say so in one line and move on\./);
  assert.match(planPrompt("x", "true", "", "none"), /Reply with exactly:\n\n- Problem — the goal in a line or two, how we'll know it worked, and any challenge to the request itself/);
  // P3: established practice counts, taste does not.
  assert.match(PLANNER_ROLE, /Evidence is this code \(a path:line, a constraint found, a test that would fail\) or a named practice, standard or documented behaviour with its concrete consequence here; never taste\./);
  // P4: the whole lifecycle is walked, in proportion; what isn't engineering goes to the right person.
  assert.match(PLANNER_ROLE, /walk what applies and skip what doesn't; a small change touches one or two of these:/);
  assert.match(PLANNER_ROLE, /- Users: what they see when it works and when it fails \(messages, empty states\); accessibility and languages when there is a UI\./);
  assert.match(PLANNER_ROLE, /- Data: the model and who owns it, how existing records and API clients survive the change, what personal data is kept, for how long, and who can see it\./);
  assert.match(PLANNER_ROLE, /- Security: who can reach it and with what \(a stolen session, another user's, replayed or automated requests\), what could leak \(secrets, personal data\), what a new dependency brings in\./);
  assert.match(PLANNER_ROLE, /- Verification: how we'll prove it works, what no test can show, what test data it needs\./);
  // Time is planned, not discovered in review.
  assert.match(PLANNER_ROLE, /- Input and state: [^\n]*time zones and day boundaries when it handles time\./);
  assert.match(PLANNER_ROLE, /A question outside engineering \(legal, compliance, licensing\) is flagged for the right person, not answered\./);
  assert.match(PLANNER_ROLE, /- Design: where does this belong, what does it couple, what does it make harder later, what already does part of it, what generality does nobody need\?/);
  assert.match(PLANNER_ROLE, /- Operations: how it ships \(a flag, migration order, rollback\), how we'd see it fail in production \(logs, metrics, alerts\), its latency and cost at the expected scale\./);
  // P5: a ledger every reply; an overruled objection is recorded once, not re-argued; the spec transcribes it.
  assert.match(PLANNER_ROLE, /end each reply with a short ledger: Decided \(each with its reason\) and Open \(each with your recommendation\)\. When I overrule you without new evidence, take my decision: put it under Decided with your objection and its risk, and don't argue it again unless something new turns up\./);
  assert.match(specPrompt("", []), /Transcribe the conversation's ledger: what was decided goes into Decisions with its reason \(an objection I overruled stays beside its decision as the risk\)/);
});

test("planner role: every run of a planning session carries it, long after the first message; it leaves with planning", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  assert.match(t.systemSections.at(-1)!.pb_planner, /^You are the senior engineer who owns this change end to end/);
  assert.doesNotMatch(t.instructions.at(-1)!, /You are the senior engineer/); // not pasted into the conversation
  t.runtime().pi.sendUserMessage("and refunds?");
  await t.settle();
  assert.match(t.systemSections.at(-1)!.pb_planner, /^You are the senior engineer who owns this change end to end/); // a later turn still has it
  await t.run("plan", "off");
  t.runtime().pi.sendUserMessage("thanks");
  await t.settle();
  assert.equal(t.systemSections.at(-1)!.pb_planner, undefined);
});

test("planner settings: planning thinks at least at the planner's level and on its model; its end puts back what you didn't change", async () => {
  const { plannerSettings } = await import("../extensions/pb/kit.ts");
  assert.deepEqual(plannerSettings({ thinking: "low", model: "p/m" }, {}), { thinking: "low", model: "p/m", appliedThinking: "high" });
  assert.deepEqual(plannerSettings({ thinking: "max", model: "p/m" }, {}), { thinking: "max", model: "p/m" }); // a floor, never lowered
  assert.deepEqual(plannerSettings({ thinking: "high", model: "p/m" }, { thinking: "xhigh", model: "p/big" }), { thinking: "high", model: "p/m", appliedThinking: "xhigh", appliedModel: "p/big" });

  const t = setup({ verify: "true", planner: { model: "p/big" } });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  assert.deepEqual([t.runtime().thinking, t.runtime().model.id], ["high", "big"]);
  await t.run("plan", "off");
  assert.deepEqual([t.runtime().thinking, t.runtime().model.id], ["off", "m"]);

  const u = setup({ verify: "true" });
  process.chdir(u.repo);
  u.selects.push("No thanks");
  await u.run("plan", "cancel orders");
  assert.equal(u.runtime().thinking, "high");
  u.runtime().pi.setThinkingLevel("xhigh"); // you chose differently mid-planning
  await u.run("plan", "off");
  assert.equal(u.runtime().thinking, "xhigh", "your own choice is kept");

  const w = setup({ verify: "true", planner: { model: "p/nope" } });
  process.chdir(w.repo);
  w.selects.push("No thanks");
  await w.run("plan", "cancel orders");
  assert.equal(w.runtime().model.id, "m");
  assert.ok(w.notes.some((n) => /planner\.model p\/nope isn't available here: planning stays on p\/m/.test(n)));
});

test("planner settings: a plan continued in a fresh session plans on them too, and its end puts back the original", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: PLANNING });
  t.runtime().thinking = "low";
  await t.run("plan", "order-cancellation");
  assert.equal(t.runtime().thinking, "high");
  assert.match(t.systemSections.at(-1)!.pb_planner, /^You are the senior engineer/);
  await t.run("plan", "off");
  assert.equal(t.runtime().thinking, "low");
});

test("plan ends decided: the exit criteria demand answered attack questions and no open leftovers", async () => {
  const { PLANNER_ROLE, planPrompt } = await import("../extensions/pb/prompts.ts");
  assert.match(PLANNER_ROLE, /Before a plan is settled, walk what applies/);
  assert.match(PLANNER_ROLE, /- Security: who can reach it/);
  assert.match(PLANNER_ROLE, /Planning is finished when they are and no Open questions remain\./);
  assert.match(planPrompt("x", "true", "", "none"), /planning.*(not finished|incomplete)|not.*done until/i);
});

test("deps: the lockfile peer ranges match package.json", async () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  assert.deepEqual(lock.packages[""].peerDependencies, pkg.peerDependencies); // npm ci refuses when these disagree
});

test("pb_explore and pb_try run guarded: the guard is loaded with each tool's limits, and a silent explorer is stopped by its idle limit", async () => {
  const t = setup({ verify: "npm test", commandTimeoutSec: 1800, verifyTimeoutSec: 600, probeTimeoutSec: 900, explorer: { idleSec: 1, timeoutSec: 1800, commandTimeoutSec: 120 } });
  process.chdir(t.repo);
  const out = path.join(os.tmpdir(), `pb-fresh-args-${process.pid}.txt`);
  const guardOf = () => {
    const [argv, settings] = fs.readFileSync(out, "utf8").split("\n---\n");
    return { argv, settings: JSON.parse(settings) };
  };
  process.env.MOCK_FRESH_ARGS_OUT = out;
  try {
    assert.equal((await t.callTool("pb_explore", { question: "Where are transitions?" })).error, undefined);
    let g = guardOf();
    assert.match(g.argv, /\n-e\n[^\n]*fresh-guard\.ts\n/, "the guard is loaded into the explorer's process");
    assert.deepEqual([g.settings.role, g.settings.shellSec, g.settings.runSec, g.settings.longCommands], ["explorer", 120, 1800, []]);
    assert.equal((await t.callTool("pb_try", { goal: "Does the ORM lock the row?" })).error, undefined);
    g = guardOf();
    assert.match(g.argv, /fresh-guard\.ts/);
    assert.equal(g.settings.role, "trier");
    assert.deepEqual([g.settings.shellSec, g.settings.longSec, g.settings.longKey, g.settings.runSec], [1800, 1800, "commandTimeoutSec", 900], "the suite's limit is never below an ordinary command's");
    assert.ok(g.settings.longCommands.includes("npm test"), "the project's suite is a long command");
    // A stuck explorer: no event at all for longer than idleSec.
    process.env.MOCK_EXPLORE_HANG = "4000";
    const stuck = await t.callTool("pb_explore", { question: "Where else?" });
    assert.match(stuck.error ?? "", /^Exploration stopped after 1s without progress \(explorer\.idleSec\)\. Split the question[\s\S]*raises the limit in \.pi\/pb\/config\.json \(0 = none\)/);
  } finally {
    delete process.env.MOCK_FRESH_ARGS_OUT;
    delete process.env.MOCK_EXPLORE_HANG;
    fs.rmSync(out, { force: true });
  }
});

test("/pb:deps runs the suite in the background for a baseline, as /pb:plan does: an upgrade is judged against today's suite", async () => {
  const t = setup({ verify: "true", baseline: true });
  process.chdir(t.repo);
  await t.run("deps");
  assert.match(t.posts.find((p) => p.startsWith("▶ /pb:deps"))!, /running `true` in the background for a baseline/);
  assert.match(t.instructions.at(-1)!, /Baseline: The harness is running `true` in the background[\s\S]*a suite already red is not the upgrade's fault/);
  await until(() => t.posts.some((p) => p.startsWith("**Baseline**")));
});

test("pb_ask: a recommendation is found however it is written, and typed letters come back as the options they name", async () => {
  const { recommendedIndex, resolveAnswer } = await import("../extensions/pb/ask.ts");
  const options = ["mail", "events", "a webhook"];
  assert.deepEqual(["events", "B", "b.", "Events", "webhook", "", "push"].map((r) => recommendedIndex(r, options)), [1, 1, 1, 1, 2, -1, -1]);
  assert.equal(recommendedIndex("D", options), -1, "a letter past the options names nothing");
  assert.equal(resolveAnswer("b", options), "B — events");
  assert.equal(resolveAnswer("A and C", options), "A and C — mail; a webhook");
  assert.equal(resolveAnswer("a, c", options), "A and C — mail; a webhook");
  assert.equal(resolveAnswer("events, but batched", options), "events, but batched", "the human's own words stay theirs");
  assert.equal(resolveAnswer("Z", options), "Z");
});

test("pb_ask: several questions in one call, a checklist where several apply, and every answer reaches the spec", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  const asked = t.selectTitles.length;
  t.selects.push("events (recommended)", "[ ] A. orders", "[ ] C. refunds", "Done — A, C", "Something else (type it)", "b");
  const r = await t.callTool("pb_ask", {
    questions: [
      { question: "Mail or event?", options: ["mail", "events"], recommended: "B" },
      { question: "Which flows notify?", options: ["orders", "users", "refunds"], multiple: true },
      { question: "Retry how?", options: ["never", "with backoff"] },
    ],
  });
  assert.deepEqual(t.selectTitles.slice(asked), [
    "Question 1 of 3: Mail or event?",
    "Question 2 of 3: Which flows notify? (pick all that apply)",
    "Question 2 of 3: Which flows notify? (pick all that apply)",
    "Question 2 of 3: Which flows notify? (pick all that apply)",
    "Question 3 of 3: Retry how?",
  ]);
  assert.deepEqual(t.selectOptions[asked], ["mail", "events (recommended)", "Something else (type it)"], "the letter B marks events");
  assert.deepEqual(t.selectOptions[asked + 2], ["[x] A. orders", "[ ] B. users", "[ ] C. refunds", "Done — A", "Something else (type it)"]);
  assert.equal(r.content![0].text, "The human's answers:\n1. Mail or event? — events\n2. Which flows notify? — A and C — orders; refunds\n3. Retry how? — B — with backoff");
  // Kept with the planning session, then handed to the spec writer: nothing answered is lost to a reset.
  await t.run("spec");
  assert.match(t.instructions.at(-1)!, /Answers I gave while planning \(each one is in Decisions, or the spec says why it no longer applies\):\n- Mail or event\? → events\n- Which flows notify\? → A and C — orders; refunds\n- Retry how\? → B — with backoff/);
});

test("pb_ask: when nobody answers in time, the rest of a batch is not asked — it waits in the chat", async () => {
  const t = setup({ verify: "true", askTimeoutSec: 1 });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  const asked = t.selectTitles.length;
  t.selects.push("<timeout>");
  const r = await t.callTool("pb_ask", { questions: [{ question: "Mail or event?", options: ["mail", "events"] }, { question: "Retry how?", options: ["never", "backoff"] }] });
  assert.equal(t.selectTitles.length - asked, 1, "one dialog, then nobody is there");
  assert.match(t.posts.at(-1)!, /^\*\*Unanswered questions\*\* \(nothing was decided — they stay open\):[\s\S]*Mail or event\?[\s\S]*\(no answer within 1 min\)[\s\S]*Retry how\?[\s\S]*\(not asked: the question before it got no answer in time\)/);
  assert.match(r.content![0].text, /1\. Mail or event\? — OPEN[\s\S]*2\. Retry how\? — OPEN/);
});

test("pb_ask in a lap: a fix lap and a hardening lap never ask; a manual repair lap asks, with the timeout", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC() });
  const progressFile = path.join(t.repo, ".pi/pb/specs/order-cancellation/progress.json");
  fs.writeFileSync(progressFile, JSON.stringify({ spec: "order-cancellation", phase: "paused", session: t.runtime().ctx.sessionManager.getSessionFile(), tasks: [], review: { at: "2026-10-01 10:00:00", verdict: "changes", findings: [{ priority: "P2", title: "x" }] }, updatedAt: "2026-10-01 10:00:00" }));
  const said: string[] = [];
  t.agent.script = async (text, tool) => {
    if (!text.startsWith("[pb:fix")) return;
    said.push(String((await tool("pb_ask", { question: "Which way?", options: ["a", "b"] })).content?.[0]?.text ?? ""));
    await tool("pb_fix_done", { fixed: [], skipped: [1], tests: "none" });
  };
  t.selects.push("Later");
  await t.run("fix");
  assert.match(said[0], /^A fix lap doesn't ask: a finding that needs a decision is reported as skipped/);

  const h = setup({ verify: "true" });
  await written(h);
  process.env.MOCK_SPEC_REVIEW = "advisory";
  const lapSaid: string[] = [];
  const lap = repairLap(h, { applied: [1, 2], rebutted: [], parked: [], assumed: [], summary: "settled" });
  h.agent.script = async (text, tool) => {
    if (text.includes("[pb:spec-fix]")) lapSaid.push(String((await tool("pb_ask", { question: "Which way?", options: ["a", "b"] })).content?.[0]?.text ?? ""));
    return lap(text, tool);
  };
  try {
    await h.run("spec-review", "order-cancellation");
    h.selects.push("Yes, go on");
    await h.run("spec-harden", "order-cancellation");
    assert.match(lapSaid[0], /^A hardening lap doesn't ask: park the question in your pb_spec_fix_done report/);
    // A manual lap runs on your say-so, so it may ask — but never without the timeout, in a session of its own.
    await h.run("spec-review", "order-cancellation");
    const before = h.dialogTimeouts.length;
    h.selects.push("a");
    await h.run("spec-fix", "order-cancellation");
    assert.ok(lapSaid.at(-1)!.startsWith("The human answered: a"));
    assert.equal(h.dialogTimeouts.slice(before).find((x) => x !== undefined), 300_000, "askTimeoutSec applies");
  } finally {
    delete process.env.MOCK_SPEC_REVIEW;
  }
});

test("planning changes nothing outside this machine either: a remote write is refused, a read is not; a sibling repository is protected like the project", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  await t.run("plan", "cancel orders");
  assert.match((await t.callTool("bash", { command: "kubectl delete pod web-1" })).error!, /^Planning mode changes nothing — not the project, and not a system outside this machine — and this looks like a change to a Kubernetes cluster/);
  assert.match((await t.callTool("bash", { command: "psql $DB -c \"update orders set status = 'x'\"" })).error!, /a write through a database client/);
  assert.equal((await t.callTool("bash", { command: "kubectl get pods" })).error, undefined, "reads stay allowed");
  // A git repository beside the project (a frontend) is the change's too.
  const sibling = fs.mkdtempSync(path.join(path.dirname(fs.realpathSync(t.repo)), "pb-front-"));
  try {
    execSync("git init -q", { cwd: sibling });
    const name = path.basename(sibling);
    assert.match((await t.callTool("write", { path: `../${name}/src/app.ts`, content: "x" })).error!, new RegExp(`^Planning mode: the sibling repository ${name} stays untouched until /pb:build`));
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pb-scratch-"));
    assert.equal((await t.callTool("write", { path: path.join(scratch, "probe.ts"), content: "x" })).error, undefined, "a scratch folder outside every repository is fine");
    fs.rmSync(scratch, { recursive: true, force: true });
  } finally {
    fs.rmSync(sibling, { recursive: true, force: true });
  }
  // Outside planning, the same commands are the human's and the build's business.
  await t.run("plan", "off");
  assert.equal((await t.callTool("bash", { command: "kubectl delete pod web-1" })).error, undefined);
});
