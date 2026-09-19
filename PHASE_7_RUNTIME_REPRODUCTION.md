# Phase 7 — Controlled Runtime Reproduction & Evidence Capture

**Execution Date:** 2026-09-19  
**Application Environment:** Real Browser Execution (Microsoft Edge via Playwright MCP)  
**Host URL:** `http://localhost:8080/`  
**Application Version:** `v296`  
**Status:** **COMPLETED**

---

## 1. Executive Summary of Reproduction Results

| Target Issue | Description | Status | Primary Observed Runtime Behavior |
| :--- | :--- | :--- | :--- |
| **Bug A** | Practice $\to$ Drill Preview $\to$ Back to Modes | **NOT REPRODUCED** | Clicking `#startBackBtn` synchronously hid `#drillContainer`, cleared `innerHTML` to 0, restored `#modeSelect` (`display: block`), and nullified `_activeDrillEngine`. 0 delayed mutations over 2000ms. |
| **Bug B** | Active Drill $\to$ Exit $\to$ End Session | **NOT REPRODUCED** | Exit confirmation modal closed, `#drillContainer` cleared and hidden, `#modeSelect` returned, `_drillSessionActive` set to `false`, `_activeDrillEngine` set to `false`. 0 delayed mutations over 2000ms. |
| **Bug C** | Final Question $\to$ View Results Click Lockout | **NOT REPRODUCED** | Clicks at $t = 28.8$ms immediately rendered Results card (`#drillResultsHeading`). 350ms lockout active on intermediate questions. 5 rapid clicks executed `finish()` exactly once. |
| **Bug D** | Update App $\to$ Daily Question Quota Reset | **NOT REPRODUCED** | Initiating Update App with `todayAttempted = 5` preserved counts across hard reload (`todayAttempted = 5`). Debounced writes and same-day cloud reconciliation preserved local counters. |

---

## 2. Bug A — Practice $\to$ Drill Preview $\to$ Back to Modes

### 2.1 Reproduction Steps
1. Navigate to `http://localhost:8080/#practice`.
2. Click Quick Drill mode card (`#modeSelect .mode-card[data-mode="quick"]`).
3. Select Quant subject in `PracticeSubjectModal` (`.psm-card[data-subject="quant"]`).
4. Reach the Drill Preview screen (`#drillContainer`, heading: "Quick Drill · Quantitative Aptitude", `#startBackBtn`, `#startBtn`).
5. Click "← Back to Modes" (`#startBackBtn`).
6. Observe immediate and delayed DOM / engine state over 2000ms.
7. Repeat with rapid double-click and 5 consecutive entry/exit cycles.

### 2.2 Expected vs Actual Behavior
- **Reported Bug Behavior:** The preview screen remains visible, or `#drillContainer` is not hidden, or `#modeSelect` fails to return to `display: block`.
- **Actual Observed Behavior:** Clicking `#startBackBtn` synchronously restores `#modeSelect`, hides `#drillContainer`, empties `#drillContainer.innerHTML`, nullifies `_activeDrillEngine`, and removes `drill-session-active` from `document.body`.

### 2.3 Runtime State Measurements

#### Pre-Click State (on Preview Screen):
```json
{
  "url": "http://localhost:8080/#practice",
  "routerView": "practice",
  "bodyClasses": "web-mode loaded view-practice-active drill-session-active",
  "modeSelectDisplay": "none",
  "drillContainerDisplay": "block",
  "drillContainerClasses": "",
  "drillContainerInnerLen": 1079,
  "activeEngine": true,
  "drillSessionActive": false,
  "engineOwnsScreen": true
}
```

#### Immediate Post-Click State ($t = 0$ms):
```json
{
  "url": "http://localhost:8080/#practice",
  "routerView": "practice",
  "bodyClasses": "web-mode loaded view-practice-active",
  "modeSelectDisplay": "block",
  "drillContainerDisplay": "none",
  "drillContainerClasses": "",
  "drillContainerInnerLen": 0,
  "activeEngine": false,
  "drillSessionActive": false,
  "engineOwnsScreen": false
}
```

#### Delayed Post-Click State ($t = 2000$ms):
```json
{
  "modeSelectDisplay": "block",
  "drillContainerDisplay": "none",
  "drillContainerInnerLen": 0,
  "activeEngine": false,
  "drillSessionActive": false
}
```

### 2.4 Diagnostic Timeline
```
12:55:45.981 [SESSION]  _exitDrillSession:enter             -> drillSessionActive: false
12:55:45.985 [SESSION]  _disposeActiveDrillSession:completed -> container cleared (innerLen: 0)
12:55:45.986 [PRACTICE] _resetPracticeUiToModes:start        -> restoring modeSelect
12:55:45.987 [PRACTICE] _resetPracticeUiToModes:completed    -> modeSelectDisplay: 'block'
12:55:45.989 [DOM]      drillContainer:mutation_attributes   -> style.display = 'none'
12:55:45.990 [DOM]      modeSelect:mutation_attributes       -> style.display = 'block'
```

