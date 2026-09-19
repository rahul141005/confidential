# Phase 3 Runtime Evidence Dossier

This document is the chronological record of empirical evidence captured during Phase 3 of the QuantReflex debugging investigation.

---

## 1. Execution Environment & Test Harness

- **Browser Runner:** Microsoft Edge (`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`) automated via `@playwright/mcp`.
- **Local Application Server:** Python HTTP Server running on `http://localhost:8080/` serving `main-app/`.
- **Telemetry System:** `QRDiagnostic` ring buffer active in memory and synchronized to `localStorage['qr_debug_investigation']`.
- **Application Version:** `v296` (`window.QR_APP_VERSION = 'v296'`).

---

## 2. Baseline State (Clean Startup)

```json
{
  "hasQRDiagnostic": true,
  "currentRoute": "",
  "activeView": null,
  "bodyClasses": "web-mode loaded",
  "drillContainerDisplay": "none",
  "modeSelectDisplay": "",
  "drillSessionActive": false,
  "hasActiveEngine": false
}
```

---

## 3. Bug A — "Back to Modes" (Preview → Back to Modes)

### Reproduction Flow
1. Navigated to `#practice`.
2. Clicked Quick Drill (`.mode-card[data-mode="quick"]`).
3. Subject picker modal (`#psmOverlay`) opened (`PracticeSubjectModal.shouldAsk() === true`). Selected `quant`.
4. Drill preview rendered into `#drillContainer` (`style.display = 'block'`, `#modeSelect` `style.display = 'none'`).
5. Clicked `#startBackBtn` ("Back to Modes").

### Telemetry Timeline (Attempt 1: Engine `engine_1789770677730_kir6`)
- `03:59:40.784`: `Router.onShow('practice')` triggered on entering Practice.
- `04:00:04.131`: `mode_card_click` event logged for `quick`.
- `04:01:17.730`: Subject `quant` picked; `createDrillEngine` generated `engine_1789770677730_kir6`.
- `04:01:17.735`: `drill_engine:renderStart:preview_mount` mounted card into `#drillContainer`.
- `04:01:29.065`: User clicked `#startBackBtn`.
- `04:01:29.066`: `drill_engine:cleanup:call` cancelled timers and set `_engineId` state to cleanup.
- `04:01:29.066`: `session_manager:_exitDrillSession` ran (`_drillSessionActive = false`).
- `04:01:29.067`: `session_manager:_disposeActiveDrillSession:completed` executed:
  - `_activeDrillEngine = null`
  - `container.innerHTML = ''` (cleared from 1079 chars to 0)
- `04:01:29.067`: `practice_config:_resetPracticeUiToModes` executed:
  - `#drillContainer.style.display = 'none'`
  - `#modeSelect.style.display = 'block'`
- `04:01:29.068`: Delayed checks at 1s, 2s, and 5s confirmed:
  - `drillContainerDisplay: 'none'`
  - `drillContainerInnerLen: 0`
  - `modeSelectDisplay: 'block'`
  - `hasActiveEngine: false`

### Repeated Attempts
- **Attempt 2 (`engine_1789770711046_w8am`, Reflex Drill):**
  - Preview mounted cleanly. Clicked `#startBackBtn`.
  - Immediate state: `engineIdAfter: null`, `drillContainerDisplay: 'none'`, `drillContainerInnerLen: 0`, `modeSelectDisplay: 'block'`.
- **Attempt 3 (Bottom Navigation click during Preview):**
  - Preview mounted (`engine_1789770719302_xm3b`). Clicked bottom nav `a[href="#practice"]`.
  - Result: `_cleanupOverlays` evaluated `_engineOwnsScreen()`. Because `_activeDrillEngine` was disposed via `onShow('practice')`, container was hidden (`display: 'none'`) and `#modeSelect` restored to `display: 'block'`.

