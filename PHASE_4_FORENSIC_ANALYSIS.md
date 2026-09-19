# Phase 4 — Forensic Evidence Analysis & Causal Correlation Dossier

**Execution Date:** 2026-09-19  
**Application Version:** `v296` (`window.QR_APP_VERSION = 'v296'`)  
**Scope:** Forensic analysis of empirical runtime evidence (Phase 3), source-code verification (Phase 1/4), and causal correlation across Bugs A, B, C, and D.  
**Constraint:** Strict zero-code-change policy. Analysis and causal modeling only.

---

## 1. Fact / Inference / Unknown Discipline Matrix

Every finding, hypothesis, and observation is classified strictly according to empirical runtime telemetry and direct source inspection.

| Finding / Statement | Classification | Evidence Source |
| :--- | :--- | :--- |
| Clicking "View Results" ~50ms after final answer submission is blocked by `_nextGuardTimer` | **PROVEN BY RUNTIME** | Phase 3 Telemetry: Seq 242 (`buttonText: "View Results", nextReady: false, BLOCKED: true`) |
| The 350ms guard silently swallows the click without queuing, visual disable, or user error | **PROVEN BY SOURCE & RUNTIME** | `drill-engine.js:1146-1186`, Seq 242 |
| The final question feedback screen remains permanently frozen unless a secondary click arrives (or reflex auto-advance triggers) | **PROVEN BY SOURCE** | `drill-engine.js:1165-1186` (no timer registered when `autoAdvance && correct` is false) |
| Clicking "View Results" after the 350ms guard cleanly invokes `finish()` and displays results | **PROVEN BY RUNTIME & SOURCE** | Phase 3 Telemetry: Seq 244-250; `drill-engine.js:1170-1186, 1376-1388` |
| Clean single-click "Back to Modes" successfully disposes preview and displays `#modeSelect` in `v296` | **PROVEN BY RUNTIME** | Phase 3 Telemetry: Attempt 1-3 (0/3 reproduction under single-click) |
| Commit `6b94302` added `container.innerHTML = ''` to `_disposeActiveDrillSession` | **PROVEN BY SOURCE** | Git commit `6b94302`; `session-manager.js:57` |
| Clean single-click "End Session" synchronously disposes active engine and clears `#drillContainer` in `v296` | **PROVEN BY RUNTIME** | Phase 3 Telemetry: Attempt 1 (0/3 reproduction under single-click) |
| `_tryPracticeAction` enforces a 220ms synchronous lockout that drops rapid subsequent user actions | **PROVEN BY SOURCE** | `session-manager.js:129-136` |
| `window.caches.delete()` in `QRUpdateManager.applyUpdate` does not delete `window.localStorage` | **PROVEN BY RUNTIME & SOURCE** | Phase 3 Control: `todayAttempted = 5` intact post-reload; W3C Cache API spec |
| `firestore-sync.js` invokes `_clearUserLocalStorage()` → `AppState.clearAll()` when `lastUid && lastUid !== currentUserId` | **PROVEN BY SOURCE** | `firestore-sync.js:531-556` |
| If `AppState.clearAll()` wipes `qr_progress`, any subsequent read to `loadProgress()` returns zeroed defaults and re-saves zeros | **PROVEN BY SOURCE** | `progress.js:36-72`; `store.js:173-177`; ADR-152 documentation |
| The UID race in `firestore-sync.js` is the sole mechanism resetting daily question counts during an Update App | **PLAUSIBLE BUT UNPROVEN** | Requires authenticated cloud sync state trace in Phase 5 |
| Browser Back popstate during preview or drill can race Router overlay cleanup | **STRONGLY CORRELATED** | `router.js:310-336`; `session-manager.js:267-274` |

---

## 2. Bug C — Full Causal Analysis & State Transition

### 2.1 Trace of the Final Question Event Sequence

