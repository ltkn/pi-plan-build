# pb eval

Does pb build better than a bare Pi agent working in one context, and at what
cost? `run.mjs` runs the same feature tasks in three arms and compares them:

| Arm | What runs |
|---|---|
| `bare` | Pi alone: the task, "investigate, implement it with tests, and run the tests" |
| `review` | the same, then `/pb:review` on the uncommitted change and one fix round |
| `pb` | `/pb:plan`, `/pb:build`, `/pb:review` and one fix round |

Every arm runs in a fresh copy of the task's repository, over Pi's RPC mode,
with only pb loaded as an extension (none in `bare`). A scripted stand-in for
the human answers the same way in every arm: the task's `answers` when the agent
ends on a question, pb's recommendation in dialogs, "no thanks" to adding
standards.

## Metrics

- **Hidden tests**: acceptance tests the agent never sees, copied in after the
  run (`pass`/`fail` counts are parsed from `node --test` output when present).
- **Judge**: one fresh call per run on a fixed model (`--judge`, default the
  build model), counting P0/P1/P2 problems in the diff against the task.
- **Cost and tokens**: every session file's assistant turns and usage entries,
  plus pb's reviewer, verifier and explorer calls from `.pi/pb/`.
- **Cache share**: cache reads over all prompt tokens.
- **Time** and **human asked**: wall-clock time; dialogs plus chat answers.

## Run

```bash
node eval/run.mjs --dry                               # wiring only: starts each arm's Pi, no model calls
node eval/run.mjs --model provider/id --thinking medium --judge provider/strong-model --runs 3
node eval/run.mjs --model provider/id --arms bare,pb --only inventory-reserve --keep
```

Results: `eval/results/results.jsonl` (one line per run) and `summary.md`
(means per arm). `--keep` leaves each run's working copy in the temp directory.

Run each task several times (`--runs`): single runs of agents vary a lot.

## Tasks

`tasks/<name>.json`:

```json
{
  "name": "inventory-reserve",
  "fixture": "fixtures/inventory",
  "prompt": "what you would type, in your own words",
  "answers": ["what the human says when the agent asks"],
  "hidden": { "dir": "hidden/inventory-reserve", "to": "test", "command": "node --test test/hidden.test.js" },
  "pbConfig": { "maxAttempts": 3 }
}
```

`fixture` is a directory copied and committed as the starting point; instead,
`"repo"` and `"commit"` clone a real repository. Good tasks are real features
of the size you'd plan: several files, a decision or two, tests to extend. The
bundled one is deliberately small, to check the setup.
