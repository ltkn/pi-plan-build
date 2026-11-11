/** The rest: the store, stats and reports, the project map, archive, help and the fresh-run machinery. */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { briefOf, diligent, repairLap, setup, SPEC, taskOf, until, written } from "./harness.mts";

test("skippedLargeFiles: oversized untracked files are reported because snapshots can't see them", async () => {
  const t = setup();
  process.chdir(t.repo);
  const { snapshot, changedPaths, skippedLargeFiles } = await import("../extensions/pb/checkpoint.ts");
  const before = snapshot(t.repo, "before")!;
  fs.writeFileSync(path.join(t.repo, "big.bin"), Buffer.alloc(21 * 1024 * 1024, 1));
  fs.writeFileSync(path.join(t.repo, "small.txt"), "ok");
  const after = snapshot(t.repo, "after")!;
  assert.deepEqual(skippedLargeFiles(t.repo), ["big.bin"]);
  assert.deepEqual(changedPaths(t.repo, before.commit, after.commit), ["small.txt"]); // big.bin is missing from the diff: that's the blind spot this warns about
});

test("map: whole-project headings carry no path; sessions read them plus the area notes for the folders they touch", async () => {
  const { CARTOGRAPHER_SYSTEM } = await import("../extensions/pb/map.ts");
  assert.match(CARTOGRAPHER_SYSTEM, /The whole-project headings — "### Security invariants", "### Layout", "### Tests \+ build", "### Docs", "### Known gaps" — carry no path: they stay in the root AGENTS\.md, read in every session/);
  assert.match(CARTOGRAPHER_SYSTEM, /Every other heading is an area heading and names its one folder[^:]*: pb stores it in that folder's AGENTS\.md, read only by the sessions working there/);
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.run("plan", "cancel orders");
  assert.match(t.instructions.at(-1)!, /Check the project map in AGENTS\.md first: its whole-project headings, then the area notes its "Area notes" list names for the folders you touch/);
});

test("a finding title capped mid-sentence renders on one line, with the cut disclosed inline", async () => {
  const { findingLine } = await import("../extensions/pb/prompts.ts");
  const { cap } = await import("../extensions/pb/store.ts");
  const title = cap(`${"the claim and how contradicted it is ".repeat(20)}rest that must be cut`, 400);
  const line = findingLine({ priority: "P1", file: "apps-tempo/docs/tempo-design.md", line: 1, title, fix: "re-run the decode and count" });
  const [body, fixLine] = line.split("\n");
  assert.match(body!, /…\[truncated \d+ chars\]$/, "the cut is disclosed inline at the end of the title line");
  assert.doesNotMatch(body!, /rest that must be cut/);
  assert.equal(fixLine, "   Fix: re-run the decode and count");
});

test("the digest prints the check's findings in full: no 400-char cut, bulleted, with what pb left standing", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  process.env.MOCK_SPEC_REVIEW = "advisory";
  process.env.MOCK_SETTLE = "huge";
  try {
    await t.run("spec-review", "order-cancellation");
    t.agent.script = repairLap(t, { applied: [1, 2], rebutted: [], parked: [], assumed: [], summary: "settled both" });
    await t.run("spec-fix", "order-cancellation");
  } finally {
    delete process.env.MOCK_SPEC_REVIEW;
    delete process.env.MOCK_SETTLE;
  }
  const digest = t.posts.at(-1)!;
  assert.match(digest, /the whole claim in one breath and more words and more words and more words/);
  assert.doesNotMatch(digest, /\[truncated \d+ chars\]/, "a realistic claim is printed in full");
  assert.match(digest, /- \[P1\]/, "claims are bulleted");
});

test("a field pb had to clip names the run log that holds the uncut text", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  process.env.MOCK_SPEC_REVIEW = "advisory";
  process.env.MOCK_SETTLE = "clipped";
  try {
    await t.run("spec-review", "order-cancellation");
    t.agent.script = repairLap(t, { applied: [1, 2], rebutted: [], parked: [], assumed: [], summary: "settled both" });
    await t.run("spec-fix", "order-cancellation");
  } finally {
    delete process.env.MOCK_SPEC_REVIEW;
    delete process.env.MOCK_SETTLE;
  }
  const digest = t.posts.at(-1)!;
  assert.match(digest, /Some fields above are clipped by pb's length bound/);
  assert.match(digest, /pi --session \.pi\/pb\/sessions\/spec-check\//, "the pointer names the run log");
});

test("stale sessions read as gone without throwing, live ones as present", async () => {
  const { sessionGone } = await import("../extensions/pb/index.ts");
  assert.equal(sessionGone({ hasUI: true }), false);
  assert.equal(
    sessionGone({
      get hasUI(): boolean {
        throw new Error("This extension ctx is stale after session replacement or reload.");
      },
    }),
    true,
  );
});

test("stats: proof and confirmed counts render for the retirement bar", async () => {
  const { renderCard } = await import("../extensions/pb/stats.ts");
  const card = renderCard({
    name: "demo",
    phase: "built",
    events: [
      { type: "build-start", at: "2026-10-01 10:00:00" },
      { type: "red", task: "T1", ok: true, at: "2026-10-01 10:01:00" },
      { type: "check", task: "T1", ok: true, at: "2026-10-01 10:02:00" },
      { type: "red", task: "T2", ok: false, at: "2026-10-01 10:03:00" },
      { type: "check", task: "T2", ok: true, at: "2026-10-01 10:04:00" },
      { type: "red", task: "T3", ok: false, at: "2026-10-01 10:05:00" },
      { type: "review", verdict: "changes_needed", p: [1, 2, 0, 3], at: "2026-10-01 10:06:00" },
      { type: "built", at: "2026-10-01 10:07:00" },
    ],
    explore: [{ session: "s1", input: 3000, output: 400, cacheRead: 0, cacheWrite: 0, cost: 0.02, ms: 1000, at: "2026-10-01 09:59:00" }],
    progress: {
      spec: "demo",
      phase: "built",
      session: "s1",
      tasks: [
        { id: "T1", title: "a", status: "done", attempts: 1, redCommand: "test -f a" },
        { id: "T2", title: "b", status: "done", attempts: 1 },
        { id: "T3", title: "c", status: "done", attempts: 1 },
      ],
      updatedAt: "2026-10-01 10:07:00",
    },
  } as any);
  assert.match(card, /Proof +1 proven · 2 sent back · 0 no run could prove/);
  assert.match(card, /Review.*P0\/P1 confirmed \(latest\): 3/);
  assert.match(card, /Explorer +1 calls · in 3\.0k · out 400 @ 3\.4k tok\/s · \$0\.02/);
});

test("report: status and stats --json return pb.report/2, and pb-report does too", async () => {
  const t = setup({ mapOnArchive: false });
  await written(t);
  await t.run("status", "--json");
  const status = JSON.parse(t.posts.at(-1)!);
  assert.equal(status.schema, "pb.report/2");
  assert.equal(status.specs[0].name, "order-cancellation");
  assert.equal(status.specs[0].phase, "written");
  assert.deepEqual(status.specs[0].acceptance.map((a: { id: string }) => a.id), ["T1.1", "T2.1"]);
  const first = status.specs[0].acceptance[0];
  assert.deepEqual([first.task, first.status], ["T1", "not reported"]);
  assert.equal(first.text, "T1.txt exists");

  await t.run("stats", "--json");
  const stats = JSON.parse(t.posts.at(-1)!);
  assert.equal(stats.schema, "pb.report/2");
  assert.equal(stats.specs[0].stats.tasks, 2);
  // pb.report/2 dropped context.asks: nothing ever wrote an ask event, so the count was dead.
  assert.deepEqual(Object.keys(stats.specs[0].stats.context).sort(), ["compactions", "nudges", "resets"]);

  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "extensions/pb/report-cli.mjs");
  const out = JSON.parse(execSync(`${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} --cwd ${JSON.stringify(t.repo)} --stats --review`, { encoding: "utf8" }));
  assert.equal(out.schema, "pb.report/2");
  assert.equal(out.specs[0].stats.tasks, 2);
  assert.deepEqual(out.specs[0].review.findings, []);
});

