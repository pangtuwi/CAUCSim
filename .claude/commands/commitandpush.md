---
description: Bump version, refresh README, run tests, then commit and push
---

Run through these steps in order. Stop and report back if any step fails — do not continue to the next step (and do not commit/push) on failure.

1. **Bump the version by 0.01.**
   - The version lives in the `version-badge` span in `public/index.html` (e.g. `v0.35`).
   - Increment it by 0.01, keeping two decimal places (e.g. `v0.35` → `v0.36`).

2. **Update the README.**
   - Look at `git status` / `git diff` for what's changed in this session (staged, unstaged, and untracked).
   - Update `README.md` so it accurately reflects any new features, changed behavior, or removed functionality. If nothing user-facing changed, skip this — don't pad the README with busywork edits.

3. **Run the full test suite.**
   - Run `npm test`.
   - If any test fails, stop here, report the failures, and do not commit or push.

4. **Commit and push.**
   - Review what's staged (`git status` / `git diff`) — watch for anything that looks like a secret before adding.
   - Stage the relevant changes (version bump, README, and whatever else this session touched — avoid unrelated files).
   - Commit with a concise message describing the change and including the new version, e.g. `chore: bump version to v0.36`, following the style of recent commits (`git log --oneline -10`).
   - Push to the current branch's upstream (ask first if there is no upstream configured yet).
