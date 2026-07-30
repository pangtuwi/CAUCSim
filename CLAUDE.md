# CLAUDE.md — CAUCSim

Project-specific instructions for Claude Code. See `AGENTS.md` for the wider
architecture, coordinate-system, and testing notes that apply to all agents, and
`Documentation/ARCHITECTURE-UPGRADE-SPEC.md` for the in-progress migration plan.

## Local development & browser testing

- **Test in Chrome on `http://localhost:3000`.** Use the Claude in Chrome tools
  (`mcp__claude-in-chrome__*`) — the user's real browser — not the in-app Browser
  pane. The app is gated behind AWS Cognito, and the logged-in session lives in
  Chrome.
- **The user authenticates.** When a check needs a signed-in session, ask them to
  sign in and wait. Never type credentials into the login form.
- Start the dev server from the `caucsim-dev` launch config in `.claude/launch.json`
  (`npm run dev`, port 3000). Don't start dev servers with Bash.
- Verify changes yourself in Chrome — page content, console messages, network
  requests — rather than asking the user to check the result manually.

## Layout

`frontend/cfd/` is the CFD UI; `backend/app/app.js` is the Express app and Lambda
handler. `serverless.yaml` stays at the repo root until CloudFront/S3 take over
serving the frontend (step 2 of the migration spec).
