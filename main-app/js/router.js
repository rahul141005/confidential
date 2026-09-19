/**
 * router.js — Simple vanilla SPA router
 *
 * Manages view switching by showing/hiding sections.
 * Supports hash-based navigation and bottom nav active states.
 */

var Router = (function () {
  var currentView = null;
  var viewInitCallbacks = {};
  var afterShowCallbacks = {};
  var _navigatingFromPopstate = false;

  /* Parse a location hash into a view id + optional sub-path (ADR-069, deep links like #learn/percentages).
     Single-segment hashes (#home, #learn) are unchanged → fully backwards-compatible. */
  function _parseHash(raw) {
    var h = (raw || '').replace(/^#/, '');
    if (!h) return { view: 'home', path: null };
    var slash = h.indexOf('/');
    if (slash === -1) return { view: h, path: null };
    return { view: h.slice(0, slash), path: h.slice(slash + 1) || null };
  }

  function onInit(viewId, callback) {
    viewInitCallbacks[viewId] = callback;
  }

  function onShow(viewId, callback) {
    if (!afterShowCallbacks[viewId]) afterShowCallbacks[viewId] = [];
    afterShowCallbacks[viewId].push(callback);
  }

  /**
   * ADR-126: re-run the CURRENT view's show hooks without navigating.
   *
   * Re-rendering a view in place used to mean calling showView() with the view it was already on, which
   * does three things that are wrong for an in-place refresh:
   *   - it re-adds .spa-view-active, so the view REPLAYS its viewSlideIn entry animation (opacity 0 -> 1).
   *     During a language morph that is a second, competing animation, and suppressing it with a class
   *     only defers the problem: a CSS animation restarts the moment its name becomes non-none again, so
   *     removing the suppression at cleanup made the view flash from opacity 0 at the very end.
   *   - it resets scroll (`window.scrollTo(0,0)` + `.container.scrollTop = 0`) with no same-view guard,
   *     and .container is scroll-behavior:smooth, so the user visibly glided to the top.
   *   - it pushes history state.
   * None of that belongs to "the strings changed, re-render". This runs only the onShow hooks, which is
   * the part that actually rebuilds JS-rendered content, and it is also ~half the work.
   */
  function refreshCurrentView() {
    if (!currentView) return false;
    var cbs = afterShowCallbacks[currentView];
    if (!cbs) return false;
    for (var i = 0; i < cbs.length; i++) {
      try { cbs[i](); } catch (_) { /* one bad hook must not abort the refresh */ }
    }
    return true;
  }

  /**
   * Globally destroys all active overlays, modals, and sessions.
   * Called on auth transitions or major route shifts to ensure a clean slate.
   */
  function _cleanupOverlays(targetViewId) {
    if (typeof hideCustomNumpad === 'function') hideCustomNumpad();

    var _drillContainer = document.getElementById('drillContainer');
    if (_drillContainer) {
      /* Results intentionally run after _exitDrillSession() and are still
         owned by _activeDrillEngine. Do not hide that screen based on the
         session flag alone. */
      var _drillOwnsScreen = (typeof _engineOwnsScreen === 'function')
        ? _engineOwnsScreen()
        : (typeof _drillSessionActive !== 'undefined' && _drillSessionActive);
      try {
        var _ms = document.getElementById('modeSelect');
        if (typeof QRDiagnostic !== 'undefined') {
          QRDiagnostic.log('ROUTER', '_cleanupOverlays', 'drillContainer_decision', {
            targetViewId: targetViewId,
            drillContainerFound: !!_drillContainer,
            _activeDrillEngine: typeof _activeDrillEngine !== 'undefined' ? !!_activeDrillEngine : null,
            _drillSessionActive: typeof _drillSessionActive !== 'undefined' ? _drillSessionActive : null,
            _engineOwnsScreenResult: typeof _engineOwnsScreen === 'function' ? _engineOwnsScreen() : null,
            _drillOwnsScreen: _drillOwnsScreen,
            drillContainerDisplay: _drillContainer ? _drillContainer.style.display : null,
            drillContainerClassName: _drillContainer ? _drillContainer.className : null,
            modeSelectDisplay: _ms ? _ms.style.display : null,
            bodyClassName: document.body ? document.body.className : '',
            htmlClassName: document.documentElement ? document.documentElement.className : '',
            willHideContainer: !_drillOwnsScreen
          });
        }
      } catch (_) {}
      /* Bug A Fix: Browser Back from Preview leaves drillContainer stuck because
         _engineOwnsScreen() returns true (engine was instantiated for Preview).
         When navigating to 'practice' and the engine owns the screen, check if
         we're on the Preview start screen (NOT the Results card). If so, safely
         dispose the engine and restore modeSelect. The .drill-results-active
         guard ensures the Results card is NEVER torn down by this path. */
      if (_drillOwnsScreen && (typeof _drillSessionActive === 'undefined' || !_drillSessionActive) &&
          targetViewId === 'practice' &&
          !_drillContainer.classList.contains('drill-results-active') &&
          _drillContainer.querySelector('.drill-start')) {
        try {
          if (typeof QRDiagnostic !== 'undefined') {
            QRDiagnostic.log('ROUTER', '_cleanupOverlays', 'bugA_preview_popstate_dispose', {
              targetViewId: targetViewId,
              hasResultsActive: _drillContainer.classList.contains('drill-results-active'),
              hasDrillStart: !!_drillContainer.querySelector('.drill-start')
            });
          }
        } catch (_) {}
        if (typeof _disposeActiveDrillSession === 'function') {
          _disposeActiveDrillSession();
        }
        /* _disposeActiveDrillSession hides drillContainer and clears the engine.
           Restore modeSelect so the user sees the practice mode cards. */
        var _modeSelect = document.getElementById('modeSelect');
        if (_modeSelect) _modeSelect.style.display = 'block';
        /* Engine is now disposed — skip the original _drillOwnsScreen branch */
      } else if (!_drillOwnsScreen) {
        _drillContainer.classList.remove('drill-results-active');
        _drillContainer.style.display = 'none';
      }
    }

    var _onboardingOverlay = document.getElementById('onboardingOverlay');
    if (_onboardingOverlay && _onboardingOverlay.style.display !== 'none') {
      _onboardingOverlay.style.display = 'none';
      if (typeof Onboarding !== 'undefined' && typeof Onboarding.forceCleanup === 'function') {
        Onboarding.forceCleanup();
      }
    }

    var _paywallOverlay = document.getElementById('paywallModalOverlay');
    if (_paywallOverlay) {
      /* FW-W2: close through the paywall's QROverlay handle first so its document-level key
         listener and ref-counted body lock are released; the instant removal below keeps this
         teardown synchronous (the handle's own delayed removal then no-ops). */
      if (typeof Paywall !== 'undefined' && Paywall.closeModal) { try { Paywall.closeModal(); } catch (_) {} }
      if (_paywallOverlay.parentNode) _paywallOverlay.parentNode.removeChild(_paywallOverlay);
      document.body.classList.remove('paywall-open');
    }

    /* Duel realtime: tear down ONLY when actually navigating AWAY from the duel view. Internal duel re-renders
       call showView('duel') on every screen change — tearing the listener down there silently kills realtime sync
       after the first snapshot (audit realtime-sync-01, the keystone defect). On a genuine nav-away, suspend()
       stops the listener AND the lobby/deadline polls (audit realtime-sync-02) while keeping state for the Home
       "Resume" card. */
    if (typeof DuelManager !== 'undefined' && DuelManager.isInDuel() && targetViewId !== 'duel') {
      if (typeof DuelManager.suspend === 'function') DuelManager.suspend();
      else if (typeof DuelCore !== 'undefined' && typeof DuelCore.stopListening === 'function') DuelCore.stopListening();
    }

    if (typeof _drillSessionActive !== 'undefined' && !_drillSessionActive) {
      document.body.classList.remove('drill-session-active');
      document.documentElement.classList.remove('drill-session-active');
    }

    /* ADR-163 — CLOSE OVERLAYS THROUGH THEIR OWN LIFECYCLE, DO NOT REACH PAST IT.
       This used to hide every `.modal-overlay` with style.display='none' and strip `body.modal-open`
       with a raw classList.remove. Both lines look harmless and neither decrements QROverlay's
       ref-count, so `_locks['modal-open']` stayed at 1 for the rest of the session: the class appeared
       to go away, then the NEXT overlay to open took the count to 2 and its close only brought it back
       to 1 — after which the class could never be removed again.
       Since ADR-158 that is a total input outage, not a scroll bug. `body.modal-open` is half of the
       drill engine's `_blockedByOverlay()`, which now gates the numpad pointer handler, the physical
       keyboard, both MCQ handlers and both Submit paths — so no question in any drill or duel could be
       answered until the app was restarted. The trigger is the most ordinary gesture on Android:
       hardware Back while a Settings modal (Clear Data, Delete Account, Profile) or the Learn
       custom-topic editor is open.
       This is the same mistake ADR-155 fixed in _exitDrillSession, in a second place. releaseAll()
       exists so there is one supported answer rather than a third hand-rolled teardown. */
    if (typeof QROverlay !== 'undefined' && typeof QROverlay.releaseAll === 'function') {
      try { QROverlay.releaseAll(); } catch (_) { /* fall through to the legacy sweep below */ }
    }
    /* Legacy sweep, kept for static modals that were never opened through QROverlay at all (they hold
       no handle and no lock, so hiding them is the whole teardown). Harmless after releaseAll(). */
    var _allModals = document.querySelectorAll('.modal-overlay');
    for (var m = 0; m < _allModals.length; m++) {
      _allModals[m].style.display = 'none';
    }
  }

  function showView(viewId, params) {
    try {
      if (typeof QRDiagnostic !== 'undefined') {
        QRDiagnostic.log('ROUTER', 'showView', 'start', {
          currentView: currentView,
          targetView: viewId,
          params: params
        });
      }
    } catch (_) {}

    /* ADR-107 hardening: a pending one-shot drill resume hook (window.__qrResumeAfterUpgrade, set when a free user
       pauses at the daily cap) is only valid within an uninterrupted paused session. Any view navigation invalidates
       it, so drop it here — a later upgrade from elsewhere must fall through to the normal refresh, never fire
       renderQuestion() into a hidden/torn-down engine. The happy-path resume runs renderQuestion() and returns
       before any showView(), so this never clears a live resume. */
    if (typeof window !== 'undefined' && window.__qrResumeAfterUpgrade) window.__qrResumeAfterUpgrade = null;

    var views = document.querySelectorAll('.spa-view');
    for (var i = 0; i < views.length; i++) {
      views[i].classList.remove('spa-view-active');
    }

    var target = document.getElementById('view-' + viewId);
    if (!target) {
      target = document.getElementById('view-home');
      viewId = 'home';
      params = undefined;   // unknown view: drop any stale sub-path so the URL canonicalizes to #home, not #home/<garbage>
    }
    target.classList.add('spa-view-active');
    /* Practice owns its own scroll shell — neutralize the app-level .container scroller so the
       fixed header and bottom nav never drift (ADR-011). */
    document.body.classList.toggle('view-practice-active', viewId === 'practice');
    /* Learn opts into the wider responsive shell (ADR-069); scoped via this body class so no other view changes. */
    document.body.classList.toggle('view-learn-active', viewId === 'learn');

    _cleanupOverlays(viewId);
    
    if (typeof _drillSessionActive !== 'undefined' && !_drillSessionActive) {
      if (document.body.classList.contains('auth-resolved')) {
        var _nav = document.querySelector('.bottom-nav');
        if (_nav) _nav.style.display = '';
      }
    }

    var navLinks = document.querySelectorAll('.bottom-nav a');
    for (var j = 0; j < navLinks.length; j++) {
      var isActive = navLinks[j].getAttribute('data-view') === viewId;
      navLinks[j].classList.toggle('active', isActive);
      if (isActive) navLinks[j].setAttribute('aria-current', 'page'); else navLinks[j].removeAttribute('aria-current');
    }

    if (currentView && currentView !== viewId) {
      if (typeof EventRegistry !== 'undefined') {
        EventRegistry.clearViewListeners(currentView);
      }
    }

    if (viewInitCallbacks[viewId]) {
      try {
        if (typeof QRDiagnostic !== 'undefined') QRDiagnostic.log('ROUTER', 'viewInitCallbacks', 'invoking', { viewId: viewId });
      } catch (_) {}
      viewInitCallbacks[viewId](params);
      delete viewInitCallbacks[viewId];
    }

    if (afterShowCallbacks[viewId]) {
      try {
        if (typeof QRDiagnostic !== 'undefined') QRDiagnostic.log('ROUTER', 'afterShowCallbacks', 'invoking', { viewId: viewId, count: afterShowCallbacks[viewId].length });
      } catch (_) {}
      for (var cb = 0; cb < afterShowCallbacks[viewId].length; cb++) {
        afterShowCallbacks[viewId][cb](params);
      }
    }

    currentView = viewId;

    var _targetHash = '#' + viewId + (params && params.path ? '/' + params.path : '');
    if (!_navigatingFromPopstate && window.location.hash !== _targetHash) {
      try {
        history.pushState({ view: viewId, path: (params && params.path) || null }, '', _targetHash);
      } catch(e) {
        window.location.hash = _targetHash;
      }
    }

    window.scrollTo(0, 0);
    var _scrollContainer = document.querySelector('.container');
    if (_scrollContainer) _scrollContainer.scrollTop = 0;

    try {
      if (typeof QRDiagnostic !== 'undefined') {
        QRDiagnostic.log('ROUTER', 'showView', 'completed', {
          activeView: viewId,
          hash: window.location.hash
        });
      }
    } catch (_) {}
  }

  function getCurrentView() {
    return currentView;
  }

  function init() {

    var parsed = _parseHash(window.location.hash);
    var canonical = '#' + parsed.view + (parsed.path ? '/' + parsed.path : '');
    try {
      history.replaceState({ view: parsed.view, path: parsed.path }, '', canonical);
    } catch (e) {
      window.location.hash = canonical;
    }
    _navigatingFromPopstate = true;
    try {

       showView(parsed.view, parsed.path ? { path: parsed.path } : undefined);
    } catch(e) {
       console.error('[ERRORS] Router initialization failed:', e);
    } finally { 
       _navigatingFromPopstate = false; 
    }

    window.addEventListener('popstate', function () {
      try {
        if (typeof QRDiagnostic !== 'undefined') {
          QRDiagnostic.log('ROUTER', 'popstate', 'received', {
            currentHash: window.location.hash,
            _drillSessionActive: typeof _drillSessionActive !== 'undefined' ? _drillSessionActive : null
          });
        }
      } catch (_) {}

      /* Close any open info modals on navigation */
      if (typeof _closeAllInfoModals === 'function') _closeAllInfoModals();

      /* Duel solving/countdown: intercept Back so it can never silently leave an un-submitted duel (audit
         solving-exit-forfeit-01). The manager shows the Submit & Leave modal (solving) or absorbs it (countdown);
         re-push the duel state so the browser does not actually navigate.
         ADR-152 — THIS MUST BE TESTED BEFORE THE PRACTICE BRANCH BELOW. begin() calls _enterDrillSession()
         unconditionally (js/drill-engine.js), with no isDuel guard, so `_drillSessionActive` is TRUE during a duel
         too. While the practice branch ran first it swallowed every duel Back: DuelManager.handleBackNav() was
         unreachable during solving, the user got the practice exit dialog, and the duel engine was left orphaned —
         still holding its timers and still writing blank answers for the remaining questions, losing the match.
         Order is the whole fix: a duel is the more specific state, so it gets first refusal. */
      if (typeof DuelManager !== 'undefined' && typeof DuelManager.handleBackNav === 'function' && DuelManager.handleBackNav()) {
        try {
          history.pushState({ view: 'duel' }, '', '#duel');
        } catch (e) {
          window.location.hash = '#duel';
        }
        return;
      }

      /* If a drill session is active, show exit dialog instead of navigating */
      if (typeof _drillSessionActive !== 'undefined' && _drillSessionActive) {
        /* Push history state back to prevent the browser from actually navigating away */
        try {
          history.pushState({ view: 'practice' }, '', '#practice');
        } catch (e) {
          window.location.hash = '#practice';
        }

        if (typeof showExitSessionDialog === 'function') {
          showExitSessionDialog(function () {
            if (typeof _disposeActiveDrillSession === 'function') {
              _disposeActiveDrillSession();
            }
            showView('practice');
          });
        }
        return;
      }

      /* Non-session popstate: clean up any stale drill state */
      if (typeof _disposeActiveDrillSession === 'function') _disposeActiveDrillSession();

      var parsed = _parseHash(window.location.hash);
      _navigatingFromPopstate = true;
      try { showView(parsed.view, parsed.path ? { path: parsed.path } : undefined); } finally { _navigatingFromPopstate = false; }
    });
  }

  function teardown() {

    var views = document.querySelectorAll('.spa-view');
    for (var i = 0; i < views.length; i++) {
      views[i].classList.remove('spa-view-active');
    }
    currentView = null;
    /* S2-NAV3: do NOT wipe the hash here. A logged-out cold start (auth resolves to no-user →
       setAppState('unauthenticated') → teardown) would otherwise destroy a deep link like
       #learn/percentages before the login screen appears, so after login Router.init() read an empty
       hash and always landed on #home. Preserving the hash lets the intended route replay post-login.
       (Reload-based logouts re-read the URL anyway, so this is safe for them.) */

    var navLinks = document.querySelectorAll('.bottom-nav a');
    for (var j = 0; j < navLinks.length; j++) {
      navLinks[j].classList.remove('active');
      navLinks[j].removeAttribute('aria-current');
    }
    
    var _allModals = document.querySelectorAll('.modal-overlay');
    for (var m = 0; m < _allModals.length; m++) {
      _allModals[m].style.display = 'none';
    }

    /* Clean up all registered event listeners to prevent leaks across login/logout */
    if (typeof EventRegistry !== 'undefined' && typeof EventRegistry.clearAll === 'function') {
      EventRegistry.clearAll();
    }
  }

  return {
    init: init,
    showView: showView,
    getCurrentView: getCurrentView,
    onInit: onInit,
    onShow: onShow,
    refreshCurrentView: refreshCurrentView,
    teardown: teardown
  };
})();
