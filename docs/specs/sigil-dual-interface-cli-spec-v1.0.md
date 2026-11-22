# Sigil Dual-Interface CLI Specification (v1.0)
> Adopting Astryx CLI Patterns for Deterministic Agent Operation

**Status:** IMPLEMENTED  
**Date:** 2026-11-21  
**Category:** Interface Architecture & Agent Governance  
**Target:** `@sorensencc/sigil`  

---

## 1. Context & Motivation

Sigil is a multi-agent communications and task routing fabric connecting Claude, Codex, Grok, Antigravity, and Floor Warden daemons. Historically, the Sigil CLI was built primarily for human operators in an interactive shell, resulting in:
1. **Unstructured Output Scrapes:** Commands like `sigil doctor`, `sigil inbox`, and `sigil peer list` emitted human terminal text, forcing autonomous agents to use brittle regex parsers.
2. **Schema & Envelope Hallucination:** Agents constructing tasks or room messages had no programmatic CLI mechanism to inspect envelope schemas or validation rules, risking malformed envelope submissions.
3. **Entrypoint Drift:** `bin/sigil.mjs` documented a subset of commands (~12) while `sigil/cli/sigil.mjs` implemented more than 30 commands.
4. **Ambiguous Failure Signatures:** Non-zero exit codes were undifferentiated, making it difficult for automated agent loops to distinguish between permanent policy refusals and transient network timeouts.

Following Meta's open-source **Astryx CLI dual-interface architecture**, this specification formalizes the CLI as the single source of truth for both humans and autonomous coding agents.

---

## 2. Core Architectural Invariants

1. **Dual-Interface Parity (`--json`):** Any query, status, diagnostic, or ledger command must support a `--json` flag outputting deterministic, machine-readable JSON.
2. **Deterministic Contract Discovery (`sigil schema`):** Agents can inspect the authoritative JSON Schema of any protocol envelope (`task`, `task.result`, `room.message`, `contract`, or `all`) at runtime.
3. **Intent-Driven Scaffolding (`sigil template`):** The CLI provides boilerplate envelope scaffolds with fresh ISO timestamps, random nonces, and schema headers pre-filled.
4. **Strict 4-Tier Exit Code Contract:**
   - `0 (SUCCESS)`: Command executed and validated cleanly.
   - `1 (INVALID_INPUT / BAD_REQUEST)`: Malformed flags, invalid schema, or local syntax errors. Non-retryable without payload amendment.
   - `2 (PERMANENT_REFUSAL)`: Signature mismatch, revoked key, policy refusal (`report_refused`), or missing permissions. Fail-fast; non-retryable.
   - `3 (TRANSIENT / RETRYABLE)`: Relay timeout, lock acquisition timeout, or network blip. Eligible for exponential backoff retry.
5. **Programmatic Host Boundary (`runHostedCli`):** Tools and MCP bridges invoke Sigil via `@sorensencc/sigil/cli/host.mjs`, enforcing `windowsHide: true`, signal trapping, and automated JSON parsing without orphan process leaks.

---

## 3. Command Reference

### 3.1 Schema Inspection
```bash
# Query schema for a specific envelope
sigil schema task
sigil schema task.result
sigil schema room.message
sigil schema contract

# Query entire contract catalog
sigil schema all
```

### 3.2 Intent-Driven Envelope Scaffolding
```bash
# Generate scaffolded task envelope
sigil template task --to ep_codex --to-owner usr_codex --instruction "Run verification suite"

# Generate room message template
sigil template room.message --conversation room_ops

# Emit to disk directly
sigil template task --to ep_claude --out ./pending_task.json
```

### 3.3 Diagnostic & Ledger Inspection
```bash
# Machine-readable health diagnostics
sigil doctor --json

# Machine-readable local inbox ledger
sigil inbox --local --json

# Machine-readable peer list
sigil peer list --database-url <url> --json
```

---

## 4. Programmatic Host Interface

Exported from `sigil/cli/host.mjs`:

```javascript
import { runHostedCli } from '@sorensencc/sigil/cli/host.mjs';

const result = await runHostedCli({
  argv: ['schema', 'task'],
  cwd: process.cwd(),
  timeoutMs: 30000,
});

if (result.exitCode === 0 && result.data) {
  console.log('Task schema ID:', result.data.$id);
}
```

---

## 5. Formal TLA+ Statechart Verification

The state machine for the Astryx dual-interface model was formally modeled in TLA+ (`AstryxSigilCli.tla`) and verified using TLC model checking via the `/statechart` skill.

### Verification Summary
- **TLC State Space:** 83 distinct states, 112 transitions.
- **Model Invariants Checked:**
  - `NoUnstructuredCrash`: In `AgentJson` mode, CLI output is guaranteed parseable.
  - `AstryxEnforcesValidEnvelopes`: Schema discovery and template scaffolding eliminate bad-input rejections.
  - `ExitCodeContractHonored`: Permanent rejections (`exit 1` or `exit 2`) never enter retry loops.
  - `NoDeadlock`: Terminal states cleanly loop on `Done`.
- **Verdict:** 100% PASS (0 invariant violations, 0 deadlocks).

```mermaid
---
title: "Astryx Dual-Interface CLI Lifecycle in Sigil"
---
stateDiagram-v2
  state "Astryx Dual-Interface Mode" as s0 {
    s1: Idle
    s2: InspectingSchema
    s3: ScaffoldingTemplate
    s4: Drafted
    s5: InvokingCli
    s6: AwaitingReceipt
    s7: Failed
    s8: RetryBackoff
    s9: Completed
  }
  [*] --> s1
  s1 --> s2: agent queries sigil schema
  s2 --> s3: agent requests template scaffold
  s3 --> s4: agent populates task params
  s4 --> s5: execute via runHostedCli
  s5 --> s6: exit 0: success [JSON envelope]
  s5 --> s7: exit 2: policy refusal [permanent] or exit 3: retry budget exhausted
  s5 --> s8: exit 3: transient timeout [backoff retry]
  s6 --> s9: delivery receipt acknowledged
  s8 --> s5: execute via runHostedCli
```

---

## 6. Implementation Manifest

- [`bin/sigil.mjs`](file:///C:/dev/sigil-repo/bin/sigil.mjs): Dynamic help delegation and command routing.
- [`sigil/cli/sigil.mjs`](file:///C:/dev/sigil-repo/sigil/cli/sigil.mjs): Added `schema` and `template` command dispatch; `--json` output for `doctor`, `inbox`, and `peer list`.
- [`sigil/cli/schema-commands.mjs`](file:///C:/dev/sigil-repo/sigil/cli/schema-commands.mjs): Protocol schema definitions and template generator.
- [`sigil/cli/host.mjs`](file:///C:/dev/sigil-repo/sigil/cli/host.mjs): Host execution wrapper with Windows console suppression and JSON auto-parsing.
- [`sigil/cli/doctor.mjs`](file:///C:/dev/sigil-repo/sigil/cli/doctor.mjs): Resilient keypair checking.
- [`dual-interface-cli.test.mjs`](file:///C:/dev/sigil-repo/dual-interface-cli.test.mjs): 10/10 automated tests passing.
