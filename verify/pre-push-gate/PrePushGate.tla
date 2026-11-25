---- MODULE PrePushGate ----
\* Pre-push gate tiers + CI backstop. Models one branch from first edit to merge.
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
  HookInit,   \* "tiered" (path-scoped) or "generated" (docs-skip else full npm test)
  Tracked,    \* TRUE: hook committed, npm install cannot overwrite it
  MemGate,    \* "core_only": RAM gate only when core tests run. "always": any non-docs push
  LocalBug,   \* TRUE: classifier treats the push as web-only when ANY file is under web
  CIBug,      \* TRUE: CI path filter picks only web gates when ANY file is under web
  CIFilter,   \* TRUE: CI uses the real path filter (ci-changes.mjs); FALSE: every job runs
  MaxRebase

Areas == {"docs", "web", "core", "db"}
Gates == {"web", "core", "live"}

\* Gates a change area needs before merge (CI or local).
Req(a) == CASE a = "docs" -> {} [] a = "web" -> {"web"}
            [] a = "core" -> {"core"} [] a = "db" -> {"core", "live"}
\* Gates the local hook runs for an area. Live Postgres stays in CI.
LocalReq(a) == CASE a = "docs" -> {} [] a = "web" -> {"web"}
                 [] a = "core" -> {"core"} [] a = "db" -> {"core"}

\* Gates CI runs for an area under the path filter. Core and db changes run the whole
\* Linux/Windows/TLC set plus the web job, a superset of Req: the filter may over-run, never under-run.
FilterReq(a) == CASE a = "docs" -> {} [] a = "web" -> {"web"}
                  [] a = "core" -> {"core", "live", "web"} [] a = "db" -> {"core", "live", "web"}

UReq(S) == UNION {Req(a) : a \in S}
UFilter(S) == UNION {FilterReq(a) : a \in S}
ULocal(S) == UNION {LocalReq(a) : a \in S}

VARIABLES touched, phase, rangeKnown, local, ci, ciDone, ram, hook, bypass,
          rebases, ranCoreLocal
vars == <<touched, phase, rangeKnown, local, ci, ciDone, ram, hook, bypass,
          rebases, ranCoreLocal>>

\* Areas the classifier believes were touched.
Seen(t, bug) == IF bug /\ "web" \in t THEN {"web"} ELSE t

\* Tier the hook runs for a push of touched set t.
Tier ==
  IF hook = "generated"
    THEN (IF touched \subseteq {"docs"} THEN {} ELSE {"core"})
    ELSE IF ~rangeKnown THEN {"core"}           \* fail closed to full suite
    ELSE ULocal(Seen(touched, LocalBug))

\* RAM gate: blocks the push while RAM is low.
MemBlocks ==
  /\ ram = "low"
  /\ IF MemGate = "always" \/ hook = "generated"
       THEN ~(touched \subseteq {"docs"})
       ELSE "core" \in Tier

\* CI gates for the touched set. The filter is a UNION over every touched area, never a first match.
CIGates ==
  IF CIBug /\ "web" \in touched THEN {"web"}
  ELSE IF CIFilter THEN UFilter(touched)
  ELSE UReq(touched)                    \* no filter: every job runs, so every needed gate runs

Init ==
  /\ touched = {} /\ phase = "dev" /\ rangeKnown = TRUE
  /\ local = {} /\ ci = {} /\ ciDone = FALSE
  /\ ram = "ok" /\ hook = HookInit /\ bypass = FALSE
  /\ rebases = 0 /\ ranCoreLocal = FALSE

Edit(a) ==
  /\ phase = "dev" /\ a \notin touched
  /\ touched' = touched \cup {a}
  /\ local' = {} /\ ci' = {} /\ ciDone' = FALSE /\ ranCoreLocal' = FALSE
  /\ UNCHANGED <<phase, rangeKnown, ram, hook, bypass, rebases>>

\* Rebase invalidates every result and may leave origin/main stale (range unknown).
Rebase ==
  /\ phase \in {"dev", "pushed"} /\ touched # {} /\ rebases < MaxRebase
  /\ rebases' = rebases + 1
  /\ phase' = "dev" /\ local' = {} /\ ci' = {} /\ ciDone' = FALSE
  /\ ranCoreLocal' = FALSE
  /\ \E k \in BOOLEAN : rangeKnown' = k
  /\ UNCHANGED <<touched, ram, hook, bypass>>

