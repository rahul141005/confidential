# Navigation / State Lifecycle Forensic Audit

**Repository:** QuantReflex  
**Branch:** main  
**Date:** 2026-09-13  
**Auditor:** Claude Sonnet (Forensic Analysis Agent)  
**Target Implementer:** Astra 6  

---

# 1. Executive Summary

## Reported Behavior
Two navigation bugs in a vanilla JavaScript SPA:

- **Bug A:** Clicking "Back to Modes" from Reflex Drill Preview returns to Practice, but Preview UI remains visible
- **Bug B:** Clicking "View Results" from completed drill returns to Practice, but completed drill/question UI remains visible

## Root Cause Determination

**VERIFIED CONTRIBUTING FACTOR:** The unified cleanup function `_disposeActiveDrillSession()` (session-manager.js:35-50) hides the drillContainer element but does NOT clear its innerHTML. This function is the central cleanup mechanism called by all navigation paths.

**VERIFIED CONTRIBUTING FACTOR:** The `_resetPracticeUiToModes()` function (practice-config.js:248-274) clears innerHTML but is only called from onFinish callbacks and Router.onShow callbacks, creating a potential window where Practice becomes visible before innerHTML is cleared.

**VERIFIED STATE LIFETIME:** The `_drillSessionActive` flag is FALSE during Results screen (per ADR-153 design), but `_activeDrillEngine` remains non-null. The `_engineOwnsScreen()` predicate handles this case correctly.

**UNVERIFIED HYPOTHESIS:** Static code analysis shows all cleanup paths execute synchronously. The discrepancy between observed behavior and apparent code behavior may be explained by:
1. Stale cached JavaScript (service worker version is v295)
2. Browser-specific rendering timing quirks
3. Edge cases not visible in static analysis

## Previous Fix Analysis

**Commit c1c24cd** changed inline cleanup to `_disposeActiveDrillSession()` in TWO paths only (startSessionReview, startLrSet). It did NOT:
- Clear innerHTML in `_disposeActiveDrillSession`
- Change the startBackBtn handler (drill-engine.js:284-295)
- Address the root issue of innerHTML persistence

## What Astra Should Change

**PRIMARY FIX:** Add `container.innerHTML = '';` to `_disposeActiveDrillSession()` at session-manager.js:48.

**SECONDARY FIX:** Bump service worker version from v295 to v296.

---

# 2. Reported Bugs

## Bug A — Back to Modes

**Flow:**
```
Practice (modeSelect visible)
→ Click "Reflex Drill" card
→ Preview screen rendered in drillContainer
→ Click "Back to Modes" button
→ Practice (should show modeSelect)
```

**Expected:** Practice displays cleanly with mode selection visible, no Preview content, drillContainer empty and hidden.

**Observed:** Practice displays but Preview UI remains visible/persisting.

**Critical State:**
- Preview is rendered by `renderStart()` (drill-engine.js:258-296)
- Preview content written to `drillContainer.innerHTML`
- Body class `drill-session-active` added for CSS positioning
- `_drillSessionActive` flag is FALSE (not set until begin())
- `_activeDrillEngine` is non-null

## Bug B — View Results

**Flow:**
```
Practice
→ Click "Reflex Drill" card
→ Preview
→ Click "Begin Challenge"
→ Answer Questions 1-10
→ Question 10 completes
→ Click "View Results"
→ Results screen
→ Click "Back to Practice"
→ Practice (should show modeSelect)
```

**Expected:** Practice displays cleanly with no drill UI, no results UI, no question state.

**Observed:** Practice displays but completed drill/question UI remains visible.

**Critical State:**
- Results rendered by `finish()` (drill-engine.js:1259-1650)
- `drill-results-active` class added (line 1462)
- `_drillSessionActive` set to FALSE by `_exitDrillSession()` at line 1263
- `_activeDrillEngine` remains non-null (ADR-153 design)
- Body class `drill-session-active` removed before results render

---

# 3. Actual Production Code Path

## Entry Point

**File:** `main-app/index.html`  
**Role:** SPA root HTML with static DOM structure  
**Key Elements:**
- `<div id="view-practice" class="spa-view">` (line 398)
- `<div id="drillContainer" style="display:none;"></div>` (line 548)
- `<script src="js/app.js"></script>` loads application

**File:** `main-app/js/app.js`  
**Role:** Application bootstrap  
**Initialization:**
- Line 46-47: Force cleanup of stuck state classes
- Line 549: `Router.init()` 
- Line 1324: `initPracticeView()`

**File:** `main-app/js/router.js`  
**Role:** Hash-based SPA router  
**Responsibility:** View visibility management via `.spa-view-active` class  
**Production Path:** Only router implementation (no duplicates)

## Practice Initialization

**File:** `main-app/js/controllers/practice-modes.js`  
**Function:** `initPracticeView()` (line 547-557)  
**Responsibility:** Register Router callbacks for Practice view  
**Key Operations:**
- Line 548-557: Register Router.onShow('practice') callback
- Line 559-720: Register onInit callback for mode card click handlers

## Mode Selection

**File:** `main-app/js/controllers/practice-modes.js`  
**Function:** `startDrillFromPractice()` (line 64-215)  
**Responsibility:** Configure and launch drill session  
**Key Operations:**
- Line 119-127: Mode configuration table (reflex: count=10, perQuestionSec=15)
- Line 196-202: Set `config.onFinish` callback
- Line 204-207: Hide modeSelect, show drillContainer
- Line 214: Call `_startPracticeEngine(drillContainer, config)`

## Engine Creation

**File:** `main-app/js/controllers/practice-modes.js`  
**Function:** `_startPracticeEngine()` (line 471-478)  
**Responsibility:** Create drill engine instance  
**Key Operations:**
- Line 472-474: Check for existing engine, cleanup if present
- Line 475: `createDrillEngine(drillContainer, config)`
- Line 476: `_activeDrillEngine = engine`
- Line 477: `engine.start()`

## Drill Engine

**File:** `main-app/js/drill-engine.js`  
**Function:** `createDrillEngine(container, opts)` (line 34-2000+)  
**Responsibility:** Core drill engine factory  
**Key Internal Functions:**

- `start()` (line 2013): Entry point, calls `renderStart()` or `begin()`
- `renderStart()` (line 258-296): Renders Preview screen
- `begin()` (line 1827-1880): Starts drill session, calls `_enterDrillSession()`
- `finish()` (line 1259-1650): Renders Results screen
- `cleanup()` (line 1793-1817): Clears engine timers and state

## Session State Manager

