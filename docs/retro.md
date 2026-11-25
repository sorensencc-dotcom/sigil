# Retros

What exists in this repo, so nobody has to rediscover it.

- **`/retro` skill** (`.agents/skills/retro/SKILL.md`): an interactive retrospective on one coding session. It reads the session and proposes improvements to the agent's environment. It writes no files.
- **`scripts/check-retro-needed.ps1`**: decides whether a same-day retro is worth running. It reads dated retro JSON from `.context/retros/<YYYY-MM-DD>-N.json`, recounts the commits in that file's window on its `base_branch`, and exits 1 (skip) when nothing new landed, 0 (proceed) otherwise. It also warns when the newest retro is older than `-MaxAgeDays` (default 7).
- **`scripts/test-check-retro-needed.ps1`**: regression tests for the script's exit codes against a throwaway git repo. Needs `pwsh` and `git`. It is not run by `npm test` or CI; run it by hand after changing the script: `pwsh scripts/test-check-retro-needed.ps1`.

`.context/` is gitignored, so retro JSON stays local. Nothing in this repo creates those files; the `/retro` skill above does not. If you do not use a retro tool that writes them, the script reports `PROCEED` (no retro filed today) and is harmless.

This repo has no `.context/retros/inbox/` or `scripts/validate-retro-inbox.mjs`. Those belong to the sibling `toolforge` repo.
