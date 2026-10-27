#!/usr/bin/env node
/**
 * pb-report: print the machine-readable pb.report/1 document for a project.
 * The same builder backs /pb:status --json and /pb:stats --json, so scripts and
 * dashboards read one shape whichever way they ask.
 *
 *   pb-report [--cwd <dir>] [--stats] [--review]
 *
 * Exit codes: 0 on success, 1 when the report can't be built, 2 on bad arguments.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { buildReport } from "./report.ts";
import { Store } from "./store.ts";

const USAGE = `Usage: pb-report [--cwd <dir>] [--stats] [--review]

Print the pb.report/1 JSON document for the project at --cwd (default: the
current directory).

  --cwd <dir>  project root holding .pi/pb
  --stats      include each spec's build stats
  --review     include the latest review's full findings
  --help       show this help`;

function fail(message) {
  process.stderr.write(`pb-report: ${message}\n\n${USAGE}\n`);
  process.exit(2);
}

function main(argv) {
  let cwd = process.cwd();
  let stats = false;
  let review = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${USAGE}\n`);
      return;
    }
    if (arg === "--stats") stats = true;
    else if (arg === "--review") review = true;
    else if (arg === "--cwd") {
      const value = argv[++i];
      if (!value) fail("--cwd needs a directory");
      cwd = value;
    } else if (arg.startsWith("--cwd=")) cwd = arg.slice("--cwd=".length);
    else fail(`unknown option "${arg}"`);
  }
  let report;
  const root = path.resolve(cwd);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail(`no directory "${cwd}"`);
  try {
    report = buildReport(new Store(root), { stats, review });
  } catch (error) {
    process.stderr.write(`pb-report: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main(process.argv.slice(2));
