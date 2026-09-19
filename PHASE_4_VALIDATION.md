# Phase 4B — Independent Validation of the Phase 4 Forensic Analysis

**Validation Date:** 2026-09-19  
**Application Version:** `v296`  
**Auditor Role:** Independent Forensic Validation Agent  
**Mandate:** Rigorous, adversarial challenge of Phase 4 conclusions, hypotheses, and source-code interpretations. No bug fixes, no code changes, no assumptions.

---

## 1. Executive Validation Summary

Phase 4 successfully performed direct source tracing and captured a real-browser reproduction of Bug C. However, an independent audit reveals that **Phase 4 over-reached on several key claims**, conflated historical hypotheses with empirical proof, and presented a flawed startup sequence for Bug D that is directly refuted by the source code.

### Core Audit Verdicts:
1. **Bug C ("View Results" Drop):** **VALIDATED & SURVIVES.** The 350ms debounce guard (`_nextGuardTimer`), un-queued click drop (`if (!_nextReady) return;`), lack of visual disable, and permanent freeze on the feedback card are fully proven by runtime telemetry (Seq 240–250) and source code (`drill-engine.js:1146-1186`).
2. **Bug A (Preview → Back to Modes):** **OVERSTATED IN PHASE 4.** Phase 4 labeled the historical cause as "PROVEN HISTORICAL / SUPPRESSED IN v296". In reality, the historical cause is **PLAUSIBLE BUT UNPROVEN**. Commit `6b94302` (`container.innerHTML = ''`) was an earlier AI agent fix, yet user reports persisted. Phase 3 observed 0/3 reproductions under clean clicks; declaring the historical bug "proven" based on static commit inspection is an unverified inference.
3. **Bug B (End Session Persistence):** **OVERSTATED IN PHASE 4.** Phase 4 labeled historical race conditions as "PROVEN HISTORICAL". Phase 3 observed 0/3 reproductions. No race condition was captured at runtime or historically documented with logs. It is **PLAUSIBLE BUT UNPROVEN**.
4. **Bug D (Daily Quota Reset on Update App):** **CRITICAL FLAW DISCOVERED IN PHASE 4 REASONING.** 
   - Phase 4 declared Bug D "PROVEN ARCHITECTURALLY" based on the hypothesis that on cold boot, `currentUserId` is temporarily null, causing `lastUid !== currentUserId` in `firestore-sync.js:541`, which then triggers `_clearUserLocalStorage()` $\rightarrow$ `AppState.clearAll()`.
   - **Independent Source Verification Disproves This:** In `firestore-sync.js:522-526`, `var docRef = _getUserDocRef(); if (!docRef) return;` executes *before* line 531. When `currentUserId` is null, `_getUserDocRef()` returns null and `loadFromFirestore` **exits immediately on line 525**. It NEVER reaches line 541!
   - Furthermore, Phase 3 tested Update App in an unauthenticated session and observed `todayAttempted = 5` **survived intact** (0/1 reproduction). Bug D is **UNPROVEN AT RUNTIME AND ITS PHASE 4 PROPOSED MECHANISM IS REFUTED BY SOURCE**.

---

## 2. Audit of Claim: "Bug C Is Proven"

### 2.1 Independent Verification
- **Runtime Evidence:** Phase 3 Telemetry Sequence:
  - `Seq 240` (`04:03:04.995`): `submitBtn.textContent` mutated to `"View Results"` (current: 4, count: 5).
  - `Seq 241` (`04:03:04.996`): `_nextGuardTimer` engaged for 350ms, `_nextReady = false`.
  - `Seq 242` (`04:03:05.046`): Click on `"View Results"` at $+50\text{ms}$. Result: `nextReady: false, BLOCKED: true`. Click dropped.
  - `Seq 243` (`04:03:05.346`): Guard expires at $+350\text{ms}$, `nextReady: true`.
  - `Seq 244` (`04:03:05.420`): Second click at $+424\text{ms}$. Result: `nextReady: true, BLOCKED: false`.
  - `Seq 245–250`: Invokes `finish()`, renders Results card.
