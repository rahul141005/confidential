/**
 * session-manager.js — Drill session lifecycle management
 *
 * Extracted from app.js. Manages:
 *   - Active drill engine reference (_activeDrillEngine)
 *   - Session active flag (_drillSessionActive)
 *   - Enter/exit session mode (nav bar, body class, numpad)
 *   - Exit confirmation dialog
 *   - Navigation transition guards
 *   - Practice action lock
 *
 * All functions remain as bare globals for backward compatibility.
 */

/* ---- Active drill engine reference for cleanup ---- */
var _activeDrillEngine = null;
var _navTransitionInProgress = false;
var _practiceActionLocked = false;
/* True only while user is actively answering questions (after START pressed) */
var _drillSessionActive = false;
/* Prevents multiple exit dialogs from stacking */
var _exitDialogShowing = false;
/* ADR-155: the live QROverlay handle for the exit dialog, so a force-exit can close it properly (see below). */
var _exitDialogHandle = null;

/**
 * Dispose the current drill engine and its screen ownership.
 *
 * The engine remains referenced after finish() so it can own the results card. A
 * real exit must release that reference before any route/show hook runs;
 * otherwise the router sees a stale engine, while the session flag says the
 * session is over. Keep this idempotent because several exit surfaces can
 * converge on the same Practice refresh.
 */
function _disposeActiveDrillSession() {
  try {
    if (typeof QRDiagnostic !== 'undefined') {
      QRDiagnostic.log('SESSION', '_disposeActiveDrillSession', 'start', {
        activeEngineExists: !!_activeDrillEngine,
        drillSessionActive: _drillSessionActive
      });
    }
  } catch (_) {}
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
    container.innerHTML = '';
  }
  try {
    if (typeof QRDiagnostic !== 'undefined') {
      QRDiagnostic.log('SESSION', '_disposeActiveDrillSession', 'completed');
    }
  } catch (_) {}
}

/**
 * Enter drill session mode:
 * - set session active flag
 * - hide bottom navigation bar for immersive experience
 * - add body class for CSS adjustments (numpad positioning)
 */
function _enterDrillSession() {
  try {
    if (typeof QRDiagnostic !== 'undefined') {
      QRDiagnostic.log('SESSION', '_enterDrillSession', 'enter');
    }
  } catch (_) {}
  _drillSessionActive = true;
  var nav = document.querySelector('.bottom-nav');
  if (nav) nav.style.display = 'none';
  document.body.classList.add('drill-session-active');
  document.documentElement.classList.add('drill-session-active');
}

/**
 * Exit drill session mode (unified cleanup):
 * - reset session flag
 * - restore bottom navigation bar
 * - remove body class
 * - hide custom numpad and clean up input state
 */
function _exitDrillSession() {
  try {
    if (typeof QRDiagnostic !== 'undefined') {
      QRDiagnostic.log('SESSION', '_exitDrillSession', 'enter');
    }
  } catch (_) {}
  _drillSessionActive = false;
  var nav = document.querySelector('.bottom-nav');
  if (nav) nav.style.display = '';
  document.body.classList.remove('drill-session-active');
  document.documentElement.classList.remove('drill-session-active');
  hideCustomNumpad();
  /* Clean up exit dialog state in case it was open when session was force-exited.
     ADR-155: close it THROUGH its QROverlay handle. The old code set display:none and removed body.modal-open
     directly, which never decremented QROverlay's per-class ref-count (js/ui/overlay.js _unlock). The counter
     stayed one too high, so the next overlay to close left `modal-open` on the body and the whole app became
     unscrollable until reload. Guarded + idempotent: handle.close() is a no-op on an already-closed overlay, and
     the direct teardown below still runs as the fallback for the no-controller path. */
  if (_exitDialogHandle) {
    var _h = _exitDialogHandle; _exitDialogHandle = null;
    try { if (typeof _h.close === 'function') _h.close(); } catch (_) {}
  }
  var exitModal = document.getElementById('exitSessionModal');
  if (exitModal) exitModal.style.display = 'none';
  _exitDialogShowing = false;
  document.body.classList.remove('modal-open');
}

function _tryBeginNavTransition() {
  if (_navTransitionInProgress) return false;
  _navTransitionInProgress = true;
  setTimeout(function () {
    _navTransitionInProgress = false;
  }, 220);
  return true;
}

function _tryPracticeAction() {
  if (_practiceActionLocked) return false;
  _practiceActionLocked = true;
  setTimeout(function () {
    _practiceActionLocked = false;
  }, 220);
  return true;
}

