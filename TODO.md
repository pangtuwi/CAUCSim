# TODO List
Last updated 25 July 2026

1. Status Idicator references "Local Server".   What is this?  Clarify
2. Frequent JWT Expired notifications on localhost.  Investgate.
3. No AppIcon.   Make one from Sandbach High image in public folder.
4. Front end display of system errors (some currently only to console.log)
5. IP Address hard coded in app.js (in userDataScript).   Is this correct?
6. Unzip, Zip and curl are installed on Droplet startup.  Pre install these on the snapshot and remove from the UserDataScript
7. AWS CLI V2 installed on droplet at startup.   Pre-install on snapshot and remove call from UserDataScript.
8. Racespeed should be able to be set by the user before the CFD simulation starts.  Default to 30 mph.
9. Racespeed should be shown in mph (and m/s) in the user interface.
10. Check for redundant packages in package.json & package-lock.json
11. Duplication in README.md and AGENTS.md.   Can one of these be removed? (Perhaps AGENTS.md is used by the google jude? coding agent)
12. AGENTS.md references mock functionality.  Remove.
13. What is the file "Archive.zip" and what does it do?
14. ARCHiTECTURE.md seems out of date.   Update and referece it from README.md
15. ARCHITECTURE.md contains Antigravity Coding Agent Guidelines.   Move to a different file if possible
16. Go Through index.html and update text to be more audience friendly (Age 11-17 High School Pupils)
17. Review and revise step flow visuals and state memory process. (i.e. what happens if user logs out and in, what happens if browser reloaded?)
18. Authentication modal overlay should use sandbach_high_dark logo in place of "Shield"
19. Are forces chart and power chart understandable by high school pupils?
20. Change of app to multi-lambda app (see MULTI_LAMBDA.md in Specifications folder)
