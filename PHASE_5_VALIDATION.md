# Phase 5B — Independent Validation of Root-Cause Proof

**Execution Date:** 2026-09-19  
**Application Version:** `v296`  
**Auditor:** Independent Forensic Validation Agent  
**Mandate:** Adversarial audit of Phase 5 claims, evidence, and classifications across Bugs A, B, C, and D. Strict zero-fix policy.

---

## 1. Validation Standard & Rules

Under the strict forensic validation standard, a root cause is classified as:
- **PROVEN:** Trigger condition observed at runtime, relevant source path verified, runtime behavior matches source, failure directly produced by that path, no stronger contradictory explanation, and conclusion does NOT depend on unobserved hypothetical events.
- **STRONGLY SUPPORTED:** Source path verified and key mechanisms demonstrated in runtime, but complete end-to-end sequence relies on unobserved boundary conditions or simulated data.
- **SUPPORTED:** Mechanism is architecturally sound and matches code, but runtime demonstration is partial.
- **PLAUSIBLE:** Hypothesis is logically consistent with code, but cannot be reproduced under current test conditions.
- **UNPROVEN:** Evidence is insufficient to verify causality.
- **DISPROVEN:** Empirical evidence or direct code inspection refutes the claim.
- **INCONCLUSIVE:** Evidence is conflicting or ambiguous.

---

## 2. Bug C Independent Validation

### 2.1 Causal Mechanism & Verification
Phase 5 claims Bug C is **PROVEN**.

