# TODO List
Last updated 18 September 2026

1. Front end display of system errors (some currently only to console.log)
2. IP Address hard coded in app.js (in userDataScript).   Is this correct?
3. Racespeed should be able to be set by the user before the CFD simulation starts.  Default to 30 mph.
4. Racespeed should be shown in mph (and m/s) in the user interface.
5. Check for redundant packages in package.json & package-lock.json
6. Duplication in README.md and AGENTS.md.   Can one of these be removed? (Perhaps AGENTS.md is used by the google Jules coding agent)
7. AGENTS.md references mock functionality.  Remove.
8. What is the file "Archive.zip" and what does it do?
9. ARCHITECTURE.md contains Antigravity Coding Agent Guidelines.   Move to a different file if possible
10. Review and revise step flow visuals and state memory process. (i.e. what happens if user logs out and in, what happens if browser reloaded?)
11. Are forces chart and power chart understandable by high school pupils?
12. Change of app to multi-lambda app (see MULTI_LAMBDA.md in Specifications folder)
13. `GET /api/jobs` and `GET /api/files` in backend/app/app.js call
    `ListObjectsV2Command` without a continuation-token loop, so they silently stop
    at 1000 keys. At roughly 11 keys per completed job that means users start losing
    their own run history at around job 90. `admin/lib/s3.js#listAllObjects` shows
    the paginated form to copy.
14. Decide whether S3 versioning should be enabled on the storage bucket. The admin
    app deletes permanently and versioning is the only undo that exists — but it
    would then need per-version deletes to be genuinely permanent.