/**
 * Show a custom in-app exit confirmation dialog instead of native confirm().
 * Native confirm() can behave unreliably in some browser contexts,
 * sometimes ending the session even when Cancel is pressed.
 * @param {function} onConfirm - callback when user confirms exit
 */
function showExitSessionDialog(onConfirm, customOptions) {
  if (_exitDialogShowing) return;
  _exitDialogShowing = true;

  /* ADR-155 — THE DIALOG MUST FREEZE THE SESSION IT IS ASKING ABOUT.
     "End Session?" is a question, and a question takes time to answer. While it was up the drill's clocks kept
     running underneath it: on a Reflex Drill the per-question countdown reached zero and auto-submitted a BLANK
     answer, grading the live question wrong and filing it in the mistake archive as a knowledge failure; on a
     Timed Test the global countdown reached zero and ran finish() — painting the results card UNDERNEATH the
     dialog, after which confirming exit tore the session down a second time. Deliberating over a confirmation
     prompt must never cost the user the question they were on.
     This is the same freeze ADR-099 already applies to the in-drill report sheet, hoisted to the ONE place all
     three exit-dialog call sites share (drill-engine's two exit buttons and router.js's Back handler) so the
     behaviour cannot drift between them. Silent = no pause overlay; the dialog is already on top and owns focus.
     Only a session that is actually ticking is frozen, so an untimed Quick Drill is unaffected. */
  var _frozenEngine = null;
  try {
    if (typeof _activeDrillEngine !== 'undefined' && _activeDrillEngine &&
        typeof _activeDrillEngine.pauseForOverlay === 'function' && _activeDrillEngine.pauseForOverlay()) {
      _frozenEngine = _activeDrillEngine;
    }
  } catch (_) { /* a guard must never block the exit dialog itself */ }
  function _thawIfDismissed() {
    if (!_frozenEngine) return;
    var e = _frozenEngine; _frozenEngine = null;
    try { if (typeof e.resumeFromOverlay === 'function') e.resumeFromOverlay(); } catch (_) {}
  }

  var modal = document.getElementById('exitSessionModal');
  if (!modal) {
    console.error('[SessionManager] exitSessionModal missing from DOM');
    _exitDialogShowing = false;   // reset the guard so the dialog isn't wedged shut for the rest of the session
    onConfirm();
    return;
  }

  var titleEl = modal.querySelector('.modal-title');
  var descEl = modal.querySelector('p');
  var cancelBtn = document.getElementById('exitSessionCancel');
  var confirmBtn = document.getElementById('exitSessionConfirm');

  if (!cancelBtn || !confirmBtn) {
    console.error('[SessionManager] exitSession buttons missing from DOM');
    _exitDialogShowing = false;
    onConfirm();
    return;
  }

  /* Reset to defaults (honest copy — answered questions are already recorded) */
  /* ADR-111 stabilization: the confirm's static markup is data-i18n-tagged, but this JS reset overwrote it with
     English literals — route through the SAME modals.* keys so the dialog stays localized. Guarded for load-order. */
  function _smT(key, fb) { try { if (typeof QRI18n !== 'undefined') { var v = QRI18n.t(key); if (v !== key) return v; } } catch (_) {} return fb; }
  if (titleEl) titleEl.textContent = _smT('modals.exitSessionTitle', 'End Session?');
  if (descEl) descEl.innerHTML = _smT('modals.exitSessionBody', 'Answered questions are saved — this session just won’t get a summary.');
  cancelBtn.textContent = _smT('modals.keepGoing', 'Keep Going');
  confirmBtn.textContent = _smT('modals.endSession', 'End Session');

  /* Apply overrides */
  if (customOptions) {
    if (titleEl && customOptions.title) titleEl.textContent = customOptions.title;
    if (descEl && customOptions.messageHTML) descEl.innerHTML = customOptions.messageHTML;
    if (customOptions.cancelText) cancelBtn.textContent = customOptions.cancelText;
    if (customOptions.confirmText) confirmBtn.textContent = customOptions.confirmText;
  }

  modal.style.display = 'flex';

  /* UI Phase 1 / M3: wire the shared overlay lifecycle onto this static modal — adds focus-trap,
     Escape-to-cancel and focus-restore to the opener, on top of the scroll-lock/backdrop it already had.
     The static markup, guard, customOptions and i18n are all preserved. Close stays instant. */
  var handle = (typeof QROverlay !== 'undefined') ? QROverlay.open(modal, {
    dialogEl: modal.querySelector('.modal-content'),
    removeOnClose: false,
    closingClass: null,
    closeMs: 0,
    initialFocus: cancelBtn,   // land on the safe "Keep Going" choice, not the destructive one
    onClose: function () { _exitDialogShowing = false; _exitDialogHandle = null; _thawIfDismissed(); }   // cancel / backdrop / Escape / confirm
  }) : null;

  /* ADR-155 — remembered so _exitDrillSession() can close this dialog THROUGH the shared controller rather than
     reaching past it. Reaching past it (display:none + a raw classList.remove) left QROverlay's ref-counted
     body.modal-open counter permanently one too high, so the NEXT overlay to close could not clear the scroll
     lock — the page stayed unscrollable for the rest of the session. Reachable via the very bug above: a global
     timer expiring under this dialog ran finish() -> _exitDrillSession() while the dialog was still open. */
  _exitDialogHandle = handle;

  function closeDialog() {
    if (handle) { handle.close(); return; }
    modal.style.display = 'none';
    _exitDialogShowing = false;
    document.body.classList.remove('modal-open');
    _thawIfDismissed();   /* the no-controller fallback has no onClose to ride on */
  }

  cancelBtn.onclick = function () {
    try { if (typeof QRDiagnostic !== 'undefined') QRDiagnostic.log('session_manager', 'showExitSessionDialog:cancel_click', { action: 'keep_going' }); } catch (_) {}
    closeDialog();
    /* Session continues — do nothing else */
  };

  confirmBtn.onclick = function () {
    try { if (typeof QRDiagnostic !== 'undefined') QRDiagnostic.log('session_manager', 'showExitSessionDialog:confirm_click', { action: 'end_session' }); } catch (_) {}
    _frozenEngine = null;   /* confirmed: performExit() tears the engine down — never resume its clocks */
    closeDialog();
    onConfirm();
  };

  if (!handle) {
    /* Fallback wiring when the shared controller isn't loaded (defensive). */
    document.body.classList.add('modal-open');
    modal.onclick = function (e) { if (e.target === modal) closeDialog(); };
  }
}