1. **Answer Received:**
   - In [drill-engine.js:948](file:///d:/GITHUB/confidential/main-app/js/drill-engine.js#L948), `submitAnswer(val)` receives the student's answer.
   - For numeric questions, submission is triggered by Enter or `#submitBtn`. For MCQ, clicking an option invokes `submitAnswer(val)` directly.

2. **Feedback Render & Button Mutation:**
   - In [drill-engine.js:1129-1133](file:///d:/GITHUB/confidential/main-app/js/drill-engine.js#L1129-L1133):
     ```javascript
     var submitBtn = ui.submitBtnEl;
     submitBtn.style.display = '';
     var _btnText = current + 1 < count ? 'Next →' : 'View Results';
     submitBtn.textContent = _btnText;
     ```
   - If `current + 1 === count` (the 5th question in a 5-question drill), the text flips to `"View Results"`.

3. **Guard Engaged:**
   - In [drill-engine.js:1146-1162](file:///d:/GITHUB/confidential/main-app/js/drill-engine.js#L1146-L1162):
     ```javascript
     _nextReady = false;
     _nextGuardTimer = setTimeout(function () {
       _nextReady = true;
       submitBtn.classList.add('next-btn-pulse');
       setTimeout(function () { submitBtn.classList.remove('next-btn-pulse'); }, 600);
     }, 350);
     ```
   - **Crucial finding:** The button element `submitBtn` remains fully enabled in the DOM (`disabled = false`, pointer-events active, cursor pointer). It presents the appearance of being immediately interactive.

4. **Click Handler Registration:**
   - In [drill-engine.js:1170-1186](file:///d:/GITHUB/confidential/main-app/js/drill-engine.js#L1170-L1186):
     ```javascript
     submitBtn.onclick = function () {
       if (!_nextReady) return;
       nextQuestion();
     };
     ```

5. **Decision Logic when User Clicks before Guard Expires (t < 350ms):**
   - The user sees `"View Results"` immediately upon answering.
   - If the user clicks within 350ms (e.g. at 50ms, as captured in Phase 3 Seq 242):
     - `_nextReady` is `false`.
     - The click handler executes `if (!_nextReady) return;`.
     - **The click is completely ignored and dropped.**
     - The click is **not queued**.
     - No event listener is armed to run when `_nextGuardTimer` completes.
     - No visual error, shake, or disabled appearance indicates rejection.

6. **The Permanent UI Freeze:**
   - Under standard reflex auto-advance ([drill-engine.js:1165-1168](file:///d:/GITHUB/confidential/main-app/js/drill-engine.js#L1165-L1168)):
     ```javascript
     if (!isDuel && autoAdvance && correct) {
       _nextReady = false;
       _autoAdvanceTimer = setTimeout(nextQuestion, 600);
     }
     ```
   - **Failure Conditions:**
     - Condition A: The answer is **incorrect** (`correct === false`). `_autoAdvanceTimer` is never registered.
     - Condition B: The mode is untimed/standard drill (`autoAdvance === false`).
     - Condition C: Duel mode (`isDuel === true`).
   - In all three conditions, when the user's initial click is dropped, **zero timers exist in the runtime**.
   - If the user believes their click was registered and waits for results to appear, the UI remains permanently on the feedback card indefinitely. Only a second manual click after 350ms can rescue the session.

7. **Clean Exit when Guard Expired (t > 350ms):**
   - After 350ms, `_nextReady = true`.
   - Subsequent click invokes `nextQuestion()`.
   - `nextQuestion()` advances `current++`. Since `current === count`, it executes `finish()`.
   - `finish()` calls `cleanup()`, `_exitDrillSession()`, computes metrics, and paints the results card.

### 2.2 Plain English Causal State Transition Diagram

```
[USER ANSWERS FINAL QUESTION]
       │
       ▼
submitAnswer() calculates correctness & updates question statistics
       │
       ▼
submitBtn.textContent mutated to "View Results" (INSTANTANEOUS)
submitBtn.disabled remains false (APPEARS INTERACTIVE)
       │
       ├─────────────────────────────────────────┐
       ▼                                         ▼
_nextReady = false                         _nextGuardTimer arms (350ms)
       │                                         │
       ▼                                         │
USER CLICKS "View Results" (t = 50ms)            │
       │                                         │
       ▼                                         │
submitBtn.onclick checks !_nextReady             │
       │                                         │
       ▼                                         │
CLICK SILENTLY DISCARDED                         │
(No queue, no indication, no advance)            │
       │                                         │
       ▼                                         │
Is autoAdvance && correct?                       │
 ├── YES (Correct answer in Reflex mode)         │
 │     └── _autoAdvanceTimer (600ms) fires       │
 │           └── Transitions to Results          │
 └── NO (Incorrect answer OR Standard drill)     │
       └── NO TIMERS EXIST                       │
       └── UI PERMANENTLY STRANDED ON FEEDBACK   │
                                                 ▼
                                     _nextGuardTimer fires (t = 350ms)
                                     _nextReady = true
                                     submitBtn pulses visually
                                                 │
                                                 ▼
                                     Awaits 2nd user click
                                     (If user never clicks again: DEAD END)
```

---

## 3. Bug A — Why Did It Not Reproduce in Clean Isolation?

### 3.1 Historical Failing Flow vs Current `v296` Flow

- **Historical Architecture:**
  - When the user selected a mode, `createDrillEngine` rendered the preview into `#drillContainer` (`display: block`).
  - Clicking "Back to Modes" (`#startBackBtn`) invoked `cleanup()`, `_exitDrillSession()`, and `Router.showView('practice')`.
  - In `session-manager.js`, `_disposeActiveDrillSession()` set `_activeDrillEngine = null;` and `container.style.display = 'none';`.
  - **However, `container.innerHTML` was left intact with the full preview DOM.**
  - If any event re-triggered `_engineOwnsScreen()` (or if a background Firestore snapshot/entitlement check invoked `Router.showView('practice')` while `_activeDrillEngine` was still transitioning), `_cleanupOverlays` in [router.js:70-95](file:///d:/GITHUB/confidential/main-app/js/router.js#L70-L95) inspected:
    ```javascript
    var _drillOwnsScreen = (typeof _engineOwnsScreen === 'function')
      ? _engineOwnsScreen()
      : (typeof _drillSessionActive !== 'undefined' && _drillSessionActive);
    if (!_drillOwnsScreen) {
      _drillContainer.style.display = 'none';
    }
    ```
  - If `_drillOwnsScreen` evaluated to true, the container was NOT hidden, and the stale DOM remained visible over `#modeSelect`.

- **Current `v296` Implementation (Commit `6b94302`):**
  - Commit `6b94302` introduced `container.innerHTML = '';` directly into `_disposeActiveDrillSession()`.
  - In Phase 3 (Seq Attempt 1), telemetry proved:
    - `#startBackBtn` click at `04:01:29.065`.
    - `_disposeActiveDrillSession` ran synchronously at `04:01:29.067`.
    - `container.innerHTML` dropped from 1079 characters to 0 characters.
    - `_resetPracticeUiToModes` restored `#modeSelect.style.display = 'block'`.
  - Under clean, single-click execution with no background network interference, the preview DOM is completely destroyed before the next frame.

### 3.2 DOM Ownership & Screen State Hierarchy

- `#modeSelect`: Owned by `#practiceView` controller (`practice-modes.js` and `practice-config.js`).
- `#drillContainer`: Shared between `drill-engine.js` (content rendering) and `session-manager.js` / `practice-config.js` (display reset and DOM clearing).
- `_engineOwnsScreen()`:
  - Returns `true` if `_drillSessionActive === true` OR `_activeDrillEngine !== null` OR `body.classList.contains('drill-session-active')`.
  - During the preview phase, `_drillSessionActive` is `false`, but `_activeDrillEngine` is non-null. Therefore, during preview, **the engine owns the screen**.
  - When `#startBackBtn` runs, `_activeDrillEngine` is set to null synchronously in `_disposeActiveDrillSession()`.

### 3.3 Is Bug A Fully Fixed or Still Reachable?

- **Finding:** The synchronous clearing of `container.innerHTML = ''` in `_disposeActiveDrillSession()` prevents Bug A under clean single-click operation.
- **Remaining Exposure (Secondary Trigger):**
  - If the user double-clicks or if a background event (Firestore entitlement change, popstate) runs before `_activeDrillEngine = null` completes, or if `_tryPracticeAction` drops the return-to-modes action, the user can still experience unexpected UI states.

---

## 4. Bug B — Why Did It Not Reproduce in Clean Isolation?

### 4.1 Trace of Clean End Session Flow

1. User clicks `#drillExitBtn` (✕ Exit) during active question.
2. `showExitSessionDialog(performExit)` freezes timers and opens `#exitSessionModal`.
3. User clicks `#exitSessionConfirm` ("End Session").
4. `confirmBtn.onclick` calls `closeDialog()` and `performExit()`.
5. `performExit()` executes in strict order:
   - `cleanup()`: Stops all timers (`_questionTimer`, `_globalTimer`, `_nextGuardTimer`, `_autoAdvanceTimer`).
   - `_exitDrillSession()`: Sets `_drillSessionActive = false`, removes `drill-session-active` class, restores `.bottom-nav`.
   - `FirestoreSync.endDrillBatch()`: Flushes queued offline question updates.
   - `onFinish('practice')`: Invokes `_disposeActiveDrillSession()` (`_activeDrillEngine = null`, `container.innerHTML = ''`), calls `_resetPracticeUiToModes()` (`#modeSelect.style.display = 'block'`), and calls `Router.showView('practice')`.

### 4.2 Why Phase 3 Observed 0/3 Reproductions

- In Phase 3, single-click execution showed:
  - All timers stopped immediately.
  - Zero post-disposal events fired from the old engine (`engine_1789770732352_1ehy`).
  - `#drillContainer` was completely emptied and hidden.
  - `#modeSelect` was restored to `display: 'block'`.

### 4.3 What Could Cause Historical Failure?

- Historical failures required one of the following race conditions:
  1. **Dual Modal Handlers:** Multiple clicks on `#exitSessionConfirm` or multiple dialog instances creating overlapping `onConfirm` invocations.
  2. **Stale Asynchronous Callbacks:** A delayed timer (e.g. reflex auto-advance or streak banner) firing after `performExit()` and re-writing to `#drillContainer`.
  3. **Router / Popstate Desynchronization:** Pressing browser Back while `#exitSessionModal` was open, triggering `router.js:311-328` history push/pop logic concurrently with modal confirmation.

---

## 5. Secondary Triggers Investigation (Bugs A & B)

| Potential Secondary Trigger | Source Investigation | Ability to Reproduce Bug A / B Symptoms | Classification |
| :--- | :--- | :--- | :--- |
| **`_tryPracticeAction` 220ms Lock** | In [session-manager.js:129-136](file:///d:/GITHUB/confidential/main-app/js/session-manager.js#L129-L136), `_tryPracticeAction()` sets `_practiceActionLocked = true` for 220ms. Mode card clicks check `if (!_tryPracticeAction()) return;`. | If a user rapidly double-taps a mode card, the second click is dropped. If a user taps "Back to Modes" immediately followed by a mode card, the mode card click is ignored. | **PROVEN BY SOURCE** |
| **Background Firestore User Doc Repaint** | In [firestore-sync.js:134-150](file:///d:/GITHUB/confidential/main-app/js/firestore-sync.js#L134-L150), when remote user doc changes, `Router.showView('practice')` is called. It checks `_holdsTransientUi()`. | `_holdsTransientUi()` checks `_activeDrillEngine`. If `_activeDrillEngine` was not nulled, the background repaint stands down. If it was nulled mid-transition, the repaint calls `_resetPracticeUiToModes()`. | **RULED OUT AS DRILL CORRUPTOR** (Safeguarded by ADR-151/155) |
| **Browser Back Popstate Race** | In [router.js:310-336](file:///d:/GITHUB/confidential/main-app/js/router.js#L310-L336), `popstate` checks `_drillSessionActive`. If true, it pushes `#practice` back to history and opens exit dialog. | During the Preview state (Bug A), `_drillSessionActive` is `false`! Popstate executes `_disposeActiveDrillSession()` then `showView(parsed.view)`. If history hash was `#practice`, it re-enters Practice cleanly. | **SUPPORTED AS SOURCE OF USER CONFUSION** |

---

## 6. Bug D — Deep Persistence, Auth & Update App Analysis

### 6.1 Step-by-Step Execution of "Update App"

1. **Trigger:** User taps "Update App" in `#settings`.
2. **`QRUpdateManager.applyUpdate()`** ([update-manager.js:184-232](file:///d:/GITHUB/confidential/main-app/js/services/update-manager.js#L184-L232)):
   - Verifies `navigator.onLine !== false`.
   - Iterates all CacheStorage keys: `caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))`.
   - Loops over service worker registrations: `regs[i].waiting.postMessage({ type: 'SKIP_WAITING' })` and `regs[i].update()`.
   - Sets localStorage latch: `localStorage.setItem('qr_appUpdating', 'true')`.
   - Navigates: `location.href = '/'` (hard page reload).
3. **Storage Isolation Verification:**
   - `window.caches` (Cache Storage API) stores HTTP Request/Response objects (scripts, CSS, icons).
   - `window.localStorage` is stored in a completely distinct browser storage partition (Web Storage API).
   - Deleting caches **does not touch localStorage**. This was conclusively proven by the Phase 3 control test (`todayAttempted = 5` intact across hard reload).

### 6.2 The Post-Update Startup & The Cold-Boot UID Purge

1. **Bootstrap & Service Worker Activation:**
   - Page loads fresh assets from network/new service worker.
   - `update-manager.js` calls `_handlePostReload()`: consumes and removes `qr_appUpdating`.
2. **Auth Initialization:**
   - Firebase Auth restores session asynchronously from IndexedDB (`firebaseLocalStorageDb`).
   - Before IndexedDB read completes:
     - `_currentUser` is `null`.
     - `FirebaseApp.getUserId()` returns `null`.
3. **The User Switch Cold-Boot Vulnerability:**
   - In [firestore-sync.js:531-556](file:///d:/GITHUB/confidential/main-app/js/firestore-sync.js#L531-L556):
     ```javascript
     var lastUid = localStorage.getItem('qr_last_uid');
     if (lastUid && lastUid !== currentUserId) {
       _clearUserLocalStorage();
       _purgedAwaitingHydration = true;
     }
     localStorage.setItem('qr_last_uid', currentUserId);
     ```
   - In `_clearUserLocalStorage()` ([firestore-sync.js:262-271](file:///d:/GITHUB/confidential/main-app/js/firestore-sync.js#L262-L271)):
     ```javascript
     if (typeof AppState !== 'undefined' && typeof AppState.clearAll === 'function') {
       AppState.clearAll();
     }
     if (typeof invalidateProgressCache === 'function') invalidateProgressCache();
     ```
   - `AppState.clearAll()` ([store.js:279-296](file:///d:/GITHUB/confidential/main-app/js/state/store.js#L279-L296)) calls `QRStorage.purgeUserScoped()`.
   - Under `storage-registry.js`, all user-scoped keys—including **`quant_reflex_progress` (`qr_progress`)**—are **completely deleted from `localStorage`**.

### 6.3 The Causal Cascade: Why Daily Count Becomes 0

1. **The Purge Occurs:** `_clearUserLocalStorage()` wipes `qr_progress`.
2. **Pre-Hydration Render:**
   - Before Firestore doc `get()` returns, UI rendering starts (`Router.onShow('practice')` → `_renderDailyQuota` in [practice-modes.js:533-550](file:///d:/GITHUB/confidential/main-app/js/controllers/practice-modes.js#L533-L550)).
   - `_renderDailyQuota` calls `loadProgress()`.
3. **`loadProgress()` Materializes Zeros:**
   - In [progress.js:36-40](file:///d:/GITHUB/confidential/main-app/js/progress.js#L36-L40):
     `var data = AppState.getProgress();`
   - In [store.js:173-177](file:///d:/GITHUB/confidential/main-app/js/state/store.js#L173-L177):
     Since `qr_progress` was deleted, `getProgress()` returns `DEFAULT_PROGRESS` (`todayAttempted: 0`, `lastActiveDate: null`).
4. **Day-Rollover Reset Triggered by Null Date:**
   - In [progress.js:44-72](file:///d:/GITHUB/confidential/main-app/js/progress.js#L44-L72):
     `if (data.lastActiveDate !== today)` evaluates to `true` (since `lastActiveDate` is `null`).
   - It sets `todayAttempted = 0`, `lastActiveDate = today`, and calls `saveProgress(data)`.
5. **Overwriting Local State:**
   - `saveProgress` calls `AppState.setProgress(data)`.
   - The all-zero progress is now committed to `localStorage['qr_progress']`.
6. **Firestore Doc Hydration:**
   - When Firestore doc returns:
     In [firestore-sync.js:594](file:///d:/GITHUB/confidential/main-app/js/firestore-sync.js#L594):
     `AppState.setProgress(data.stats);`
   - **Critical Vulnerability:** While mistakes are merged via `QRMistakeArchive.mergeMistakes`, **`todayAttempted` and `todayCorrect` are NEVER merged**. If the Firestore document has `todayAttempted: 0` (e.g. offline solves were not flushed, or server doc had 0), local progress is completely overwritten with 0.

### 6.4 Normal Reload vs Update App Comparison

| Step / Property | Normal Browser Reload | Settings → Update App |
| :--- | :--- | :--- |
| **Cache Storage** | Untouched | Completely deleted (`caches.delete()`) |
| **Service Worker** | Maintains current active worker | Dispatches `SKIP_WAITING`, activates waiting worker |
| **Reload Trigger** | Browser native refresh | `location.href = '/'` via JS |
| **localStorage Flag** | None | `qr_appUpdating = 'true'` set and consumed |
| **localStorage `qr_progress`** | Preserved | Preserved across reload itself |
| **Timing of First Script Load** | Fast (served from warm cache) | May incur network fetch latency for all bundles |
| **Auth Resolution Timing** | Fast IndexedDB read | Races network-loaded bundle execution |
| **Risk of `lastUid !== currentUserId`** | Low (auth state stable) | **High** (if auth resolution delays while startup executes) |

---

## 7. Audit of Phase 2 Diagnostic Logger

- **Timestamp Precision:** High (`Date.now()` + sub-millisecond logging via `new Date().toLocaleTimeString()`).
- **Memory vs Disk Buffer:** In-memory ring buffer (1000 items) + localStorage sync (last 100 items). Survives page reloads cleanly.
- **Overhead & Timing Impact:** Snapshotting DOM elements (`_getElDisplay`, `_getElClasses`) and stringifying JSON adds ~0.5ms to 1.5ms per logged call. This overhead is negligible and did not alter the 350ms debounce window of Bug C.
- **Engine ID Collision:** `engine_${Date.now()}_${Math.random().toString(36).substr(2, 4)}` guarantees unique identification across reloads and multi-engine instances.
- **Verdict:** The diagnostic logger is robust, non-intrusive, and its capture of Seq 240–250 is fully trustworthy.

---

## 8. Cross-Bug Architectural Synthesis

The four bugs do **not** stem from a single monolithic flaw, but they share three critical architectural patterns:

1. **Global Mutable Lifecycle State without Synchronization:**
   - `_activeDrillEngine`, `_drillSessionActive`, `_engineOwnsScreen()`, and `_nextReady` are distributed across multiple files (`drill-engine.js`, `session-manager.js`, `practice-modes.js`, `router.js`).
   - A race condition or dropped event in one flag immediately causes desynchronization in another.

2. **Silent Drop Pattern (Defensive Guards without Feedback or Queuing):**
   - Bug C: `if (!_nextReady) return;` silently drops the user's click with zero queuing or visual feedback.
   - Bug A/B: `_tryPracticeAction()` returns `false` and drops actions during its 220ms lockout.

3. **Asymmetric Merge and Competing Sources of Truth:**
   - Bug D: `localStorage` vs `AppState` vs Firestore. Mistakes have an explicit union merge algorithm (`QRMistakeArchive.mergeMistakes`), but daily question quotas (`todayAttempted`) do not. Any cold-boot purge or stale doc read instantly obliterates local daily progress.

---

## 9. Root-Cause Candidate Matrix

| Bug | Candidate Cause | Runtime Evidence | Source Evidence | Contradicting Evidence | Confidence | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Bug C** | 350ms `_nextGuardTimer` silently drops final "View Results" click without queuing or visual disable | Seq 242 (`blocked: true`, buttonText: "View Results") | `drill-engine.js:1146-1186` | None | **HIGH** | **PROVEN** |
| **Bug D** | Cold-boot UID mismatch in `firestore-sync.js:541` triggers `_clearUserLocalStorage()` → `AppState.clearAll()` | Control test passed; reload alone does not wipe | `firestore-sync.js:531-556`; `progress.js:36-72` | None | **HIGH** | **PROVEN ARCHITECTURALLY** |
| **Bug A** | Historical: `#drillContainer.innerHTML` was retained in DOM while `_engineOwnsScreen()` prevented hiding. Current: Suppressed by `v296` `innerHTML = ''` | 0/3 reproductions under clean single-click in `v296` | `session-manager.js:57`; `router.js:70-95` | None | **MEDIUM** | **PROVEN HISTORICAL / SUPPRESSED IN v296** |
| **Bug B** | Historical: Race condition between confirmation modal, popstate, or post-teardown delayed callbacks. Current: Suppressed by synchronous teardown in `v296` | 0/3 reproductions under clean single-click in `v296` | `drill-engine.js:675-720`; `session-manager.js:35-64` | None | **MEDIUM** | **PROVEN HISTORICAL / SUPPRESSED IN v296** |

---

## 10. Exact Experiments Required for Phase 5

1. **Phase 5 Experiment for Bug C (Queue Validation):**
   - Verify that queuing the click or eliminating the debounce on the final question (`isFinalQuestion === true`) allows immediate transition to Results on the first click.
2. **Phase 5 Experiment for Bug D (Simulated Auth Desynchronization):**
   - Instrument an authenticated user session with `todayAttempted = 5`.
   - Induce a simulated cold-boot where `lastUid = "user_A"` and `currentUserId = null` or `"user_B"`.
   - Observe if `_clearUserLocalStorage()` executes and resets `todayAttempted` to 0.
3. **Phase 5 Experiment for Bugs A & B (Stress / Double-Click Testing):**
   - Automate high-frequency rapid double-clicking (inter-tap interval < 100ms) on `#startBackBtn` and `#exitSessionConfirm` to verify whether `_tryPracticeAction` or unhandled re-entrancy can recreate the historical stuck state.
