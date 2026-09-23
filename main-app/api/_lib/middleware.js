/**
 * Shared middleware for Vercel serverless API routes.
 *
 * Provides:
 *   withAuth(handler)  — wraps a handler with Firebase ID token verification
 *                        and entitlement resolution (userId, userPremium)
 *   formatError(err)   — consistent JSON error envelope
 *   methodGuard(req, res, allowed) — reject non-matching HTTP methods
 */

const aiService = require('../../services/aiService');

/**
 * Allowed CORS origins.
 * Production domains + localhost for development.
 */
var _ALLOWED_ORIGINS = [
  /* Canonical production domain (https://quantreflex.app) + production aliases/apps.
     https://appassets.androidplatform.net is required for Android WebViewAssetLoader. */
  'https://quantreflex.app',
  'https://www.quantreflex.app',
  'https://dev.quantreflex.app',
  'https://admin.quantreflex.app',
  'https://appassets.androidplatform.net'
];
if (process.env.NODE_ENV !== 'production') {
  _ALLOWED_ORIGINS.push('http://localhost:3000', 'http://localhost:5500', 'http://localhost:5173');
}

/**
 * Set CORS headers if the request origin is in the allowlist.
 * @param {object} req
 * @param {object} res
 */
function _setCorsHeaders(req, res) {
  var origin = req.headers.origin;
  if (origin && _ALLOWED_ORIGINS.indexOf(origin) !== -1) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
}

/**
 * Parse JSON body from the request.
 * Vercel typically auto-parses, but this is a safety net.
 */
function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return {};
}

/**
 * Reject requests that don't match the allowed HTTP method.
 * @param {object} req
 * @param {object} res
 * @param {string} allowed - e.g. 'POST'
 * @returns {boolean} true if method is NOT allowed (response already sent)
 */
function methodGuard(req, res, allowed) {
  if (req.method === allowed) return false;
  res.setHeader('Allow', allowed);
  res.status(405).json({
    error: { code: 'METHOD_NOT_ALLOWED', message: 'Only ' + allowed + ' is accepted.', retryable: false }
  });
  return true;
}

/**
 * Format an error into a consistent JSON envelope.
 * @param {*} err
 * @returns {{ code: string, message: string, retryable: boolean }}
 */