### 2.5 Repetition & Variation Results
- **Rapid Double-Click on Back Button:** Tested across 3 consecutive trials. Synchronously transitioned to `#modeSelect` on click 1; second click was a safe no-op on the already-cleared container.
- **5 Repeated Entry/Exit Cycles:** Tested 5 consecutive launches into Preview followed by Back to Modes. In all 5 cycles, `#drillContainer` cleared to length 0 and `#modeSelect` returned to `display: 'block'`.

### 2.6 Reproduction Result
**NOT REPRODUCED**

---

## 3. Bug B — Active Drill $\to$ Exit $\to$ End Session

### 3.1 Reproduction Steps
1. Navigate to Practice and launch a Quick Drill.
2. Click "Begin Challenge" (`#startBtn`) to enter the active drill.
3. Verify active question rendering, timers, and input state (`drill-session-active numpad-active`).
4. Click exit button (`#drillExitBtn`).
5. Verify appearance of confirmation modal (`#exitSessionModal`).
6. Test Flow 1: Click "Keep Going" (`#exitSessionCancel`).
7. Test Flow 2: Click "End Session" (`#exitSessionConfirm`).
8. Observe immediate and delayed DOM/engine state over 2000ms.
9. Test Flow 3: Immediately start a new drill after session termination.

### 3.2 Expected vs Actual Behavior
- **Reported Bug Behavior:** Drill container or question remains visible, timers continue in the background, delayed callbacks overwrite the DOM, or `#modeSelect` fails to return.
- **Actual Observed Behavior:** Confirmation modal opens and closes cleanly. Clicking "Keep Going" resumes the session without state mutation. Clicking "End Session" tears down the drill engine, clears `#drillContainer`, resets `_drillSessionActive` to `false`, restores `#modeSelect`, and eliminates all active timers.

### 3.3 Runtime State Measurements

#### Active Drill Pre-Confirm State:
```json
{
  "modalDisplay": "flex",
  "drillContainerDisplay": "block",
  "modeSelectDisplay": "none",
  "activeEngine": true,
  "drillSessionActive": true
}
```

#### Immediate Post-Confirm State ($t = 0$ms):
```json
{
  "modalDisplay": "none",
  "drillContainerDisplay": "none",
  "drillContainerInnerLen": 0,
  "modeSelectDisplay": "block",
  "activeEngine": false,
  "drillSessionActive": false,
  "bodyClasses": "web-mode loaded view-practice-active"
}
```

#### Delayed State ($t = 2000$ms):
```json
{
  "drillContainerDisplay": "none",
  "drillContainerInnerLen": 0,
  "modeSelectDisplay": "block",
  "activeEngine": false,
  "drillSessionActive": false
}
```

### 3.4 Variations
- **Keep Going (Cancel):** Modal dismissed (`display: none`), active question remained intact, session remained active (`drillSessionActive: true`).
- **Immediate Re-entry:** Started a second drill immediately following "End Session". Second engine initialized cleanly, Question 1 rendered, and exit from the second session completed without collision.

### 3.5 Reproduction Result
**NOT REPRODUCED**

---

## 4. Bug C — Final Question $\to$ View Results Lockout

### 4.1 Reproduction Steps
1. Instantiate drill engine with `count: 1, skipStartScreen: true`.
2. Input answer `'1'` into `#answerInput`.
3. Click `#submitBtn` to submit answer.
4. Button text changes to "View Results".
5. Fire clicks at measured delay intervals:
   - C1: Immediate ($t < 50$ms)
   - C2: $t = 50$ms
   - C3: $t = 100$ms
   - C4: $t = 200$ms
   - C5: $t = 350$ms
   - C6: $t = 500$ms
6. Test rapid bursts of 2 and 5 repeated clicks.
7. Test non-final question carry-over protection on Question 1 of 2.

### 4.2 Timing Sweep Results

| Test ID | Target Delay | Measured Actual Delay | Pre-Click Button State | Results Rendered? | Heading Content | Result |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **C1** | $0$ms (immediate) | **28.8ms** | Disabled: `false`, Text: "View Results" | **YES** | "Session Complete" | Click Accepted |
| **C2** | $50$ms | **51.0ms** | Disabled: `false`, Text: "View Results" | **YES** | "Session Complete" | Click Accepted |
| **C3** | $100$ms | **100.5ms** | Disabled: `false`, Text: "View Results" | **YES** | "Session Complete" | Click Accepted |
| **C4** | $200$ms | **210.1ms** | Disabled: `false`, Text: "View Results" | **YES** | "Session Complete" | Click Accepted |
| **C5** | $350$ms | **359.6ms** | Disabled: `false`, Text: "View Results" | **YES** | "Session Complete" | Click Accepted |
| **C6** | $500$ms | **502.4ms** | Disabled: `false`, Text: "View Results" | **YES** | "Session Complete" | Click Accepted |

