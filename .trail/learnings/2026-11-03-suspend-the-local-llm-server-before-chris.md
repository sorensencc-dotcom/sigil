---
title: "Suspend the local LLM server before pushing, or test workers time out"
author: Chris
date: 2026-11-03
standing: true
id: l-b7dc95e8
scope: repo
status: active
src: init-sessions
---

## Watch out
- The local model server used 100% CPU and 2.4 GB, so vitest workers hit 'Timeout waiting for worker to respond' and the hook failed even though all tests passed. Suspending it let the push succeed.
- In the code: Before `git push` in sigil-repo, suspend `llama-server` with `NtSuspendProcess` (ntdll.dll), then resume with `NtResumeProcess`. The PID changes between restarts. Also check free RAM is at least 2 GB, since the hook enforces it.

_From past Claude sessions here, Oct 29._