function formatError(err) {
  if (err instanceof aiService.AIServiceError) {
    return { code: err.code, message: err.message, retryable: err.retryable };
  }
  return { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred. Try again later.', retryable: true };
}

/**
 * In-memory per-user rate limiter.
 * Limits AI requests to MAX_REQUESTS_PER_HOUR per user per serverless instance.
 * Not shared across Vercel instances — defense-in-depth, not a hard global limit.
 */
var _rateLimitMap = {};
var _rateLimitCheckCount = 0;
var RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; /* 1 hour */
var MAX_REQUESTS_PER_HOUR = 20;
/* Duel endpoint (api/duel.js) gets its OWN, higher bucket (ADR-033/D1): a live duel hits ?action=
   create/join/start/state/finish/ackResult, which the shared 20/hr AI cap could 429 mid-finish. 120/hr ≈ 8
   duels/hr of endpoint traffic — ample for real play, still a cap (NOT a blanket bypass). Keyed separately so
   duel polling never consumes a user's AI budget and vice-versa. */
var DUEL_MAX_REQUESTS_PER_HOUR = 600;   /* a live duel legitimately POLLS room state (lobby sync + waiting) — 120
                                            could 429 the poll mid-lobby during back-to-back play, stranding a
                                            player. 600/hr (~10/min sustained) covers real play + rapid testing. */
/* Reporting (api/report.js) gets its OWN bucket (ADR-099) so a burst of reports can't 429 the user's AI calls
   (or vice-versa). The real cap is the domain limiter in report.js (15/hr, 60/day); this coarse middleware gate
   sits comfortably above it (offline-queue retries can legitimately re-POST) so the domain limiter is what bites. */
var REPORT_MAX_REQUESTS_PER_HOUR = 40;
/* ADR-175: payments get their OWN bucket. `?action=verify` runs AFTER Razorpay has captured the money,
   so a 429 there is money taken with no entitlement written by the client path — recoverable only
   because the webhook is a second, independent grant route, which is a safety net and not a plan. It
   used to share the 20/hr AI bucket, so a user who had spent their hour on AI explanations could pay and
   then be rate-limited out of their own verification. Low-volume by nature (create-order, verify, refund
   eligibility/request/cancel, play-config, verify-play), so this is generous and still a cap. */
var PAYMENT_MAX_REQUESTS_PER_HOUR = 60;
var CLEANUP_INTERVAL = 50; /* purge stale entries every N checks */

/* Parameterized per-user limiter. `max` defaults to the AI cap; `bucket` namespaces the counter so different
   traffic classes (AI vs duel) don't share a budget. */
function _checkRateLimit(uid, max, bucket) {
  max = max || MAX_REQUESTS_PER_HOUR;
  var key = bucket ? (bucket + ':' + uid) : uid;
  var now = Date.now();

  /* On-demand cleanup: purge stale entries periodically instead of setInterval.
     Avoids keeping serverless instances warm with persistent timers. */
  _rateLimitCheckCount++;
  if (_rateLimitCheckCount >= CLEANUP_INTERVAL) {
    _rateLimitCheckCount = 0;
    var keys = Object.keys(_rateLimitMap);
    for (var i = 0; i < keys.length; i++) {
      if (now - _rateLimitMap[keys[i]].windowStart > RATE_LIMIT_WINDOW_MS) {
        delete _rateLimitMap[keys[i]];
      }
    }
  }

  if (!_rateLimitMap[key]) {
    _rateLimitMap[key] = { count: 1, windowStart: now };
    return true;
  }
  var entry = _rateLimitMap[key];
  if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    /* Window expired — reset */
    entry.count = 1;
    entry.windowStart = now;
    return true;
  }
  entry.count++;
  return entry.count <= max;
}

/**
 * Wrap a serverless handler with Firebase auth verification.
 *
 * The wrapped handler receives (req, res) where:
 *   req.userId      — Firebase UID
 *   req.userPremium — boolean (plan === 'premium', not expired)
 *
 * @param {function} handler - async (req, res) => void
 * @returns {function} Vercel-compatible handler
 */
