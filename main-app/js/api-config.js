/**
 * api-config.js — Environment-aware API URL resolver for QuantReflex.
 *
 * In standard browser and PWA deployments, requests to /api/* remain root-relative
 * against the serving origin (e.g. https://quantreflex.app/api/*).
 *
 * In the Android WebView packaged build, the application origin is the virtual
 * WebViewAssetLoader domain (https://appassets.androidplatform.net). Because local
 * assets do not provide serverless API endpoints, all /api/* requests must route
 * to the canonical production backend (https://quantreflex.app/api/*).
 *
 * This module transparently adapts fetch() for /api/* paths ONLY when executing
 * under the Android WebView virtual origin, ensuring zero disruption to browser/PWA.
 */
(function (root) {
  'use strict';

  var isAppAssets = Boolean(
    root.location &&
    root.location.origin === 'https://appassets.androidplatform.net'
  );

  var CANONICAL_BACKEND = 'https://quantreflex.app';
  var API_BASE = isAppAssets ? CANONICAL_BACKEND : '';

  root.QR_API_BASE = API_BASE;
  root.QR_IS_APPASSETS = isAppAssets;

  if (isAppAssets && typeof root.fetch === 'function') {
    var _nativeFetch = root.fetch;

    root.fetch = function (resource, init) {
      if (typeof resource === 'string') {
        if (resource.indexOf('/api/') === 0) {
          resource = CANONICAL_BACKEND + resource;
        }
      } else if (resource && typeof resource === 'object' && resource.url) {
        if (resource.url.indexOf('https://appassets.androidplatform.net/api/') === 0) {
          var targetUrl = resource.url.replace('https://appassets.androidplatform.net', CANONICAL_BACKEND);
          try {
            resource = new Request(targetUrl, resource);
          } catch (_) {
            // Fallback if Request reconstruction fails
          }
        }
      }
      return _nativeFetch.call(this, resource, init);
    };
  }
})(typeof window !== 'undefined' ? window : this);
