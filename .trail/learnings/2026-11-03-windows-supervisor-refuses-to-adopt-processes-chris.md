---
title: Windows supervisor refuses to adopt processes started with the wrong auth mode
author: Chris
date: 2026-11-03
standing: true
id: l-7efb6ee7
scope: repo
status: active
src: init-review
---

## Decided
- A healer relaunched the web app without cookie auth mode and the supervisor adopted it, causing a token-mode incident.
- In the code: `start-sigil-stack.ps1` adopts relay only if 8791, 8792, 8796, 8797 all listen, and rooms-web only if `/config.json` reports `authMode: cookie`. Keep only one launcher.

_From PR #146 here, Oct 30._
