---
description: Bump version, refresh README and TODO, run tests, then commit and push
---

Run through these steps in order. Stop and report back if any step fails — do not continue to the next step (and do not commit/push) on failure.

1. **Bump the version by 0.01.**
   - The version lives in the `version-badge` span in `frontend/cfd/index.html` (e.g. `v0.35`).
   - Increment it by 0.01, keeping two decimal places (e.g. `v0.35` → `v0.36`).

2. **Update the README.**
   - Look at `git status` / `git diff` for what's changed in this session (staged, unstaged, and untracked).
   - Update `README.md` so it accurately reflects any new features, changed behavior, or removed functionality. If nothing user-facing changed, skip this — don't pad the README with busywork edits.

3. **Update TODO.md.**
   - Remove any numbered item that the work in this session actually resolved, then renumber the remaining items so the list stays sequential, and set the `Last updated` date to today.
   - Only remove an item once you have **verified in the code** that it's genuinely done — read the relevant file and confirm, don't infer it from a commit message or from what was discussed. If an item was only investigated or explained and no code changed, leave it.
   - Never remove, reword, or reorder items unrelated to this session's work. If the user has edited `TODO.md` themselves (including re-adding something you previously removed), treat their version as intentional and leave those entries alone.
   - Report which items you removed and why. If you're unsure whether something counts as done, leave it in and say so rather than deleting it.

4. **Run the full test suite.**
   - Run `npm test`.
   - If any test fails, stop here, report the failures, and do not commit or push.

5. **Commit and push.**
   - Review what's staged (`git status` / `git diff`) — watch for anything that looks like a secret before adding.
   - Stage the relevant changes (version bump, README, TODO.md, and whatever else this session touched — avoid unrelated files).
   - Commit with a concise message describing the change and including the new version, e.g. `chore: bump version to v0.36`, following the style of recent commits (`git log --oneline -10`).
   - Push to the current branch's upstream (ask first if there is no upstream configured yet).
