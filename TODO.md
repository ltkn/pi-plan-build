# TODO — future improvements (`/pb:plan` review)

- Revert-or-mention spec status when continuing planning is cancelled (`extensions/pb/index.ts:1038-1096`).
- Validate the spec parses before opening the fresh continue-session (`extensions/pb/index.ts:1033-1071`).
- Treat an unresolvable planning snapshot as missing and warn (`extensions/pb/index.ts:950-968`, `extensions/pb/checkpoint.ts:141-143`).
- Distinguish "git repo without commits" from "not a git repo" in the baseline warning (`extensions/pb/index.ts:881-884`).
- Check planning preconditions before the one-time standards offer (`extensions/pb/index.ts:1134-1137`, `extensions/pb/index.ts:990-997`).
- Normalize session keys (realpath) for planning state, baselines, and dedupe sets (`extensions/pb/store.ts:423-434`, `extensions/pb/index.ts:875-877`).
- Prefer the planning session's (`writtenIn`) baseline for fresh builds before the global fallback (`extensions/pb/index.ts:2101-2136`).
- Document snapshots as the primary planning guard; keep the edit/write block as UX (`extensions/pb/index.ts:1168-1181`).
- Pass explorer context explicitly instead of `plan: `-prefix sniffing (`extensions/pb/index.ts:636-719` pattern).
- Prefer per-session files over shared read-modify-write maps for new state (`extensions/pb/store.ts:408-434`).
- Unify the `.pi` exclude between snapshots and store helpers (`extensions/pb/checkpoint.ts:14`, `extensions/pb/store.ts:669-698`).