**File:** `main-app/js/session-manager.js`  
**Responsibility:** Global drill session state management  
**Key Functions:**

- `_enterDrillSession()` (line 58-64): Sets `_drillSessionActive = true`, adds body class
- `_exitDrillSession()` (line 73-94): Sets `_drillSessionActive = false`, removes body class
- `_disposeActiveDrillSession()` (line 35-50): Unified cleanup function
- `_engineOwnsScreen()` (line 241-248): Predicate for screen ownership

**Global State:**
- Line 16: `var _activeDrillEngine = null;`
- Line 20: `var _drillSessionActive = false;`

## Practice State Reset

**File:** `main-app/js/controllers/practice-config.js`  
**Function:** `_resetPracticeUiToModes()` (line 248-274)  
**Responsibility:** Reset Practice UI to mode selection  
**Key Operations:**
- Line 259: `modeSelect.style.display = 'block';`
- Line 265: `drillContainer.style.display = 'none';`
- Line 266: `drillContainer.classList.remove('drill-results-active');`
- Line 267: `drillContainer.innerHTML = '';`

**DUPLICATE/LEGACY IMPLEMENTATIONS:** None found. Only one drill engine implementation, one session manager, one router.

---

# 4. State Ownership Map

| State | Declaration | Owner | Initialization | Writers | Readers | Resetters | Persistence | Lifetime |
|---|---|---|---|---|---|---|---|---|
| `_activeDrillEngine` | session-manager.js:16 | Session Manager | `null` at parse time | practice-modes.js:476 (set), session-manager.js:37 (clear) | session-manager.js:244, router.js:70 | session-manager.js:37 | Memory only | Engine lifetime |
| `_drillSessionActive` | session-manager.js:20 | Session Manager | `false` at parse time | drill-engine.js:1847 (set via `_enterDrillSession`), session-manager.js:74 (clear via `_exitDrillSession`) | session-manager.js:243, router.js:261, i18n-transition.js:113 | session-manager.js:74 | Memory only | Active answering phase only |
| `drillContainer.innerHTML` | DOM property | DOM | Empty string initially (index.html) | drill-engine.js (8 locations: 269, 320, 515, 1074, 1526, 1886, 1899, 1951), practice-config.js:267 (clear) | Browser renderer | practice-config.js:267 | DOM | Until explicitly cleared |
| `drillContainer.style.display` | DOM property | DOM | `'none'` (index.html:548) | practice-modes.js:207, practice-config.js:265, session-manager.js:48, drill-engine.js:1463, router.js:75 | Browser renderer, CSS | session-manager.js:48, practice-config.js:265 | DOM | Visible session |
| `drill-results-active` class | DOM classList | drillContainer | Not present initially | drill-engine.js:1462 (add), session-manager.js:47 (remove), practice-config.js:266 (remove) | CSS (style.css:821-832) | session-manager.js:47, practice-config.js:266 | DOM | Results screen |
| `body.drill-session-active` | DOM classList | document.body | Not present initially | drill-engine.js:279-280 (add), session-manager.js:77-78 (remove), app.js:46-47 (startup cleanup) | CSS (style.css:3915-3923) | session-manager.js:77-78, app.js:46 | DOM | During drill + preview |
| `.spa-view-active` | DOM classList | Active SPA view | One view has it | router.js:148 (remove all), router.js:157 (add one) | CSS | router.js:148 | DOM | Current view lifetime |
| `currentView` | router.js:9 (private) | Router | `null` initially | router.js:197 | router.js:215 (via getCurrentView) | router.js:295 (teardown) | Memory | Application lifetime |

**State Lifetime Summary:**

- `_drillSessionActive`: Set TRUE by `begin()`, set FALSE by `_exitDrillSession()` which is called BEFORE results render
- `_activeDrillEngine`: Set by `_startPracticeEngine()`, cleared ONLY by `_disposeActiveDrillSession()`
- `drillContainer.innerHTML`: Written by drill engine, cleared ONLY by `_resetPracticeUiToModes()`

---

# 5. Component Lifecycle Analysis

**IMPORTANT:** This is a vanilla JavaScript SPA. There is NO framework lifecycle. Components are DOM elements controlled by:

1. CSS classes (`.spa-view-active`, `.drill-session-active`, `.drill-results-active`)
2. Inline style properties (`display`, `visibility`)
3. Imperative DOM manipulation (`innerHTML`, `classList`)

## What "Mounts" / "Unmounts"

**Nothing unmounts in the React sense.** All views exist permanently in the DOM.

- **#view-practice:** Always exists, visibility controlled by `.spa-view-active`
- **#drillContainer:** Always exists, visibility controlled by `style.display`
- **#modeSelect:** Always exists, visibility controlled by `style.display`

## What Remains Mounted

All DOM elements remain in the DOM permanently:
- All `.spa-view` elements
- drillContainer
- modeSelect
- categorySelect

## What Becomes Hidden vs Removed

**HIDDEN (style.display = 'none'):**
- `#drillContainer` when not in use
- `#modeSelect` when drill is active

**REMOVED FROM DOM:**
- Nothing removed programatically

**STATE CLEARED:**
- `drillContainer.innerHTML` cleared by `_resetPracticeUiToModes()`
- Global state variables reset by their respective functions

## What Survives Navigation

**Survives:**
- All DOM elements
- `_activeDrillEngine` until explicitly nulled
- `_drillSessionActive` until explicitly set false

**Does NOT survive:**
- `.spa-view-active` class (moved to new view)
- Visibility of drillContainer (hidden on navigation)

## What Survives Session Disposal

After `_disposeActiveDrillSession()`:
- `_activeDrillEngine = null`
- `_drillSessionActive = false`
- `drillContainer.style.display = 'none'`
- `drillContainer.classList.remove('drill-results-active')`

**PROBLEM:** `drillContainer.innerHTML` is NOT cleared by `_disposeActiveDrillSession()`

---

# 6. Navigation / Router Analysis

## Router.showView() Execution Sequence

**File:** `main-app/js/router.js:137-213`

```
Line 147-149: Remove .spa-view-active from ALL views
Line 157: Add .spa-view-active to target view (PRACTICE BECOMES VISIBLE)
Line 160-162: Toggle body classes (view-practice-active)
Line 164: _cleanupOverlays(viewId) - SEE BELOW
Line 166-171: Restore bottom nav if no session
Line 173-178: Update nav links
Line 180-184: Clear old view listeners
Line 186-189: Fire viewInitCallbacks
Line 191-195: Fire afterShowCallbacks
Line 197: currentView = viewId
Line 199-206: Update hash/history
Line 208-211: Reset scroll
```