\* npm install runs `prepare`, which rewrites an untracked hook.
Clobber ==
  /\ ~Tracked /\ hook = "tiered"
  /\ hook' = "generated"
  /\ UNCHANGED <<touched, phase, rangeKnown, local, ci, ciDone, ram, bypass,
                 rebases, ranCoreLocal>>

RamLow ==
  /\ ram = "ok" /\ ram' = "low"
  /\ UNCHANGED <<touched, phase, rangeKnown, local, ci, ciDone, hook, bypass,
                 rebases, ranCoreLocal>>
FreeRam ==
  /\ ram = "low" /\ ram' = "ok"
  /\ UNCHANGED <<touched, phase, rangeKnown, local, ci, ciDone, hook, bypass,
                 rebases, ranCoreLocal>>

\* git push with the hook active.
Push ==
  /\ phase = "dev" /\ touched # {}
  /\ IF MemBlocks
       THEN /\ phase' = "blocked"
            /\ UNCHANGED <<local, ranCoreLocal, bypass>>
       ELSE /\ phase' = "pushed" /\ local' = Tier
            /\ ranCoreLocal' = ("core" \in Tier) /\ UNCHANGED bypass
  /\ UNCHANGED <<touched, rangeKnown, ci, ciDone, ram, hook, rebases>>

\* A blocked push resumes once RAM is back.
Unblock ==
  /\ phase = "blocked" /\ ~MemBlocks
  /\ phase' = "pushed" /\ local' = Tier /\ ranCoreLocal' = ("core" \in Tier)
  /\ UNCHANGED <<touched, rangeKnown, ci, ciDone, ram, hook, bypass, rebases>>

\* --no-verify with user approval: local gates skipped, CI still decides.
BypassPush ==
  /\ phase \in {"dev", "blocked"} /\ touched # {}
  /\ phase' = "pushed" /\ bypass' = TRUE /\ local' = {} /\ ranCoreLocal' = FALSE
  /\ UNCHANGED <<touched, rangeKnown, ci, ciDone, ram, hook, rebases>>

CIRun ==
  /\ phase = "pushed" /\ ~ciDone
  /\ ci' = CIGates /\ ciDone' = TRUE
  /\ UNCHANGED <<touched, phase, rangeKnown, local, ram, hook, bypass, rebases,
                 ranCoreLocal>>

Merge ==
  /\ phase = "pushed" /\ ciDone
  /\ phase' = "merged"
  /\ UNCHANGED <<touched, rangeKnown, local, ci, ciDone, ram, hook, bypass,
                 rebases, ranCoreLocal>>

Done == phase = "merged" /\ UNCHANGED vars

Next == (\E a \in Areas : Edit(a)) \/ Rebase \/ Clobber \/ RamLow \/ FreeRam
        \/ Push \/ Unblock \/ BypassPush \/ CIRun \/ Merge \/ Done

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ touched \subseteq Areas /\ local \subseteq Gates /\ ci \subseteq Gates
  /\ phase \in {"dev", "blocked", "pushed", "merged"}

\* Safety: nothing merges unless every touched area's gates ran (locally or in CI).
NoUnverifiedMerge ==
  phase = "merged" => UReq(touched) \subseteq (local \cup ci)

\* Local tier covers what the hook promises, when it ran and the range was known.
LocalCoversLocalReq ==
  (phase \in {"pushed", "merged"} /\ ~bypass /\ rangeKnown /\ hook = "tiered")
    => ULocal(touched) \subseteq local

\* Cost: a docs/web-only push with a known range never runs the full core suite.
WebOnlyPushCheap ==
  (phase \in {"pushed", "merged"} /\ ~bypass /\ rangeKnown
   /\ touched \subseteq {"docs", "web"})
    => ~ranCoreLocal

\* CI cost: under the path filter a docs/web-only PR never runs the core or live-Postgres jobs.
CIWebOnlyCheap ==
  (ciDone /\ touched \subseteq {"docs", "web"}) => ci \cap {"core", "live"} = {}

\* RAM: a docs/web-only push is never held up by low RAM.
RamNeverBlocksWebOnly ==
  (phase = "blocked" /\ rangeKnown) => ~(touched \subseteq {"docs", "web"})

====