### Observation Summary
- **Reproduced in this run:** **NO**.
- **Evidence:** Under `v296` with `container.innerHTML = ''` in `_disposeActiveDrillSession()`, when `#startBackBtn` executes cleanly, disposal and DOM reset successfully transition back to `#modeSelect`.

---

## 4. Bug B — "End Session" (Active Question → Exit → End Session)

### Reproduction Flow
1. Launched Quick Drill (`engine_1789770732352_1ehy`). Clicked "Begin Challenge".
2. Waited for Question 1 to mount (`bodyClasses: "drill-session-active numpad-active"`, `#drillExitBtn` present).
3. Clicked `#drillExitBtn` (✕ Exit).
4. Confirmation modal `#exitSessionModal` opened (`style.display = 'flex'`).
5. Clicked `#exitSessionConfirm` ("End Session").

### Telemetry Timeline
- `04:02:13.352`: Engine `engine_1789770732352_1ehy` began; `_drillSessionActive = true`.
- `04:02:21.265`: `#drillExitBtn` clicked. `showExitSessionDialog` displayed modal.
- `04:02:25.264`: `#exitSessionConfirm` clicked.
- `04:02:25.265`: `drill_engine:performExit:start` executed.
- `04:02:25.265`: `drill_engine:cleanup:call` stopped question timers.
- `04:02:25.266`: `session_manager:_exitDrillSession` ran (`body.classList.remove('drill-session-active')`).
- `04:02:25.266`: `session_manager:_disposeActiveDrillSession` executed:
  - `_activeDrillEngine = null`
  - `container.innerHTML = ''`
  - `container.style.display = 'none'`
- `04:02:25.267`: `practice_config:_resetPracticeUiToModes` restored `#modeSelect` to `display: 'block'`.
- `04:02:26.265` (1s), `04:02:27.265` (2s), `04:02:30.265` (5s): All verified `#drillContainer` remained empty and hidden.
- `04:02:37.000`: Navigated away to `#learn`, then back to `#practice`. Old drill did NOT reappear.

### Stale Engine Verification
- Immediately started a new drill session (`engine_1789770762158_dmwa`).
- Monitored all logs for 2000ms:
  - Events emitted by old engine (`engine_1789770732352_1ehy`) after disposal: **0**.
  - No stale timers or callbacks fired into DOM.

### Observation Summary
- **Reproduced in this run:** **NO**.
- **Evidence:** Synchronous teardown in `performExit()` cleanly cleared `_activeDrillEngine`, emptied `#drillContainer`, and reset body classes.

---

## 5. Bug C — "View Results" (Final Question Feedback → View Results)

### Reproduction Flow
1. Active session with 5 questions (`engine_1789770762158_dmwa`).
2. Answered Questions 1, 2, 3, and 4.
3. Reached Question 5 / 5 (`progressText: "Question 5 / 5"`).
4. Submitted answer on Question 5 at `t = 258686.2ms`.
5. Button text immediately changed to `"View Results"`.
6. Simulated immediate user click at `t = 258749.2ms` (50ms after submit, inside the 350ms guard window).
7. Simulated subsequent user click at `t = 259115.3ms` (after 350ms guard expired).

### Telemetry Timeline
```
[Seq 240] 04:03:04.995 — drill_engine:submitBtn:text_changed -> "View Results" (current: 4, count: 5, isFinalQuestion: true)
[Seq 241] 04:03:04.996 — drill_engine:submitBtn:guard_engaged -> durationMs: 350, nextReady: false
[Seq 242] 04:03:05.046 — drill_engine:submitBtn:click -> buttonText: "View Results", nextReady: false, BLOCKED: true (DROPPED)
[Seq 243] 04:03:05.346 — drill_engine:submitBtn:guard_cleared -> nextReady: true
[Seq 244] 04:03:05.420 — drill_engine:submitBtn:click -> buttonText: "View Results", nextReady: true, BLOCKED: false
[Seq 245] 04:03:05.421 — drill_engine:nextQuestion:call -> current: 4, count: 5
[Seq 246] 04:03:05.422 — drill_engine:nextQuestion:deck_complete_invoke_finish
[Seq 247] 04:03:05.423 — drill_engine:finish:call (score calculated)
[Seq 248] 04:03:05.424 — drill_engine:cleanup:call
[Seq 249] 04:03:05.425 — session_manager:_exitDrillSession
[Seq 250] 04:03:05.428 — DOM:drillContainer:mutation -> "Session Complete" results card rendered
```