test("help: every What-now block the code uses exists in the guide, and /pb:help lists the topics", async () => {
  const { tip } = await import("../extensions/pb/help.ts");
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "../extensions/pb");
  const src = fs.readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
  const keys = new Set([...src.matchAll(/tip\(\s*"([\w.-]+)"/g)].map((m) => m[1]));
  for (const k of ["build.paused", "build.paused-attempts", "review.pass", "review.changes", "review.unverified", "review.other", "review.mid-build"]) keys.add(k);
  for (const k of keys) assert.ok(tip(k).startsWith("**What now**"), `missing tip ${k}`);
  const t = setup();
  process.chdir(t.repo);
  await t.run("help");
  assert.match(t.posts.at(-1)!, /\/pb:help build` — Building/);
});

test("asked.json is append-only: interleaved writers keep both keys, legacy array still reads", async () => {
  const t = setup();
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  const a = new Store(t.repo);
  const b = new Store(t.repo);
  a.markAsked("x");
  b.markAsked("y"); // second writer must not drop the first key
  assert.ok(a.asked("x") && a.asked("y"));
  assert.ok(b.asked("x") && b.asked("y"));
  a.markAsked("x"); // duplicate tolerated
  assert.ok(a.asked("x"));
  fs.writeFileSync(path.join(t.repo, ".pi/pb/asked.json"), '["legacy"]\n');
  const c = new Store(t.repo);
  assert.ok(c.asked("legacy"));
  c.markAsked("fresh");
  assert.ok(c.asked("legacy") && c.asked("fresh"));
});

test("map: helpers read and write the AGENTS.md section, resolve its paths leniently, normalize and diff it", async () => {
  const { readMap, writeMap, mapPaths, unresolvedPaths, normalizeMap, mapDiff } = await import("../extensions/pb/map.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-map-"));
  execSync("git init -q", { cwd: dir });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Mine\n\nMy own notes.\n");
  writeMap(dir, "- `src/a.ts`: a");
  writeMap(dir, "- `src/b.ts`: b");
  const md = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  assert.match(md, /^# Mine\n\nMy own notes\.\n\n<!-- pb:map -->\n## Project map\n\n- `src\/b\.ts`: b\n<!-- \/pb:map -->\n$/); // replaced, your text kept
  assert.equal(readMap(dir), "- `src/b.ts`: b");
  assert.deepEqual(mapPaths("- `src/a.ts:12` and `pom.xml`, `./mvnw -pl api`, `http://x/y`, `**/*.ts`, `/signin/**`, `a/.../b.imports`, `harness.jdbcAs(X)`"), ["src/a.ts", "pom.xml"]);
  fs.mkdirSync(path.join(dir, "platform-core/src/main/java/app/auth"), { recursive: true });
  fs.writeFileSync(path.join(dir, "platform-core/src/main/java/app/auth/LoginController.java"), "");
  fs.mkdirSync(path.join(dir, "platform-core/ops"), { recursive: true });
  fs.writeFileSync(path.join(dir, "platform-core/ops/check.sh"), "");
  const body = [
    "### Runtime (platform-core/src/main/java/app/)",
    "- `auth/`: sign-in", // under the heading's path
    "- `auth/LoginController`: without extension, found as the end of a real path",
    "- `ops/check.sh`: relative to a module",
    "- `platform-core/Gone`: stale",
  ].join("\n");
  assert.deepEqual(unresolvedPaths(dir, body).map((u) => u.path), ["platform-core/Gone"]);
  assert.equal(normalizeMap("## Layout\n- a\n### Empty\n\n\n\n### Tests\n- t\n### Also empty"), "### Layout\n- a\n\n### Tests\n- t");
  assert.deepEqual(mapDiff("- a\n- b", "- a\n- c"), ["- - b", "+ - c"]);
});

test("map: resolve its paths leniently: only a name shaped like a path is checked", async () => {
  const { mapPaths, unresolvedPaths } = await import("../extensions/pb/map.ts");

  // Shape decides, never a suffix vocabulary: a slash, a leading dot, or a root file name pb knows.
  // A dotted word with no slash is whatever the map means by it — code, prose, a name — so it is not checked.
  assert.deepEqual(
    mapPaths("- `Store.config` merges `process.env`, `thread.lock` guards it, `harness.jdbcAs(X)`, `report_map`, `login.ts`, `pom.xml`"),
    ["pom.xml"],
  );
  assert.deepEqual(mapPaths("`AGENTS.md` `.pi/` `auth/LoginController` and `src/a.ts` are paths; `guide.md` and `config.json` are not"), [
    "AGENTS.md",
    ".pi",
    "auth/LoginController",
    "src/a.ts",
  ]);

  // The false positives this whole check exists to stop, in the repos that used to hit them: a Rust repo
  // tracking Cargo.lock, a .NET one tracking App.config.
  for (const [tracked, symbol] of [
    ["Cargo.lock", "thread.lock"],
    ["App.config", "Store.config"],
    ["main.go", "request.go"],
  ] as const) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-map-symbol-"));
    execSync("git init -q", { cwd: dir });
    fs.writeFileSync(path.join(dir, tracked), "x\n");
    execSync("git add . && git commit -qm src", { cwd: dir });
    assert.deepEqual(unresolvedPaths(dir, `- \`${symbol}\` is a member, \`platform/Gone\` is gone`).map((u) => u.path), ["platform/Gone"]);
  }

  // A gone path is still caught, with the line naming it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-map-stale-"));
  execSync("git init -q", { cwd: dir });
  fs.mkdirSync(path.join(dir, "platform"), { recursive: true });
  const stale = unresolvedPaths(dir, "### Runtime\n- Sign-in reads `process.env` and `Store.config`.\n- `platform/Gone`: stale");
  assert.deepEqual(stale.map((u) => u.path), ["platform/Gone"]);
  assert.deepEqual(stale.map((u) => u.line), ["- `platform/Gone`: stale"]);
});