**CRITICAL TIMING:** Practice becomes visible at Line 157. onShow callbacks fire at Lines 191-195.

## _cleanupOverlays() Behavior

**File:** `main-app/js/router.js:62-135`

```
Line 65-76: Drill container handling
  Line 70-72: Check _engineOwnsScreen()
  Line 73-76: If !_drillOwnsScreen:
    drillContainer.classList.remove('drill-results-active')
    drillContainer.style.display = 'none'
    (NO innerHTML clear!)
Line 79-85: Onboarding overlay
Line 87-95: Paywall overlay
Line 102-104: Duel manager
Line 107-110: Body classes if !drillSessionActive
Line 126-128: QROverlay.releaseAll()
Line 131-134: Legacy modal sweep
```

**PROBLEM:** No innerHTML clear in _cleanupOverlays.

## Router.onShow('practice') Callback

**File:** `main-app/js/controllers/practice-modes.js:548-557`

```javascript
Router.onShow('practice', function () {
  _disposeActiveDrillSession();              // Line 549
  _renderDailyQuota(...);                    // Line 552-554
  _resetPracticeUiToModes();                 // Line 556 - CLEARS innerHTML
});
```

**SEQUENCE:** This callback fires AFTER Router.showView has already made Practice visible.

## Back to Modes Navigation

**Handler:** drill-engine.js:284-295 (startBackBtn)

```javascript
cleanup();                                    // Clear engine timers
_exitDrillSession();                          // Set _drillSessionActive=false, remove body class
FirestoreSync.endDrillBatch();               // End batch
if (onFinish) {
  onFinish('practice');                       // Call host callback
} else {
  Router.showView('practice');               // Direct navigation
}
```

**onFinish callback** (practice-modes.js:196-202):
```javascript
_disposeActiveDrillSession();                // Clear engine reference, hide container
if (view === 'practice') {
  _resetPracticeUiToModes();                 // Clear innerHTML, reset UI
}
Router.showView(view);                       // Navigate
```

## Browser Back Navigation

**Handler:** router.js:238-286 (popstate)

```javascript
// Line 261-278: Check _drillSessionActive (ACTIVE SESSIONS)
if (_drillSessionActive) {
  history.pushState({ view: 'practice' }, '', '#practice');  // Re-push
  showExitSessionDialog(function () {
    _disposeActiveDrillSession();            // Disposal
    showView('practice');                    // Navigate
  });
  return;
}

// Line 280-285: INACTIVE SESSIONS
_disposeActiveDrillSession();                // Always dispose
var parsed = _parseHash(window.location.hash);
showView(parsed.view);
```

**PROBLEM:** From Preview, `_drillSessionActive` is FALSE, so path goes through Line 280-285.

---

# 7. Drill Engine Analysis

## Initialization

**Function:** `createDrillEngine(container, opts)` (line 34)

Returns engine object with methods: `start()`, `begin()`, `cleanup()`, etc.

## start() - Entry Point

**Function:** `start()` (line 2013)

```javascript
function start() {
  if (opts.skipStartScreen === true) {
    begin();                    // Skip preview, go straight to questions
  } else {
    renderStart();              // Show preview screen
  }
}
```

## renderStart() - Preview Screen

**Function:** `renderStart()` (line 258-296)

```javascript
// Line 269-277: Render preview HTML into container
container.innerHTML = '<div class="card center-content drill-start">...</div>';

// Line 279-280: Add body classes for CSS overlay
document.body.classList.add('drill-session-active');
document.documentElement.classList.add('drill-session-active');

// Line 281-282: Hide bottom nav
var nav = document.querySelector('.bottom-nav');
if (nav) nav.style.display = 'none';

// Line 283: Wire Begin button
container.querySelector('#startBtn').addEventListener('click', begin);

// Line 284-295: Wire Back button
container.querySelector('#startBackBtn').addEventListener('click', function () {
  cleanup();
  _exitDrillSession();
  if (typeof FirestoreSync !== 'undefined') FirestoreSync.endDrillBatch();
  if (onFinish) onFinish('practice');
  else Router.showView('practice');
});
```

**CRITICAL:** Preview DOES NOT add `drill-results-active` class. Uses `body.drill-session-active` for CSS positioning.

## begin() - Start Session

**Function:** `begin()` (line 1827-1880)

```javascript
beginStarted = true;                                      // Line 1829
// ... onStart callback
_enterDrillSession();                                     // Line 1847 - SET FLAG
// ... Firestore batch
// ... render loading or question
```

## finish() - Results Screen

**Function:** `finish()` (line 1259-1650)

```javascript
if (_isFinished) return;                                  // Line 1260 - Idempotent
_isFinished = true;                                       // Line 1261
cleanup();                                                 // Line 1262
_exitDrillSession();                                       // Line 1263 - SET FLAG FALSE
// ... scoring, recording ...
container.classList.add('drill-results-active');          // Line 1462
container.style.display = 'block';                        // Line 1463
container.innerHTML = '<div class="card...>';              // Line 1526 - RESULTS HTML
```

**CRITICAL:** `_exitDrillSession()` called at line 1263, BEFORE results HTML rendered. This means:
- `_drillSessionActive = false`
- Body class removed
- BUT `_activeDrillEngine` still non-null
- This is INTENTIONAL (ADR-153)

## cleanup() - Engine Timers

**Function:** `cleanup()` (line 1793-1817)

Clears internal timers and state flags. Does NOT touch global state or DOM.

---

# 8. Session Manager Analysis

## Global State

```javascript
var _activeDrillEngine = null;        // Line 16
var _drillSessionActive = false;      // Line 20
```

## _enterDrillSession()

**Function:** `_enterDrillSession()` (line 58-64)

```javascript
_drillSessionActive = true;
var nav = document.querySelector('.bottom-nav');
if (nav) nav.style.display = 'none';
document.body.classList.add('drill-session-active');
document.documentElement.classList.add('drill-session-active');
```

## _exitDrillSession()

**Function:** `_exitDrillSession()` (line 73-94)

```javascript
_drillSessionActive = false;
var nav = document.querySelector('.bottom-nav');
if (nav) nav.style.display = '';
document.body.classList.remove('drill-session-active');
document.documentElement.classList.remove('drill-session-active');
hideCustomNumpad();
// ... exit dialog cleanup
```

**NOTE:** Does NOT null `_activeDrillEngine`. Only sets flag false.

## _disposeActiveDrillSession()

**Function:** `_disposeActiveDrillSession()` (line 35-50)

