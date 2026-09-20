# TODO List
Last updated 20 September 2026

1. Front end display of system errors (some currently only to console.log)
2. Check for redundant packages in package.json & package-lock.json
3. Duplication in README.md and AGENTS.md.   Can one of these be removed? (Perhaps AGENTS.md is used by the google Jules coding agent)
4. What is the file "Archive.zip" and what does it do?
5. ARCHITECTURE.md contains Antigravity Coding Agent Guidelines.   Move to a different file if possible
6. Review and revise step flow visuals and state memory process. (i.e. what happens if user logs out and in, what happens if browser reloaded?)
7. The race-speed marker on the forces and power charts is an unlabelled dashed
   line, so nothing says what it is. (The rest of item "are the charts
   understandable by high school pupils" is done: the LaTeX notation is gone and
   both charts carry a plain-English takeaway.)
8. Change of app to multi-lambda app (see MULTI_LAMBDA.md in Specifications folder)
9. `GET /api/jobs` and `GET /api/files` in backend/app/app.js call
   `ListObjectsV2Command` without a continuation-token loop, so they silently stop
   at 1000 keys. At roughly 11 keys per completed job that means users start losing
   their own run history at around job 90. `admin/lib/s3.js#listAllObjects` shows
   the paginated form to copy.
10. Decide whether S3 versioning should be enabled on the storage bucket. The admin
    app deletes permanently and versioning is the only undo that exists — but it
    would then need per-version deletes to be genuinely permanent.

## Answered

- **IP address hard coded in app.js (in userDataScript). Is this correct?** Yes.
  `169.254.169.254` is the link-local cloud metadata endpoint, and the droplet uses
  it to look up its own id before self-destructing. It is a fixed, well-known
  address on every major provider, not a host that could change, so hard-coding it
  is correct.