test("map: gitignored files in the working tree resolve as map paths, dependencies and look-alikes do not", async () => {
  const { unresolvedPaths, ignoredPathsFor } = await import("../extensions/pb/map.ts");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pb-map-ignored-"));
  execSync("git init -q", { cwd: repo });
  fs.writeFileSync(path.join(repo, ".gitignore"), ".pi/\n.deep/\n.aa/\n.bb/\n.local/\nnode_modules/\n*.csv\n");
  const tree: [string, string][] = [
    [".pi/pb/config.json", "{}\n"], // a gitignored file no visible listing carries
    [".deep/config.json", "{}\n"], // a shallower bearer of the same name
    [".aa/db/index.json", "{}\n"],
    [".bb/db/index.json", "{}\n"], // two bearers at the same depth
    [".local/nested/settings.json", "{}\n"],
    ["db/subconfig.csv", "a\n"], // a look-alike no tail match may claim
    ["tokens.csv", "a\n"], // gitignored at the root, so no `*/name` pathspec can reach it
    ["src/a.ts", "export {}\n"], // visible, as before
  ];
  for (const [rel, text] of tree) {
    fs.mkdirSync(path.join(repo, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  }

  // Names the visible listing misses resolve from one look-up; a name nothing bears still reports; code
  // symbols and bare names in the same lines stay unchecked.
  assert.deepEqual(
    unresolvedPaths(repo, [
      "- The project's `config.json` is merged by `Store.config`.",
      "- Its `pb/config.json`, `nested/settings.json` and `db/index.json` live in gitignored paths.",
      "- `src/a.ts` resolves; `db/config.csv` bears nothing.",
    ].join("\n")).map((u) => u.path),
    ["db/config.csv"],
  );

  // The lookup answers token → the file to open, deterministically: fewest separators, then lexicographic.
  const found = ignoredPathsFor(repo, ["config.json", "pb/config.json", "nested/settings.json", "db/index.json", "tokens.csv", "config.json"]);
  assert.deepEqual([...found.keys()], ["config.json", "pb/config.json", "nested/settings.json", "db/index.json", "tokens.csv"]);
  assert.equal(found.get("config.json"), path.join(repo, ".deep/config.json"));
  assert.equal(found.get("db/index.json"), path.join(repo, ".aa/db/index.json"));
  assert.equal(found.get("pb/config.json"), path.join(repo, ".pi/pb/config.json"));
  assert.equal(found.get("tokens.csv"), path.join(repo, "tokens.csv")); // the bare pathspec form reaches it

  // A dependency directory holds the name but does not make a dead line live.
  const dep = fs.mkdtempSync(path.join(os.tmpdir(), "pb-map-vendored-"));
  execSync("git init -q", { cwd: dep });
  fs.writeFileSync(path.join(dep, ".gitignore"), "node_modules/\n");
  fs.mkdirSync(path.join(dep, "node_modules/some/dep"), { recursive: true });
  fs.writeFileSync(path.join(dep, "node_modules/some/dep/config.json"), "{}\n");
  assert.deepEqual(unresolvedPaths(dep, "- `dep/config.json` lives in a dependency").map((u) => u.path), ["dep/config.json"]);
});

test("map: the gitignored lookup's own limits leave every name flagged", async () => {
  const { unresolvedPaths, ignoredPathsFor } = await import("../extensions/pb/map.ts");

  // Where git refuses the lookup (no repository here), every name it would have answered stays flagged.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "pb-map-nogit-"));
  fs.mkdirSync(path.join(bare, "inner/pb"), { recursive: true }); // deeper than the names, so nothing resolves directly
  fs.writeFileSync(path.join(bare, "inner/pb/config.json"), "{}\n");
  fs.writeFileSync(path.join(bare, "inner/pb/settings.json"), "{}\n");
  assert.equal(ignoredPathsFor(bare, ["pb/config.json", "pb/settings.json"]).size, 0);
  assert.deepEqual(unresolvedPaths(bare, "- `pb/config.json` and `pb/settings.json`").map((u) => u.path), [
    "pb/config.json",
    "pb/settings.json",
  ]);

  // One lookup answers at most 200 names, in the order the map names them; the rest keep their warning.
  const many = fs.mkdtempSync(path.join(os.tmpdir(), "pb-map-many-"));
  execSync("git init -q", { cwd: many });
  fs.writeFileSync(path.join(many, ".gitignore"), "ignored/\n");
  const tokens = Array.from({ length: 210 }, (_, i) => `gen/g${i + 1}.json`); // each bears a name at one depth below the gitignored root
  fs.mkdirSync(path.join(many, "ignored/gen"), { recursive: true });
  for (const t of tokens) fs.writeFileSync(path.join(many, "ignored", t), "{}\n");
  assert.deepEqual(unresolvedPaths(many, `- ${tokens.map((t) => `\`${t}\``).join(", ")}`).map((u) => u.path), tokens.slice(200));
});

test("map: the repair pass says what it's fixing", async () => {
  const { mapRepairPhase } = await import("../extensions/pb/map.ts");
  assert.equal(mapRepairPhase(3, 0), "checking 3 paths");
  assert.equal(mapRepairPhase(1, 0), "checking 1 path");
  assert.equal(mapRepairPhase(0, 1500), "trimming 1,500 tokens");
  assert.equal(mapRepairPhase(2, 2500), "checking 2 paths and trimming 2,500 tokens");
});

test("archive: a spec with work left asks first and says what — never reviewed, a non-pass verdict, open findings; a bad name is refused", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  const live = () => fs.existsSync(path.join(t.repo, ".pi/pb/specs/order-cancellation/spec.md"));
  // Built but never reviewed: asked, and a no keeps it where /pb:fix and /pb:review reach it.
  t.confirmAnswers.push(false);
  await t.run("archive", "order-cancellation");
  assert.equal(t.confirms.at(-1), "order-cancellation isn't finished: it was never reviewed");
  assert.ok(live());
  // Reviewed with an open finding: both facts are named.
  const progressFile = path.join(t.repo, ".pi/pb/specs/order-cancellation/progress.json");
  const p = JSON.parse(fs.readFileSync(progressFile, "utf8"));
  fs.writeFileSync(progressFile, JSON.stringify({ ...p, review: { at: "2026-10-01 10:00:00", verdict: "changes_needed", findings: [{ priority: "P1", title: "the guard is missing" }] } }));
  t.confirmAnswers.push(false);
  await t.run("archive", "order-cancellation");
  assert.equal(t.confirms.at(-1), "order-cancellation isn't finished: its last review was CHANGES NEEDED; 1 review finding still open");
  assert.ok(live());
  // A name that is not one never reaches a path.
  const asked = t.confirms.length;
  await t.run("archive", "../order-cancellation");
  assert.match(t.notes.at(-1)!, /`\.\.\/order-cancellation` isn't a valid spec name/);
  assert.equal(t.confirms.length, asked);
  // A clean pass with nothing open archives without a question.
  fs.writeFileSync(progressFile, JSON.stringify({ ...p, phase: "reviewed", review: { at: "2026-10-01 10:00:00", verdict: "pass", findings: [] } }));
  await t.run("archive", "order-cancellation");
  assert.equal(t.confirms.length, asked, "nothing owed, nothing asked");
  assert.ok(!live());
});

test("map: /pb:archive updates it by itself: paths that don't resolve go back once to be fixed, then it's written, and undo swaps back", async () => {
  const t = setup({ verify: "true" });
  fs.mkdirSync(path.join(t.repo, "src/main/auth"), { recursive: true });
  fs.writeFileSync(path.join(t.repo, "src/order.ts"), "export {}\n");
  fs.writeFileSync(path.join(t.repo, "src/main/auth/Login.java"), "class Login {}\n");
  fs.writeFileSync(path.join(t.repo, "AGENTS.md"), "# Shop\n");
  execSync("git add . && git commit -qm src", { cwd: t.repo });
  await written(t, SPEC().replace("## Context\nsrc/order.ts holds the model.", "## Findings\n- `src/order.ts` holds the model."));
  t.agent.script = async (text, tool) => {
    if (taskOf(text) === "T1") await tool("pb_update_spec", { section: "Design", content: "- One file per task." });
    return diligent(text, tool);
  };
  await t.run("build");
  const briefFile = path.join(os.tmpdir(), `pb-map-brief-${process.pid}.md`);
  process.env.MOCK_BRIEF_OUT = briefFile;
  const asked = t.selectTitles.length;
  await t.run("archive");
  delete process.env.MOCK_BRIEF_OUT;
  assert.equal(t.selectTitles.length, asked); // no question
  assert.match(fs.readFileSync(briefFile, "utf8"), /# The current map\n\n\(none yet[\s\S]*# The feature just finished: order-cancellation[\s\S]*`src\/order\.ts` holds the model[\s\S]*# Files that feature changed/);
  assert.match(fs.readFileSync(briefFile, "utf8"), /The design as built \(its "## Design"\):\n- One file per task\./); // recorded by the build, in T1
  assert.match(fs.readFileSync(briefFile, "utf8"), /# How far to look: the whole map/, "the first map is a full read, even on an archive");
  const agents = t.read("AGENTS.md");
  assert.match(agents, /^# Shop\n\n<!-- pb:map -->\n## Project map\n\n### Layout\n- `src\/`: the application\n### Orders\n- `src\/order\.ts`[\s\S]*follow `auth\/Login`[\s\S]*Services own transactions[\s\S]*<!-- \/pb:map -->/);
  assert.doesNotMatch(agents, /gone\.ts|### Empty/); // corrected by the cartographer, not cut by pb; empty headings go
  assert.deepEqual(t.views.find((v) => v.customType === "pb-map")!.data.warnings, []);
  assert.match(t.notes.at(-1)!, /Project map written in AGENTS\.md \(~\d+ tokens in \d+s: added Orders; noted transactions\)\. 5 new lines were checked against the code\. `\/pb:map undo` puts the previous one back/);

  await t.run("map", "undo");
  assert.doesNotMatch(t.read("AGENTS.md"), /### Orders/); // back to no map
  await t.run("map", "undo");
  assert.match(t.read("AGENTS.md"), /### Orders/); // and forth
});

test("map: /pb:archive reads only the feature's change against the map, marking the lines that cite a changed file; /pb:map audits the whole map", async () => {
  const t = setup({ verify: "true" });
  fs.mkdirSync(path.join(t.repo, "src/auth"), { recursive: true });
  fs.mkdirSync(path.join(t.repo, "src/orders"), { recursive: true });
  fs.writeFileSync(path.join(t.repo, "src/order.ts"), "export {}\n");
  fs.writeFileSync(path.join(t.repo, "src/orders/state.ts"), "export {}\n");
  fs.writeFileSync(path.join(t.repo, "src/auth/Login.java"), "class Login {}\n");
  const { writeMap } = await import("../extensions/pb/map.ts");
  writeMap(t.repo, "### Security invariants\n- Orders change state only in `src/order.ts`.\n- Sessions are issued by `src/auth/Login.java` alone.\n### Orders (src/)\n- `orders/state.ts` holds the transitions.");
  execSync("git add . && git commit -qm src", { cwd: t.repo });
  const base = execSync("git rev-parse HEAD", { cwd: t.repo }).toString().trim();
  await written(t, SPEC().replace("## Context\nsrc/order.ts holds the model.", "## Findings\n- `src/order.ts` holds the model."));
  t.agent.script = async (text, tool) => {
    if (taskOf(text) === "T1") {
      fs.appendFileSync(path.join(t.repo, "src/order.ts"), "export const cancelled = true;\n");
      fs.appendFileSync(path.join(t.repo, "src/orders/state.ts"), "export const states = [];\n");
    }
    return diligent(text, tool);
  };
  await t.run("build");
  const briefFile = path.join(os.tmpdir(), `pb-map-change-brief-${process.pid}.md`);
  const systemFile = path.join(os.tmpdir(), `pb-map-change-system-${process.pid}.md`);
  process.env.MOCK_BRIEF_OUT = briefFile;
  process.env.MOCK_SYSTEM_OUT = systemFile;
  try {
    await t.run("archive");
    const brief = fs.readFileSync(briefFile, "utf8");
    assert.match(brief, /# How far to look: this feature's change\n\nThe map was audited before: this run looks only at what the feature changed \(the files above; `git diff ([0-9a-f]+)` shows the change, uncommitted work included\)/);
    assert.equal(brief.match(/`git diff ([0-9a-f]+)`/)![1], base, "the diff starts where the build did");
    assert.match(brief, /for every rule on the map ask whether the change breaks it, bypasses it/);
    const marked = brief.slice(brief.indexOf("## Lines that cite a changed file"));
    assert.match(marked, /- \[under ### Security invariants\] - Orders change state only in `src\/order\.ts`\./);
    assert.match(marked, /- \[under ### Orders \(src\/\)\] - `orders\/state\.ts` holds the transitions\./, "a path under its heading's folder counts");
    assert.doesNotMatch(marked, /Login\.java/, "a line whose code didn't change is kept unread");
    assert.doesNotMatch(brief, /How far to look: the whole map/);
    assert.match(fs.readFileSync(systemFile, "utf8"), /never a whole file or a long block of context/);
    assert.match(t.notes.join("\n"), /Only order-cancellation's change was read against the map; `\/pb:map` audits the whole map\./);

    await t.run("map");
    const full = fs.readFileSync(briefFile, "utf8");
    assert.match(full, /# How far to look: the whole map\n\nRevisit the whole map/);
    assert.doesNotMatch(full, /Lines that cite a changed file/);
  } finally {
    delete process.env.MOCK_BRIEF_OUT;
    delete process.env.MOCK_SYSTEM_OUT;
    fs.rmSync(briefFile, { force: true });
    fs.rmSync(systemFile, { force: true });
  }
});

test("map: a map over the budget goes back once to be trimmed, by the same cartographer that can read the code", async () => {
  const t = setup({ verify: "true" });
  fs.mkdirSync(path.join(t.repo, "src/auth"), { recursive: true });
  fs.writeFileSync(path.join(t.repo, "src/order.ts"), "export {}\n");
  fs.writeFileSync(path.join(t.repo, "src/auth/Login.java"), "class Login {}\n");
  process.chdir(t.repo);
  const repair = path.join(os.tmpdir(), `pb-map-repair-${process.pid}.md`);
  process.env.MOCK_MAP_BIG = "1";
  process.env.MOCK_REPAIR_OUT = repair;
  try {
    await t.run("map");
  } finally {
    delete process.env.MOCK_MAP_BIG;
    delete process.env.MOCK_REPAIR_OUT;
  }
  const { MAP_TOKENS } = await import("../extensions/pb/map.ts");
  const brief = fs.readFileSync(repair, "utf8");
  fs.rmSync(repair);
  assert.match(brief, /^# Your proposed map[\s\S]*# Over the budget\n\nIt is about [\d,]+ tokens over the /);
  assert.doesNotMatch(brief, /Paths in it that don't resolve/); // every path resolved: the budget alone sent it back
  assert.ok(brief.includes(`the ${MAP_TOKENS.toLocaleString("en-US")} budget`));
  assert.match(brief, /keep every security invariant with its enforcement point, and every known gap/);
  const agents = t.read("AGENTS.md");
  assert.doesNotMatch(agents, /### Filler/);
  assert.match(agents, /### Orders/);
  assert.equal(t.read(".pi/pb/explore.jsonl").trim().split("\n").length, 3); // the cartographer twice and the map check, all counted in the stats
});

test("map: its entry reads well: collapsed, what changed; expanded, the map as markdown and what was removed", async () => {
  const { mapView } = await import("../extensions/pb/render.ts");
  const { MAP_TOKENS } = await import("../extensions/pb/map.ts");
  const d = { diff: ["- - `old.ts`: gone", "+ ### Orders", "+ - `src/order.ts`: orders"], warnings: [], tokens: 420, map: "### Orders\n- `src/order.ts`: orders", changes: ["added Orders"] };
  const collapsed = mapView(d, false);
  assert.equal(collapsed.head, "~420 tokens · 2 lines added, 1 removed");
  assert.deepEqual(collapsed.lines.map((l) => l.text), ["• added Orders", "(expand to read the map)"]);
  assert.equal(collapsed.markdown, undefined);
  const expanded = mapView(d, true);
  assert.equal(expanded.markdown, "### Orders\n- `src/order.ts`: orders");
  assert.deepEqual(expanded.removed, ["- `old.ts`: gone"]);
  const over = mapView({ ...d, tokens: MAP_TOKENS + 1, warnings: ["`x/y` doesn't resolve"] }, false);
  assert.ok(over.over);
  assert.match(over.head, new RegExp(`over the ~${MAP_TOKENS.toLocaleString("en-US")} budget`));
  assert.equal(mapView({ ...d, tokens: MAP_TOKENS }, false).over, false);
});

test("map: the cartographer is told the budget the view warns at", async () => {
  const { CARTOGRAPHER_SYSTEM, MAP_TOKENS } = await import("../extensions/pb/map.ts");
  assert.ok(CARTOGRAPHER_SYSTEM.includes(`about ${MAP_TOKENS.toLocaleString("en-US")} tokens at most`));
  assert.match(CARTOGRAPHER_SYSTEM, /### Security invariants[\s\S]*Known gaps[\s\S]*Never write a verdict/);
  assert.match(CARTOGRAPHER_SYSTEM, /capable models that explore fast[\s\S]*Under "### Layout", only where exploring misleads[\s\S]*No module-by-module tour[\s\S]*Start with the security invariants/);
});

test("map: every map write strips markers and tabs", async () => {
  const { writeMap, readMap } = await import("../extensions/pb/map.ts");
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  fs.writeFileSync(path.join(t.repo, "AGENTS.md"), "# Shop\n\nMy own note, mine to keep.\n");
  assert.equal(
    writeMap(
      t.repo,
      "### Layout\n- `src/`:\tthe app\twith words\n### Odd\n-\tleading tab\n\u0007hidden <!-- pb:map --> and <!-- /pb:map --> markers\n",
    ),
    true,
  );
  const agents = t.read("AGENTS.md");
  const body = readMap(t.repo);
  assert.ok(!agents.includes("\t"), agents);
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(agents), agents);
  assert.equal(agents.split("<!-- pb:map -->").length - 1, 1);
  assert.equal(agents.split("<!-- /pb:map -->").length - 1, 1);
  assert.match(body, /- `src\/`: the app with words/); // tabs to single spaces, every word intact
  assert.match(body, /^- leading tab$/m);
  assert.ok(body.includes("/pb:map"), body); // the words stay: only the markup goes
  assert.ok(!/^\s/m.test(body), body); // no line becomes an indented code block
  assert.match(agents, /My own note, mine to keep\./);

  // undo writes the stored previous body through the same guarantee.
  fs.writeFileSync(path.join(t.repo, ".pi/pb/map-previous.md"), "### Old\n-\ttabbed\tout\n<!-- /pb:map --> smuggled in\n");
  await t.run("map", "undo");
  const undone = t.read("AGENTS.md");
  assert.ok(!undone.includes("\t") && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(undone), undone);
  assert.equal(undone.split("<!-- /pb:map -->").length - 1, 1);
  assert.match(readMap(t.repo), /- tabbed out/);
  const backup = t.read(".pi/pb/map-previous.md"); // what undo kept is the clean map it replaced
  assert.ok(!backup.includes("\t") && !/<!--|-->/.test(backup), backup);
});

test("map: an unbalanced map section is refused", async () => {
  const { writeMap, readMap, mapDefect } = await import("../extensions/pb/map.ts");
  const tail = "\nMy own note after pb's section, mine to keep.\n";
  const doubleEnd = `# Shop\n\n<!-- pb:map -->\n## Project map\n\n- \`README\`: readme\n<!-- /pb:map -->\n<!-- /pb:map -->${tail}`;
  const noEnd = `# Shop\n\n<!-- pb:map -->\n## Project map\n\n- \`README\`: readme${tail}`;

  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  fs.writeFileSync(path.join(t.repo, "AGENTS.md"), doubleEnd);
  fs.writeFileSync(path.join(t.repo, ".pi/pb/map-previous.md"), "### Old\n- older\n");
  const backup = t.read(".pi/pb/map-previous.md");
  assert.equal(mapDefect(t.repo)!.marker, "<!-- /pb:map -->");
  assert.equal(mapDefect(t.repo)!.line, 8);
  assert.equal(readMap(t.repo), ""); // a body pb can't locate is never handed on
  assert.equal(writeMap(t.repo, "### Layout\n- `README`: the readme"), false);
  assert.equal(t.read("AGENTS.md"), doubleEnd);

  const brief = path.join(os.tmpdir(), `pb-map-refused-${process.pid}.md`);
  fs.rmSync(brief, { force: true });
  process.env.MOCK_BRIEF_OUT = brief;
  let notes = 0;
  try {
    notes = t.notes.length;
    await t.run("map");
  } finally {
    delete process.env.MOCK_BRIEF_OUT;
  }
  assert.ok(!fs.existsSync(brief), "no cartographer run was spent on a file that cannot be written");
  assert.equal(t.read("AGENTS.md"), doubleEnd); // the human's tail is byte-identical
  assert.equal(t.read(".pi/pb/map-previous.md"), backup); // and the only good copy is still there
  const refusal = t.notes.slice(notes).join("\n");
  assert.match(refusal, /AGENTS\.md/);
  assert.match(refusal, /<!-- \/pb:map -->/);
  assert.match(refusal, /wrote nothing/);

  // undo: a broken file never replaces the stored previous map with a truncated read of itself.
  await t.run("map", "undo");
  assert.equal(t.read("AGENTS.md"), doubleEnd);
  assert.equal(t.read(".pi/pb/map-previous.md"), backup);

  // The archive step refuses a start without its end the same way, and still archives the spec.
  const u = setup({ verify: "true" });
  await written(u);
  u.agent.script = diligent;
  await u.run("build");
  process.chdir(u.repo);
  fs.writeFileSync(path.join(u.repo, "AGENTS.md"), noEnd);
  assert.equal(mapDefect(u.repo)!.marker, "<!-- /pb:map -->");
  const brief2 = path.join(os.tmpdir(), `pb-map-archive-refused-${process.pid}.md`);
  fs.rmSync(brief2, { force: true });
  process.env.MOCK_BRIEF_OUT = brief2;
  try {
    await u.run("archive");
  } finally {
    delete process.env.MOCK_BRIEF_OUT;
  }
  assert.ok(!fs.existsSync(brief2), "the archive's map step ran no cartographer either");
  assert.equal(u.read("AGENTS.md"), noEnd);
  assert.ok(u.notes.some((n) => /wrote nothing/.test(n)), u.notes.join("\n"));
  assert.ok(!fs.existsSync(path.join(u.repo, ".pi/pb/specs/order-cancellation"))); // the refusal stops the map step, not the archive
  assert.ok(fs.readdirSync(path.join(u.repo, ".pi/pb-archive")).some((d) => d.endsWith("order-cancellation")));
});

test("map: a stray fence does not hide the map", async () => {
  const { readMap, writeMap, mapDefect } = await import("../extensions/pb/map.ts");
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  // An unclosed fence in the author's own prose above the section must not hide pb's own end marker.
  fs.writeFileSync(
    path.join(t.repo, "AGENTS.md"),
    "# Shop\n\nAn example I never closed:\n\n```\ngit config core.bare true\n\n<!-- pb:map -->\n## Project map\n\n- `README`: readme\n<!-- /pb:map -->\n\nMy own note.\n",
  );
  assert.equal(mapDefect(t.repo), undefined);
  assert.equal(readMap(t.repo), "- `README`: readme");
  assert.equal(writeMap(t.repo, "### Layout\n- `README`: the readme"), true);
  const agents = t.read("AGENTS.md");
  assert.match(agents, /git config core\.bare true/);
  assert.match(agents, /My own note\./);
  assert.equal(agents.split("<!-- /pb:map -->").length - 1, 1);

  // A marker shown inside a properly fenced example is the section's documentation, not its end.
  fs.writeFileSync(
    path.join(t.repo, "AGENTS.md"),
    "# Shop\n\n<!-- pb:map -->\n## Project map\n\n### Marker syntax\n\n```\n<!-- /pb:map -->\n```\n\n- `README`: readme\n<!-- /pb:map -->\n\nMy own note.\n",
  );
  assert.equal(mapDefect(t.repo), undefined);
  assert.equal(readMap(t.repo), "### Marker syntax\n\n```\n<!-- /pb:map -->\n```\n\n- `README`: readme");
  assert.equal(writeMap(t.repo, "### Layout\n- `README`: the readme"), true);
  assert.match(t.read("AGENTS.md"), /My own note\./);
  assert.equal(t.read("AGENTS.md").split("<!-- /pb:map -->").length - 1, 1);

  // The same example shown above the section: fence state is counted from the top of the file, so the
  // documented pair is masked where it stands and pb's real section below it is the only section.
  const example = "```\n<!-- pb:map -->\n## Project map\n\n- the map, as documented\n<!-- /pb:map -->\n```\n";
  const documented = `# Shop\n\npb's own markers, documented:\n\n${example}\n<!-- pb:map -->\n## Project map\n\n- \`README\`: readme\n<!-- /pb:map -->\n\nMy own note.\n`;
  fs.writeFileSync(path.join(t.repo, "AGENTS.md"), documented);
  assert.equal(mapDefect(t.repo), undefined);
  assert.equal(readMap(t.repo), "- `README`: readme");
  assert.equal(writeMap(t.repo, "### Layout\n- `README`: the readme"), true);
  const after = t.read("AGENTS.md");
  assert.ok(after.startsWith(`# Shop\n\npb's own markers, documented:\n\n${example}`), `the documented example was rewritten: ${after}`);
  assert.ok(after.endsWith("\nMy own note.\n"), after);
  assert.equal(after.split("<!-- pb:map -->").length - 1, 2); // the documented pair plus pb's own, never a second section
  assert.equal(after.split("<!-- /pb:map -->").length - 1, 2);
  assert.equal(readMap(t.repo), "### Layout\n- `README`: the readme"); // still the one real section after the write

  // The same file with a ``` the author never closed inside pb's own section: the fence-aware pass still
  // finds pb's start, so the file's own fence state stands and the section is simply unterminated. pb says
  // so instead of falling back to a fence-blind read, which lands on the documented pair above and would
  // write the map into the author's example.
  const unclosed = `# Shop\n\npb's own markers, documented:\n\n${example}\n<!-- pb:map -->\n## Project map\n\n- \`README\`: readme\n\n\`\`\`\n\nMy own note.\n`;
  fs.writeFileSync(path.join(t.repo, "AGENTS.md"), unclosed);
  assert.deepEqual(mapDefect(t.repo), { marker: "<!-- /pb:map -->", line: 13, file: path.join(t.repo, "AGENTS.md") }); // line 13 is pb's own start; its end sits past the fence nobody closed
  assert.equal(readMap(t.repo), "");
  assert.equal(writeMap(t.repo, "### Layout\n- `README`: the readme"), false);
  assert.equal(t.read("AGENTS.md"), unclosed); // the documented example and the tail both stay byte-identical

  // Markers in documentation only, no section yet: the example is not pb's, so a write appends below it.
  fs.writeFileSync(path.join(t.repo, "AGENTS.md"), `# Shop\n\n${example}`);
  assert.equal(mapDefect(t.repo), undefined);
  assert.equal(readMap(t.repo), "");
  assert.equal(writeMap(t.repo, "### Layout\n- `README`: the readme"), true);
  assert.equal(t.read("AGENTS.md"), `# Shop\n\n${example}\n<!-- pb:map -->\n## Project map\n\n### Layout\n- \`README\`: the readme\n<!-- /pb:map -->\n`);
});

test("notify: a desktop notification when pb asks, and none when it's turned off", async () => {
  const { setNotifySink } = await import("../extensions/pb/notify.ts");
  const sent: string[][] = [];
  setNotifySink((title, body) => sent.push([title, body]));
  try {
    const t = setup({ notify: true });
    process.chdir(t.repo);
    t.selects.push("No thanks");
    await t.run("plan", "cancel orders");
    t.selects.push("mail");
    await t.callTool("pb_ask", { question: "Mail\nor event;\x07 now?", options: ["mail", "event"] });
    assert.deepEqual(sent.at(-1), ["pb: a question for you", "Mail or event now?"]); // one line, nothing that ends the escape sequence
    const v = setup({ verify: "true", notify: true }); // a dialog that goes on without you
    await written(v);
    v.runtime().usage = 72;
    v.agent.script = diligent;
    v.selects.push("Build here anyway");
    await v.run("build");
    assert.ok(sent.some(([title, body]) => title === "pb: your choice" && body === "Build order-cancellation: this session is 72% full")); // the build ending adds its own ping after this one

    const u = setup();
    process.chdir(u.repo);
    u.selects.push("No thanks");
    await u.run("plan", "x");
    const before = sent.length;
    u.selects.push("mail");
    await u.callTool("pb_ask", { question: "Mail or event?", options: ["mail", "event"] });
    assert.equal(sent.length, before);
  } finally {
    setNotifySink(undefined);
  }
});

test("fresh calls are saved as sessions to open afterwards, and stream their text while they run", async () => {
  const { runFresh } = await import("../extensions/pb/runner.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-sessions-"));
  const seen: string[] = [];
  const r = await runFresh({ cwd: dir, role: "explorer", systemPrompt: "You are an EXPLORER", brief: "# Question\n\nwhere?", prompt: "go", tools: ["read"], sessionDir: dir, onText: (t) => seen.push(t) });
  assert.match(r.sessionFile!, /_mock-\d+-\d+\.jsonl$/);
  assert.ok(seen.length > 2 && r.text.startsWith(seen.at(-1)!.slice(0, 20))); // grows piece by piece
  assert.equal(seen.at(-1), r.text);

  const t = setup({ verify: "true", reviewer: { security: "always" } });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  await t.run("review");
  assert.match(t.posts.at(-1)!, /The review sessions: spec `pi --session build-session-\d+` · adversarial `pi --session [^`]+`/);
  const e = await t.callTool("pb_explore", { question: "where?" });
  assert.match((e as any).details.session, /^\.pi\/pb\/sessions\/explorer\/.+\.jsonl$/);

  // The feature is done: its review runs and the explorer runs go with /pb:archive.
  t.selects.push("<timeout>");
  await t.run("archive");
  const archived = fs.readdirSync(path.join(t.repo, ".pi/pb-archive")).find((d) => d.endsWith("order-cancellation"))!;
  assert.ok(!fs.existsSync(path.join(t.repo, ".pi/pb-archive", archived, "sessions")));
  assert.deepEqual(fs.existsSync(path.join(t.repo, ".pi/pb/sessions/explorer")), false);
});

test("concurrent fresh runs queue to PI_PB_MAX_CONCURRENT (default 2)", async () => {
  const { runFresh } = await import("../extensions/pb/runner.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-conc-"));
  const log = path.join(dir, "conc.log");
  const prior = { MOCK_HOLD_MS: process.env.MOCK_HOLD_MS, PI_PB_MAX_CONCURRENT: process.env.PI_PB_MAX_CONCURRENT, MOCK_CONCURRENCY_LOG: process.env.MOCK_CONCURRENCY_LOG };
  process.env.MOCK_HOLD_MS = "300";
  process.env.PI_PB_MAX_CONCURRENT = "2";
  process.env.MOCK_CONCURRENCY_LOG = log;
  try {
    const rs = await Promise.all(
      Array.from({ length: 4 }, () =>
        runFresh({ cwd: dir, role: "explorer", systemPrompt: "You are an EXPLORER", brief: "# Question\n\nwhere?", prompt: "go", tools: ["read"] }),
      ),
    );
    assert.ok(rs.every((r) => r.exitCode === 0 && r.text.includes("holds the model")));
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const events = fs
    .readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => ({ kind: line.split(" ")[0], at: Number(line.split(" ")[1]) }))
    .sort((a, b) => a.at - b.at || (a.kind === "e" ? -1 : 1)); // ends before starts at the same ms
  let openCount = 0;
  let peak = 0;
  for (const event of events) {
    openCount += event.kind === "s" ? 1 : -1;
    peak = Math.max(peak, openCount);
  }
  assert.equal(peak, 2); // the cap is exercised, not merely absent
});

test("a queued run aborted while waiting doesn't strand the next one behind it", { timeout: 10_000 }, async () => {
  const { runFresh } = await import("../extensions/pb/runner.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-conc-abort-"));
  const log = path.join(dir, "conc.log");
  const prior = { MOCK_HOLD_MS: process.env.MOCK_HOLD_MS, PI_PB_MAX_CONCURRENT: process.env.PI_PB_MAX_CONCURRENT, MOCK_CONCURRENCY_LOG: process.env.MOCK_CONCURRENCY_LOG };
  process.env.MOCK_HOLD_MS = "400";
  process.env.PI_PB_MAX_CONCURRENT = "1";
  process.env.MOCK_CONCURRENCY_LOG = log;
  const run = (signal?: AbortSignal) =>
    runFresh({ cwd: dir, role: "explorer", systemPrompt: "You are an EXPLORER", brief: "# Question\n\nwhere?", prompt: "go", tools: ["read"], signal });
  try {
    const a = run(); // holds the only slot
    await until(() => fs.existsSync(log) && fs.readFileSync(log, "utf8").includes("s "));
    const stopped = new AbortController();
    const b = run(stopped.signal); // queues, then leaves before a slot frees
    stopped.abort();
    const c = run(); // queues behind the aborted waiter
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    assert.equal(ra.exitCode, 0);
    assert.equal(rb.aborted, true); // it never started
    assert.equal(rc.exitCode, 0); // the freed slot woke c: an aborted waiter must not eat the wakeup
    assert.ok(rc.text.includes("holds the model"));
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("fresh runs honor the config's maxConcurrent, but PI_PB_MAX_CONCURRENT outranks it", async () => {
  const { runFresh } = await import("../extensions/pb/runner.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-conc-cfg-"));
  const prior = { MOCK_HOLD_MS: process.env.MOCK_HOLD_MS, PI_PB_MAX_CONCURRENT: process.env.PI_PB_MAX_CONCURRENT, MOCK_CONCURRENCY_LOG: process.env.MOCK_CONCURRENCY_LOG };
  process.env.MOCK_HOLD_MS = "200";
  const peakOf = (file: string) => {
    const events = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => ({ kind: line.split(" ")[0], at: Number(line.split(" ")[1]) }))
      .sort((a, b) => a.at - b.at || (a.kind === "e" ? -1 : 1)); // ends before starts at the same ms
    let openCount = 0;
    let peak = 0;
    for (const event of events) {
      openCount += event.kind === "s" ? 1 : -1;
      peak = Math.max(peak, openCount);
    }
    return peak;
  };
  const run = () =>
    runFresh({ cwd: dir, role: "explorer", systemPrompt: "You are an EXPLORER", brief: "# Question\n\nwhere?", prompt: "go", tools: ["read"], maxConcurrent: 3 });
  try {
    // No env: the config's 3 holds while a fourth run queues.
    process.env.MOCK_CONCURRENCY_LOG = path.join(dir, "cfg.log");
    const first = await Promise.all(Array.from({ length: 4 }, run));
    assert.ok(first.every((r) => r.exitCode === 0 && r.text.includes("holds the model")));
    assert.equal(peakOf(process.env.MOCK_CONCURRENCY_LOG as string), 3);

    // The env outranks the config: capped to 1.
    process.env.PI_PB_MAX_CONCURRENT = "1";
    process.env.MOCK_CONCURRENCY_LOG = path.join(dir, "env.log");
    const second = await Promise.all(Array.from({ length: 4 }, run));
    assert.ok(second.every((r) => r.exitCode === 0 && r.text.includes("holds the model")));
    assert.equal(peakOf(process.env.MOCK_CONCURRENCY_LOG as string), 1);
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("fresh runs are uncapped by default: 4 runs all run at once until the config or the env caps them", async () => {
  const { runFresh } = await import("../extensions/pb/runner.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-conc-free-"));
  const log = path.join(dir, "free.log");
  const prior = { MOCK_HOLD_MS: process.env.MOCK_HOLD_MS, PI_PB_MAX_CONCURRENT: process.env.PI_PB_MAX_CONCURRENT, MOCK_CONCURRENCY_LOG: process.env.MOCK_CONCURRENCY_LOG };
  process.env.MOCK_HOLD_MS = "200";
  process.env.MOCK_CONCURRENCY_LOG = log;
  try {
    const rs = await Promise.all(
      Array.from({ length: 4 }, () =>
        runFresh({ cwd: dir, role: "explorer", systemPrompt: "You are an EXPLORER", brief: "# Question\n\nwhere?", prompt: "go", tools: ["read"] }),
      ),
    );
    assert.ok(rs.every((r) => r.exitCode === 0 && r.text.includes("holds the model")));
    const events = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => ({ kind: line.split(" ")[0], at: Number(line.split(" ")[1]) }))
      .sort((a, b) => a.at - b.at || (a.kind === "e" ? -1 : 1)); // ends before starts at the same ms
    let openCount = 0;
    let peak = 0;
    for (const event of events) {
      openCount += event.kind === "s" ? 1 : -1;
      peak = Math.max(peak, openCount);
    }
    assert.equal(peak, 4); // all four at once: no cap without a config or env value
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("maxConcurrent: uncapped by default; the global pb config caps every project until the project sets its own", async () => {
  const { Store } = await import("../extensions/pb/store.ts");
  const { agentDir } = await import("../extensions/pb/standards.ts");
  const global = path.join(agentDir(), "pb", "config.json");
  fs.mkdirSync(path.dirname(global), { recursive: true });
  fs.writeFileSync(global, JSON.stringify({ maxConcurrent: 2 }));
  try {
    const t = setup({ verify: "true" }); // a fresh project config: no maxConcurrent of its own
    assert.equal(new Store(t.repo).config().maxConcurrent, 2); // the machine's cap applies
    new Store(t.repo).updateConfig((raw) => ({ ...raw, maxConcurrent: 4 }));
    assert.equal(new Store(t.repo).config().maxConcurrent, 4); // the project outranks the machine
  } finally {
    fs.rmSync(global, { force: true });
  }
  const t2 = setup({ verify: "true" });
  assert.equal(new Store(t2.repo).config().maxConcurrent, 0); // no machine cap: uncapped
});

test("session shutdown prunes every session-keyed registry for that session", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  t.selects.push("No thanks"); // the standards offer
  t.agent.script = async () => {
    fs.writeFileSync(path.join(t.repo, "stray.txt"), "written by a shell command");
  };
  await t.run("plan", "x"); // a planning turn whose write seeds the planning-write dedupe note
  const session = t.runtime().ctx.sessionManager.getSessionFile()!;
  const kit = await import("../extensions/pb/kit.ts");
  kit.specStarted.set(session, 1);
  kit.rememberStall(session, { changed: [], read: [], tokens: 1, strikes: 1 });
  kit.baselineSessions.add(session);
  kit.specWriting.add(session);
  kit.checkpointing.set(session, { since: "x", percent: 1, last: {} });
  kit.checkpointQuiet.set(session, 1);
  assert.ok(kit.planningWriteNotes.has(session), "the planning turn should have left a dedupe note");
  await t.fire("session_shutdown", { reason: "quit" });
  for (const [name, present] of Object.entries({
    specStarted: kit.specStarted.has(session),
    compactStalls: kit.compactStalls.has(session),
    baselineSessions: kit.baselineSessions.has(session),
    specWriting: kit.specWriting.has(session),
    checkpointing: kit.checkpointing.has(session),
    checkpointQuiet: kit.checkpointQuiet.has(session),
    planningWriteNotes: kit.planningWriteNotes.has(session),
  })) assert.ok(!present, `${name} still holds the shut-down session`);
});

test("session shutdown leaves other sessions state intact", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  t.selects.push("No thanks");
  t.agent.script = async () => {
    fs.writeFileSync(path.join(t.repo, "stray.txt"), "written by a shell command");
  };
  await t.run("plan", "x");
  const session = t.runtime().ctx.sessionManager.getSessionFile()!;
  const kit = await import("../extensions/pb/kit.ts");
  const other = path.join(t.repo, ".pi", "other-session.jsonl");
  for (const s of [session, other]) {
    kit.specStarted.set(s, 1);
    kit.rememberStall(s, { changed: [], read: [], tokens: 1, strikes: 1 });
    kit.baselineSessions.add(s);
    kit.specWriting.add(s);
    kit.checkpointing.set(s, { since: "x", percent: 1, last: {} });
    kit.checkpointQuiet.set(s, 1);
    kit.planningWriteNotes.set(s, "stray.txt");
  }
  await t.fire("session_shutdown", { reason: "new", targetSessionFile: "next" });
  for (const [name, set] of Object.entries({
    specStarted: kit.specStarted,
    compactStalls: kit.compactStalls,
    baselineSessions: kit.baselineSessions,
    specWriting: kit.specWriting,
    checkpointing: kit.checkpointing,
    checkpointQuiet: kit.checkpointQuiet,
    planningWriteNotes: kit.planningWriteNotes,
  })) {
    assert.ok(!set.has(session), `${name} still holds the shut-down session`);
    assert.ok(set.has(other), `${name} dropped a live session`);
  }
});

test("stats: the session line no longer counts questions", async () => {
  const { renderCard } = await import("../extensions/pb/stats.ts");
  const card = renderCard({
    name: "demo",
    phase: "reviewed",
    events: [{ type: "ask", at: "2026-10-01 10:00:00" }], // nothing writes this event type: no card may imply it exists
    explore: [],
    progress: { spec: "demo", phase: "reviewed", session: "s", tasks: [], updatedAt: "2026-10-01 10:08:00" },
  } as any);
  assert.match(card, /^Session +\d+ compactions · \d+ resets · \d+ reminders$/m);
  assert.doesNotMatch(card, /questions/);
  const source = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "extensions", "pb", "stats.ts"), "utf8");
  assert.ok(!/\basks\s*:/.test(source) && !source.includes('count("ask")'), "the dead asks counter must not remain in stats.ts");
});

test("manifests: a pipe planted as package.json hangs no detection, and a script npm stubs out is not a command", async () => {
  const { detectVerify, detectLint } = await import("../extensions/pb/verify.ts");
  const { projectStack, usesDatabase } = await import("../extensions/pb/standards.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-manifest-"));
  if (process.platform !== "win32") {
    execSync("mkfifo package.json", { cwd: dir }); // opening it for reading would block until a writer appears
    assert.equal(detectVerify(dir), null);
    assert.equal(detectLint(dir), null);
    assert.equal(projectStack(dir), undefined);
    assert.equal(usesDatabase(dir), false);
    fs.rmSync(path.join(dir, "package.json"));
  }
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', lint: "eslint ." }, devDependencies: { vue: "3" } }));
  assert.equal(detectVerify(dir), null);
  assert.equal(detectLint(dir), "npm run lint --silent");
  assert.equal(projectStack(dir), "vue");
  fs.writeFileSync(path.join(dir, "package.json"), "[1, 2]"); // JSON, but not a manifest
  assert.equal(detectLint(dir), null);
});

test("what's next: one derivation names every state a spec can be in and the command that moves it on", async () => {
  const { whereNext } = await import("../extensions/pb/next.ts");
  const { Store } = await import("../extensions/pb/store.ts");
  const t = setup({ verify: "true" });
  await written(t);
  process.chdir(t.repo);
  const store = new Store(t.repo);
  const name = "order-cancellation";
  const progressFile = path.join(t.repo, ".pi/pb/specs", name, "progress.json");
  const base = JSON.parse(fs.readFileSync(progressFile, "utf8"));
  const at = (p: object) => {
    fs.writeFileSync(progressFile, JSON.stringify({ ...base, ...p }));
    const w = whereNext(store, name);
    return `${w.state} | ${w.command ?? "-"}`;
  };
  assert.equal(at({}), "spec ready | /pb:build order-cancellation");
  assert.equal(at({ phase: "building", current: "T2" }), "building T2 | -", "a running build says it will call you");
  assert.equal(at({ phase: "paused", pause: "T2 failed 3 times" }), "paused: T2 failed 3 times | /pb:build order-cancellation");
  assert.equal(at({ phase: "built" }), "built | /pb:review order-cancellation");
  const review = (verdict: string, findings: object[] = []) => ({ at: "2026-10-01 10:00:00", verdict, findings });
  assert.equal(at({ phase: "built", review: review("changes_needed", [{ priority: "P1", title: "x" }, { priority: "P3", title: "nit" }]) }), "review: CHANGES NEEDED (1 open) | /pb:fix order-cancellation");
  assert.equal(at({ phase: "built", review: review("unverified") }), "review: UNVERIFIED | /pb:review order-cancellation");
  assert.equal(at({ phase: "reviewed", review: review("pass") }), "reviewed: PASS | /pb:commit order-cancellation");
  store.event(name, { type: "review", verdict: "pass" });
  store.event(name, { type: "commit", sha: "abc", files: 2, subject: "Order cancellation" });
  assert.equal(at({ phase: "reviewed", review: review("pass") }), "reviewed and committed | /pb:archive order-cancellation", "committed since the review: archiving is next");
  // Fixes after the last review: the follow-up review is next, not the fixes again.
  store.event(name, { type: "review", verdict: "changes_needed" });
  store.event(name, { type: "fix", fixed: ["x"], skipped: [] });
  assert.equal(at({ phase: "built", review: review("changes_needed", [{ priority: "P1", title: "x" }]) }), "fixed, not re-reviewed | /pb:review order-cancellation");
  // A spec review on this exact text decides what "written" means.
  const md = store.readSpec(name)!;
  const { specHash } = await import("../extensions/pb/spec.ts");
  store.event(name, { type: "spec-review", verdict: "pass", hash: specHash(md), reported: [{ priority: "P1", title: "a" }, { priority: "P2", title: "b" }] });
  assert.equal(at({ phase: "written" }), "spec reviewed: 1 P1 | /pb:build order-cancellation");
  store.event(name, { type: "spec-review", verdict: "block", hash: specHash(md), reported: [{ priority: "P0", title: "c" }] });
  assert.equal(at({ phase: "written" }), "spec review found a P0 | /pb:spec-fix order-cancellation");
  fs.writeFileSync(path.join(t.repo, ".pi/pb/specs", name, "spec.md"), md.replace("Status: ready", "Status: planning").replace(/^# Order cancellation\n/, "# Order cancellation\nStatus: planning\n"));
  assert.match(at({ phase: "written" }), /^planning \| \/pb:spec order-cancellation$/, "an edited text has no review: the planning status decides");
});

test("what's next: always on screen — the footer, the title, situational help and status, a startup greeting, alt+n, completions", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  // The footer and the title follow every command.
  assert.equal(t.statuses.get("pb"), "pb · order-cancellation · built · next: /pb:review order-cancellation");
  assert.match(t.stat.title, /^π - order-cancellation: built - /);
  await t.run("help");
  assert.match(t.posts.at(-1)!, /^\*\*You are here:\*\* order-cancellation — built\n\*\*Next:\*\* \/pb:review order-cancellation \(alt\+n puts `\/pb:review order-cancellation` in the editor\)/);
  await t.run("status");
  assert.match(t.notes.at(-1)!, /order-cancellation — built[\s\S]*\n    next: \/pb:review order-cancellation/);
  // Starting Pi on this work says so once; pb's own session switches never do.
  const notes = t.notes.length;
  for (const h of t.runtime().handlers.session_start ?? []) await h({ type: "session_start", reason: "startup" }, t.runtime().ctx);
  assert.equal(t.notes.length, notes + 1);
  assert.match(t.notes.at(-1)!, /^pb · order-cancellation: built — next: \/pb:review order-cancellation \(alt\+n puts `\/pb:review order-cancellation` in the editor\)\.$/);
  for (const h of t.runtime().handlers.session_start ?? []) await h({ type: "session_start", reason: "resume" }, t.runtime().ctx);
  assert.equal(t.notes.length, notes + 1);
  // One key puts the next command in the editor.
  await t.runtime().shortcuts["alt+n"].handler(t.runtime().ctx);
  assert.equal(t.stat.editorText, "/pb:review order-cancellation");
  // Finding numbers complete with what they are; Pi replaces the whole argument with the value.
  process.chdir(t.repo);
  const progressFile = path.join(t.repo, ".pi/pb/specs/order-cancellation/progress.json");
  const p = JSON.parse(fs.readFileSync(progressFile, "utf8"));
  fs.writeFileSync(progressFile, JSON.stringify({ ...p, review: { at: "2026-10-01 10:00:00", verdict: "changes_needed", findings: [{ priority: "P1", title: "the guard is missing" }, { priority: "P2", title: "name the constant" }] } }));
  const fix = t.runtime().cmds["pb:fix"].getArgumentCompletions;
  assert.deepEqual(fix(""), [
    { value: "order-cancellation 1 ", label: "1", description: "[P1] the guard is missing" },
    { value: "order-cancellation 2 ", label: "2", description: "[P2] name the constant" },
  ]);
  assert.deepEqual(fix("order-cancellation 1 ").map((i: any) => i.value), ["order-cancellation 1 2 "], "a number already picked is not offered again");
  const undo = t.runtime().cmds["pb:undo"].getArgumentCompletions("");
  assert.ok(undo.some((i: any) => i.value === "T1" && i.description), "checkpoints complete with what they undo");
});

test("build-start screen: an unbuilt dependency, the review's P1 and a full session are one screen with one choice", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  const { Store } = await import("../extensions/pb/store.ts");
  new Store(t.repo).markAsked("standards");
  await t.callTool("pb_write_spec", { name: "base-feature", content: SPEC() });
  assert.equal((await t.callTool("pb_write_spec", { name: "order-cancellation", content: SPEC().replace("Depends on: none", "Depends on: base-feature") })).error, undefined);
  t.runtime().usage = 80; // past freshAbove (50): where to build is part of the same screen
  process.env.MOCK_SPEC_REVIEW = "advisory"; // a pass with a P1
  t.selects.push("Stop here");
  try {
    await t.run("build", "order-cancellation");
  } finally {
    delete process.env.MOCK_SPEC_REVIEW;
  }
  const screens = t.selectTitles.filter((x) => x.startsWith("Build order-cancellation"));
  assert.equal(screens.length, 1, "one screen, not a dialog per concern");
  assert.equal(
    screens[0],
    "Build order-cancellation: this session is 80% full\n- ⚠ order-cancellation depends on base-feature, which isn't built yet\n- ⚠ the spec review raised 1 P1 finding (shown above): the build would carry it",
  );
  assert.deepEqual(t.selectOptions.at(-1), ["Build in a fresh session, from the spec (recommended)", "Build here anyway", "Repair first: /pb:spec-harden order-cancellation works through them", "Stop here"]);
  assert.equal(t.progress("order-cancellation").phase, "written", "stopped: nothing approved");
});

test("a build in the planning session renames it, so /resume shows what it became", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  const session = t.runtime().ctx.sessionManager.getSessionFile();
  await t.run("build");
  assert.equal(t.names.get(session), "build: order-cancellation");
});

test("dialogs: the footer says pb is waiting for you, and a timed-out choice says what pb did", async () => {
  const { choose } = await import("../extensions/pb/kit.ts");
  const { Store } = await import("../extensions/pb/store.ts");
  const t = setup({ verify: "true", askTimeoutSec: 1 });
  await written(t);
  const ctx = t.runtime().ctx as any;
  for (const h of t.runtime().handlers.ui_prompt_start ?? []) await h({ type: "ui_prompt_start", kind: "select", title: "Build order-cancellation?\n- ⚠ something" }, ctx);
  assert.equal(t.statuses.get("pb"), "pb · waiting for your answer: Build order-cancellation?");
  for (const h of t.runtime().handlers.ui_prompt_end ?? []) await h({ type: "ui_prompt_end" }, ctx);
  assert.match(t.statuses.get("pb")!, /^pb · order-cancellation · spec ready · next: /, "the next step is back");
  ctx.mode = "tui";
  t.selects.push("<hang>");
  const notes: string[] = [];
  const picked = await choose(ctx, new Store(t.repo), "Build order-cancellation?\n- ⚠ a P1", ["Build anyway", "Stop here"], "Build anyway", notes);
  assert.equal(picked, "Build anyway");
  assert.equal(t.posts.at(-1), '**No answer within 1 min**, so pb went on with its default — "Build anyway" — for: Build order-cancellation?');
  assert.equal(notes.length, 1);
});

test("config: a mistyped or replaced setting is named at startup and in /pb:status, with the nearest real key; null turns a command off", async () => {
  const t = setup({ comandTimeoutSec: 5, maxAttempts: 0, reviewer: { idelSec: 1 }, planner: { thinking: "ultra" }, verify: null, lint: null });
  const globalFile = path.join(process.env.PI_CODING_AGENT_DIR!, "pb", "config.json");
  fs.mkdirSync(path.dirname(globalFile), { recursive: true });
  fs.writeFileSync(globalFile, JSON.stringify({ verifyTimeoutSec: 60 }));
  try {
    for (const h of t.runtime().handlers.session_start ?? []) await h({ type: "session_start", reason: "startup" }, t.runtime().ctx);
    const warning = t.notes.at(-1)!;
    assert.match(warning, /^pb config — these settings are ignored or replaced:/);
    assert.match(warning, /\.pi\/pb\/config\.json: `comandTimeoutSec` is not a pb setting — did you mean `commandTimeoutSec`\?/);
    assert.match(warning, /`maxAttempts`: 0 is not valid — pb uses 1/);
    assert.match(warning, /`reviewer\.idelSec` is not a pb setting — did you mean `reviewer\.idleSec`\?/);
    assert.match(warning, /`planner\.thinking`: "ultra" is not valid/);
    assert.match(warning, /the user-level pb config\.json: `verifyTimeoutSec` is read only from a project's \.pi\/pb\/config\.json/);
    // null is the documented way to turn a command off: it is honoured, and not reported.
    assert.doesNotMatch(warning, /`verify`|`lint`|`build`/);
    const { Store } = await import("../extensions/pb/store.ts");
    const config = new Store(t.repo).config();
    assert.equal(config.verify, null);
    assert.equal(config.lint, null);
    // /pb:status says the same while Pi runs, specs or not; resuming a session does not repeat the warning.
    await t.run("status");
    assert.match(t.notes.at(-1)!, /No specs yet[\s\S]*config — ignored or replaced:[\s\S]*comandTimeoutSec/);
    const notes = t.notes.length;
    for (const h of t.runtime().handlers.session_start ?? []) await h({ type: "session_start", reason: "resume" }, t.runtime().ctx);
    assert.equal(t.notes.length, notes);
    // A file that is not JSON is named rather than silently replaced by the defaults.
    fs.writeFileSync(path.join(t.repo, ".pi/pb/config.json"), "{ verify: true");
    assert.match(new Store(t.repo).configProblems()[0], /^\.pi\/pb\/config\.json is not valid JSON \(.+\): pb uses the defaults$/);
  } finally {
    fs.rmSync(globalFile);
  }
});

test("stats compare: the last specs side by side — what the first spec review and code review found, laps, first try, cost per phase", async () => {
  const { renderCompare } = await import("../extensions/pb/stats.ts");
  const spec = (name: string, events: Record<string, unknown>[]) => ({ name, phase: "reviewed", events: events.map((e) => ({ at: "2026-10-01 10:00:00", ...e })), explore: [] });
  const list = [
    spec("oldest", [{ type: "usage", cost: 9 }]),
    spec("before", [
      { type: "spec-review", verdict: "error" },
      { type: "spec-review", verdict: "block", reported: [{ priority: "P0" }, { priority: "P1" }, { priority: "P1" }], cost: 0.5 },
      { type: "spec-fix", applied: ["a"] },
      { type: "spec-review", verdict: "pass", reported: [{ priority: "P3" }], cost: 0.25 },
      { type: "usage", cost: 2 },
      { type: "review", verdict: "changes_needed", p: [0, 2, 1, 0], dismissed: 1, cost: 1 },
      { type: "fix", fixed: ["x"] },
      { type: "review", verdict: "pass", p: [0, 0, 0, 0] },
    ]),
    spec("after", [{ type: "spec-review", verdict: "pass", reported: [] }, { type: "usage", cost: 1.5 }]),
  ];
  const out = renderCompare(list as any, 2);
  assert.ok(!out.split("\n").some((l) => l.startsWith("oldest")), "only the last n specs");
  const before = out.split("\n").find((l) => l.startsWith("before"))!;
  assert.deepEqual(before.trim().split(/\s+/).slice(1, 10), ["1/2/0/0", "1", "–", "4", "1", "–", "$0.75", "$2.00", "$1.00"]);
  const after = out.split("\n").find((l) => l.startsWith("after"))!;
  assert.deepEqual(after.trim().split(/\s+/).slice(1, 10), ["0/0/0/0", "0", "–", "–", "0", "–", "–", "$1.50", "–"]);
  assert.ok(out.indexOf("before") < out.indexOf("after"), "oldest first");
});

test("map: a bullet carrying the mechanism goes back to be shortened; the limit is per bullet, and one left long is named", async () => {
  const { longBullets, MAP_BULLET_CHARS, CARTOGRAPHER_SYSTEM } = await import("../extensions/pb/map.ts");
  // A wrapped bullet is one bullet; a heading or a blank line ends it.
  const wrapped = `- first part ${"x".repeat(MAP_BULLET_CHARS)}\n  continued\n- short\n### Next\n- also short`;
  assert.deepEqual(longBullets(wrapped).map((b) => b.text.endsWith("continued")), [true]);
  assert.match(CARTOGRAPHER_SYSTEM, new RegExp(`Each bullet is at most two sentences, about ${MAP_BULLET_CHARS} characters: the rule, where it is enforced, and the test that proves it\\.`));
  assert.match(CARTOGRAPHER_SYSTEM, /shorten it, never drop a rule that is still true\. The map's total, about [\d,]+ tokens at most, is a sanity bound, not a target\./);
  const t = setup({ verify: "true" });
  fs.mkdirSync(path.join(t.repo, "src/auth"), { recursive: true });
  fs.writeFileSync(path.join(t.repo, "src/order.ts"), "export {}\n");
  fs.writeFileSync(path.join(t.repo, "src/auth/Login.java"), "class Login {}\n");
  process.chdir(t.repo);
  const repair = path.join(os.tmpdir(), `pb-map-long-${process.pid}.md`);
  process.env.MOCK_MAP_LONG = "1";
  process.env.MOCK_REPAIR_OUT = repair;
  try {
    await t.run("map");
    const brief = fs.readFileSync(repair, "utf8");
    assert.match(brief, /# Bullets over the length\n\nEach of these is over 400 characters\. Rewrite each as the rule, where it is enforced, and the test that proves it/);
    assert.match(brief, /- \(\d+ characters\) - Orders settle in one transaction:/);
    assert.doesNotMatch(brief, /# Over the budget/); // far below the total: the bullet alone sent it back
    assert.doesNotMatch(t.read("AGENTS.md"), /the mechanism, case by case/);
    // A cartographer that doesn't shorten it: the map is written, and the result says what is still long.
    process.env.MOCK_MAP_LONG = "stubborn";
    fs.writeFileSync(path.join(t.repo, "src/extra.ts"), "export {}\n");
    await t.run("map", "orders");
    assert.match(t.read("AGENTS.md"), /the mechanism, case by case/);
    assert.match(t.notes.at(-1)!, /1 bullet is still over 400 characters\./);
  } finally {
    delete process.env.MOCK_MAP_LONG;
    delete process.env.MOCK_REPAIR_OUT;
    fs.rmSync(repair, { force: true });
  }
});

test("map: an area lives in its folder's AGENTS.md, listed in the core; the build's handouts and the review name the notes their files need", async () => {
  const { areaDir, areaNotes, areaNotesFor, readMap, writeMap } = await import("../extensions/pb/map.ts");
  const t = setup({ verify: "true" });
  fs.mkdirSync(path.join(t.repo, "src/auth"), { recursive: true });
  fs.writeFileSync(path.join(t.repo, "src/order.ts"), "export {}\n");
  fs.writeFileSync(path.join(t.repo, "src/auth/Login.java"), "class Login {}\n");
  process.chdir(t.repo);
  process.env.MOCK_MAP_AREA = "1";
  try {
    await t.run("map");
  } finally {
    delete process.env.MOCK_MAP_AREA;
  }
  // Every session reads the core and the index; the area's rules sit in its folder, for the sessions working there.
  const root = t.read("AGENTS.md");
  assert.match(root, /### Area notes\n- `src\/auth\/AGENTS\.md`: Auth — read it before working under `src\/auth\/`\./);
  assert.doesNotMatch(root, /Sign-in goes through/);
  assert.match(t.read("src/auth/AGENTS.md"), /^<!-- pb:map -->\n## Project map: src\/auth\/\n\n### Auth \(src\/auth\/\)\n- Sign-in goes through `Login\.java`; nothing else issues sessions\.\n<!-- \/pb:map -->\n$/);
  assert.match(t.notes.at(-1)!, /written in AGENTS\.md \(~\d+ tokens read in every session\) and 1 area note/);
  // The cartographer reads one map: the core without the index, then the areas.
  assert.match(readMap(t.repo), /### Orders[\s\S]*### Auth \(src\/auth\/\)\n- Sign-in goes through/);
  assert.doesNotMatch(readMap(t.repo), /Area notes/);
  assert.deepEqual(areaNotesFor(t.repo, ["src/auth/Login.java", "src/order.ts"]), ["src/auth/AGENTS.md"]);
  assert.deepEqual(areaNotesFor(t.repo, ["src/order.ts"]), []);
  // Undo swaps the whole map, the area notes with it.
  await t.run("map", "undo");
  assert.ok(!fs.existsSync(path.join(t.repo, "src/auth/AGENTS.md")));
  await t.run("map", "undo");
  assert.match(t.read("src/auth/AGENTS.md"), /Sign-in goes through/);

  // A heading is model text: it becomes a folder only inside the project, existing, not the root, not dot-named,
  // not ignored, and not through a link that leaves the project. Anything else stays in the core.
  fs.mkdirSync(path.join(t.repo, "build"), { recursive: true });
  fs.writeFileSync(path.join(t.repo, ".gitignore"), "build/\n");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pb-outside-"));
  fs.symlinkSync(outside, path.join(t.repo, "src/linked"));
  for (const h of ["(../)", "(./)", "(.pi/pb/)", "(src/missing/)", "(build/)", "(src/linked/)", "(/etc/)", ""]) assert.equal(areaDir(t.repo, `### X ${h}`), undefined, h);
  assert.equal(areaDir(t.repo, "### X (src/auth/Login.java, src/auth/)"), "src/auth"); // files count as their folder
  // An index line edited by hand never makes pb read or write outside the project.
  fs.writeFileSync(path.join(t.repo, "AGENTS.md"), root.replace("- `src/auth/AGENTS.md`", "- `../outside/AGENTS.md`: X\n- `src/auth/AGENTS.md`"));
  assert.deepEqual(areaNotes(t.repo), ["src/auth"]);

  // An area the map no longer has leaves its folder; the author's own text there stays.
  fs.writeFileSync(path.join(t.repo, "src/auth/AGENTS.md"), `My notes.\n\n${t.read("src/auth/AGENTS.md")}`);
  assert.equal(writeMap(t.repo, "### Layout\n- `src/`: the application"), true);
  assert.equal(t.read("src/auth/AGENTS.md"), "My notes.\n");
  assert.doesNotMatch(t.read("AGENTS.md"), /Area notes/);

  // The build's handouts name the notes for the folders the spec cites; the review, those for the files it changed.
  const u = setup({ verify: "true" });
  fs.mkdirSync(path.join(u.repo, "src/auth"), { recursive: true });
  fs.writeFileSync(path.join(u.repo, "src/auth/Login.java"), "class Login {}\n");
  fs.writeFileSync(path.join(u.repo, "src/order.ts"), "export {}\n");
  writeMap(u.repo, "### Layout\n- `src/`: the app\n### Auth (src/auth/)\n- Sign-in goes through `Login.java`.\n### Orders (src/)\n- Orders settle in one transaction.");
  execSync("git add . && git commit -qm src", { cwd: u.repo });
  await written(u, SPEC().replace("## Context\nsrc/order.ts holds the model.", "## Findings\n- `src/auth/Login.java` signs in."));
  u.agent.script = diligent;
  await u.run("build");
  assert.ok(u.instructions.some((i) => i.includes("The project map's area notes for the folders this spec cites: `src/auth/AGENTS.md`, `src/AGENTS.md`")), "the task handout names the notes");
  fs.writeFileSync(path.join(u.repo, "src/order.ts"), "export const settled = true;\n");
  await u.run("review");
  assert.match(briefOf(u), /The project map's area notes for the folders this change touches: `src\/AGENTS\.md` — read the ones covering a file/);
});

test("map: new lines are checked against the code before they're written; a contradicted one is corrected, or you decide", async () => {
  const t = setup({ verify: "true", askTimeoutSec: 0.001 });
  fs.mkdirSync(path.join(t.repo, "src/auth"), { recursive: true });
  fs.writeFileSync(path.join(t.repo, "src/order.ts"), "export {}\n");
  fs.writeFileSync(path.join(t.repo, "src/auth/Login.java"), "class Login {}\n");
  process.chdir(t.repo);
  const checkBrief = path.join(os.tmpdir(), `pb-map-check-${process.pid}.md`);
  const repair = path.join(os.tmpdir(), `pb-map-check-repair-${process.pid}.md`);
  process.env.MOCK_CHECK_BRIEF_OUT = checkBrief;
  process.env.MOCK_REPAIR_OUT = repair;
  process.env.MOCK_MAP_CHECK = "reject";
  try {
    await t.run("map");
    // The check reads only the new lines, each with the heading it sits under.
    assert.match(fs.readFileSync(checkBrief, "utf8"), /^# Lines to check\n\n1\. \[under ### Layout\] - `src\/`: the application\n[\s\S]*\d\. \[under ### Orders\] - Services own transactions; controllers never call repositories\./);
    assert.match(fs.readFileSync(repair, "utf8"), /# Lines the code contradicts\n\n[\s\S]*- - Services own transactions; controllers never call repositories\.\n  Evidence: src\/order\.ts:3 the controller calls the repository/);
    assert.doesNotMatch(t.read("AGENTS.md"), /controllers never call repositories/);
    // Nothing new: nothing to check.
    const calls = t.read(".pi/pb/explore.jsonl").trim().split("\n").length;
    fs.rmSync(checkBrief);
    process.env.MOCK_MAP_CHECK = "stubborn";
    t.selects.push("Keep the current map");
    await t.run("map");
    assert.ok(t.read(".pi/pb/explore.jsonl").trim().split("\n").length > calls);
    // A cartographer that keeps a contradicted line word for word: you decide, and kept, the map stays.
    t.selects.push("Keep the current map");
    fs.writeFileSync(path.join(t.repo, "src/extra.ts"), "export {}\n");
    await t.run("map", "transactions");
    assert.match(t.selectTitles.at(-1)!, /The proposed project map needs a look: the code contradicts "- Services own transactions; controllers never call repositories\." \(src\/order\.ts:3 the controller calls the repository\)/);
    assert.doesNotMatch(t.read("AGENTS.md"), /controllers never call repositories/);
    // A check that reports nothing is said, never read as a pass.
    process.env.MOCK_MAP_CHECK = "silent";
    t.selects.push("<timeout>");
    await t.run("map", "again");
    assert.ok(t.notes.some((n) => /The new lines weren't checked against the code: the check reported nothing/.test(n)));
  } finally {
    delete process.env.MOCK_CHECK_BRIEF_OUT;
    delete process.env.MOCK_REPAIR_OUT;
    delete process.env.MOCK_MAP_CHECK;
    fs.rmSync(checkBrief, { force: true });
    fs.rmSync(repair, { force: true });
  }
});

test("stats: a lap's own session is counted — repair laps in the spec phase, /pb:fix laps as their own cost", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  const { Store } = await import("../extensions/pb/store.ts");
  const store = new Store(t.repo);
  const ctx = t.runtime().ctx;
  const session = ctx.sessionManager.getSessionFile()!;
  const turn = (cost: number) => ({ type: "message_end", message: { role: "assistant", usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: { total: cost } } } });
  const fire = async (cost: number) => {
    for (const h of t.runtime().handlers.message_end ?? []) await h(turn(cost), ctx);
  };
  // A /pb:fix lap's session: its turns are the fix phase's.
  store.saveFixSession(session, { spec: "order-cancellation", findings: [{ priority: "P1", title: "x" }] });
  await fire(0.5);
  store.clearFixSession(session);
  // A repair lap's session: its turns are the spec phase's.
  const p = store.progress("order-cancellation")!;
  store.saveProgress({ ...p, fix: { session, driver: false, stage: "lap", startedAt: Date.now(), hash: "h", work: "findings" } as any });
  await fire(0.25);
  const laps = t.events("order-cancellation").filter((e: any) => e.type === "lap-usage");
  assert.deepEqual(laps.map((e: any) => [e.phase, e.cost]), [["fix", 0.5], ["spec-fix", 0.25]]);
  assert.ok(!t.events("order-cancellation").some((e: any) => e.type === "usage"), "never counted as the build's");
  await t.run("stats", "order-cancellation");
  assert.match(t.posts.at(-1)!, /Spec .*\$0\.25/);
  assert.match(t.posts.at(-1)!, /Fix laps +in 1\.0k · out 200 · \$0\.50/);
  await t.run("stats", "compare");
  const row = t.posts.at(-1)!.split("\n").find((l) => l.startsWith("order-cancellation"))!;
  assert.match(row, /\$0\.25 .*\$0\.50/);
});

test("approach: it reads the map like every planning prompt, area notes included", async () => {
  const { approachPrompt } = await import("../extensions/pb/prompts.ts");
  assert.match(approachPrompt("", ""), /Check the project map in AGENTS\.md first: its whole-project headings, then the area notes its "Area notes" list names/);
});

test("fresh runs show where they are: the step, time and tokens, the last few actions in words, and the run's file", async () => {
  const t = setup({ verify: "true" });
  fs.mkdirSync(path.join(t.repo, "src/auth"), { recursive: true });
  fs.writeFileSync(path.join(t.repo, "src/order.ts"), "export {}\n");
  fs.writeFileSync(path.join(t.repo, "src/auth/Login.java"), "class Login {}\n");
  process.chdir(t.repo);
  await t.run("map");
  const frames = t.widgetLog.filter((w) => w.id === "pb-map" && w.lines).map((w) => w.lines!);
  // The first step, with what it has done so far: actions in words, paths from the project, the cd dropped.
  const reading = frames.filter((f) => f[0].startsWith("pb map — reading the project"));
  assert.ok(reading.some((f) => /^pb map — reading the project · [^·]+ · 3\.4k tokens$/.test(f[0])), "time and tokens so far");
  assert.ok(reading.some((f) => f.includes("  · read src/order.ts") && f.includes("  ↳ git log --oneline -5")), reading.map((f) => f.join("\n")).join("\n---\n"));
  assert.ok(reading.some((f) => f.at(-2) === "  ↳ writing its report" || f.at(-1) === "  ↳ writing its report"), "the report, in words");
  assert.ok(reading.some((f) => f.some((l) => /^ {2}the whole run: \.pi\/pb\/sessions\/cartographer\/.+\.jsonl$/.test(l))), "the run's file while it runs");
  // The later steps are numbered, each starting with a clean list of actions.
  assert.ok(frames.some((f) => /^pb map — step 2: checking \d+ new lines? against the code/.test(f[0])));
  assert.ok(frames.some((f) => /^pb map — step 3: checking \d+ paths?/.test(f[0])));
  assert.equal(t.widgets.get("pb-map"), undefined, "gone when the run ends");
  // At most five recent actions are kept, the newest marked.
  const { freshProgress } = await import("../extensions/pb/progress.ts");
  const drawn: string[][] = [];
  const p = freshProgress({ hasUI: false, ui: { setWidget: (_k: string, l?: string[]) => void (l && drawn.push(l)) } } as any, "k", "pb x");
  for (let i = 1; i <= 7; i++) p.hooks.onActivity!(`a${i}`, { name: "read", arguments: {} });
  assert.deepEqual(drawn.at(-1)!.slice(1), ["  · a3", "  · a4", "  · a5", "  · a6", "  ↳ a7"]);
  p.stop();
});