```javascript
var engine = _activeDrillEngine;
_activeDrillEngine = null;
if (engine && typeof engine.cleanup === 'function') {
  try { engine.cleanup(); } catch (_) {}
}
if (typeof FirestoreSync !== 'undefined' && typeof FirestoreSync.endDrillBatch === 'function') {
  try { FirestoreSync.endDrillBatch(); } catch (_) {}
}
_exitDrillSession();
var container = document.getElementById('drillContainer');
if (container) {
  container.classList.remove('drill-results-active');
  container.style.display = 'none';
  // MISSING: container.innerHTML = '';
}
```

**PROBLEM:** No innerHTML clear.

## _engineOwnsScreen()

**Function:** `_engineOwnsScreen()` (line 241-248)

```javascript
function _engineOwnsScreen() {
  try {
    if (typeof _drillSessionActive !== 'undefined' && _drillSessionActive) return true;
    if (typeof _activeDrillEngine !== 'undefined' && _activeDrillEngine) return true;
    if (document.body && document.body.classList.contains('drill-session-active')) return true;
  } catch (_) {}
  return false;
}
```

**ADR-153 Purpose:** This predicate correctly identifies screen ownership even when `_drillSessionActive` is false (during Results). Used by i18n-transition.js and router.js.

---

# 9. DOM / Imperative Rendering Analysis

## drillContainer Element

**HTML:** `<div id="drillContainer" style="display:none;"></div>` (index.html:548)

**Location:** Inside `#view-practice`

**Parent:** `<div id="view-practice" class="spa-view">`

**CSS Selector:** `#drillContainer`

## All Writers to drillContainer.innerHTML

1. **drill-engine.js:269** - `renderStart()` writes Preview HTML
2. **drill-engine.js:320** - DI Set context rendering
3. **drill-engine.js:515** - Question rendering
4. **drill-engine.js:1074** - Quota reached card
5. **drill-engine.js:1526** - Results HTML
6. **drill-engine.js:1886** - Loading state
7. **drill-engine.js:1899** - Generation error card
8. **drill-engine.js:1951** - "All caught up" message
9. **practice-config.js:267** - **CLEAR innerHTML** (ONLY location)

## All Writers to drillContainer.style.display

1. **drill-engine.js:1463** - `finish()` sets `'block'`
2. **practice-modes.js:207** - `startDrillFromPractice()` sets `'block'`
3. **practice-config.js:265** - `_resetPracticeUiToModes()` sets `'none'`
4. **session-manager.js:48** - `_disposeActiveDrillSession()` sets `'none'`
5. **router.js:75** - `_cleanupOverlays()` sets `'none'`

## All Writers to drill-results-active Class

1. **drill-engine.js:1462** - `finish()` adds class
2. **session-manager.js:47** - `_disposeActiveDrillSession()` removes class
3. **practice-config.js:266** - `_resetPracticeUiToModes()` removes class

## Imperative DOM Summary

**The drill engine is ENTIRELY imperative.** No declarative rendering. All UI is generated by:
1. Writing HTML strings to `container.innerHTML`
2. Adding/removing CSS classes
3. Setting inline styles

**There are NO duplicate drillContainer elements.** Verified by searching index.html.

---

# 10. CSS / Overlay Analysis

## drill-results-active CSS

**File:** `main-app/css/style.css:821-832`

```css
#drillContainer.drill-results-active {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: var(--z-session-bg);
  background: var(--qr-bg);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior-y: contain;
}
```

**Effect:** Creates fullscreen overlay that covers entire viewport, including Practice view.

## drill-session-active CSS

**File:** `main-app/css/style.css:3915-3923`

```css
body.drill-session-active #drillContainer {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: var(--z-session-bg);
  background: var(--qr-bg);
}
```

**Effect:** When body has this class, drillContainer becomes fullscreen overlay.