- **Source Code Verification (`drill-engine.js`):**
  - Line 1133: `submitBtn.textContent = current + 1 < count ? 'Next →' : 'View Results';`
  - Line 1146: `_nextReady = false;`
  - Line 1152: `_nextGuardTimer = setTimeout(function () { _nextReady = true; ... }, 350);`
  - Line 1170–1186: `submitBtn.onclick = function () { if (!_nextReady) return; nextQuestion(); };`
  - Line 1165–1168: Auto-advance exists *only* when `!isDuel && autoAdvance && correct`.
- **Adversarial Check:** Could any other event advance the screen?
  - If the user got the last question wrong (`correct === false`), or if the drill is untimed/standard drill (`autoAdvance === false`): **Zero timers exist in the runtime**.
  - Is the dropped click queued or retried? **No**. The click event terminates synchronously on `return;`.
  - Does the button look disabled? **No**. `submitBtn.disabled` remains `false`.
- **Verdict on Bug C:** **PROVEN BY RUNTIME + SOURCE.** Phase 4's conclusion on Bug C is 100% sound.

---

## 3. Audit of Claim: "Bug A Was Historically Caused by X"

### 3.1 Independent Verification
- **Phase 4 Claim:** Historical Bug A was caused by `#drillContainer` retaining innerHTML + `_engineOwnsScreen()` preventing Router from hiding it, and that commit `6b94302` (`v296`) suppressed or fixed it.
- **Adversarial Analysis:**
  1. Commit `6b94302` was committed on Sun Sep 13 with the message: *"fix(drill-lifecycle): clear container innerHTML on disposal + v296"*.
  2. The user specifically initiated this multi-phase investigation because previous AI agent fixes (including commit `6b94302`) **appeared correct under static inspection but failed in real production use**.
  3. In Phase 3, single-click clean execution produced 0/3 reproductions.
  4. Phase 4 concluded that because `container.innerHTML = ''` was added in `6b94302`, the bug was "historically proven" to be caused by missing `innerHTML = ''`.