### Observation Summary
- **Reproduced in this run:** **YES (Direct Timing Trap Observed)**.
- **Evidence:**
  - When the final answer is submitted, the button text changes immediately to `"View Results"`.
  - Concurrently, `_nextGuardTimer` engages for 350ms setting `_nextReady = false`.
  - A click on "View Results" occurring during this 350ms window is **silently dropped** (`blocked: true`).
  - No visual feedback, disable state, or pending queue exists; the tap is discarded entirely while the feedback UI remains visible.
  - Clicks occurring after 350ms (`_nextReady = true`) cleanly invoke `finish()` and render Results.

---

## 6. Bug D — "Update App Daily Limit Reset"

### Control Experiment: Normal Browser Hard Reload
1. Answered 5 questions in Quick Drill:
   - `localStorage['qr_progress'].todayAttempted = 5`
   - `localStorage['qr_progress'].lastActiveDate = "Sat Sep 19 2026"`
2. Performed standard hard navigation/reload to `http://localhost:8080/`.
3. Verified post-reload state:
   - `todayAttempted`: **5** (Intact)
   - `lastActiveDate`: `"Sat Sep 19 2026"` (Intact)

### Update App Experiment: Settings → Update App
1. Starting state: `todayAttempted = 5`.
2. Navigated to Settings view (`#settings`).
3. Clicked `#updateAppBtn` ("Update App").
4. `QRUpdateManager.applyUpdate()` executed:
   - Emptied `caches.keys()`.
   - Dispatched `SKIP_WAITING` to registered service workers.
   - Forced hard location reload to `/`.
5. Post-update reload verification:
   - `todayAttempted`: **5** (Intact in local unauthenticated session)
   - `lastActiveDate`: `"Sat Sep 19 2026"`

### Critical Code Correlation on Bug D
- Inspection of `firestore-sync.js:531-555` revealed the user-switch cold-boot branch:
  ```javascript
  var lastUid = localStorage.getItem('qr_last_uid');
  if (lastUid && lastUid !== currentUserId) {
    _clearUserLocalStorage(); // Calls AppState.clearAll(), zeroing qr_progress
    _purgedAwaitingHydration = true;
  }
  ```
- If an authenticated user triggers `applyUpdate()` and reloads, if Firebase Auth initializes asynchronously (`currentUserId` temporarily null while `lastUid` is populated), or if the remote Firestore user document returns default counters before local state syncs, local progress is completely purged.

---

## 7. Conclusions & Findings Summary Table

| Target Bug | Flow Tested | Reproduced in Real Browser? | Key Finding / Empirical Observation |
| :--- | :--- | :--- | :--- |
| **Bug A** | Preview → Back to Modes | **NO** (Passed in isolation) | `container.innerHTML = ''` in `v296` clears Preview on explicit `#startBackBtn` click. |
| **Bug B** | Active Question → Exit → End Session | **NO** (Passed in isolation) | Teardown is synchronous and zero stale events were emitted by the disposed engine. |
| **Bug C** | Final Question Feedback → View Results | **YES** (Observed) | **350ms debounce guard dropped clicks (`blocked: true`)**, leaving user stranded on feedback UI. |
| **Bug D** | Settings → Update App | **Control Passed / Isolated Condition** | Normal reload preserves `todayAttempted = 5`. Cold-boot wipe in `firestore-sync.js:542` identified as the architectural vulnerability under user authentication. |