function withAuth(handler, opts) {
  opts = opts || {};
  /* Rate-limit class (ADR-033/D1): default is the shared AI bucket (20/hr); the duel endpoint passes
     { rateLimitClass: 'duel' } for its own 120/hr bucket so it can't 429 mid-duel or eat the AI budget. */
  var rlMax = MAX_REQUESTS_PER_HOUR, rlBucket = '';
  if (opts.rateLimitClass === 'duel') { rlMax = DUEL_MAX_REQUESTS_PER_HOUR; rlBucket = 'duel'; }
  else if (opts.rateLimitClass === 'report') { rlMax = REPORT_MAX_REQUESTS_PER_HOUR; rlBucket = 'report'; }
  else if (opts.rateLimitClass === 'payment') { rlMax = PAYMENT_MAX_REQUESTS_PER_HOUR; rlBucket = 'payment'; }
  return async function (req, res) {
    /* Handle CORS preflight — required for POST with Authorization header */
    if (req.method === 'OPTIONS') {
      _setCorsHeaders(req, res);
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session-Id');
      res.setHeader('Access-Control-Max-Age', '86400');
      return res.status(200).end();
    }

    /* Set CORS headers for non-preflight requests too */
    _setCorsHeaders(req, res);

    var authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required.', retryable: false }
      });
    }

    var idToken = authHeader.substring(7);
    var decoded;
    try {
      decoded = await aiService.verifyIdToken(idToken);
    } catch (tokenErr) {
      console.error('[middleware:withAuth] token verification threw:', tokenErr.message);
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Authentication failed. Please login again.', retryable: false }
      });
    }
    if (!decoded || !decoded.uid) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Invalid or expired authentication token.', retryable: false }
      });
    }

    /* Per-user rate limiting (parameterized class — duel uses its own higher bucket; ADR-033/D1) */
    if (!_checkRateLimit(decoded.uid, rlMax, rlBucket)) {
      console.warn('[middleware:withAuth] rate limit exceeded for uid:', decoded.uid);
      return res.status(429).json({
        error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests. Please try again later.', retryable: true }
      });
    }

    req.userId = decoded.uid;
    var authState;
    try {
      /* v2: single entitlement read — req.userPremium is true iff plan==='premium' (and not expired).
         resolveUserAuth self-heals expired premium/trials AND returns the active session id in the SAME read,
         so the single-device check below costs no extra Firestore read (ADR-072). */
      authState = await aiService.resolveUserAuth(decoded.uid);
      req.userPremium = authState.premium;
    } catch (entitlementErr) {
      return res.status(503).json({ error: formatError(entitlementErr) });
    }

    /* Single-active-device enforcement (ADR-072, newest-login-wins). Once a session has been claimed
       (activeSessionId set), every authed request must carry the matching X-Session-Id; a stale device (displaced by
       a newer login) gets 409 SESSION_REPLACED and signs out. Before any claim (activeSessionId null) we don't
       enforce — so nothing locks out on first deploy / before the updated client claims. The session-claim endpoint
       passes { skipSession:true } so a NEW device (which can't yet hold the active id) is able to claim. */
    if (!opts.skipSession && authState.activeSessionId) {
      var sentSession = req.headers['x-session-id'];
      if (sentSession !== authState.activeSessionId) {
        return res.status(409).json({
          error: { code: 'SESSION_REPLACED', message: 'Your account was opened on another device.', retryable: false }
        });
      }
    }

    return handler(req, res);
  };
}

/**
 * Wrap a serverless handler with Firebase auth verification, requiring Admin access.
 *
 * @param {function} handler - async (req, res) => void
 * @returns {function} Vercel-compatible handler
 */
function withAdminAuth(handler) {
  return async function (req, res) {
    if (req.method === 'OPTIONS') {
      _setCorsHeaders(req, res);
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS, DELETE, PUT');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session-Id');
      res.setHeader('Access-Control-Max-Age', '86400');
      return res.status(200).end();
    }

    /* Set CORS headers for non-preflight requests too */
    _setCorsHeaders(req, res);

    var authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } });
    }

    var idToken = authHeader.substring(7);
    var decoded;
    try {
      decoded = await aiService.verifyIdToken(idToken);
    } catch (tokenErr) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication failed.' } });
    }
    
    if (!decoded || !decoded.uid) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid token.' } });
    }

    // Verify Admin Custom Claim
    if (decoded.admin !== true) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admin privileges required.' } });
    }

    req.userId = decoded.uid;
    return handler(req, res);
  };
}

/**
 * Canonical coaching active-state check (audit M4).
 *
 * Single source of truth for "can this coaching accept students / be claimed".
 * Previously three endpoints disagreed: register checked status
 * 'suspended'/'deleted', while claim/validate checked status 'expired'
 * (a value the admin tooling never writes) — so a suspended coaching could
 * slip through claim/validate unless `isActive:false` happened to be set too.
 *
 * Canonical rule: a coaching is active IFF `status === 'active'` when a
 * `status` field is present; otherwise fall back to `isActive !== false`
 * for legacy documents that predate the status field.
 *
 * @param {object} data - coachings/{id} document data
 * @returns {boolean}
 */
function isCoachingActive(data) {
  if (!data) return false;
  if (typeof data.status === 'string' && data.status.length > 0) {
    return data.status === 'active';
  }
  return data.isActive !== false;
}

module.exports = { withAuth, withAdminAuth, formatError, methodGuard, parseBody, isCoachingActive, setCorsHeaders: _setCorsHeaders };
