/**
 * diagnostic-logger.js — Forensic Runtime Diagnostic Logger for QuantReflex
 *
 * Temporary non-functional diagnostic utility for Phase 2 investigation.
 * Captures structured lifecycle events across Router, Practice Controller,
 * Drill Engine, Session Manager, Persistence, and Update Manager.
 *
 * Exposes global `window.QRDiagnostic` and persistent storage under `qr_debug_investigation`.
 * ZERO sensitive data: passwords, tokens, API keys, credentials, and PII are strictly excluded.
 */
(function (root) {
  'use strict';

  var MAX_MEMORY_LOGS = 1000;
  var MAX_STORAGE_LOGS = 100;
  var STORAGE_KEY = 'qr_debug_investigation';

  var _logs = [];
  var _seq = 0;
  var _enabled = true;

  // Restore prior logs from localStorage (preserves pre-reload events across Bug D update reloads)
  try {
    var stored = root.localStorage ? root.localStorage.getItem(STORAGE_KEY) : null;
    if (stored) {
      var parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        _logs = parsed;
        if (_logs.length > 0) {
          _seq = _logs[_logs.length - 1].seq || 0;
        }
      }
    }
  } catch (_) {}

  function _getElDisplay(id) {
    try {
      var el = root.document ? root.document.getElementById(id) : null;
      return el ? (el.style.display !== '' ? el.style.display : (root.getComputedStyle ? root.getComputedStyle(el).display : '')) : 'NOT_FOUND';
    } catch (_) {
      return 'ERR';
    }
  }

  function _getElClasses(id) {
    try {
      var el = root.document ? root.document.getElementById(id) : null;
      return el ? el.className : 'NOT_FOUND';
    } catch (_) {
      return 'ERR';
    }
  }

  function _snapshotDomState() {
    if (!root.document) return {};
    return {
      drillContainerDisplay: _getElDisplay('drillContainer'),
      drillContainerClasses: _getElClasses('drillContainer'),
      drillContainerInnerLen: (function () {
        var el = root.document.getElementById('drillContainer');
        return el ? (el.innerHTML ? el.innerHTML.length : 0) : -1;
      })(),
      modeSelectDisplay: _getElDisplay('modeSelect'),
      categorySelectDisplay: _getElDisplay('categorySelect'),
      exitModalDisplay: _getElDisplay('exitSessionModal'),
      bodyClasses: root.document.body ? root.document.body.className : '',
      htmlClasses: root.document.documentElement ? root.document.documentElement.className : ''
    };
  }

  function _snapshotEngineState() {
    return {
      activeEngineExists: typeof root._activeDrillEngine !== 'undefined' ? !!root._activeDrillEngine : null,
      drillSessionActive: typeof root._drillSessionActive !== 'undefined' ? !!root._drillSessionActive : null,
      engineOwnsScreen: typeof root._engineOwnsScreen === 'function' ? root._engineOwnsScreen() : null,
      currentRoute: (typeof root.Router !== 'undefined' && root.Router.getCurrentView) ? root.Router.getCurrentView() : (root.location ? root.location.hash : '')
    };
  }

  function log(category, fnName, eventName, data) {
    if (!_enabled) return;
    try {
      _seq++;
      var now = Date.now();
      var record = {
        seq: _seq,
        ts: now,
        time: new Date(now).toLocaleTimeString() + '.' + String(now % 1000).padStart(3, '0'),
        cat: category || 'GENERAL',
        fn: fnName || 'anonymous',
        event: eventName || 'event',
        data: data || {},
        engineState: _snapshotEngineState(),
        domState: _snapshotDomState()
      };

      _logs.push(record);
      if (_logs.length > MAX_MEMORY_LOGS) {
        _logs.shift();
      }

      // Persist ring buffer to localStorage (survives app update reload)
      if (root.localStorage) {
        try {
          var persisted = _logs.slice(-MAX_STORAGE_LOGS);
          root.localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
        } catch (_) {}
      }

      // Console output with colored categorization
      if (root.console && root.console.log) {
        var color = '#3b82f6';
        if (category === 'ROUTER') color = '#8b5cf6';
        else if (category === 'PRACTICE') color = '#06b6d4';
        else if (category === 'ENGINE') color = '#10b981';
        else if (category === 'SESSION') color = '#f59e0b';
        else if (category === 'UPDATE') color = '#ef4444';
        else if (category === 'DOM') color = '#ec4899';
        else if (category === 'SYNC') color = '#14b8a6';

        root.console.log(
          '%c[QR-DIAG][' + category + '] ' + fnName + ' ➔ ' + eventName,
          'color: ' + color + '; font-weight: bold;',
          data || '',
          record.engineState
        );
      }
    } catch (_) {}
  }

  function getLogs(filterCat) {
    if (!filterCat) return _logs.slice();
    return _logs.filter(function (l) { return l.cat === filterCat; });
  }

  function dumpLogs(filterCat) {
    var list = getLogs(filterCat);
    if (!root.console) return;
    root.console.group('=== QUANTREFLEX DIAGNOSTIC AUDIT LOGS (' + list.length + ' entries) ===');
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      root.console.log(
        '#' + item.seq + ' [' + item.time + '][' + item.cat + '][' + item.fn + '] ' + item.event,
        item.data,
        'Engine:', item.engineState,
        'DOM:', item.domState
      );
    }
    root.console.groupEnd();
    return list.length;
  }

  function clearLogs() {
    _logs = [];
    _seq = 0;
    try {
      if (root.localStorage) root.localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
    if (root.console) root.console.log('[QR-DIAG] Logs cleared.');
  }

  function exportLogsJson() {
    return JSON.stringify(_logs, null, 2);
  }

  function _initDomObservers() {
    if (typeof root.MutationObserver === 'undefined' || typeof root.document === 'undefined') return;

    var _observed = {};
    var observer = new root.MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        var target = m.target;
        if (!target || !target.id) continue;
        var elId = target.id;
        if (elId !== 'drillContainer' && elId !== 'modeSelect' && elId !== 'exitSessionModal') continue;

        var detail = {
          elementId: elId,
          type: m.type,
          attributeName: m.attributeName || null,
          display: target.style ? target.style.display : null,
          className: target.className || '',
          innerHTMLSnippet: (target.innerHTML || '').slice(0, 80),
          innerHTMLFullLength: (target.innerHTML || '').length
        };
        log('DOM', elId, 'mutation_' + m.type, detail);
      }
    });

    function _attach() {
      var targets = ['drillContainer', 'modeSelect', 'exitSessionModal'];
      for (var i = 0; i < targets.length; i++) {
        var el = root.document.getElementById(targets[i]);
        if (el && !_observed[targets[i]]) {
          observer.observe(el, {
            attributes: true,
            attributeFilter: ['style', 'class'],
            childList: true
          });
          _observed[targets[i]] = true;
          log('DOM', targets[i], 'observer_attached');
        }
      }
    }

    if (root.document.readyState === 'complete' || root.document.readyState === 'interactive') {
      _attach();
    } else {
      root.document.addEventListener('DOMContentLoaded', _attach);
    }
    var _retryCount = 0;
    var _timer = root.setInterval(function () {
      _attach();
      _retryCount++;
      if (_retryCount > 10 || (_observed['drillContainer'] && _observed['modeSelect'])) {
        root.clearInterval(_timer);
      }
    }, 500);
  }

  _initDomObservers();

  var QRDiagnostic = {
    log: log,
    getLogs: getLogs,
    dumpLogs: dumpLogs,
    clearLogs: clearLogs,
    exportLogsJson: exportLogsJson,
    setEnabled: function (b) { _enabled = !!b; },
    isEnabled: function () { return _enabled; }
  };

  root.QRDiagnostic = QRDiagnostic;
  root.__QR_GET_DEBUG_LOGS = getLogs;
  root.__QR_DUMP_DEBUG_LOGS = dumpLogs;
  root.__QR_CLEAR_DEBUG_LOGS = clearLogs;
  root.__QR_EXPORT_DEBUG_LOGS = exportLogsJson;

})(typeof globalThis !== 'undefined' ? globalThis : this);