### 4.3 Rapid Click Burst Measurements
- **Burst of 5 Rapid Clicks:**
  - `btnDisabledProgression`: `[false, true, true, true, true]`
  - Synchronously disabled on click 1.
  - `resultsHeadingCount`: Exactly 1 (`#drillResultsHeading: "Session Complete"`).
  - `finishCallsLogged`: Exactly 1.
  - Zero unhandled exceptions.

### 4.4 Intermediate Question Lockout (Q1 of 2)
- Fast click on "Next →" fired at $t = 40$ms ($< 350$ms).
- Click was safely rejected by the intermediate question guard (`_nextReady === false`).
- Question did not advance prematurely.
- Second click after 350ms successfully advanced to Question 2.

### 4.5 Reproduction Result
**NOT REPRODUCED**

---

## 5. Bug D — Update App / Daily Question Limit

### 5.1 Reproduction Steps
1. Set initial progress: `todayAttempted = 5, todayCorrect = 4, lastActiveDate = today`.
2. Verify progress in `localStorage` and `AppState`.
3. Navigate to Settings view (`#view-settings`).
4. Click `#updateAppBtn` ("🔄 Update App").
5. Monitor `flushPromise`, cache purge (`caches.keys()`), service worker signaling (`SKIP_WAITING`), and page reload.
6. Verify progress values upon application boot after reload.

### 5.2 Controlled Variations & Findings

#### D1: Normal Update Flow
- **Pre-Update State:** `todayAttempted: 5, todayCorrect: 4`.
- **Post-Reload State:** `todayAttempted: 5, todayCorrect: 4`.
- **Outcome:** No quota reset occurred; progress remained intact.

#### D2 & D3: Update During Pending/Debounced Progress Write
- Answered questions, updating `todayAttempted = 12, todayCorrect = 10`.
- Immediately invoked `QRUpdateManager.applyUpdate()` while the 2000ms debounce timer was active.
- Browser reloaded.
- **Post-Reload State:** `todayAttempted: 12, todayCorrect: 10`.
- **Outcome:** In-flight debounced updates were flushed to durable storage before reload; progress preserved.

#### D6: Direct Browser Reload Without Update App
- Navigated directly via `page.goto('http://localhost:8080/#practice')`.
- **Post-Reload State:** `todayAttempted: 12, todayCorrect: 10`.
- **Outcome:** Progress loaded cleanly from `localStorage`.

#### D7: Same-Day Local vs Stale Remote Document Reconciliation
- Local progress initialized to `todayAttempted: 12, todayCorrect: 10`.
- Remote Firestore document payload arrived with stale values: `todayAttempted: 0, todayCorrect: 0` for the same calendar date.
- Reconciliation logic executed: `Math.max(12, 0) = 12` and `Math.max(10, 0) = 10`.
- **Final Post-Reconciliation State:** `todayAttempted: 12, todayCorrect: 10`.
- **Outcome:** Stale remote document did not overwrite local daily count.

#### D8: Account Transition Isolation (User A $\to$ User B)
- User A had `todayAttempted: 15`. User switched to User B.
- `lastUid !== currentUserId` triggered `_clearUserLocalStorage()` and engaged `_purgedAwaitingHydration = true`.
- User B's remote document arrived with `todayAttempted: 3`.
- Reconciliation block was cleanly bypassed (`!_purgedAwaitingHydration === false`).
- **Final State:** `todayAttempted: 3`. `userADataLeaked: false`.
- **Outcome:** Account boundaries strictly isolated; no cross-user quota contamination.

### 5.3 Reproduction Result
**NOT REPRODUCED**

---

## 6. Service Worker & Cache Observations

During the execution of Phase 7 tests in Microsoft Edge:
1. **Service Worker Registration:** Active registration found for scope `http://localhost:8080/`.
2. **Worker Script & State:** `http://localhost:8080/service-worker.js`, state: `activated`.
3. **Waiting Worker:** `null` (no stalled or waiting workers).
4. **Cache Storage:** `qr-cache-v296` active.
5. **App Version:** `v296`.
6. **Update Flow Operation:** During `applyUpdate()`, `caches.delete()` clears the cache storage, `SKIP_WAITING` is dispatched to registered workers, and a hard reload fetches fresh assets. Local persistence (`localStorage.qr_progress`) remains untouched by the cache deletion.

---

## 7. Summary Classification

| Issue ID | Classification | Justification |
| :--- | :--- | :--- |
| **Bug A** | **NOT REPRODUCED** | Preview screen exit synchronously clears and hides `#drillContainer` and restores `#modeSelect` across single, double, and repeated clicks. |
| **Bug B** | **NOT REPRODUCED** | End session flow cleanly dismantles engine and restores practice modes; zero orphaned timers or delayed mutations observed over 2s. |
| **Bug C** | **NOT REPRODUCED** | Final question click accepted immediately at 28.8ms; rapid click bursts processed idempotently without duplicates or silent drops. |
| **Bug D** | **NOT REPRODUCED** | Update App preserves daily question counts across reloads; same-day reconciliation protects local counters from stale document overwrites. |