Independent verification of the empirical trace and source code ([`drill-engine.js:1129-1186`](file:///d:/GITHUB/confidential/main-app/js/drill-engine.js#L1129-L1186)):
1. **Button Text Change:** Line 1133 sets `submitBtn.textContent = 'View Results'` immediately on final answer check.
2. **Lockout Engaged:** Line 1146 sets `_nextReady = false;`, and line 1152 arms `_nextGuardTimer = setTimeout(..., 350)`.
3. **Immediate Click Dropped:** In Case C1, user clicked at $\Delta t = 63\text{ms}$. Line 1184 evaluates `if (!_nextReady) return;`. The click handler executed and exited immediately.
4. **Execution Halted:** `nextQuestion()` did NOT run; `finish()` did NOT run.
5. **No Timers Active:** Because the test was not reflex auto-advance, zero timers were active in the event loop. The UI remained permanently frozen on the feedback card at 150ms and 1150ms.
6. **Control Succeeded:** In Case C2, clicking after guard expiration ($t > 350\text{ms}$) cleanly invoked `nextQuestion()` $\to$ `finish()`, rendering the Results card (`.session-complete`).
7. **UX Mismatch Confirmed:** DOM audit confirmed `disabled: false`, `ariaDisabled: null`, `className: "btn-primary"`, `pointerEvents: "auto"`, `cursor: "pointer"`. The button visually communicated interactivity while silently rejecting input.

### 2.2 Investigation of Alternative Theories (e.g. `finish()` Exception)
- **Phase 1 Hypothesis:** `finish()` contains heavy synchronous metric calculations (`_computeSessionImprovement`, `_computeSpeedScore`, personal best comparisons) before Results rendering; an unhandled exception could halt rendering.
- **Independent Verification:**
  - In Phase 3 and Phase 5 runtime traces, `finish:call` and `finish:rendering_results_card` both logged successfully without error.
  - Inspection of `drill-engine.js:1470-1700` reveals that `localStorage`, sound engine, sharing, and subcollection writes are wrapped in defensive `try/catch` blocks.
  - No exception occurred at runtime.
  - In Case C1, execution never even reached `finish()` because line 1184 aborted at the guard.
- **Verdict for Bug C:** **PROVEN (RUNTIME + SOURCE).**

---

## 3. Bug D Independent Validation (Claims A–G)

Phase 5 concluded that the complete sequence:
`Update App → pending Firestore write race → stale Firestore data → overwrite local progress`
was **PROVEN**.

An adversarial breakdown of Claims A through G reveals that while individual components are verified, the complete end-to-end remote race was **overstated** as "PROVEN" and must be calibrated to **STRONGLY SUPPORTED**.

### Claim-by-Claim Verification Matrix

| Claim | Description | Phase 5 Stance | Source Verification | Runtime Verification | Final Classification |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Claim A** | Firestore hydration can overwrite local `todayAttempted`. | PROVEN | [`firestore-sync.js:594`](file:///d:/GITHUB/confidential/main-app/js/firestore-sync.js#L594) runs `AppState.setProgress(data.stats)`. No max-reconciliation exists for quotas. | Exp B observed: local 5 $\to$ 0 immediately in AppState, localStorage, and UI badge. | **PROVEN** |
| **Claim B** | `applyUpdate()` does not wait for Firestore synchronization. | PROVEN | [`update-manager.js:184-232`](file:///d:/GITHUB/confidential/main-app/js/services/update-manager.js#L184-L232) deletes caches, posts `SKIP_WAITING`, and sets `location.href`. Zero calls to `flushUpdatesAsync()` or `_syncTimer`. | Confirmed in source. | **PROVEN (SOURCE)** |
| **Claim C** | A local progress update can still be pending when Update App is pressed. | PROVEN | [`firestore-sync.js:1082`](file:///d:/GITHUB/confidential/main-app/js/firestore-sync.js#L1082) blocks writes during drills (`_drillActive`). Line 1086 debounces writes by 2000ms (`SYNC_DEBOUNCE_MS`). | Verified in source. | **PROVEN (SOURCE)** |
| **Claim D** | The pending update is actually absent from Firestore after the reload. | PROVEN | `beforeunload` runs `_flushUpdates()`, but async network requests during reload are unreliable without `await` or `sendBeacon`. | **NOT OBSERVED AGAINST LIVE FIRESTORE BACKEND.** Phase 5 simulated remote 0 payload rather than capturing an aborted Firestore write on the wire. | **STRONGLY SUPPORTED (UNPROVEN AT RUNTIME)** |
| **Claim E** | Subsequent Firestore hydration returns the older value. | PROVEN | If Claim D occurs, `loadFromFirestore()` queries `users/{uid}` and receives the older document. | Follows logically from Claim D, but remote document was simulated in test. | **STRONGLY SUPPORTED** |
| **Claim F** | That older value overwrites the local value. | PROVEN | [`firestore-sync.js:594`](file:///d:/GITHUB/confidential/main-app/js/firestore-sync.js#L594): `AppState.setProgress(data.stats)`. Furthermore, `_replayPendingBuffer()` (line 629) runs *after* line 594 and never restores `AppState`. | Exp B observed: 5 $\to$ 0. | **PROVEN** |
| **Claim G** | This complete sequence actually produces the user's Update App daily-limit reset. | PROVEN | Complete sequence connects all verified components. | Full live-backend reproduction with active network write abort was not executed. | **STRONGLY SUPPORTED** |

### 3.1 Critical Discovery on `_persistPendingBuffer` & `_replayPendingBuffer`
Independent inspection revealed a previously unanalyzed nuance in [`firestore-sync.js:217-250`](file:///d:/GITHUB/confidential/main-app/js/firestore-sync.js#L217-L250):
- When `session-manager.js:294` fires on `beforeunload`, it calls `flushUpdatesAsync()`, which calls `_persistPendingBuffer()`.
- On cold boot, `loadFromFirestore()` hydrates remote data at line 594 (`AppState.setProgress(data.stats)`).
- At line 629, `_replayPendingBuffer(currentUserId)` runs.
- **However:** `_replayPendingBuffer` only merges fields back into `_pendingUpdates` to push to the server; **it NEVER updates `AppState` or `localStorage['qr_progress']`!**
- Furthermore, if `base > 0 && loadedUpdatedAt > base`, `_replayPendingBuffer` **clears and discards the buffer entirely!**
- Therefore, even if the pending buffer survived, local state in `AppState` is still wiped to 0 by line 594.

### 3.2 Alternative Hypotheses Evaluated
1. **Could Firestore already contain 0 before Update App?**
   - YES. If the user answered questions on another device or in guest mode, or if local progress had accumulated while Firestore was unreachable/unauthenticated, Firestore legitimately holds 0. Pressing Update App and re-hydrating will clobber local progress regardless of whether a write was pending.
   - This proves that **Fixation on the reload race alone is insufficient**: the root vulnerability is the **asymmetric reconciliation policy** in `loadFromFirestore:594`.
2. **Could `AppState.clearAll()` be the cause?**
   - Phase 4B already proved that line 525 (`if (!docRef) return;`) prevents `_clearUserLocalStorage()` from executing during null-UID auth transitions. Phase 5 telemetry verified 0 invocations of `clearAll()`.

---

## 4. Bug A & Bug B Independent Validation

### 4.1 Bug A ("Back to Modes")
- **Phase 5 Classification:** `PLAUSIBLE BUT UNPROVEN AS PRIMARY HISTORICAL CAUSE`.
- **Validation Verdict:** **VALIDATED.**
  - In `v296`, commit `6b94302` added `container.innerHTML = ''` to `_disposeActiveDrillSession()`. Clean single-click, double-click, and rapid repeated clicks all succeeded in clearing `#drillContainer`.
  - Under `history.back()` stress, an actual Router/hash desynchronization was captured (URL hash became `#learn`, but `Router.getCurrentView()` remained `practice`). This proves the Router has state-transition vulnerabilities, but does not prove it caused the specific historical preview-retention report.
  - Classification remains **PLAUSIBLE BUT UNPROVEN**.

### 4.2 Bug B ("End Session")
- **Phase 5 Classification:** `PLAUSIBLE BUT UNPROVEN`.
- **Validation Verdict:** **VALIDATED.**
  - `performExit()` teardown is synchronous. Over 1500ms of post-exit monitoring, exactly 0 events or callbacks were emitted by the old engine.
  - The current implementation in `v296` completely isolates the disposed engine.
  - Classification remains **PLAUSIBLE BUT UNPROVEN**.

---

## 5. Audit of Language in Phase 5 Report

A search for absolute and causal assertions in `PHASE_5_ROOT_CAUSE_PROOF.md` identified several statements requiring calibration:

1. **Line 125:** *"Asynchronous network writes initiated during beforeunload are aborted when the page unloads."*
   - **Correction:** While uncompleted asynchronous HTTP requests are dropped by browsers during page navigation, this specific network termination was not measured on the wire. This is an **architectural deduction**, not an observed network packet trace.
2. **Line 127:** *"Because the pending write was aborted before reaching Firestore, the remote document still contains stats.todayAttempted = 0."*
   - **Correction:** It is equally possible that the write was never sent because the 2000ms debounce timer had not elapsed prior to reload. The claim should state: *"Because pending writes are either un-flushed in the debounce buffer or interrupted during navigation..."*
3. **Line 131 & 172:** *"Classification: PROVEN (RUNTIME OVERWRITE + VERIFIED SOURCE RACE)."*
   - **Correction:** The overwrite mechanism is **PROVEN**. The uncoordinated reload is **PROVEN IN SOURCE**. However, the full end-to-end race against a live Firestore backend was simulated and is therefore **STRONGLY SUPPORTED**, not PROVEN.

---

## 6. Comprehensive Validation Table

| Issue | Claim / Mechanism | Phase 5 Classification | Evidence Type | Independent Audit Finding | Final Validated Classification |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Bug C** | 350ms unqueued guard drops "View Results" click | PROVEN | Runtime Telemetry + Source Code | Deterministic reproduction at 63ms (`blocked: true`), freeze past 1150ms, control passes post-guard, DOM mismatch verified. | **PROVEN** |
| **Bug D** | Claim A: Firestore hydration overwrites local `todayAttempted` | PROVEN | Runtime Telemetry + Source Code | Exp B observed local 5 overwritten to 0 via line 594. UI badge reflects reset. | **PROVEN** |
| **Bug D** | Claim B: `applyUpdate()` does not await sync flush | PROVEN | Source Code Inspection | `applyUpdate()` has zero calls to `flushUpdatesAsync()` or FirestoreSync. | **PROVEN (SOURCE)** |
| **Bug D** | Claim C: Local progress remains pending during drill / 2s debounce | PROVEN | Source Code Inspection | `_drillActive` blocks writes; `SYNC_DEBOUNCE_MS = 2000` delays queue. | **PROVEN (SOURCE)** |
| **Bug D** | Claim D: Write is absent from Firestore after reload | PROVEN | Architectural Inference | Not measured on the wire against live backend. | **STRONGLY SUPPORTED** |
| **Bug D** | Claim E: Post-reload hydration returns older value | PROVEN | Architectural Inference | Consequence of Claim D; simulated in runtime test. | **STRONGLY SUPPORTED** |
| **Bug D** | Claim F: Older value overwrites local value on reload | PROVEN | Runtime Telemetry + Source Code | Confirmed in Exp B; `_replayPendingBuffer` does not restore AppState. | **PROVEN** |
| **Bug D** | Claim G: Complete sequence produces user-visible reset | PROVEN | Combined Deduction | Overwrite proven; full race strongly supported but not captured against live backend. | **STRONGLY SUPPORTED** |
| **Bug A** | Preview screen stuck over modes | PLAUSIBLE (UNPROVEN) | Stress Testing + Git Audit | Not reproduced under single/double click; popstate desync observed. | **PLAUSIBLE (UNPROVEN)** |
| **Bug B** | Old engine persists/writes after End Session | PLAUSIBLE (UNPROVEN) | Stress Testing + Telemetry | Teardown is synchronous; 0 stale callbacks observed over 1500ms. | **PLAUSIBLE (UNPROVEN)** |

---

## 7. Root-Cause Status Summary

- **Bug C:** **PROVEN.** (350ms unqueued debounce guard silently discards final transition; UI freezes indefinitely; button presents misleading active state).
- **Bug D:** **STRONGLY SUPPORTED.** (Local overwrite via `AppState.setProgress` in `firestore-sync.js:594` is **PROVEN**; pending write race in `applyUpdate()` is **PROVEN IN SOURCE**; full end-to-end race against live backend is **STRONGLY SUPPORTED**).
- **Bug A:** **PLAUSIBLE BUT UNPROVEN AS PRIMARY HISTORICAL CAUSE.** (Suppressed by `v296` `innerHTML = ''`; router popstate desynchronization captured under stress).
- **Bug B:** **PLAUSIBLE BUT UNPROVEN.** (Synchronous teardown in `v296` isolates disposed engine with 0 leaks).

---

## 8. Exact Fix Boundaries for Phase 6

Phase 6 is authorized to implement ONLY the fixes justified by proven/strongly supported causal evidence.

### 8.1 Bug C Fix Boundary
- **Target File:** [`main-app/js/drill-engine.js`](file:///d:/GITHUB/confidential/main-app/js/drill-engine.js)
- **Target Functions:** `checkAnswer()` (lines 1129-1186), `submitBtn.onclick`, and `finish()` (lines 1470-1700).
- **Authorized Changes:**
  1. On the final question (`current + 1 >= count`), do NOT engage the 350ms `_nextReady = false` lockout, OR queue any click arriving while `_nextReady === false` to automatically invoke `finish()` upon timer expiry.
  2. If any guard lockout is active, visually synchronize the button (`disabled = true`, appropriate cursor) so the user is never misled.
- **Forbidden Changes:**
  - Do NOT remove the 350ms guard on non-final questions (`current + 1 < count`), as it protects against carry-over numpad taps.
  - Do NOT alter scoring, speed calculations, or session reporting logic in `finish()`.
- **Invariants to Preserve:**
  - Idempotency of `finish()` (`_isFinished` flag).
  - Proper timer cleanup in `cleanup()`.

### 8.2 Bug D Fix Boundary
Two complementary fixes are authorized:

#### Fix 1: Same-Day Quota Reconciliation (Primary Root-Cause Fix)
- **Target File:** [`main-app/js/firestore-sync.js`](file:///d:/GITHUB/confidential/main-app/js/firestore-sync.js)
- **Target Function:** `loadFromFirestore()` (around lines 573-597).
- **Authorized Changes:**
  - Before invoking `AppState.setProgress(data.stats)`, inspect local progress via `AppState.getProgress()`.
  - If both local and remote timestamps represent today's date (`new Date().toDateString()`):
    `data.stats.todayAttempted = Math.max(localProgress.todayAttempted || 0, data.stats.todayAttempted || 0);`
    `data.stats.todayCorrect = Math.max(localProgress.todayCorrect || 0, data.stats.todayCorrect || 0);`
  - Never allow an incoming remote document with `todayAttempted = 0` to clobber a valid positive local count on the same calendar day.
- **Forbidden Changes:**
  - Do NOT bypass day-rollover resets when the date genuinely changes to tomorrow.
  - Do NOT alter mistake archive merging via `QRMistakeArchive.mergeMistakes`.

#### Fix 2: Flush Synchronization in Update Manager (Secondary Guard)
- **Target File:** [`main-app/js/services/update-manager.js`](file:///d:/GITHUB/confidential/main-app/js/services/update-manager.js)
- **Target Function:** `applyUpdate()` (lines 184-232).
- **Authorized Changes:**
  - Before deleting caches and initiating reload, check if `FirestoreSync.flushUpdatesAsync` is available and await its completion via a Promise before navigating.
- **Forbidden Changes:**
  - Do NOT weaken offline protection (`nav.onLine === false`).
  - Do NOT remove query parameter preservation (`QRPlatform.launchQuery()`).

### 8.3 Bugs A & B Boundaries
- **No architectural rewrites are authorized for Bugs A or B.**
- The historical symptoms are prevented by `v296` `container.innerHTML = ''`.
- Speculative modifications to Router, practice mode controllers, or session manager are **strictly forbidden**.

---

## 9. Verdict on Phase 6 Readiness
**Phase 6 is READY to begin.**
The causal mechanisms for Bug C and Bug D are clearly understood, rigorously bounded, and backed by verifiable code and runtime behavior.