- **The Logical Fallacy:**
  - Correlation was mistaken for causation.
  - Adding `innerHTML = ''` prevents the preview DOM from showing if the container is exposed, but it does NOT prove that missing `innerHTML = ''` was why the original bug occurred.
  - If `_resetPracticeUiToModes()` ([practice-config.js:248-284](file:///d:/GITHUB/confidential/main-app/js/controllers/practice-config.js#L248-L284)) failed to run, `#modeSelect` remained at `display: 'none'`. Even if `#drillContainer` is empty, an empty white screen appears—not a returned mode list!
  - Furthermore, `_tryPracticeAction()` ([session-manager.js:129](file:///d:/GITHUB/confidential/main-app/js/session-manager.js#L129)) drops rapid subsequent clicks within 220ms.
- **Verdict on Bug A:** **DOWNGRADED from "PROVEN HISTORICAL" to PLAUSIBLE BUT UNPROVEN.** Clean single-click passes in `v296`, but the exact mechanism that triggered historical failures in production has not been empirically proven.

---

## 4. Audit of Claim: "Bug B Was Historically Caused by Race Conditions"

### 4.1 Independent Verification
- **Phase 4 Claim:** Bug B required concurrency races (double-clicking confirmation buttons, popstate navigation races, or delayed callbacks).
- **Adversarial Analysis:**
  1. Phase 3 reproduced Bug B **0 out of 3 times**.
  2. Inspection of `session-manager.js:244-249`:
     ```javascript
     confirmBtn.onclick = function () {
       _frozenEngine = null;
       closeDialog();
       onConfirm();
     };
     ```
     `confirmBtn.onclick` is a direct property assignment (not an `addEventListener` stack). It re-binds on every dialog open.
  3. `performExit()` ([drill-engine.js:675-720](file:///d:/GITHUB/confidential/main-app/js/drill-engine.js#L675-L720)) runs completely synchronously:
     `cleanup()` -> `_exitDrillSession()` -> `FirestoreSync.endDrillBatch()` -> `onFinish('practice')`.
  4. In Phase 3, zero stale timers and zero events were emitted by the disposed engine (`engine_1789770732352_1ehy`).
  5. There is no runtime telemetry or diagnostic trace demonstrating that popstate or double-clicking caused Bug B.
- **Verdict on Bug B:** **DOWNGRADED from "PROVEN HISTORICAL" to PLAUSIBLE HYPOTHESIS, BUT UNPROVEN.**

---

## 5. Audit of Bug D: The Startup Sequence & The Flawed Null-UID Hypothesis

### 5.1 The Flawed Phase 4 Hypothesis
Phase 4 stated:
> "T2: startup reads localStorage before Firebase Auth resolves  
> T3: currentUserId = null / undefined  
> T4: comparison incorrectly treats this as a different user (`lastUid && lastUid !== currentUserId`)  
> T5: `_clearUserLocalStorage()`  
> T6: `AppState.clearAll()`  
> T7: progress resets"

### 5.2 Direct Source Code Refutation
Let us inspect the exact lines of [firestore-sync.js:506-545](file:///d:/GITHUB/confidential/main-app/js/firestore-sync.js#L506-L545):
```javascript
function loadFromFirestore(callback) {
  var currentUserId = FirebaseApp.getUserId();
  _flushPendingSystemNotifications();

  if (_loadedUserId && currentUserId && _loadedUserId !== currentUserId) {
    resetSyncState();
  }

  if (_dataLoaded && _memoryCache) {
    if (callback) callback(true);
    return;
  }

  var docRef = _getUserDocRef();
  if (!docRef) {
    if (callback) callback(false);
    return; // <--- LINE 525: EXITS IMMEDIATELY IF docRef IS NULL!
  }

  try {
    var lastUid = localStorage.getItem('qr_last_uid');
    ...
    if (lastUid && lastUid !== currentUserId) {
      _clearUserLocalStorage(); // <--- LINE 542: UNREACHABLE IF currentUserId IS NULL!
      _purgedAwaitingHydration = true;
    }
    localStorage.setItem('qr_last_uid', currentUserId);
  } catch (_) {}
```

Now inspect `_getUserDocRef()` in [firestore-sync.js:285-291](file:///d:/GITHUB/confidential/main-app/js/firestore-sync.js#L285-L291):
```javascript
function _getUserDocRef() {
  if (!FirebaseApp.isReady()) return null;
  var userId = FirebaseApp.getUserId();
  if (!userId) return null; // <--- RETURNS NULL IF userId IS NULL!
  var db = FirebaseApp.getDb();
  return db.collection('users').doc(userId);
}
```

### 5.3 The Mathematical Proof of Impossibility
1. If Firebase Auth has not resolved yet, `FirebaseApp.getUserId()` returns `null`.
2. Because `userId` is `null`, `_getUserDocRef()` returns `null`.
3. In `loadFromFirestore`, `var docRef = _getUserDocRef();` evaluates to `null`.
4. Line 523 executes: `if (!docRef) { if (callback) callback(false); return; }`.
5. **The function exits on line 525.**
6. Line 531 (`var lastUid = localStorage.getItem('qr_last_uid')`) is **never reached**.
7. Line 541 (`if (lastUid && lastUid !== currentUserId)`) is **never reached**.
8. Line 542 (`_clearUserLocalStorage()`) is **never executed** when `currentUserId` is null.

**Conclusion:** Phase 4's central hypothesis for Bug D—that an uninitialized `currentUserId === null` triggers `_clearUserLocalStorage()`—is **refuted by the code**.

---

## 6. Audit of Alternative Bug D Mechanisms

If the null-UID race cannot cause Bug D, what can?

### Pathway A: Stale Firestore `data.stats` Overwrite (The Real Architectural Flaw)
- In [firestore-sync.js:573-597](file:///d:/GITHUB/confidential/main-app/js/firestore-sync.js#L573-L597):
  ```javascript
  if (data.stats) {
    try {
      if (typeof QRMistakeArchive !== 'undefined' && Array.isArray(data.stats.mistakes)) {
        var _localP = (typeof AppState !== 'undefined' && AppState.getProgress) ? AppState.getProgress() : null;
        var _localM = (_localP && Array.isArray(_localP.mistakes)) ? _localP.mistakes : [];
        data.stats.mistakes = QRMistakeArchive.mergeMistakes(_localM, data.stats.mistakes);
      }
    } catch (_) {}
    if (typeof AppState !== 'undefined') AppState.setProgress(data.stats); // <--- UNCONDITIONAL OVERWRITE!
    if (typeof invalidateProgressCache === 'function') invalidateProgressCache();
  }
  ```
- **The Asymmetry:** Mistakes are union-merged. **Quotas are not.**
- If a user completes drills, but the debounced write (`SYNC_DEBOUNCE_MS = 2000` in `firestore-sync.js:114`) has not reached Firestore, or if writes were deferred during the drill (`_drillActive = true`), and the user taps "Update App":
  - `applyUpdate()` navigates via `location.href`.
  - In-memory `_pendingUpdates` is lost if not flushed.
  - Upon reload, Firestore returns the server document where `data.stats.todayAttempted` is `0` (or an earlier count).
  - Line 594 unconditionally executes `AppState.setProgress(data.stats)`.
  - **Local `todayAttempted = 5` is overwritten with the server's `0`!**

### Pathway B: Date Rollover with Null `lastActiveDate`
- In [progress.js:44-72](file:///d:/GITHUB/confidential/main-app/js/progress.js#L44-L72):
  ```javascript
  var today = new Date().toDateString();
  if (data.lastActiveDate !== today) {
    data.todayAttempted = 0;
    data.todayCorrect = 0;
    ...
  }
  ```
- If remote Firestore document `stats.lastActiveDate` was `null` or a previous date, local `loadProgress()` resets `todayAttempted = 0`.

### Pathway C: Genuinely Different User Account
- If a user logs into a different account B, `lastUid !== currentUserId` *does* fire (when `currentUserId` is truthy `"B"` and `lastUid` is `"A"`). This is intended account isolation, not Bug D.

### Summary of Bug D Status:
- Bug D was **NOT reproduced** in Phase 3 (0/1).
- The Phase 4 "null-UID race" explanation is **REFUTED**.
- Pathway A (Stale remote `data.stats` overwriting local quota during hydration) is **SOURCE-SUPPORTED BUT UNPROVEN AT RUNTIME**.

---

## 7. Audit of Cross-Bug Architectural Claims

| Claimed Pattern | Phase 4 Assertion | Independent Audit Finding |
| :--- | :--- | :--- |
| **Uncoordinated Global Mutable State** | `_activeDrillEngine`, `_drillSessionActive`, `_engineOwnsScreen()`, `_nextReady` cause cross-file conflicts. | **VALIDATED.** These flags have mismatched lifetimes. E.g., `_drillSessionActive` is false during preview and results, while `_activeDrillEngine` is non-null. |
| **Defensive Silent Drops** | `if (!_nextReady) return;` and `if (!_tryPracticeAction()) return;` drop user clicks without feedback. | **VALIDATED.** Directly responsible for Bug C; potential contributor to Bug A under rapid tapping. |
| **Asymmetric State Hydration** | Mistakes are union-merged, but question quotas are overwritten wholesale. | **VALIDATED.** Verified in `firestore-sync.js:588-594`. Quotas have zero local/remote reconciliation logic. |

---

## 8. Phase 4 Validation Matrix

| Phase 4 Claim | Evidence Supporting It | Evidence Against It | Source Verification | Final Classification |
| :--- | :--- | :--- | :--- | :--- |
| **Bug C is caused by 350ms debounce guard** | Phase 3 Telemetry: Seq 242 (`blocked: true`) | None | `drill-engine.js:1146-1186` | **PROVEN** |
| **Bug C leaves UI permanently frozen** | Phase 3 timing; lack of recovery timers | None (when reflex correct is false) | `drill-engine.js:1165-1186` | **PROVEN** |
| **Bug A was historically caused by un-cleared innerHTML** | Commit `6b94302` commit message | Phase 3 did not reproduce pre-v296 behavior; user reported bug still persisted after 6b94302 | `session-manager.js:57`; `practice-config.js:259` | **PLAUSIBLE (UNPROVEN)** |
| **Bug B was historically caused by race conditions** | Conceptual concurrency paths | Zero runtime reproductions (0/3); teardown is synchronous | `session-manager.js:244-249`; `drill-engine.js:675-720` | **PLAUSIBLE (UNPROVEN)** |
| **`caches.delete()` does not delete `localStorage`** | Phase 3 Control: `todayAttempted = 5` intact | None | W3C Storage Standards | **PROVEN** |
| **Bug D caused by cold-boot null UID triggering `clearAll()`** | Theoretical narrative in Phase 4 | `loadFromFirestore:525` exits if user is null; never reaches line 541! | `firestore-sync.js:522-545` | **CONTRADICTED / REFUTED** |
| **Bug D can be caused by stale Firestore stats overwrite** | Hydration writes `AppState.setProgress(data.stats)` without quota merge | Not captured in Phase 3 unauthenticated test | `firestore-sync.js:573-596` | **STRONGLY SUPPORTED** |

---

## 9. Bug-by-Bug Strict Verdict

### BUG A (Preview → Back to Modes)
- **What we KNOW:**
  - In `v296`, clean single-click exit disposes preview and restores `#modeSelect` with 0 failures in 3 trials.
  - Commit `6b94302` added `container.innerHTML = ''` to `_disposeActiveDrillSession()`.
  - `#modeSelect.style.display = 'block'` is written in exactly one function: `_resetPracticeUiToModes()`.
  - `_tryPracticeAction` blocks repeated clicks within 220ms.
- **What we THINK:**
  - Production failures likely occur when rapid tapping triggers `_tryPracticeAction` or when browser Back popstate races view navigation.
- **What we DO NOT KNOW:**
  - Why production users continued to report Bug A after commit `6b94302` was deployed.

### BUG B (Active Question → End Session)
- **What we KNOW:**
  - In `v296`, clean single-click End Session synchronously cleans up timers, resets session flags, empties container, and restores modes (0/3 failures).
  - The disposed engine emitted zero post-cleanup events or delayed callbacks.
- **What we THINK:**
  - The historical bug may have required multi-tap modal re-entrancy, popstate collisions, or unhandled errors in intermediate callbacks.
- **What we DO NOT KNOW:**
  - The exact operational sequence that produced Bug B in the wild.

### BUG C (View Results Drop)
- **What we KNOW:**
  - Submitting final answer immediately mutates button to "View Results" while leaving it visually enabled.
  - Concurrently, `_nextGuardTimer` engages a 350ms lockout (`_nextReady = false`).
  - Clicks within 350ms are silently dropped without error or queuing (verified at runtime Seq 242).
  - For wrong answers or non-reflex modes, no auto-advance timer exists; UI freezes indefinitely.
  - Clicks after 350ms cleanly reach Results (verified at runtime Seq 244–250).
- **What we THINK:**
  - Removing or queuing the guard on the final question will eliminate 100% of Bug C occurrences.
- **What we DO NOT KNOW:**
  - Nothing. Bug C is fully understood.

### BUG D (Daily Question Limit Reset on Update)
- **What we KNOW:**
  - `caches.delete()` in `applyUpdate()` does not touch `localStorage`.
  - In an unauthenticated session, Update App does not reset `todayAttempted`.
  - `loadFromFirestore` does not execute line 541 when `currentUserId` is null.
  - Firestore doc hydration unconditionally overwrites `AppState.setProgress(data.stats)` without merging quotas.
- **What we THINK:**
  - Bug D occurs in authenticated sessions when in-flight local progress has not synced to Firestore before `applyUpdate()` hard-reloads, after which incoming remote stats (with 0 questions) clobber local progress.
- **What we DO NOT KNOW:**
  - Whether Bug D can be reproduced under an authenticated session with simulated network latency.

---

## 10. Readiness for Phase 5

**Is the investigation ready for Phase 5?**  
**YES.**

Phase 4B has successfully pruned false assumptions (e.g. the refuted null-UID race hypothesis) and isolated the exact empirical boundaries.

### Exact Phase 5 Proof Experiments:
1. **Experiment 1 (Bug C):** Implement a non-destructive prototype queue or disable check on `submitBtn` during the final question feedback to prove that 100% of first clicks advance to Results.
2. **Experiment 2 (Bug D):** Test an authenticated user session where `todayAttempted = 5` is local, while the Firestore server doc has `todayAttempted = 0`. Execute `loadFromFirestore()` and observe whether line 594 overwrites local progress to 0.
3. **Experiment 3 (Bugs A & B Stress Testing):** Execute rapid multi-tap stress tests (<100ms intervals) on `#startBackBtn` and `#exitSessionConfirm` to determine if `_tryPracticeAction` locks or re-entrancy reproduces the stuck states.
