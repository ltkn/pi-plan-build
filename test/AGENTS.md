<!-- pb:map -->
## Project map: test/

### Prompt snapshots (test/prompts.golden.test.mts, test/golden/)
- Every prompt pb sends is rendered with fixed inputs and compared with `test/golden/<name>.txt`, whose first line is its word count: information for review, never a cap. A prompt change — direct or through a shared rule — fails the test until `UPDATE_GOLDEN=1 npm test` rewrites the snapshot, so the change lands as a reviewable text diff. A new prompt gets an entry in `RENDERED`.
- Prompts are built only in `prompts.ts` (and the cartographer's in `map.ts`), never inline at a call site, so the snapshots see all of them.
<!-- /pb:map -->