/* ADR-153 — THE ONE PREDICATE FOR "THE ENGINE OWNS THE SCREEN".
   `_drillSessionActive` is NOT that predicate, and this is the trap that produced the results-screen bug:
   finish() calls _exitDrillSession() BEFORE it paints the results card, so from that moment the flag reads false
   while the engine still owns the whole viewport. Anything that consulted the flag alone therefore stood down
   during the drill and then happily tore down the score card the user was reading.
   `_activeDrillEngine` is the signal with the right lifetime — it is set for the entire engine lifetime (start
   screen, live questions, the free-quota pause panel AND the results card) and is nulled only by a deliberate
   navigation. Background repaints must consult THIS, never the raw flag.
   Exposed as a bare global to match the rest of this file's convention. */
function _engineOwnsScreen() {
  try {
    if (typeof _drillSessionActive !== 'undefined' && _drillSessionActive) return true;
    if (typeof _activeDrillEngine !== 'undefined' && _activeDrillEngine) return true;
    if (document.body && document.body.classList.contains('drill-session-active')) return true;
  } catch (_) { /* a guard must never throw into its caller */ }
  return false;
}

/* Prevent accidental page close / tab close during active drill sessions */
window.addEventListener('beforeunload', function (e) {
  if (_drillSessionActive) {
    e.preventDefault();
    /* Modern browsers require returnValue to be set */
    e.returnValue = '';

    /* Clear adaptive difficulty override so stale state doesn't persist
       if the user force-closes the tab mid-drill */
    if (typeof AdaptiveState !== 'undefined' && typeof AdaptiveState.clearDifficulty === 'function') {
      AdaptiveState.clearDifficulty();
    } else {
      window._adaptiveOverrideDifficulty = null;
    }
  }

  /* Always flush pending Firestore writes on page unload */
  if (typeof FirestoreSync !== 'undefined' && typeof FirestoreSync.flushUpdatesAsync === 'function') {
    FirestoreSync.flushUpdatesAsync();
  }
});

/* On mobile (especially PWAs), beforeunload is unreliable when the OS kills the app.
   Hook into visibilitychange to safely flush pending Firestore writes when backgrounded. */
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'hidden') {
    if (typeof FirestoreSync !== 'undefined' && typeof FirestoreSync.flushUpdatesAsync === 'function') {
      FirestoreSync.flushUpdatesAsync();
    }
  }
});