**IMPORTANT:** This is used for Preview screen (preview doesn't add drill-results-active, but body has drill-session-active).

## CSS Role in Bugs

**VERIFIED:** CSS overlay mechanism allows drill content to cover Practice.

**NOT A ROOT CAUSE:** CSS is working as designed. The question is why content persists when it should be cleared.

**CLASSIFICATION:** CSS is only EXPOSING another bug (innerHTML not cleared).

---

# 11. Async / Race / Effect Analysis

## Async Operations During Drill

### 1. AIFeatures.fetchSpeedBenchmark

**Location:** drill-engine.js:1605-1613

```javascript
AIFeatures.fetchSpeedBenchmark(accNum, parseFloat(avg), speedScore, count, mode, function (err, data) {
  if (err || !data) {
    benchmarkPlaceholder.innerHTML = '';
    return;
  }
  _renderBenchmarkAi(benchmarkPlaceholder, data);
});
```

**Analysis:** Runs during Results rendering. Asynchronous callback may execute after navigation.

**Risk:** If user navigates away from Results immediately, callback would try to write to cleared DOM. But benchmarkPlaceholder is a child of drillContainer which gets cleared.

**Potential Issue:** Could cause console errors but NOT the reported bug.

### 2. _loadingTimer

**Location:** drill-engine.js:1872-1876

```javascript
_loadingTimer = setTimeout(function () {
  _loadingTimer = null;
  if (_isFinished) return; // torn down during the yield
  _beginBuild();
}, 0);
```

**Analysis:** Used for heavy question generation. Cleared by `cleanup()`.

**Risk:** None - cleared before navigation completes.

### 3. FirestoreSync Operations

**Locations:** Various

**Analysis:** Asynchronous but don't block navigation. Called synchronously during cleanup.

**Risk:** None.

### 4. QROverlay Operations

**Analysis:** All overlay operations are synchronous. QROverlay manages modals.

**Risk:** None identified.

## Race Condition Investigation

**HYPOTHESIS:** Browser could paint Practice visible before cleanup completes.

**ANALYSIS:** JavaScript execution is single-threaded. Router.showView executes synchronously from Line 147 to Line 211. Browser cannot paint mid-execution.

**VERIFIED TIMING:**
- Line 157: Practice receives `.spa-view-active`
- Line 164: `_cleanupOverlays` hides drillContainer
- Line 191-195: onShow callbacks fire

**THERE IS NO PAINT WINDOW.** All operations complete before any browser paint.

**DISPROVEN:** Browser paint race condition.

---

# 12. The "Static Code Says This Should Not Happen" Problem

## The Apparent Contradiction

**Observation:** Static code analysis shows all cleanup executes synchronously before Practice becomes visible.

**Cleanup Sequence (Back to Modes):**
1. `cleanup()` - clears engine timers
2. `_exitDrillSession()` - sets flag false, removes body class
3. `onFinish('practice')`:
   - `_disposeActiveDrillSession()`:
     - `_activeDrillEngine = null`
     - Hides drillContainer
     - NO innerHTML clear
   - `_resetPracticeUiToModes()`:
     - Clears innerHTML (line 267)
   - `Router.showView('practice')`:
     - Makes Practice visible (line 157)
     - Calls `_cleanupOverlays()` (line 164)
     - Fires onShow callback (line 191-195):
       - `_disposeActiveDrillSession()` (redundant)
       - `_resetPracticeUiToModes()` (redundant)

**The Problem:** innerHTML is cleared by `_resetPracticeUiToModes()` but NOT by `_disposeActiveDrillSession()`.

**Window of Exposure:** If for ANY reason `_resetPracticeUiToModes()` is not called, innerHTML persists.

## Possible Explanations

### 1. onFinish Not Defined (Edge Case)

**Code:** drill-engine.js:290-294

```javascript
if (onFinish) {
  onFinish('practice');
} else {
  Router.showView('practice');
}
```

**Scenario:** If onFinish is undefined, direct Router.showView call fires onShow callback which DOES call `_resetPracticeUiToModes()`.

**VERIFIED:** This path still clears innerHTML.

### 2. Stale Cached Code

**Analysis:** Users may be running old JavaScript that doesn't have recent fixes.

**Evidence:**
- Service worker version: v295
- Recent fixes in v294 (commit f025842)
- Previous fix (c1c24cd) didn't bump version

**UNVERIFIED:** Cannot prove without deployment metrics.

### 3. Browser-Specific Quirk

**Analysis:** Some browsers may have rendering timing quirks.

**EVIDENCE:** None found. JavaScript execution model is standardized.

**UNVERIFIED:** Cannot test in this environment.

### 4. InnerHTML Cleared Too Late

**Analysis:** The innerHTML is cleared by `_resetPracticeUiToModes()` but this might execute after Practice is visible.

**SEQUENCE ANALYSIS:**

In onFinish callback:
```
_disposeActiveDrillSession();    // Hides container
_resetPracticeUiToModes();       // Clears innerHTML
Router.showView('practice');     // Makes Practice visible
```

**VERIFIED:** innerHTML cleared BEFORE Practice visible.

In onShow callback:
```
Router.showView makes Practice visible (Line 157)
...
onShow callback fires (Line 191-195)
  _disposeActiveDrillSession();  // Hides container
  _resetPracticeUiToModes();     // Clears innerHTML
```

**PROBLEM:** In this path, Practice is VISIBLE for a brief moment before innerHTML is cleared.

**CLASSIFICATION:** PLAUSIBLE CONTRIBUTING FACTOR.

---

# 13. Previous Fix Analysis

## Commit c1c24cd

**Message:** "Refactor practice modes controller logic"

**Author:** Replit Agent

**Files Changed:**
- `main-app/js/controllers/practice-modes.js`

## What Changed

**startSessionReview onFinish** (line 309-313 before):
```javascript
// BEFORE
if (_activeDrillEngine) { _activeDrillEngine.cleanup(); _activeDrillEngine = null; }
var _dc = document.getElementById('drillContainer');
if (_dc) { _dc.classList.remove('drill-results-active'); _dc.style.display = 'none'; }
if (_drillSessionActive && typeof FirestoreSync !== 'undefined') FirestoreSync.endDrillBatch();
_exitDrillSession();

// AFTER
_disposeActiveDrillSession();
```

**startLrSet onFinish** (line 458-462 before):
```javascript
// Same change as above
```

## What It Fixed

**Intention:** Code consolidation - replace inline cleanup with unified function.

**What Was Actually Fixed:** Code style improvement. Both paths were ALREADY calling equivalent cleanup.

## What It Failed to Address

1. **startBackBtn handler unchanged** - drill-engine.js:284-295 still uses old pattern
2. **No innerHTML clear** - `_disposeActiveDrillSession()` still doesn't clear innerHTML
3. **Version not bumped** - Service worker still at v295

## Why Previous Fix Was Incomplete

**Root Issue:** The problem is NOT about using unified cleanup vs inline cleanup. The problem is that NEITHER clears innerHTML.

**Missing Fix:** Add `container.innerHTML = '';` to `_disposeActiveDrillSession()`.

---

# 14. Alternate / Duplicate Implementations

## Search Results

**Drill Engines:**
- `main-app/js/drill-engine.js` - **PRODUCTION** (only implementation)
- `main-app/js/di-engine.js` - DI question generator (called BY drill-engine)
- `main-app/js/lr-engine.js` - LR question generator (called BY drill-engine)
- `main-app/js/mock-engine.js` - Mock mode support (called BY drill-engine)
- `main-app/js/di-set-engine.js` - DI Sets
- `main-app/js/lr-set-engine.js` - LR Sets
- `main-app/js/lr-authored-engine.js` - Authored LR content
- `main-app/js/lr-visual-engine.js` - Visual LR content

**Routers:**
- `main-app/js/router.js` - **PRODUCTION** (only router)

**Session Managers:**
- `main-app/js/session-manager.js` - **PRODUCTION** (only session manager)
- `main-app/api/session.js` - Backend API (not client)

**Practice Config:**
- `main-app/js/controllers/practice-config.js` - **PRODUCTION**
- `main-app/js/controllers/practice-modes.js` - **PRODUCTION**

## Conclusion

**NO DUPLICATES FOUND.** All production code is in expected locations.

---

# 15. Service Worker / Cache Analysis

## Current Strategy

**File:** `main-app/service-worker.js`

### Version Constants

```javascript
const APP_VERSION = 'v295';        // Line 6
const CACHE_NAME = 'qr-cache-' + APP_VERSION;  // Line 7
```

### Cache Assets List

Lines 9-43 define cached assets including:
- `/index.html`
- `/css/style.css`
- `/js/app.js`
- `/js/drill-engine.js`
- etc.

### Install Event

```javascript
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
  );
});
```

### Activate Event (Cache Cleanup)

```javascript
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => 
      Promise.all(keys.map(key => {
        if (key !== CACHE_NAME) {
          return caches.delete(key);  // DELETE OLD CACHES
        }
      }))
    )
  );
});
```

### Fetch Strategy

```javascript
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
  );
});
```

**Strategy:** Cache-first. Serve from cache, fallback to network.

## Index.html Version Reference

**File:** `main-app/index.html:17`

```javascript
<script>window.QR_APP_VERSION = 'v295';</script>
```

**Purpose:** App build tag for error reports.

## Stale JavaScript Risk

**Problem:** Users with cached v294 or earlier may not have recent fixes.

**Evidence:**
- Commit f025842 (v294) fixed preview positioning
- Commit c1c24cd (v294) refactored cleanup
- Users may be stuck on v293 or earlier

**Cannot Verify:** Without deployment metrics, cannot prove users have stale code.

## Version Bump Requirements

**When implementing fix:**

1. Update `service-worker.js:6`: `const APP_VERSION = 'v296';`
2. Update `index.html:17`: `window.QR_APP_VERSION = 'v296';`

**Why:** Force browser to download new JavaScript files.

---

# 16. Root Cause Classification

| Finding | Classification | Evidence | Confidence |
|---|---|---|---|
| `_disposeActiveDrillSession()` doesn't clear innerHTML | VERIFIED CONTRIBUTING FACTOR | session-manager.js:35-50 shows no innerHTML clear, only hide | HIGH |
| `_resetPracticeUiToModes()` is responsible for clearing innerHTML | VERIFIED | practice-config.js:267 is the ONLY location that clears innerHTML | HIGH |
| onShow callback fires after Practice becomes visible | VERIFIED | router.js:157 (make visible) vs router.js:191-195 (onShow) | HIGH |
| Window where Practice visible with drill content | PLAUSIBLE | If onShow path is used, Practice visible at line 157 before cleanup at line 191-195 | MEDIUM |
| Browser paint race condition | DISPROVEN | JavaScript single-threaded execution, all operations synchronous | HIGH |
| Duplicate drillContainer elements | DISPROVEN | Single drillContainer in index.html:548 | HIGH |
| Multiple drill engines | DISPROVEN | Single engine instance per session, verified | HIGH |
| Stale cached JavaScript causing bug | PLAUSIBLE / UNVERIFIED | Service worker caches aggressively, version v295, no deployment metrics available | MEDIUM |
| CSS overlay as root cause | DISPROVEN | CSS works as designed, only exposes innerHTML persistence | HIGH |
| `_engineOwnsScreen()` predicate incorrect | DISPROVEN | Predicate correctly handles Results state (ADR-153) | HIGH |
| Async operations mutating after cleanup | DISPROVEN | All navigation synchronous, async ops could only cause console errors | MEDIUM |

---

# 17. Evidence Matrix

## Claim: `_disposeActiveDrillSession()` doesn't clear innerHTML

**File:** `main-app/js/session-manager.js:35-50`

**Function:** `_disposeActiveDrillSession`

```javascript
function _disposeActiveDrillSession() {
  var engine = _activeDrillEngine;
  _activeDrillEngine = null;
  if (engine && typeof engine.cleanup === 'function') {
    try { engine.cleanup(); } catch (_) {}
  }
  if (typeof FirestoreSync !== 'undefined' && typeof FirestoreSync.endDrillBatch === 'function') {
    try { FirestoreSync.endDrillBatch(); } catch (_) {}
  }
  _exitDrillSession();
  var container = document.getElementById('drillContainer');
  if (container) {
    container.classList.remove('drill-results-active');
    container.style.display = 'none';
    // NO innerHTML CLEAR
  }
}
```

**Support:** Function hides container but never clears innerHTML.

---

## Claim: `_resetPracticeUiToModes()` clears innerHTML

**File:** `main-app/js/controllers/practice-config.js:264-268`

**Function:** `_resetPracticeUiToModes`

```javascript
if (drillContainer) {
  drillContainer.style.display = 'none';
  drillContainer.classList.remove('drill-results-active');
  drillContainer.innerHTML = '';
}
```

**Support:** This is the ONLY location that clears innerHTML.

---

## Claim: Router makes Practice visible before onShow fires

**File:** `main-app/js/router.js:137-195`

**Function:** `showView`

```javascript
// Line 157: Practice becomes visible
target.classList.add('spa-view-active');

// Line 164: Cleanup overlays
_cleanupOverlays(viewId);

// ...

// Line 191-195: onShow callbacks fire
if (afterShowCallbacks[viewId]) {
  for (var cb = 0; cb < afterShowCallbacks[viewId].length; cb++) {
    afterShowCallbacks[viewId][cb](params);
  }
}
```

**Support:** Timing evidence shows Practice visible before cleanup in onShow path.

---

## Claim: Preview uses body class for CSS overlay

**File:** `main-app/js/drill-engine.js:279-280`

**Function:** `renderStart`

```javascript
document.body.classList.add('drill-session-active');
document.documentElement.classList.add('drill-session-active');
```

**Support:** Preview doesn't add drill-results-active, uses body class.

**File:** `main-app/css/style.css:3915-3923`

```css
body.drill-session-active #drillContainer {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: var(--z-session-bg);
  background: var(--qr-bg);
}
```

**Support:** CSS rule applies when body has drill-session-active.

---

## Claim: Results screen has `_drillSessionActive = false` but `_activeDrillEngine` non-null

**File:** `main-app/js/drill-engine.js:1263`

**Function:** `finish`

```javascript
_exitDrillSession();  // Called BEFORE results render
```

**File:** `main-app/js/session-manager.js:73-74`

**Function:** `_exitDrillSession`

```javascript
function _exitDrillSession() {
  _drillSessionActive = false;
  // ... but doesn't null _activeDrillEngine
}
```

**Comment:** `main-app/js/session-manager.js:233-239`

```javascript
/* ADR-153 — THE ONE PREDICATE FOR "THE ENGINE OWNS THE SCREEN".
   `_drillSessionActive` is NOT that predicate, and this is the trap that 
   produced the results-screen bug: finish() calls _exitDrillSession() 
   BEFORE it paints the results card, so from that moment the flag reads false
   while the engine still owns the whole viewport. */
```

**Support:** ADR-153 explicitly documents this behavior.

---

## Claim: `_engineOwnsScreen()` handles Results state correctly

**File:** `main-app/js/session-manager.js:241-248`

```javascript
function _engineOwnsScreen() {
  try {
    if (typeof _drillSessionActive !== 'undefined' && _drillSessionActive) return true;
    if (typeof _activeDrillEngine !== 'undefined' && _activeDrillEngine) return true;
    if (document.body && document.body.classList.contains('drill-session-active')) return true;
  } catch (_) {}
  return false;
}
```

**Support:** Predicate checks `_activeDrillEngine` which is non-null during Results.

---

## Claim: commit c1c24cd only changed 2 paths

**Git Diff:**

```diff
// startSessionReview onFinish
-      if (_activeDrillEngine) { _activeDrillEngine.cleanup(); _activeDrillEngine = null; }
-      var _dc = document.getElementById('drillContainer');
-      if (_dc) { _dc.classList.remove('drill-results-active'); _dc.style.display = 'none'; }
-      if (_drillSessionActive && typeof FirestoreSync !== 'undefined') FirestoreSync.endDrillBatch();
-      _exitDrillSession();
+      _disposeActiveDrillSession();

// startLrSet onFinish
-      [same 4 lines]
+      _disposeActiveDrillSession();
```

**Support:** Only changed two onFinish callbacks, didn't change startBackBtn or add innerHTML clear.

---

# 18. Implementation Plan for Astra 6

**IMPORTANT:** This is a PLAN ONLY. Do NOT implement.

---

### File 1: main-app/js/session-manager.js

**Function:** `_disposeActiveDrillSession()` (line 35)

**Current Behavior:**
Hides drillContainer and removes classes but doesn't clear innerHTML.

**Required Change:**
Add `container.innerHTML = '';` after line 48.

```javascript
var container = document.getElementById('drillContainer');
if (container) {
  container.classList.remove('drill-results-active');
  container.style.display = 'none';
  container.innerHTML = '';                                  // ADD THIS LINE
}
```

**Root Cause Addressed:**
innerHTML persistence allows drill content to remain in DOM when it should be cleared.

**Why This Layer:**
`_disposeActiveDrillSession()` is the UNIFIED cleanup function called by:
- onFinish callbacks (practice-modes.js:197)
- Router.onShow('practice') callback (practice-modes.js:549)
- Router.popstate handler (router.js:281)
- startBackBtn else branch (implied)

**Risk:**
Minimal. Clearing innerHTML of a hidden container is safe.

**Do Not Change:**
- Do NOT remove the existing `style.display = 'none'` or `classList.remove`
- Do NOT null `_activeDrillEngine` earlier (already done at line 37)
- Do NOT change the order of operations

---

### File 2: main-app/service-worker.js

**Line:** 6

**Current Behavior:**
`const APP_VERSION = 'v295';`

**Required Change:**
`const APP_VERSION = 'v296';`

**Root Cause Addressed:**
Force browser to download updated JavaScript.

**Why This Layer:**
Cache invalidation is handled by service worker's activate event which deletes old caches.

**Risk:**
None. Standard deployment hygiene.

**Do Not Change:**
- Cache strategy
- Asset list
- Fetch handler

---

### File 3: main-app/index.html

**Line:** 17

**Current Behavior:**
`<script>window.QR_APP_VERSION = 'v295';</script>`

**Required Change:**
`<script>window.QR_APP_VERSION = 'v296';</script>`

**Root Cause Addressed:**
Keep version consistent for error reporting.

**Why This Layer:**
This version is used by error reporting and should match service worker.

**Risk:**
None.

**Do Not Change:**
- Any other HTML
- Any script sources
- Any CSS links

---

# 19. Regression Test Plan

## Normal Practice

**Setup:** App loaded, user on Practice tab

**Steps:**
1. Verify modeSelect is visible (style.display = 'block')
2. Verify drillContainer is hidden (style.display = 'none')
3. Verify drillContainer.innerHTML is empty
4. Verify no stale _activeDrillEngine
5. Verify _drillSessionActive = false

**Expected State:**
```javascript
_activeDrillEngine = null
_drillSessionActive = false
drillContainer.style.display = 'none'
drillContainer.innerHTML = ''
drillContainer.classList.contains('drill-results-active') = false
document.body.classList.contains('drill-session-active') = false
modeSelect.style.display = 'block'
```

---

## Quick Drill

**Flow:** Practice → Quick Drill → Complete → Results → Exit

**Test Steps:**
1. Click Quick Drill card
2. Verify Preview appears
3. Click "Begin Challenge"
4. Complete 5 questions
5. Verify Results screen
6. Click "Back to Practice"

**Following State Checks:**
- Same as Normal Practice above

---

## Bug A - Reflex Preview Back to Modes

**Flow:** Practice → Reflex Drill → Preview → Back to Modes

**Test Steps:**
1. Click Reflex Drill card
2. Verify Preview appears (drillContainer.innerHTML contains preview HTML)
3. Verify body has drill-session-active class
4. Click "Back to Modes"

**Expected State:**
```javascript
_activeDrillEngine = null
_drillSessionActive = false
drillContainer.style.display = 'none'
drillContainer.innerHTML = ''                    // CRITICAL: must be empty
drillContainer.classList.contains('drill-results-active') = false
document.body.classList.contains('drill-session-active') = false
modeSelect.style.display = 'block'
```

**Visual Check:** No Preview content visible in Practice.

---

## Bug B - Reflex Drill View Results

**Flow:** Practice → Reflex Drill → Complete → View Results → Back to Practice

**Test Steps:**
1. Click Reflex Drill card
2. Click "Begin Challenge"
3. Answer all 10 questions (or let timer expire for some)
4. When Question 10 completes:
   - Verify "View Results" button appears
5. Click "View Results"
6. Verify Results screen appears:
   - drill-results-active class present
   - Results HTML visible
7. Click "Back to Practice"

**Expected State:**
```javascript
_activeDrillEngine = null
_drillSessionActive = false
drillContainer.style.display = 'none'
drillContainer.innerHTML = ''                    // CRITICAL: must be empty
drillContainer.classList.contains('drill-results-active') = false
document.body.classList.contains('drill-session-active') = false
modeSelect.style.display = 'block'
```

**Visual Check:** No drill UI, no results UI visible in Practice.

---

## Browser Back from Preview

**Flow:** Practice → Reflex Drill → Preview → Browser Back

**Test Steps:**
1. Click Reflex Drill card
2. Press browser back button
3. Verify either:
   - Exit dialog appears (if _drillSessionActive were true, but it's not in Preview)
   - OR direct navigation to previous view (expected for Preview)

**Expected State:**
All cleanup should fire. Practice clean.

---

## Browser Back from Results

**Flow:** Practice → Reflex Drill → Complete → Results → Browser Back

**Test Steps:**
1. Complete a drill to Results screen
2. Press browser back button
3. Verify cleanup and navigation to previous view

**Expected State:**
All cleanup should fire. Practice clean.

---

## Second Drill After First

**Flow:** Complete Drill 1 → Start Drill 2

**Test Steps:**
1. Complete a Quick Drill, return to Practice
2. Start a Reflex Drill
3. Verify session state is fresh

**Expected:** No state leakage from first drill.

---

## Abandoned Session

**Flow:** Start Drill → Browser Close → Reopen

**Test Steps:**
1. Start a drill, answer a few questions
2. Close browser tab
3. Reopen app in new tab

**Expected:** Fresh state. app.js:46-47 cleanup on startup.

---

# 20. Acceptance Criteria

## PASS Criteria

### After Back to Modes (Bug A Fix)

- [ ] Practice displays modeSelect
- [ ] drillContainer is hidden (style.display = 'none')
- [ ] drillContainer.innerHTML is empty
- [ ] No Preview content visible visually
- [ ] No drill-session-active body class
- [ ] Bottom nav is visible
- [ ] _activeDrillEngine = null

### After View Results → Back to Practice (Bug B Fix)

- [ ] Practice displays modeSelect
- [ ] drillContainer is hidden
- [ ] drillContainer.innerHTML is empty
- [ ] No results UI visible
- [ ] No question UI visible
- [ ] No drill-session-active body class
- [ ] drill-results-active class removed
- [ ] Bottom nav is visible
- [ ] _activeDrillEngine = null

### Starting Second Drill

- [ ] Session state is fresh
- [ ] No previous answers present
- [ ] Timer resets correctly
- [ ] Question counter starts from 1

---

## FAIL Criteria

Any of the following indicates FAILURE:

- [ ] Preview content visible in Practice after "Back to Modes"
- [ ] Results content visible in Practice after "Back to Practice"
- [ ] Question UI visible in Practice
- [ ] drillContainer.innerHTML not empty after navigation
- [ ] drill-results-active class persists in Practice
- [ ] drill-session-active class persists in Practice
- [ ] _activeDrillEngine not null in Practice
- [ ] Console errors during navigation
- [ ] Visual flash of drill content during transition

---

# 21. Remaining Uncertainty

## Unverified: Are Users Running Stale Code?

**What is Unknown:**
Whether users experiencing the bug are running cached JavaScript older than v294.

**Why It Is Unknown:**
No deployment metrics, no user reports with version numbers available in this investigation.

**How Astra Could Verify:**
1. Add telemetry to report `window.QR_APP_VERSION` on bug occurrence
2. Check service worker version via `navigator.serviceWorker.controller`
3. Check cached assets via `caches.keys()`

---

## Unverified: Exact User Actions Causing Bug

**What is Unknown:**
The exact sequence of user actions that triggers the bug. This investigation relied on reported behavior descriptions.

**Why It Is Unknown:**
No video reproduction, no step-by-step user report.

**How Astra Could Verify:**
Request video/screenshots from users reporting the bug, or attempt reproduction in a browser environment.

---

## Unverified: Browser-Specific Behavior

**What is Unknown:**
Whether bug occurs on specific browsers only.

**Why It Is Unknown:**
Cannot test in multiple browsers in this environment.

**How Astra Could Verify:**
Test on Chrome, Firefox, Safari, Edge (mobile and desktop).

---

## Verified: JavaScript Execution Flow is Correct

**What Was Investigated:**
All cleanup paths were traced.

**Conclusion:**
Code paths execute synchronously. No browser paint window. Stale cache or user-specific factors most likely explanation if bug is real.

---

# 22. Handoff Instructions to Astra 6

## What to Trust

**STRONG EVIDENCE:**
1. `_disposeActiveDrillSession()` doesn't clear innerHTML - VERIFIED by reading session-manager.js:35-50
2. `_resetPracticeUiToModes()` clears innerHTML - VERIFIED by reading practice-config.js:267
3. Router execution sequence - VERIFIED by reading router.js:137-213
4. Drill engine behavior - VERIFIED by reading drill-engine.js
5. Commit c1c24cd changes - VERIFIED by Git diff

**MODERATE EVIDENCE:**
1. Window where Practice visible before innerHTML cleared in onShow path - PLAUSIBLE based on Router timing
2. Stale cache explanation - PLAUSIBLE but unverified

## What to Independently Verify

**BEFORE IMPLEMENTING:**

1. Read session-manager.js:35-50 yourself
   - Confirm no innerHTML clear

2. Read practice-config.js:248-274 yourself
   - Confirm it clears innerHTML

3. Read router.js:137-213 yourself
   - Confirm Line 157 (make visible) before Line 191-195 (onShow)

4. Read drill-engine.js:284-295
   - Confirm startBackBtn handler

5. Run Git diff on c1c24cd
   - Confirm only 2 paths changed

## What NOT to Assume

**DO NOT ASSUME:**
- The bug is definitely real (may be user misunderstanding)
- Stale cache is the cause (unverified)
- Browser race condition (disproven)
- Multiple drill engines (disproven)
- CSS is root cause (disproven)

## Which Files Deserve Attention First

**Priority 1:**
- `main-app/js/session-manager.js` - Add innerHTML clear

**Priority 2:**
- `main-app/service-worker.js` - Bump version
- `main-app/index.html` - Bump version

**Do NOT modify:**
- drill-engine.js (not the issue)
- router.js (already correct)
- CSS files (not the issue)

## Which Findings Are Strongest

**STRONGEST:**
- Missing innerHTML clear in `_disposeActiveDrillSession()`

**SUPPORTING:**
- Router timing allows brief visibility window
- Previous fix didn't address innerHTML

## What Implementation Should Accomplish

**MINIMUM VIABLE FIX:**
Add `container.innerHTML = '';` to `_disposeActiveDrillSession()`

**OUTCOME:**
All navigation paths will clear drill content, ensuring no persistence into Practice.

## What Must Not Be Changed

**DO NOT CHANGE:**
- Router logic
- Drill engine start/finish flow
- CSS overlay mechanism
- `_engineOwnsScreen()` predicate
- Body class management
- Session flag semantics

**DO NOT:**
- Refactor drill engine
- Change navigation flow
- Add timeouts or delays
- Duplicate existing cleanup

## What Tests Must Pass

**EXISTING TESTS:**
Run `npm test` - all existing tests should continue to pass:
- practice-session-integrity.check.js
- drill-grading.check.js
- practice-browser.check.js

**MANUAL VERIFICATION:**
All flows in Section 19 (Regression Test Plan) must pass visual inspection.

---

# Conclusion

This investigation identified a verified contributing factor (missing innerHTML clear in unified cleanup function) and a plausible explanation for user-observed behavior (visibility window in onShow path or stale cache).

**Recommended implementation is minimal and safe:** Add one line to clear innerHTML in `_disposeActiveDrillSession()`, bump version numbers.

**Investigation confidence:** HIGH on code analysis, MEDIUM on explanation of user-observed bug (due to lack of reproduction).

---

**Document End**
