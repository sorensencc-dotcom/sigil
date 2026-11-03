---
title: New routes added to the token server must also be added to the public cookie server
author: Chris
date: 2026-11-03
standing: true
id: l-4486debf
scope: repo
status: active
src: init-review
---

## Watch out
- Contacts worked on the bearer listener but the web Settings page got Not found, because the public cookie listener had no route.
- In the code: When adding `/v1/me/*` routes, update `matchPublicRoute` and `createPublicListener` (port 8797, cookie auth plus CSRF) as well as the bearer server (8791). Wire deps in `buildOAuthStack`.

_From PR #150 here, Oct 30._
