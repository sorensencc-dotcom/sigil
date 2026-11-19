---
title: "The relay domain now comes from the service config, and the live relay still runs from a stale branch"
author: Chris
date: 2026-11-19
branch: fix/service-config-domain-rewritelabs
cost: { minutes: 10, tokens: 49685 }
id: l-0931f171
scope: repo
status: active
src: agent
touches:
  - docs/phase7-setup-runbook.md
  - docs/service-config.md
  - sigil/cli/service-config.test.mjs
  - sigil/cli/service-config.mjs
  - sigil/cli/phase7-setup-policy.mjs
  - sigil/cli/phase7-setup-runbook.test.mjs
---

## Decided
- Issue 219's domain choice (rewritelabs.io) belongs in the service config, not the Windows launcher. On main the launcher only forwards to `sigil service start`, so whatever `.sigil/service.json` says is what the relay runs. The documented example is now pinned to rewritelabs.io by a test.

## Tried and ruled out
- Checking relay health on port 8765: nothing listens there. The SigilStack relay is on 8791 (stream 8792). A refused 8765 does not mean the relay is down.
- Treating `.sigil/service.example.json` as the template: it is an untracked local file, not on main. The only tracked example is the JSON block in docs/service-config.md.

## Watch out
- As of 2026-11-19 the live relay was started by the old launcher in C:\dev\sigil-repo, on branch docs/trail-learning-issue-219 (remote deleted), which hardcodes `--domain rewritelabs.io`. No `.sigil/service.json` exists on that machine. Updating that checkout to main and restarting SigilStack fails or comes back as `local` until a real service.json with relay.domain = rewritelabs.io is created.
- Under any domain, messages addressed to bare endpoint IDs (ep_chief and the others) fail federation routing with MALFORMED_FEDERATED_ID. Inbox, stream and room traffic are not affected.

In the code:
- sigil/cli/service-config.mjs:189 passes relay.domain as `--domain`
- sigil/cli/phase7-setup-policy.mjs:57 endpoint domain must match relayDomain
- sigil/cli/service-config.test.mjs: docs example domain test
- health: http://127.0.0.1:8791/v1/health
