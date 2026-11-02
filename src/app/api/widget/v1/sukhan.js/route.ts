import { db } from '@/lib/db'
import { normalizeApiKey } from '@/lib/widget/widget-utils'
import { IDENTITY_HELPERS_JS, IDENTITY_STATEFUL_JS } from '@/lib/widget-script-identity'
import { POSITIONING_FN_SOURCE } from '@/lib/widget/positioning-script'

/**
 * Script-tag alternative endpoint — versioned under `/api/widget/v1/`.
 *
 * Customers embed a single tag (no NPM install, no bundler):
 *
 *   <script async defer
 *     src="https://app.sukhan.chat/api/widget/v1/sukhan.js"
 *     data-api-key="sk_your-workspace-slug"></script>
 *
 * The browser resolves the API key from the `data-api-key` attribute on the
 * script tag at runtime. The script then:
 *   1. Determines the Sukhan backend origin from its own `src` URL.
 *   2. Strips the optional `sk_` prefix from the API key to get the slug.
 *   3. Fetches the tenant's WidgetConfig.
 *   4. Renders the same launcher button + chat panel as the slug-based
 *      endpoint at /api/widget/[slug]/script.
 *   5. Connects to Socket.IO + handles all chat interactions.
 *
 * Response is `application/javascript` with `Access-Control-Allow-Origin: *`
 * so it can be loaded from any host origin.
 *
 * Caching: 60s public — config changes (accent color, greeting, etc.) propagate
 * within a minute.
 *
 * Why a separate endpoint from /api/widget/[slug]/script:
 *   - This endpoint is the v1-stable contract for the NPM-package-style
 *     install. Future versions (v2, v3) can ship breaking changes without
 *     touching the existing slug-based path used by older widgets.
 *   - It accepts an API key (not a slug), so it survives slug renames when
 *     the API key feature is rolled out (today the slug IS the API key, but
 *     the contract is forward-compatible).
 */

export function buildScript(socketUrlOverride: string | null, isVercel: boolean): string {
  // When isVercel is true and no explicit override is set, the script resolves
  // SOCKET_URL at runtime from the Sukhan origin (API_URL). The placeholder
  // "__API_URL__" is baked-in server-side and the script replaces it at runtime.
  //
  // The baked SOCKET_URL value can be one of THREE things:
  //   1. The literal placeholder string "__API_URL__" (Vercel, no override) —
  //      the script replaces this with API_URL at runtime.
  //   2. A JSON-stringified absolute URL (when NEXT_PUBLIC_REALTIME_URL is set).
  //   3. The raw JavaScript expression `API_URL + "/?XTransformPort=3003"`
  //      (Docker/dev, no override) — NOT a JSON string, this is live JS code
  //      that builds the Caddy URL at runtime.
  const vercelPlaceholder = '__API_URL__'
  // Determine the literal text that goes between `var SOCKET_URL = ` and `;`.
  let bakedSocketUrlExpr: string
  if (isVercel && !socketUrlOverride) {
    bakedSocketUrlExpr = JSON.stringify(vercelPlaceholder)
  } else if (socketUrlOverride) {
    bakedSocketUrlExpr = JSON.stringify(socketUrlOverride)
  } else {
    // Docker/dev default — bake the raw JavaScript expression (NOT a JSON
    // string). This is the original behaviour: the expression is evaluated
    // at runtime in the browser.
    bakedSocketUrlExpr = 'API_URL + "/?XTransformPort=3003"'
  }
  const forceVercelPath = isVercel && !socketUrlOverride
  return `(function(){
  "use strict";

  // ---- Resolve API key from the script tag's data-api-key attribute ----
  var thisScript = document.currentScript;
  var apiKey = (thisScript && thisScript.getAttribute('data-api-key')) || '';
  if (!apiKey) {
    console.error('[sukhan] missing data-api-key attribute on <script> tag');
    return;
  }
  // Strip optional sk_ prefix → the slug is the public identifier.
  var SLUG = apiKey.indexOf('sk_') === 0 ? apiKey.slice(3) : apiKey;

  // ---- Resolve API origin from the script's src URL ----
  // Falls back to the page origin if the script tag has no src (unlikely).
  var API_URL = (thisScript && thisScript.src)
    ? thisScript.src.split('/api/widget/v1/sukhan.js')[0]
    : (window.location && window.location.origin ? window.location.origin : '');

  var CONFIG_URL = API_URL + "/api/widget/" + SLUG + "/config";
  var CONTACT_URL = API_URL + "/api/widget/" + SLUG + "/contact";
  var MESSAGES_URL = API_URL + "/api/widget/" + SLUG + "/messages";
  var CSAT_URL = API_URL + "/api/widget/" + SLUG + "/csat";
  // V2 pre-chat form: visitor details submitted BEFORE the first message.
  // The server gates the first visitor message on a successful pre-chat
  // submission when fields are configured (returns 403 pre_chat_required).
  var PRE_CHAT_URL = API_URL + "/api/widget/" + SLUG + "/pre-chat";
  var SOCKET_IO_JS = API_URL + "/socket.io.min.js";
  // SOCKET_URL is resolved server-side and baked in.
  //   - docker/dev (no env, VERCEL!=1) → API_URL + "/?XTransformPort=3003"
  //     (Caddy reverse-proxies to the realtime service on port 3003).
  //   - vercel (VERCEL=1, no NEXT_PUBLIC_REALTIME_URL) → the placeholder
  //     "__API_URL__", replaced at runtime with the Sukhan origin. We must
  //     NOT bake "/api/realtime" — passing it to io() as the URL creates a
  //     NAMESPACE, not a path, and silently breaks on Vercel. Connecting
  //     to the Sukhan origin with path /api/realtime lets
  //     Vercel's edge route the WebSocket request to the Function.
  //   - explicit (NEXT_PUBLIC_REALTIME_URL set) → that absolute URL.
  var SOCKET_URL = ${bakedSocketUrlExpr};
  if (SOCKET_URL === ${JSON.stringify(vercelPlaceholder)}) {
    SOCKET_URL = API_URL;
  }
  var SOCKET_PATH = SOCKET_URL.indexOf("/api/realtime") >= 0 ? "/api/realtime" : "/";
  // On Vercel, SOCKET_URL is API_URL (just an origin — no /api/realtime
  // substring), so SOCKET_PATH defaults to "/". Force it to the Vercel
  // WebSocket Function path.
  if (${forceVercelPath ? 'true' : 'false'} && SOCKET_PATH === '/') {
    SOCKET_PATH = "/api/realtime";
  }
${IDENTITY_HELPERS_JS}
${IDENTITY_STATEFUL_JS}
${POSITIONING_FN_SOURCE}
  var state = {
    open: false,
    config: null,
    contactId: null,
    conversationId: null,
    token: null,
    socket: null,
    messages: [],
    typing: false,
    agentTyping: false,
    locale: 'fa',
    dir: 'rtl',
    connected: false,
    effectivePos: null,
    effectiveAttention: 'none',
    panelSide: 'right',
    rootEl: null,
    resizeHandler: null,
    colorTokens: null,
    // V2 message preview state.
    messagePreviewEnabled: false, // effective server-authoritative entitlement
    previewEl: null,       // .sk-message-preview DOM element
    previewVisible: false,
    seenMessageIds: [],    // dedup across socket + poll + history
    // V2 quick replies state.
    quickRepliesItems: [],  // effective items from public config
    quickRepliesEl: null,   // .sk-quick-replies DOM element
    quickRepliesInFlight: false, // prevents duplicate sends
    // V2 pre-chat form state.
    preChatFormFields: [],  // effective fields from public config
    preChatFormEl: null,    // .sk-pre-chat-form DOM container
    preChatCompleted: false, // whether the form was successfully submitted
    preChatInFlight: false,  // prevents double submission
    // V2 page visibility state.
    pageVisibilityRules: [], // effective rules from public config (Feature 8)
    pageVisibilityPopHandler: null, // popstate listener (for cleanup)
    pageVisibilityOrigPushState: null, // original history.pushState (for cleanup)
    pageVisibilityOrigReplaceState: null, // original history.replaceState (for cleanup)
    // V2 alternative contact buttons state (Feature 9).
    altContactItems: [],  // effective items from public config
    altContactEl: null,   // .sk-alt-contact-links DOM container
  };

  // ============================================================
  // V2 Positioning helpers (shared geometry from positioning-script.ts).
  // ============================================================
  function resolveDevicePositioning(config) {
    // __skDetectDevice returns 'mobile' or 'desktop' (string, not boolean).
    var device = __skDetectDevice();
    if (config.positioning && config.positioning[device]) {
      return config.positioning[device];
    }
    var v1Pos = config.position || 'bottom-end';
    var anchor = v1Pos === 'bottom-start' ? 'bottom-start' : 'bottom-end';
    return { anchor: anchor, offsetX: 0, offsetY: 0 };
  }

  function getLauncherDims(shape) {
    if (shape === 'tab') return { w: 60, h: 52 };
    if (shape === 'pill') return { w: 64, h: 48 };
    return { w: 52, h: 52 };
  }

  function applyPosition() {
    if (!state.config || !state.rootEl || !state.effectivePos) return;
    var pos = state.effectivePos;
    var dims = getLauncherDims(state.config.launcherShape);
    var sab = __skGetSafeAreaBottom();
    var result = __skComputePosition({
      anchor: pos.anchor,
      offsetX: pos.offsetX || 0,
      offsetY: pos.offsetY || 0,
      dir: state.dir,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      launcherWidth: dims.w,
      launcherHeight: dims.h,
      safeAreaBottom: sab,
      baseMargin: 20,
      attentionAnimation: state.effectiveAttention
    });
    state.rootEl.style.left = result.left + 'px';
    state.rootEl.style.bottom = result.bottom + 'px';
    state.rootEl.style.right = '';
    // Diagnostic data attributes — prove the widget received + applied
    // V2 positioning (verifiable by browser tests).
    state.rootEl.setAttribute('data-sk-anchor', pos.anchor);
    state.rootEl.setAttribute('data-sk-offset-x', String(pos.offsetX || 0));
    state.rootEl.setAttribute('data-sk-offset-y', String(pos.offsetY || 0));
    state.panelSide = result.panelSide;
    applyPanelSide(result.panelSide);
    // Apply panel vertical containment — keep the panel inside the
    // viewport even when the launcher is near the top edge.
    if (panel) {
      var pv = __skComputePanelVertical(result.bottom, dims.h, window.innerHeight, 12, 500, sab);
      panel.style.bottom = pv.bottom + 'px';
      panel.style.maxHeight = pv.maxHeight + 'px';
    }
    // Reposition the preview bubble if it's visible (stays in viewport on resize).
    positionPreview();
  }

  function applyPanelSide(side) {
    if (!panel || !state.config || !state.effectivePos) return;
    var pos = state.effectivePos;
    var dims = getLauncherDims(state.config.launcherShape);
    var lr = __skComputePosition({
      anchor: pos.anchor, offsetX: pos.offsetX || 0, offsetY: pos.offsetY || 0,
      dir: state.dir, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
      launcherWidth: dims.w, launcherHeight: dims.h,
      safeAreaBottom: __skGetSafeAreaBottom(), baseMargin: 20,
      attentionAnimation: state.effectiveAttention
    });
    var ph = __skComputePanelHorizontal(lr.left, dims.w, 360, window.innerWidth, side, 20);
    panel.style.left = ph.left + 'px';
    panel.style.right = '';
    panel.style.width = ph.width + 'px';
    applyPanelTransform();
  }

  function applyPanelTransform() {
    if (!panel) return;
    if (state.open) {
      panel.style.transform = 'translateY(0) scale(1)';
    } else {
      panel.style.transform = 'translateY(8px) scale(.98)';
    }
  }

  function setupResizeListener() {
    if (state.resizeHandler) return;
    var handler = function() {
      var newPos = resolveDevicePositioning(state.config);
      var oldPos = state.effectivePos;
      if (!oldPos || newPos.anchor !== oldPos.anchor || newPos.offsetX !== oldPos.offsetX || newPos.offsetY !== oldPos.offsetY) {
        state.effectivePos = newPos;
      }
      applyPosition();
      // V2 page visibility: re-evaluate on resize because the device may
      // switch between desktop/mobile (device-specific rules apply differently).
      updatePageVisibility();
    };
    state.resizeHandler = handler;
    try {
      window.addEventListener('resize', handler);
      window.addEventListener('orientationchange', handler);
    } catch (e) {}
  }

  function teardownResizeListener() {
    if (!state.resizeHandler) return;
    try {
      window.removeEventListener('resize', state.resizeHandler);
      window.removeEventListener('orientationchange', state.resizeHandler);
    } catch (e) {}
    state.resizeHandler = null;
  }

  // ============================================================
  // V2 Page Visibility helpers (Feature 8).
  //   The public config exposes 'pageVisibility: { rules: [...] }' where
  //   each rule is { pattern, match, action, device? }. The runtime
  //   evaluates the current page's visibility against these rules using
  //   window.location.pathname + the detected device.
  //
  //   Behavior:
  //     - No rules → always visible (default 'show').
  //     - Hide overrides show when both match.
  //     - Hiding the widget toggles 'display:none' on the root element —
  //       it does NOT erase conversation history, reset visitor identity,
  //       or mark unread messages as read.
  //     - Re-evaluated on popstate, pushState/replaceState interception,
  //       and resize (device may switch desktop↔mobile).
  // ============================================================
  function __skEvaluatePageVisibility(rules, pathname, device) {
    if (!rules || rules.length === 0) return 'show';
    var hasShow = false, hasHide = false;
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (!r) continue;
      if (r.device && r.device !== device) continue;
      var matches = r.match === 'prefix'
        ? (pathname === r.pattern || pathname.indexOf(r.pattern + '/') === 0 || (r.pattern.charAt(r.pattern.length-1) === '/' && pathname.indexOf(r.pattern) === 0))
        : pathname === r.pattern;
      if (matches) { if (r.action === 'hide') hasHide = true; else hasShow = true; }
    }
    if (hasHide) return 'hide';
    return 'show';
  }

  // __skOnPageChange: single callback wired to popstate + the patched
  // history methods. Re-evaluates the current page's visibility. Bounded
  // with a microtask flush so a burst of pushState/replaceState calls
  // collapses into one evaluation.
  var __skPageChangeScheduled = false;
  function __skOnPageChange() {
    if (__skPageChangeScheduled) return;
    __skPageChangeScheduled = true;
    // Use setTimeout(0) to coalesce synchronous navigation bursts.
    setTimeout(function() {
      __skPageChangeScheduled = false;
      updatePageVisibility();
    }, 0);
  }

  // updatePageVisibility: read the current pathname + device, evaluate
  // the rules, and toggle the root element's display. Safe to call
  // before mount completes (no-op when state.rootEl is null).
  function updatePageVisibility() {
    if (!state.rootEl) return;
    var rules = state.pageVisibilityRules || [];
    var pathname = (window.location && window.location.pathname) || '/';
    var device = __skDetectDevice();
    var result = __skEvaluatePageVisibility(rules, pathname, device);
    if (result === 'hide') {
      state.rootEl.style.display = 'none';
    } else {
      state.rootEl.style.display = '';
    }
    // Diagnostic attribute — verifiable by browser tests.
    state.rootEl.setAttribute('data-sk-page-visibility', result);
  }

  // setupPageVisibilityListeners: wire popstate + patch history methods.
  // Idempotent — safe to call from mount() even if the widget re-mounts.
  function setupPageVisibilityListeners() {
    if (state.pageVisibilityPopHandler) return; // already wired
    state.pageVisibilityPopHandler = __skOnPageChange;
    try {
      window.addEventListener('popstate', __skOnPageChange);
    } catch (e) {}
    // Patch history.pushState + replaceState to intercept SPA navigation.
    // Store the originals so teardownPageVisibility() can restore them.
    if (typeof history !== 'undefined' && history.pushState && !state.pageVisibilityOrigPushState) {
      state.pageVisibilityOrigPushState = history.pushState;
      history.pushState = function() {
        var ret = state.pageVisibilityOrigPushState.apply(this, arguments);
        __skOnPageChange();
        return ret;
      };
    }
    if (typeof history !== 'undefined' && history.replaceState && !state.pageVisibilityOrigReplaceState) {
      state.pageVisibilityOrigReplaceState = history.replaceState;
      history.replaceState = function() {
        var ret = state.pageVisibilityOrigReplaceState.apply(this, arguments);
        __skOnPageChange();
        return ret;
      };
    }
  }

  // teardownPageVisibility: remove popstate listener + restore the
  // original history methods. Called from a destroy path (the script
  // runtimes are one-shot embeds, but exposing cleanup keeps tests +
  // future SPA host integrations deterministic).
  function teardownPageVisibility() {
    if (state.pageVisibilityPopHandler) {
      try {
        window.removeEventListener('popstate', state.pageVisibilityPopHandler);
      } catch (e) {}
      state.pageVisibilityPopHandler = null;
    }
    if (state.pageVisibilityOrigPushState && typeof history !== 'undefined') {
      try { history.pushState = state.pageVisibilityOrigPushState; } catch (e) {}
      state.pageVisibilityOrigPushState = null;
    }
    if (state.pageVisibilityOrigReplaceState && typeof history !== 'undefined') {
      try { history.replaceState = state.pageVisibilityOrigReplaceState; } catch (e) {}
      state.pageVisibilityOrigReplaceState = null;
    }
  }

  // Expose teardown so a host page or test harness can deterministically
  // restore the original history methods after the widget is destroyed.
  // The slug/v1 runtimes are one-shot embeds (no formal destroy()), but
  // exposing this keeps the contract symmetric with the NPM widget's
  // destroy() path.
  try {
    if (typeof window !== 'undefined') {
      window.__sukhan_destroy_page_visibility = function() {
        teardownPageVisibility();
      };
    }
  } catch (e) {}

  // ============================================================
  // V2 Alternative Contact Buttons helpers (Feature 9).
  //   The public config exposes 'alternativeContactButtons: { items: [...] }'
  //   where each item is { kind, label, value }. The runtime renders a row of
  //   anchor links inside the open panel — these links NEVER send a Sukhan
  //   message, complete a pre-chat form, or bypass authorization. They are
  //   plain <a> elements that the visitor's browser handles natively.
  //
  //   Behavior:
  //     - Empty items array → no container is created (legacy behavior).
  //     - The container is part of the widget root → hidden automatically
  //       when Page Visibility hides the widget (Feature 8).
  //     - Visible only when the panel is open + items.length > 0.
  //     - Website links open in a new tab (target=_blank rel=noopener).
  //     - tel:/mailto: links have no target/rel (native handler).
  //     - Labels use textContent (never innerHTML) — XSS-safe.
  // ============================================================
  function __skBuildAltContactHref(item) {
    if (!item || typeof item.kind !== 'string' || typeof item.value !== 'string') return '#';
    switch (item.kind) {
      case 'phone':   return 'tel:' + item.value;
      case 'email':   return 'mailto:' + item.value;
      case 'whatsapp': return 'https://wa.me/' + item.value.replace(/[^\\d]/g, '');
      case 'telegram': return 'https://t.me/' + item.value;
      case 'website': return item.value;
      default: return '#';
    }
  }

  // buildAltContactLinks: create the .sk-alt-contact-links container with one
  // <a class="sk-alt-contact-link"> per item. Returns the container element.
  // Idempotent across repeated mount/render cycles — each invocation produces
  // a fresh container (the caller is responsible for replacing any prior one).
  function buildAltContactLinks(items) {
    var container = el('div', 'sk-alt-contact-links');
    css(container, {
      display: 'none', flexDirection: 'column', gap: '2px',
      padding: '6px 8px', background: '#fff',
      borderTop: '1px solid #f0eee9', flexShrink: '0',
    });
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || typeof it.kind !== 'string' || typeof it.label !== 'string' || typeof it.value !== 'string') continue;
      var href = __skBuildAltContactHref(it);
      var a = el('a', 'sk-alt-contact-link');
      a.setAttribute('data-sk-alt-contact-kind', it.kind);
      a.setAttribute('href', href);
      // Website links open in a new tab; tel:/mailto: use the native handler.
      if (it.kind === 'website') {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      }
      // SECURITY: tenant-controlled label — use textContent, NEVER innerHTML.
      a.textContent = it.label;
      container.appendChild(a);
    }
    return container;
  }

  // updateAltContactLinks: toggle visibility based on the panel open state.
  // Called from toggle(). The container itself is part of the widget root
  // (so Page Visibility hides it automatically with the rest of the root).
  function updateAltContactLinks() {
    if (!state.altContactEl) return;
    var show = state.open && state.altContactItems.length > 0;
    state.altContactEl.style.display = show ? 'flex' : 'none';
  }

  // ---- V2 Color application ----
  function applyColors(config) {
    if (!state.rootEl) return;
    var colors = config.colors;
    if (!colors || !colors.tokens) {
      state.colorTokens = null;
      state.rootEl.setAttribute('data-sk-color-mode', 'legacy');
      return;
    }
    var t = colors.tokens;
    state.colorTokens = t;
    state.rootEl.setAttribute('data-sk-color-mode', colors.mode || 'preset');
    if (colors.presetId) state.rootEl.setAttribute('data-sk-color-preset', colors.presetId);
    if (launcher) { launcher.style.background = t.launcherBg; launcher.style.color = t.launcherFg; }
    if (panel) { panel.style.background = t.panelBg; }
    var headerEl = panel ? panel.querySelector('.sk-header') : null;
    if (headerEl) { headerEl.style.background = t.headerBg; headerEl.style.color = t.headerText; }
    if (bodyEl) { bodyEl.style.background = t.panelBg; bodyEl.style.color = t.panelText; }
    if (sendBtn) { sendBtn.style.background = t.accent; }
    if (typingEl) { typingEl.style.background = t.accent; }
    if (typeof renderMessages === 'function') renderMessages();
  }

  var STORAGE_KEY = 'sukhan_visitor_' + SLUG;

  function getVisitorId(){
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      if (v) return v;
      // Cryptographically strong visitor ID — prefer crypto.randomUUID().
      v = (window.crypto && crypto.randomUUID)
        ? 'vis_' + crypto.randomUUID()
        : 'vis_' + Date.now() + '_' + (window.crypto && crypto.getRandomValues
            ? Array.from(crypto.getRandomValues(new Uint8Array(16)), function(b){ return b.toString(16).padStart(2, '0'); }).join('')
            : Math.random().toString(36).slice(2, 14));
      localStorage.setItem(STORAGE_KEY, v);
      return v;
    } catch(e) {
      return 'vis_' + Date.now() + '_' + Math.random().toString(36).slice(2, 14);
    }
  }

  function el(tag, cls, html){
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function css(node, props){ for (var k in props) node.style[k] = props[k]; }
  function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); }
  function hexA(hex, a){
    var h = String(hex||'#E09A2B').replace('#','');
    if (h.length === 3) h = h.split('').map(function(c){return c+c;}).join('');
    var r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }
  function fmt(ts){
    try { var d = new Date(ts); return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); } catch(e){ return ''; }
  }
  function shapeClass(s){
    if (s === 'pill') return 'sk-pill';
    if (s === 'rounded') return 'sk-rounded';
    return 'sk-tab';
  }

  // V2 Message Preview — pure eligibility + text policy (inlined mirror of
  // src/lib/widget/message-preview-policy.ts). Returns safe plain text or null.
  // Only new agent text messages from 'live' or 'poll' may produce a preview.
  function __skGetMessagePreviewText(o){
    if (!o) return null;
    if (!o.enabled) return null;
    if (o.panelOpen) return null;
    if (!o.authorized) return null;
    if (!o.conversationId) return null;
    if (o.source !== 'live' && o.source !== 'poll') return null;
    var m = o.message;
    if (!m || typeof m !== 'object') return null;
    if (m.conversationId !== o.conversationId) return null;
    if (m.senderType !== 'agent') return null;
    if (m.contentType !== 'text') return null;
    var id = m.id;
    if (typeof id !== 'string' || id === '') return null;
    if (o.seenIds && o.seenIds.indexOf(id) !== -1) return null;
    var raw = (m.content && m.content.text);
    if (typeof raw !== 'string') return null;
    var text = raw.trim().replace(/\\s+/g, ' ');
    if (text === '') return null;
    var chars = Array.from(text);
    if (chars.length > 120) return chars.slice(0, 120).join('') + '\u2026';
    return text;
  }

  // ---- DOM refs (created in mount) ----
  var bodyEl, inputEl, sendBtn, typingEl, launcher, panel, pulseDot, inputBar;

  function mount(config){
    if (window.__sukhan_mounted) return;
    window.__sukhan_mounted = true;
    state.config = config;
    state.locale = config.defaultLocale === 'en' ? 'en' : 'fa';
    state.dir = config.defaultDirection === 'ltr' ? 'ltr' : 'rtl';
    var accent = config.accentColor || '#E09A2B';

    // V2 positioning: resolve effective positioning for the current device.
    state.effectivePos = resolveDevicePositioning(config);
    state.panelSide = 'right';

    injectStyles(accent);

    var root = el('div', 'sk-root');
    root.setAttribute('dir', state.dir);
    css(root, { position: 'fixed', zIndex: '2147483000' });
    state.rootEl = root;

    // Position application is deferred to after the panel + launcher are
    // appended (the panel side cannot be set before the panel DOM element exists).

    // V2 launcher: use config.launcher.shape when present, fall back to V1.
    var effectiveShape = (config.launcher && config.launcher.shape) || config.launcherShape || 'tab';
    // V2 attention: the public config exposes only the effective authorized
    // animation. 'none' preserves the legacy unanimated launcher (no class).
    var effectiveAttention = (config.attention && config.attention.animation) || 'none';
    root.setAttribute('data-sk-attention-animation', effectiveAttention);
    state.effectiveAttention = effectiveAttention;
    var attentionClass = effectiveAttention !== 'none' ? ' sk-attention-' + effectiveAttention : '';
    launcher = el('button', 'sk-launcher ' + shapeClass(effectiveShape) + attentionClass);
    launcher.setAttribute('aria-label', state.locale === 'fa' ? 'گفت‌وگو' : 'Open chat');
    css(launcher, {
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#0E1116', color: '#FAF7F2', cursor: 'pointer',
      border: 'none', boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
      transition: 'transform .15s ease', padding: '0', position: 'relative'
    });
    launcher.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    launcher.onclick = toggle;

    pulseDot = el('span', 'sk-pulse');
    css(pulseDot, { position:'absolute', top:'-2px', right:'-2px', width:'10px', height:'10px', borderRadius:'50%', background:accent, border:'2px solid #fff' });
    pulseDot.style.display = 'none';
    launcher.appendChild(pulseDot);

    panel = el('div', 'sk-panel');
    css(panel, {
      position: 'absolute', bottom: '64px', width: '360px', maxWidth: 'calc(100vw - 40px)',
      height: '500px', maxHeight: 'calc(100vh - 100px)',
      background: '#fff', borderRadius: '16px', boxShadow: '0 20px 60px rgba(0,0,0,0.22)',
      overflow: 'hidden', fontFamily: 'Vazirmatn,system-ui,sans-serif',
      display: 'flex', flexDirection: 'column',
      opacity: '0', transform: 'translateY(8px) scale(.98)', pointerEvents: 'none',
      transition: 'opacity .18s ease, transform .18s ease'
    });
    // Panel side is applied by applyPosition() via applyPanelSide().

    // V2 message preview: read the effective server-authoritative entitlement.
    // Free / unknown plans expose { enabled: false } — the preview never
    // appears. The preview DOM is always created (so the class contract is
    // stable) but remains hidden when disabled.
    state.messagePreviewEnabled = !!(config.messagePreview && config.messagePreview.enabled);

    // V2 page visibility: read the effective authorized rules from the public
    // config (Feature 8). Empty array for Free / unknown / no-V2-selection.
    // The runtime evaluates these rules against window.location.pathname +
    // the detected device to decide whether to hide the widget root.
    state.pageVisibilityRules = (config.pageVisibility && config.pageVisibility.rules) || [];

    // V2 alternative contact buttons: read the effective authorized items from
    // the public config (Feature 9). Empty array for Free / unknown / no-V2-
    // selection. The runtime renders one <a class="sk-alt-contact-link"> per
    // item inside the panel; the links NEVER send a Sukhan message, complete
    // a pre-chat form, or bypass authorization.
    var altContactItems = (config.alternativeContactButtons && config.alternativeContactButtons.items) || [];
    // Defensive copy + sanitize: keep only items with the expected shape so a
    // malformed persisted config cannot break the render loop. The backend
    // validates these too — this is defense-in-depth at the runtime boundary.
    var safeAltItems = [];
    for (var aci = 0; aci < altContactItems.length; aci++) {
      var acItem = altContactItems[aci];
      if (!acItem || typeof acItem !== 'object') continue;
      if (typeof acItem.kind !== 'string' || typeof acItem.label !== 'string' || typeof acItem.value !== 'string') continue;
      safeAltItems.push({ kind: acItem.kind, label: acItem.label, value: acItem.value });
    }
    state.altContactItems = safeAltItems;
    state.altContactEl = safeAltItems.length > 0 ? buildAltContactLinks(safeAltItems) : null;

    // Build the preview bubble (.sk-message-preview). Positioned adjacent to
    // the launcher by positionPreview(). Hidden by default.
    var previewEl = el('div', 'sk-message-preview');
    css(previewEl, {
      position: 'absolute', bottom: '64px', left: '0',
      maxWidth: '280px', background: '#fff', borderRadius: '12px',
      boxShadow: '0 8px 24px rgba(0,0,0,0.18)', padding: '10px 12px',
      display: 'none', flexDirection: 'column', gap: '4px',
      fontFamily: 'Vazirmatn,system-ui,sans-serif', zIndex: '2147483001',
    });
    var previewText = el('div', 'sk-message-preview-text');
    css(previewText, {
      fontSize: '13px', lineHeight: '1.4', color: '#0E1116', cursor: 'pointer',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      maxWidth: '100%',
    });
    previewText.setAttribute('role', 'button');
    previewText.setAttribute('tabindex', '0');
    var previewDismiss = el('button', 'sk-message-preview-dismiss');
    css(previewDismiss, {
      position: 'absolute', top: '2px', insetInlineEnd: '2px',
      width: '20px', height: '20px', border: 'none', background: 'transparent',
      color: '#888', cursor: 'pointer', fontSize: '16px', lineHeight: '1',
      borderRadius: '4px', padding: '0', display: 'flex', alignItems: 'center',
      justifyContent: 'center',
    });
    previewDismiss.setAttribute('aria-label', state.locale === 'fa' ? 'بستن' : 'Dismiss');
    previewDismiss.textContent = '\u00d7';
    previewText.onclick = function(){ hidePreview(); toggle(); };
    previewText.onkeydown = function(e){ if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hidePreview(); toggle(); } };
    previewDismiss.onclick = function(e){ e.stopPropagation(); hidePreview(); };
    previewEl.appendChild(previewText);
    previewEl.appendChild(previewDismiss);
    state.previewEl = previewEl;

    // Safe image URL check (CUST-B): only absolute http(s) URLs are ever
    // assigned to img.src. The backend validates these too — this is
    // defense-in-depth at the runtime boundary.
    function safeImg(u){
      // NOTE: this code is served inside a template literal — no regex
      // escapes and no backticks allowed here. Scheme check is done with
      // plain string comparisons so the served script is byte-identical
      // to this source.
      if (typeof u !== 'string' || u.length > 500) return null;
      var low = u.slice(0, 8).toLowerCase();
      if (low !== 'https://' && low.slice(0, 7) !== 'http://') return null;
      try { new URL(u); return u; } catch (e) { return null; }
    }

    // Header
    var header = el('div', 'sk-header');
    css(header, { display:'flex', alignItems:'center', gap:'10px', padding:'12px 16px', color:'#fff', background:accent, flexShrink:'0' });
    var logo = el('div', 'sk-logo');
    css(logo, { width:'28px', height:'28px', borderRadius:'50%', background:'rgba(255,255,255,.25)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:'0' });
    logo.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    var titleText = el('div', '');
    // SECURITY: config.name is tenant-controlled — use textContent, NEVER innerHTML.
    titleText.textContent = config.name || (state.locale==='fa'?'گفت‌وگو':'Chat');
    css(titleText, { fontSize:'14px', fontWeight:'600', flex:'1' });
    var closeBtn = el('button', '', '×');
    css(closeBtn, { background:'none', border:'none', color:'#fff', fontSize:'20px', cursor:'pointer', padding:'0', lineHeight:'1' });
    closeBtn.onclick = toggle;
    header.appendChild(logo); header.appendChild(titleText); header.appendChild(closeBtn);
    // CUST-B: render the configured logo/avatar when they are SAFE image
    // URLs. DOM APIs only (createElement + .src property) — never
    // innerHTML with tenant-controlled content. The default SVG logo
    // stays until a custom logo actually loads; a broken avatar image
    // is removed on error.
    var logoImgSrc = safeImg(config.logoUrl);
    if (logoImgSrc) {
      var limg = document.createElement('img');
      limg.alt = ''; limg.referrerPolicy = 'no-referrer';
      css(limg, { width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%', display: 'none' });
      limg.onload = function(){ logo.innerHTML = ''; limg.style.display = 'block'; logo.appendChild(limg); };
      limg.src = logoImgSrc;
    }
    var avatarSrc = safeImg(config.avatarUrl);
    if (avatarSrc) {
      var av = document.createElement('img');
      av.alt = state.locale === 'fa' ? 'کارشناس' : 'Agent';
      av.referrerPolicy = 'no-referrer';
      css(av, { width: '28px', height: '28px', borderRadius: '50%', objectFit: 'cover', flexShrink: '0' });
      av.onerror = function(){ if (av.parentNode) av.parentNode.removeChild(av); };
      av.src = avatarSrc;
      header.insertBefore(av, titleText);
    }


    // Messages area
    bodyEl = el('div', 'sk-body');
    css(bodyEl, { flex:'1', overflowY:'auto', padding:'16px', background:'#f7f5f1', display:'flex', flexDirection:'column', gap:'8px' });

    // Greeting message
    var greeting = config.greetingTexts && config.greetingTexts[state.locale];
    if (greeting) {
      state.messages.push({ senderType:'system', content:{ text: greeting }, createdAt: new Date().toISOString() });
    }

    // Typing indicator
    typingEl = el('div', 'sk-typing');
    css(typingEl, { display:'none', padding:'4px 16px', fontSize:'11px', color:'#888', background:'#f7f5f1' });
    typingEl.innerHTML = '<span style="display:inline-flex;gap:3px"><span class="sk-dot"></span><span class="sk-dot"></span><span class="sk-dot"></span></span>';
    bodyEl.appendChild(typingEl);

    // V2 quick replies: suggestion buttons inside the open panel.
    // Shown only when the panel is open + visitor authorized + NO visitor
    // message has been persisted yet (including from history on reload).
    var qrItems = (config.quickReplies && config.quickReplies.items) || [];
    state.quickRepliesItems = qrItems;
    var quickRepliesEl = el('div', 'sk-quick-replies');
    css(quickRepliesEl, {
      display: 'none', flexWrap: 'wrap', gap: '6px', padding: '8px 12px',
      background: '#fff', borderTop: '1px solid #eee', flexShrink: '0',
    });
    for (var qi = 0; qi < qrItems.length; qi++) {
      var qrBtn = el('button', 'sk-quick-reply');
      qrBtn.textContent = qrItems[qi]; // XSS-safe: textContent, never innerHTML
      css(qrBtn, {
        border: '1px solid #ddd', background: '#f7f5f1', color: '#0E1116',
        borderRadius: '16px', padding: '6px 14px', fontSize: '13px',
        cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
        maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis',
      });
      qrBtn.setAttribute('type', 'button');
      qrBtn.onclick = (function(text) {
        return function() {
          if (state.quickRepliesInFlight) return;
          state.quickRepliesInFlight = true;
          inputEl.value = text;
          sendMessage();
          updateQuickReplies();
        };
      })(qrItems[qi]);
      quickRepliesEl.appendChild(qrBtn);
    }
    state.quickRepliesEl = quickRepliesEl;

    // Input bar
    inputBar = el('div', 'sk-input');
    css(inputBar, { display:'flex', padding:'10px 12px', background:'#fff', borderTop:'1px solid #eee', gap:'8px', flexShrink:'0' });
    inputEl = el('input');
    inputEl.setAttribute('placeholder', state.locale === 'fa' ? 'پیام بنویسید…' : 'Type a message…');
    css(inputEl, { flex:'1', border:'none', outline:'none', fontSize:'14px', background:'transparent', color:'#0E1116', fontFamily:'inherit' });
    inputEl.setAttribute('autocomplete', 'off');
    sendBtn = el('button', '', '');
    sendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>';
    css(sendBtn, { background:accent, color:'#fff', border:'none', borderRadius:'8px', width:'34px', height:'34px', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:'0' });
    sendBtn.onclick = sendMessage;
    inputEl.onkeydown = function(e){
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    };
    inputEl.oninput = function(){
      if (state.socket && state.conversationId) {
        state.socket.emit('typing:start', { conversationId: state.conversationId });
        clearTimeout(state._typingTimer);
        state._typingTimer = setTimeout(function(){
          state.socket.emit('typing:stop', { conversationId: state.conversationId });
        }, 1500);
      }
    };
    inputBar.appendChild(inputEl); inputBar.appendChild(sendBtn);

    // V2 pre-chat form: collect visitor details (name/email/phone/company)
    // BEFORE the first message. Shown only when the panel is open + visitor
    // authorized + no persisted visitor message + form not yet completed.
    // The server gates the first visitor message on a successful pre-chat
    // submission when fields are configured (returns 403 pre_chat_required).
    // SECURITY: visitor-supplied values are read via input.value (never
    // innerHTML) and submitted as JSON; error messages use textContent.
    var preChatFields = (config.preChatForm && config.preChatForm.fields) || [];
    state.preChatFormFields = preChatFields;
    var preChatFormEl = el('div', 'sk-pre-chat-form');
    for (var pci = 0; pci < preChatFields.length; pci++) {
      var pcf = preChatFields[pci];
      if (!pcf || typeof pcf.key !== 'string') continue;
      var pcfInput = el('input', 'sk-pre-chat-field-' + pcf.key);
      if (pcf.key === 'email') pcfInput.setAttribute('type', 'email');
      else if (pcf.key === 'phone') pcfInput.setAttribute('type', 'tel');
      else pcfInput.setAttribute('type', 'text');
      pcfInput.setAttribute('placeholder', preChatFieldLabel(pcf.key, state.locale));
      pcfInput.setAttribute('autocomplete', 'off');
      if (pcf.required) pcfInput.setAttribute('aria-required', 'true');
      preChatFormEl.appendChild(pcfInput);
    }
    var preChatErrorEl = el('div', 'sk-pre-chat-error');
    preChatFormEl.appendChild(preChatErrorEl);
    var preChatSubmitBtn = el('button', 'sk-pre-chat-submit', state.locale === 'fa' ? 'شروع گفت‌وگو' : 'Start chat');
    preChatSubmitBtn.setAttribute('type', 'button');
    preChatSubmitBtn.onclick = submitPreChatForm;
    preChatFormEl.appendChild(preChatSubmitBtn);
    state.preChatFormEl = preChatFormEl;

    panel.appendChild(header); panel.appendChild(bodyEl);
    if (state.quickRepliesEl) panel.appendChild(state.quickRepliesEl);

    // Free-plan "Powered by" badge (CUST-F): the old condition
    // (!config.plan || config.plan === 'free') was ALWAYS true — the
    // backend never sends a plan field; it sends the effective-config
    // flags poweredBy and isLocked. Render the badge only when the
    // effective config sets poweredBy to true.
    if (config.poweredBy) {
      var badge = el('a', 'sk-powered');
      badge.href = 'https://sukhan.chat';
      badge.target = '_blank';
      badge.rel = 'noopener noreferrer';
      css(badge, { display:'block', padding:'4px 12px 6px', background:'#fff', borderTop:'1px solid #f0eee9', fontSize:'10px', color:'#999', textAlign:'center', textDecoration:'none', flexShrink:'0' });
      badge.textContent = state.locale === 'fa' ? 'نیرو گرفته از سُخن' : 'Powered by Sukhan';
      panel.appendChild(badge);
    }
    // Pre-chat form sits between quick replies/badge and the input bar.
    // While visible, the input bar + quick replies are hidden by
    // updatePreChatForm(); when hidden, the input bar is restored.
    if (state.preChatFormEl) panel.appendChild(state.preChatFormEl);
    // V2 alternative contact links (Feature 9): appended just above the input
    // bar so the visitor always sees them when the panel is open, even while
    // the pre-chat form is visible (the links do NOT send a Sukhan message,
    // complete a pre-chat form, or bypass authorization). Empty when the
    // tenant has no buttons configured — no container is appended.
    if (state.altContactEl) panel.appendChild(state.altContactEl);
    panel.appendChild(inputBar);
    root.appendChild(panel); root.appendChild(launcher); root.appendChild(previewEl);
    document.body.appendChild(root);

    // Apply the computed position NOW that the panel exists (the panel side
    // could not be set earlier because the panel DOM element didn't exist yet).
    applyPosition();
    setupResizeListener();
    // V2 page visibility: wire navigation listeners + evaluate the current
    // page AFTER the root is mounted. Toggling display does NOT erase
    // conversation history, reset visitor identity, or mark unread read.
    setupPageVisibilityListeners();
    updatePageVisibility();
    // Apply V2 color tokens (additive — falls back to legacy colors if absent).
    applyColors(config);

    renderMessages();
    // Mode-aware identity bootstrap (anonymous/verified_visitor/site_user_only).
    // The anonymous path still calls identifyVisitor() internally via __sk_bootstrap().
    __sk_bootstrap();
  }

  function toggle(){
    state.open = !state.open;
    if (state.open) {
      css(panel, { opacity:'1', pointerEvents:'auto' });
      applyPanelTransform();
      hidePreview(); // opening the conversation hides the preview
      pulseDot.style.display = 'none';
      updatePreChatForm(); // may hide input + quick replies when form is shown
      updateQuickReplies();
      updateAltContactLinks(); // V2 alternative contact buttons (Feature 9)
      // Only focus the input when the pre-chat form is NOT visible —
      // otherwise focusing the input would scroll past the form.
      var preChatVisible = state.preChatFormEl && state.preChatFormEl.style.display === 'flex';
      if (!preChatVisible) {
        setTimeout(function(){ inputEl && inputEl.focus(); }, 200);
      }
    } else {
      css(panel, { opacity:'0', pointerEvents:'none' });
      applyPanelTransform();
      updatePreChatForm();
      updateQuickReplies();
      updateAltContactLinks();
    }
  }

  // V2 quick replies: show suggestion buttons only when the panel is open,
  // the visitor is authorized, and NO visitor message has been persisted yet
  // (including from history on reload). After the first visitor message,
  // suggestions are permanently hidden.
  function updateQuickReplies(){
    if (!state.quickRepliesEl) return;
    var hasPersistedVisitorMsg = false;
    if (state.messages && state.messages.length > 0) {
      for (var i = 0; i < state.messages.length; i++) {
        var m = state.messages[i];
        if (!m || m.senderType !== 'contact') continue;
        // Only count server-persisted messages (real id, not __local_).
        if (m.id && String(m.id).indexOf('__local_') === 0) continue;
        hasPersistedVisitorMsg = true; break;
      }
    }
    var authorized = !!state.token;
    var show = state.open && state.quickRepliesItems.length > 0 && !hasPersistedVisitorMsg && authorized;
    state.quickRepliesEl.style.display = show ? 'flex' : 'none';
    if (hasPersistedVisitorMsg && state.quickRepliesEl.childNodes.length > 0) {
      while (state.quickRepliesEl.firstChild) state.quickRepliesEl.removeChild(state.quickRepliesEl.firstChild);
    }
    // Disable buttons while a send is in-flight (prevents duplicate sends).
    if (show) {
      var btns = state.quickRepliesEl.querySelectorAll('.sk-quick-reply');
      for (var bi = 0; bi < btns.length; bi++) {
        btns[bi].disabled = state.quickRepliesInFlight;
        btns[bi].style.opacity = state.quickRepliesInFlight ? '0.5' : '1';
        btns[bi].style.pointerEvents = state.quickRepliesInFlight ? 'none' : 'auto';
      }
    }
  }

  // ---- V2 Pre-chat Form helpers ----
  // Bilingual placeholder labels for the four supported field keys.
  // SECURITY: fixed brand strings only — never tenant-controlled content.
  function preChatFieldLabel(key, locale){
    var fa = { name: 'نام', email: 'ایمیل', phone: 'تلفن', company: 'شرکت' };
    var en = { name: 'Name', email: 'Email', phone: 'Phone', company: 'Company' };
    var map = locale === 'en' ? en : fa;
    return map[key] || key;
  }

  // True when a server-persisted visitor message exists (real id, not __local_).
  // Mirrors the gate in updateQuickReplies — a persisted visitor message means
  // the visitor already started the conversation, so the pre-chat form is not
  // required (the server has already accepted their first message).
  function hasPersistedVisitorMessage(){
    if (!state.messages || state.messages.length === 0) return false;
    for (var i = 0; i < state.messages.length; i++) {
      var m = state.messages[i];
      if (!m || m.senderType !== 'contact') continue;
      if (m.id && String(m.id).indexOf('__local_') === 0) continue; // optimistic placeholder
      return true;
    }
    return false;
  }

  // updatePreChatForm: decide whether to show the form based on the current
  // state. Called from toggle(), renderMessages(), and identifyVisitor() —
  // similar to updateQuickReplies(). When the form is visible, the input bar
  // and quick replies are hidden; when hidden, the input bar is restored
  // (quick replies remain governed by updateQuickReplies()).
  function updatePreChatForm(){
    if (!state.preChatFormEl) return;
    var hasMsg = hasPersistedVisitorMessage();
    var show = state.open && !!state.token
      && state.preChatFormFields.length > 0
      && !state.preChatCompleted
      && !hasMsg;
    state.preChatFormEl.style.display = show ? 'flex' : 'none';
    if (show) {
      // Hide the input bar + quick replies while the form is visible.
      if (inputBar) inputBar.style.display = 'none';
      if (state.quickRepliesEl) state.quickRepliesEl.style.display = 'none';
    } else {
      // Restore the input bar (quick replies handled by updateQuickReplies).
      if (inputBar) inputBar.style.display = 'flex';
    }
  }

  // showPreChatForm / hidePreChatForm: direct visibility toggles used by the
  // submit handler. updatePreChatForm() is the authoritative gate; these are
  // narrow helpers for the post-submit transition.
  function showPreChatForm(){
    if (!state.preChatFormEl) return;
    state.preChatFormEl.style.display = 'flex';
    if (inputBar) inputBar.style.display = 'none';
    if (state.quickRepliesEl) state.quickRepliesEl.style.display = 'none';
  }

  function hidePreChatForm(){
    if (!state.preChatFormEl) return;
    state.preChatFormEl.style.display = 'none';
    if (inputBar) inputBar.style.display = 'flex';
  }

  // submitPreChatForm: collect visitor-supplied values from the configured
  // fields and POST them to the pre-chat endpoint. On success (200): mark
  // completed + hide form + restore input/quick replies. On failure (4xx):
  // show a safe error message, preserve typed values, re-enable the submit
  // button. SECURITY: values are read via input.value (never innerHTML) and
  // sent as JSON; the error element uses textContent (never innerHTML).
  function submitPreChatForm(){
    if (state.preChatInFlight) return; // prevent double submission
    if (!state.preChatFormEl || !state.token) return;
    var values = {};
    for (var i = 0; i < state.preChatFormFields.length; i++) {
      var f = state.preChatFormFields[i];
      if (!f || typeof f.key !== 'string') continue;
      var input = state.preChatFormEl.querySelector('.sk-pre-chat-field-' + f.key);
      if (input) {
        var v = (input.value || '').trim();
        if (v !== '') values[f.key] = v;
      }
    }
    // Clear any prior error before submitting.
    var errEl = state.preChatFormEl.querySelector('.sk-pre-chat-error');
    if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }
    // Disable submit while in-flight (prevents double submission).
    state.preChatInFlight = true;
    var submitBtn = state.preChatFormEl.querySelector('.sk-pre-chat-submit');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.style.opacity = '0.6';
      submitBtn.style.cursor = 'default';
    }
    fetch(PRE_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
      body: JSON.stringify({ values: values })
    })
    .then(function(r){
      if (!r.ok) {
        // Parse a safe error code from the JSON body; never log headers or
        // the raw response body. The body may contain { error: '...' }.
        return r.json().catch(function(){ return {}; }).then(function(b){
          var code = (b && typeof b.error === 'string') ? b.error : ('http_' + r.status);
          throw new Error('pre_chat_failed_' + code);
        });
      }
      return r.json();
    })
    .then(function(){
      state.preChatCompleted = true;
      state.preChatInFlight = false;
      hidePreChatForm();
      // Restore the input bar + re-evaluate quick replies.
      if (inputBar) inputBar.style.display = 'flex';
      updateQuickReplies();
      setTimeout(function(){ if (inputEl) inputEl.focus(); }, 100);
    })
    .catch(function(e){
      state.preChatInFlight = false;
      // Re-enable submit so the visitor can retry.
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.style.opacity = '1';
        submitBtn.style.cursor = 'pointer';
      }
      // Show a safe bilingual error message. Values are preserved (inputs
      // are not cleared) so the visitor can correct + resubmit.
      var safeMsg = state.locale === 'fa'
        ? 'ثبت ناموفق بود — دوباره تلاش کنید'
        : 'Submission failed — please try again';
      if (errEl) {
        errEl.textContent = safeMsg; // XSS-safe: textContent, never innerHTML
        errEl.style.display = 'block';
      }
      // Safe error log — only the safe error code, never the token.
      console.error('[sukhan] pre-chat submit failed:', e && e.message ? e.message : 'unknown');
    });
  }

  // clearPreChatForm: reset on identity clear (__sk_clearIdentityState calls
  // this via a typeof guard). Resets the completed + in-flight flags so a
  // fresh identity (SPA user-switch / policy recovery) starts clean.
  function clearPreChatForm(){
    state.preChatCompleted = false;
    state.preChatInFlight = false;
  }

  // ---- V2 Message Preview helpers ----
  // showPreview: render the safe plain text via textContent (never innerHTML)
  // and reveal the bubble adjacent to the launcher.
  function showPreview(text){
    if (!state.previewEl) return;
    var pt = state.previewEl.querySelector('.sk-message-preview-text');
    if (pt) pt.textContent = text; // XSS-safe: textContent, never innerHTML
    state.previewEl.style.display = 'flex';
    state.previewVisible = true;
    positionPreview();
  }

  // hidePreview: hide the bubble without opening the conversation.
  function hidePreview(){
    if (!state.previewEl) return;
    state.previewEl.style.display = 'none';
    state.previewVisible = false;
  }

  // positionPreview: keep the bubble within the viewport (320px mobile safe).
  // Aligns with the launcher's left edge, clamped to [margin, vw - margin - width].
  function positionPreview(){
    if (!state.previewEl || !state.previewVisible) return;
    var vw = window.innerWidth;
    var margin = 8;
    var maxW = Math.min(280, vw - margin * 2);
    state.previewEl.style.maxWidth = maxW + 'px';
    // The root's left is the launcher's left (set by applyPosition). The
    // preview aligns with the root's left edge, clamped to stay in bounds.
    var rootLeft = state.rootEl ? parseFloat(state.rootEl.style.left) || 0 : 0;
    var previewW = state.previewEl.offsetWidth || maxW;
    var left = rootLeft;
    if (left + previewW > vw - margin) left = vw - margin - previewW;
    if (left < margin) left = margin;
    state.previewEl.style.left = left + 'px';
  }

  // processMessageForPreview: check a newly ingested message against the pure
  // eligibility policy. Deduped by message id across socket + poll + history.
  function processMessageForPreview(msg, source){
    if (!msg || typeof msg !== 'object') return;
    var id = msg.id;
    if (typeof id !== 'string' || id === '') return;
    // Dedup: skip if already processed (prevents socket+poll double-delivery
    // and history replay from producing a stale preview).
    if (state.seenMessageIds.indexOf(id) !== -1) return;
    // Check the pure policy.
    var text = __skGetMessagePreviewText({
      enabled: state.messagePreviewEnabled,
      panelOpen: state.open,
      authorized: !!state.conversationId,
      conversationId: state.conversationId,
      source: source,
      message: msg,
      seenIds: state.seenMessageIds,
    });
    // Mark as seen regardless of whether it produced a preview (so history
    // and duplicates never trigger a future preview).
    state.seenMessageIds.push(id);
    if (text !== null && text !== undefined) {
      showPreview(text);
    }
  }

  // clearMessagePreviewState: reset on identity switch, conversation change,
  // authorization recovery, logout, or teardown.
  function clearMessagePreviewState(){
    hidePreview();
    state.seenMessageIds = [];
  }

  function identifyVisitor(){
    var visitorId = getVisitorId();
    fetch(CONTACT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId: visitorId }),
    })
    .then(function(r){ return r.json(); })
    .then(function(data){
      state.contactId = data.contactId;
      state.conversationId = data.conversationId;
      state.token = data.realtimeToken;
      // Identity is now ready — Quick Replies may become visible.
      updateQuickReplies();
      // V2 pre-chat form: if the backend reports the contact has already
      // completed pre-chat (e.g. on a reload after a prior submission), mark
      // completed so the form does not reappear. The flag is optional —
      // older backends omit it and the form visibility is governed by the
      // hasPersistedVisitorMessage gate instead.
      if (data && data.preChatCompleted === true) {
        state.preChatCompleted = true;
      }
      // Re-evaluate pre-chat form visibility now that the token is set.
      updatePreChatForm();
      connectSocket();
      if (state.conversationId) loadMessages();
    })
    .catch(function(e){ console.error('[sukhan] identify failed', e); });
  }

  function loadMessages(){
    if (!state.conversationId) return;
    fetch(MESSAGES_URL + '?conversationId=' + state.conversationId, {
      headers: { 'Authorization': 'Bearer ' + state.token },
    })
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (data.messages) {
        state.messages = data.messages;
        renderMessages();
        // History messages are tagged 'history' — the policy never previews
        // them, but they're added to seenIds so a re-delivery (socket/poll)
        // never replays a stale preview.
        for (var hi = 0; hi < data.messages.length; hi++) {
          processMessageForPreview(data.messages[hi], 'history');
        }
      }
    });
  }

  function loadSocketIO(callback){
    if (window.io) { callback(); return; }
    var s = document.createElement('script');
    s.src = SOCKET_IO_JS;
    s.async = true;
    s.onload = callback;
    s.onerror = function(){ console.error('[sukhan] failed to load socket.io-client from', SOCKET_IO_JS); };
    document.head.appendChild(s);
  }

  function refreshVisitorToken(callback){
    var visitorId = getVisitorId();
    fetch(CONTACT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId: visitorId }),
    })
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (data.realtimeToken) {
        state.token = data.realtimeToken;
        if (data.conversationId && !state.conversationId) state.conversationId = data.conversationId;
      }
      if (callback) callback(data);
    })
    .catch(function(e){
      console.error('[sukhan] token refresh failed', e);
      if (callback) callback(null);
    });
  }

  function connectSocket(){
    loadSocketIO(function(){
      if (state.socket) return;
      state.socket = window.io(SOCKET_URL, {
        path: SOCKET_PATH,
        addTrailingSlash: false,
        auth: { token: state.token },
        transports: (${forceVercelPath ? "true" : "false"} || SOCKET_PATH.indexOf("/api/realtime") >= 0) ? ["websocket"] : ["websocket", "polling"],
        reconnection: true,
      });
      state.socket.on('connect', function(){
        state.connected = true;
        if (state.conversationId) {
          state.socket.emit('conversation:join', state.conversationId);
        }
      });
      state.socket.on('disconnect', function(){ state.connected = false; });
      var visitorMembershipRevoked = false;
      state.socket.on('connect_error', function(err){
        if (!err) return;
        if (err.message === 'membership_inactive' || err.message === 'membership_check_failed') {
          visitorMembershipRevoked = true;
          if (state.socket) { state.socket.io.opts.reconnection = false; state.socket.disconnect(); }
          return;
        }
        if (visitorMembershipRevoked) return;
        if (err.message === 'invalid_token' || err.message === 'no_token') {
          // Mode-aware token refresh (anonymous=refreshVisitorToken;
          // verified_visitor=resume credential; site_user_only=customer identity).
          __sk_modeAwareRefreshToken(function(data){
            if (data && data.realtimeToken && state.socket) {
              state.socket.auth = { token: data.realtimeToken };
              state.socket.connect();
            }
          });
        } else if (__sk_POLICY_REASONS[err.message]) {
          // Visitor policy connect_error → re-fetch config + re-bootstrap on the
          // CURRENT policy (single-flight, bounded — no infinite reconnect loop).
          __sk_authorizationRecovery(err.message);
        }
      });
      state.socket.on('message:new', function(msg){
        state.messages.push(msg);
        renderMessages();
        // V2 message preview: check the new realtime message (source='live').
        processMessageForPreview(msg, 'live');
        if (!state.open) pulseDot.style.display = 'block';
        if (msg.senderType === 'system' && msg.content && msg.content.text &&
            (msg.content.text.indexOf('closed') >= 0 || msg.content.text.indexOf('بسته') >= 0 ||
             msg.content.text.indexOf('resolved') >= 0 || msg.content.text.indexOf('حل') >= 0)) {
          showCsatSurvey();
        }
      });
      state.socket.on('conversation:updated', function(data){
        if (data && data.changes && data.changes.status === 'closed') showCsatSurvey();
      });
      state.socket.on('typing:start', function(data){
        if (data.senderType === 'agent') {
          typingEl.style.display = 'block';
          scrollBody();
        }
      });
      state.socket.on('typing:stop', function(){ typingEl.style.display = 'none'; });
    });
  }

  function sendMessage(){
    var text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    // Centralized cleanup: ALWAYS reset in-flight + update buttons after
    // every settled send attempt — success, HTTP 4xx/5xx, network failure,
    // malformed JSON, or auth-policy rejection. This guarantees the buttons
    // are never stuck disabled. On success, updateQuickReplies() removes
    // the buttons (persisted message); on failure, it re-enables them
    // (if the visitor remains authorized). If identity was cleared during
    // error handling, the authorized gate in updateQuickReplies() keeps
    // the buttons hidden — cleanup does NOT accidentally enable them for
    // a different visitor.
    var finalizeSend = function() {
      state.quickRepliesInFlight = false;
      updateQuickReplies();
    };
    fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
      body: JSON.stringify({ text: text }),
    })
    .then(function(r){
      if (!r.ok) {
        // Policy send errors → trigger identity recovery. Preserve the typed
        // message (restore the input) so the user can explicitly retry after
        // re-authenticating — no auto-resend (PR9 semantics).
        return __sk_safeApiCode(r).then(function(code){
          if (inputEl) inputEl.value = text;
          if (code && __sk_POLICY_REASONS[code]) { __sk_authorizationRecovery(code); }
          console.error('[sukhan] send failed:', code);
          return null;
        });
      }
      return r.json();
    })
    .then(function(data){
      if (!data) { finalizeSend(); return; }
      if (data.message) {
        state.messages.push(data.message);
        renderMessages(); // calls updateQuickReplies() — removes buttons on success
      }
      if (data.conversationId && data.conversationId !== state.conversationId) {
        clearMessagePreviewState();
        state.conversationId = data.conversationId;
        if (state.socket && state.connected) {
          state.socket.emit('conversation:join', state.conversationId);
        }
      }
      startPolling();
      finalizeSend(); // clears in-flight; updateQuickReplies() is idempotent
    })
    .catch(function(e){
      if (inputEl) inputEl.value = text; // never silently lose the typed message
      finalizeSend();
      console.error('[sukhan] send failed', e);
    });
  }

  var pollTimer = null;
  function startPolling(){
    if (pollTimer) return;
    pollTimer = setInterval(function(){
      if (!state.conversationId || !state.token) return;
      fetch(MESSAGES_URL + '?conversationId=' + state.conversationId, {
        headers: { 'Authorization': 'Bearer ' + state.token },
      })
      .then(function(r){ return r.json(); })
      .then(function(data){
        if (data.messages && data.messages.length !== state.messages.length) {
          var newMsgs = data.messages.slice(state.messages.length);
          for (var i = 0; i < newMsgs.length; i++) {
            var exists = state.messages.some(function(m){ return m.id === newMsgs[i].id; });
            if (!exists) state.messages.push(newMsgs[i]);
          }
          renderMessages();
          // V2 message preview: check polled messages (source='poll').
          // The policy deduplicates against seenIds (history + prior deliveries).
          for (var pi = 0; pi < data.messages.length; pi++) {
            processMessageForPreview(data.messages[pi], 'poll');
          }
          if (!state.open) pulseDot.style.display = 'block';
        }
      })
      .catch(function(){});
    }, 10000);
  }

  function renderMessages(){
    var children = bodyEl.children;
    for (var i = children.length - 1; i >= 0; i--) {
      if (children[i] !== typingEl) bodyEl.removeChild(children[i]);
    }
    for (var j = 0; j < state.messages.length; j++) {
      var msg = state.messages[j];
      var isVisitor = msg.senderType === 'contact';
      var isSystem = msg.senderType === 'system';
      var bubble = el('div', 'sk-msg ' + (isSystem ? 'sk-sys' : (isVisitor ? 'sk-vis' : 'sk-agt')));
      if (isSystem) {
        css(bubble, { alignSelf:'center', background:'transparent', color:'#888', fontSize:'11px', padding:'4px 0' });
        bubble.textContent = msg.content.text || '';
      } else {
        var align = isVisitor ? 'flex-end' : 'flex-start';
        var ct = state.colorTokens;
        var bg = isVisitor ? (ct ? ct.visitorBubbleBg : '#0E1116') : (ct ? ct.agentBubbleBg : '#fff');
        var color = isVisitor ? (ct ? ct.visitorBubbleText : '#FAF7F2') : (ct ? ct.agentBubbleText : '#0E1116');
        var radius = isVisitor ? '12px 12px 4px 12px' : '12px 12px 12px 4px';
        css(bubble, { alignSelf:align, background:bg, color:color, borderRadius:radius, padding:'8px 12px', fontSize:'13px', maxWidth:'75%', boxShadow:'0 1px 2px rgba(0,0,0,.06)', wordBreak:'break-word' });
        bubble.setAttribute('dir', 'auto');
        if (msg.content.text) {
          var p = el('p', '');
          // SECURITY: msg.content.text is user-controlled — use textContent.
          p.textContent = msg.content.text;
          css(p, { margin:'0' });
          bubble.appendChild(p);
        }
        if (msg.content.attachments) {
          for (var k = 0; k < msg.content.attachments.length; k++) {
            var att = msg.content.attachments[k];
            if (att.type === 'image') {
              var img = el('img');
              img.src = att.url; img.alt = att.name;
              css(img, { maxWidth:'100%', borderRadius:'8px', marginTop:'4px', display:'block' });
              bubble.appendChild(img);
            } else {
              var a = el('a', '');
              // SECURITY: att.name is user-controlled — use textContent.
              a.textContent = att.name;
              a.href = att.url; a.setAttribute('download', att.name);
              css(a, { display:'block', marginTop:'4px', fontSize:'11px', color: isVisitor ? '#FAF7F2' : '#1F8F8F' });
              bubble.appendChild(a);
            }
          }
        }
        var ts = el('span', '');
        ts.textContent = fmt(msg.createdAt);
        css(ts, { display:'block', fontSize:'10px', marginTop:'2px', opacity:'.6' });
        bubble.appendChild(ts);
      }
      bodyEl.insertBefore(bubble, typingEl);
    }
    scrollBody();
    updateQuickReplies(); // hide suggestions after the first visitor message
    updatePreChatForm(); // hide form after the first persisted visitor message
  }

  function scrollBody(){ if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight; }

  var csatShown = false;
  function showCsatSurvey(){
    if (csatShown || !state.conversationId || !state.token) return;
    csatShown = true;

    var csatOverlay = el('div', 'sk-csat');
    css(csatOverlay, {
      position:'absolute', top:'0', left:'0', right:'0', bottom:'0',
      background:'rgba(0,0,0,.5)', display:'flex', alignItems:'center', justifyContent:'center',
      zIndex:'10', opacity:'0', transition:'opacity .2s ease'
    });
    var csatCard = el('div', 'sk-csat-card');
    var accent = (state.config && state.config.accentColor) || '#E09A2B';
    css(csatCard, { background:'#fff', borderRadius:'16px', padding:'24px', maxWidth:'280px', width:'90%', textAlign:'center', fontFamily:'inherit', boxShadow:'0 20px 60px rgba(0,0,0,.3)' });
    var title = el('div', '', state.locale === 'fa' ? 'چقدر راضی بودید؟' : 'How satisfied were you?');
    css(title, { fontSize:'16px', fontWeight:'600', marginBottom:'16px', color:'#0E1116' });
    var stars = el('div', 'sk-csat-stars');
    css(stars, { display:'flex', justifyContent:'center', gap:'8px', marginBottom:'16px' });

    for (var i = 1; i <= 5; i++) {
      (function(rating) {
        var star = el('button', 'sk-star');
        star.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ccc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>';
        css(star, { background:'none', border:'none', cursor:'pointer', padding:'0', transition:'transform .1s' });
        star.onmouseenter = function(){ star.style.transform = 'scale(1.2)'; };
        star.onmouseleave = function(){ star.style.transform = 'scale(1)'; };
        star.onclick = function() {
          var allStars = stars.querySelectorAll('.sk-star svg');
          for (var s = 0; s < allStars.length; s++) {
            if (s < rating) {
              allStars[s].setAttribute('stroke', accent);
              allStars[s].setAttribute('fill', accent);
            } else {
              allStars[s].setAttribute('stroke', '#ccc');
              allStars[s].setAttribute('fill', 'none');
            }
          }
          setTimeout(function() { submitCsat(rating, null); }, 300);
        };
        stars.appendChild(star);
      })(i);
    }
    var skip = el('button', '', state.locale === 'fa' ? 'نادیده بگیر' : 'Skip');
    css(skip, { background:'none', border:'none', color:'#888', fontSize:'12px', cursor:'pointer', marginTop:'8px' });
    skip.onclick = function() { removeCsat(); };

    csatCard.appendChild(title); csatCard.appendChild(stars); csatCard.appendChild(skip);
    csatOverlay.appendChild(csatCard);
    panel.appendChild(csatOverlay);
    setTimeout(function(){ csatOverlay.style.opacity = '1'; }, 10);

    function removeCsat(){
      csatOverlay.style.opacity = '0';
      setTimeout(function(){ if (csatOverlay.parentNode) csatOverlay.parentNode.removeChild(csatOverlay); }, 200);
    }
    function submitCsat(rating, comment) {
      fetch(CSAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
        body: JSON.stringify({ conversationId: state.conversationId, rating: rating, comment: comment })
      })
      .then(function(r) { return r.json(); })
      .then(function() {
        var msg = state.locale === 'fa' ? 'ممنون از بازخورد شما!' : 'Thanks for your feedback!';
        title.textContent = msg;
        stars.style.display = 'none';
        skip.textContent = state.locale === 'fa' ? 'بستن' : 'Close';
        setTimeout(removeCsat, 2000);
      })
      .catch(function(){
        title.textContent = state.locale === 'fa' ? 'خطا در ثبت امتیاز' : 'Error submitting rating';
        setTimeout(removeCsat, 2000);
      });
    }
  }

  function injectStyles(accent){
    var style = el('style');
    style.textContent = ''
      + '.sk-root{font-family:Vazirmatn,system-ui,sans-serif;}'
      + '.sk-launcher.sk-tab{width:60px;height:52px;border-radius:14px;border-bottom-start-radius:4px;}'
      + '.sk-launcher.sk-rounded{width:52px;height:52px;border-radius:16px;}'
      + '.sk-launcher.sk-pill{width:64px;height:48px;border-radius:999px;}'
      + '.sk-pulse{animation:skpulse 2s ease-in-out infinite;}'
      + '@keyframes skpulse{0%,100%{box-shadow:0 0 0 0 ' + hexA(accent, .5) + ';}50%{box-shadow:0 0 0 6px ' + hexA(accent, 0) + ';}}'
      + '.sk-dot{display:inline-block;width:5px;height:5px;border-radius:50%;background:#888;animation:skbounce 1.4s infinite ease-in-out both;}'
      + '.sk-dot:nth-child(1){animation-delay:-0.32s;} .sk-dot:nth-child(2){animation-delay:-0.16s;}'
      + '@keyframes skbounce{0%,80%,100%{transform:scale(0);}40%{transform:scale(1);}}'
      + '.sk-body::-webkit-scrollbar{width:4px;} .sk-body::-webkit-scrollbar-thumb{background:rgba(0,0,0,.15);border-radius:2px;}'
      // V2 attention animations — bounded, restrained, GPU-friendly motion.
      + '.sk-launcher.sk-attention-pulse{animation:sk-attention-pulse 2s ease-in-out infinite;}'
      + '.sk-launcher.sk-attention-bounce{animation:sk-attention-bounce 1.8s ease-in-out infinite;}'
      + '.sk-launcher.sk-attention-shake{animation:sk-attention-shake 1.2s ease-in-out infinite;}'
      + '.sk-launcher.sk-attention-glow{animation:sk-attention-glow 2.4s ease-in-out infinite;}'
      + '@keyframes sk-attention-pulse{0%,100%{transform:scale(1);}50%{transform:scale(1.06);}}'
      + '@keyframes sk-attention-bounce{0%,100%{transform:translateY(0);}50%{transform:translateY(-6px);}}'
      + '@keyframes sk-attention-shake{0%,100%{transform:translateX(0);}25%{transform:translateX(-3px);}75%{transform:translateX(3px);}}'
      + '@keyframes sk-attention-glow{0%,100%{box-shadow:0 8px 24px rgba(0,0,0,0.18),0 0 0 0 ' + hexA(accent, 0) + ';}50%{box-shadow:0 8px 24px rgba(0,0,0,0.18),0 0 14px 2px ' + hexA(accent, 0.45) + ';}}'
      + '@media (prefers-reduced-motion:reduce){.sk-launcher.sk-attention-pulse,.sk-launcher.sk-attention-bounce,.sk-launcher.sk-attention-shake,.sk-launcher.sk-attention-glow{animation:none !important;}}'
      // V2 message preview — bubble adjacent to the launcher.
      + '.sk-message-preview{box-sizing:border-box;}'
      + '.sk-message-preview-text{box-sizing:border-box;padding-right:20px;}'
      + '.sk-message-preview-dismiss:hover{color:#0E1116;background:rgba(0,0,0,0.06);}'
      // V2 quick replies — suggestion buttons inside the open panel.
      + '.sk-quick-replies{box-sizing:border-box;}'
      + '.sk-quick-reply{box-sizing:border-box;transition:background .15s ease;}'
      + '.sk-quick-reply:hover{background:#e8e4dc;}'
      // V2 pre-chat form — visitor details collected before the first message.
      + '.sk-pre-chat-form{display:none;flex-direction:column;gap:8px;padding:16px;background:#f7f5f1;flex-shrink:0;}'
      + '.sk-pre-chat-form input{border:1px solid #ddd;border-radius:8px;padding:8px 12px;font-size:14px;width:100%;box-sizing:border-box;}'
      + '.sk-pre-chat-submit{background:#0E1116;color:#fff;border:none;border-radius:8px;padding:10px;cursor:pointer;font-size:14px;}'
      + '.sk-pre-chat-error{color:#e53e3e;font-size:12px;display:none;}'
      // V2 alternative contact buttons (Feature 9) — anchor links inside the
      // open panel. Plain <a> elements: never send a Sukhan message, complete
      // a pre-chat form, or bypass authorization. The container is part of
      // the widget root → hidden automatically when Page Visibility hides the
      // widget. Hover affordance matches the rest of the panel surfaces.
      + '.sk-alt-contact-links{box-sizing:border-box;}'
      + '.sk-alt-contact-link{display:flex;align-items:center;gap:6px;padding:6px 12px;text-decoration:none;color:inherit;border-radius:8px;transition:background .15s;}'
      + '.sk-alt-contact-link:hover{background:rgba(0,0,0,0.06);}';
    document.head.appendChild(style);
  }

  // ---- Bootstrap ----
  function fetchConfig(){
    // Cache-busting timestamp ensures fresh config (V2 positioning changes
    // propagate immediately — no stale cached response from a previous load).
    fetch(CONFIG_URL + '?_t=' + Date.now(), { cache: 'no-store' })
      .then(function(r){ return r.json(); })
      .then(function(config){ mount(config); })
      .catch(function(e){ console.error('[sukhan] config fetch failed', e); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fetchConfig);
  } else {
    fetchConfig();
  }
})();`
}

/**
 * GET /api/widget/v1/sukhan.js
 *
 * Serves the embeddable widget JS. The script reads `data-api-key` from its
 * own `<script>` tag at runtime — the server doesn't need to know the API
 * key. This makes the endpoint cacheable across all tenants (60s TTL).
 *
 * Query params:
 *   - `apiKey` (optional): if provided, the script will use this as the
 *     fallback when `data-api-key` is missing. Useful for testing.
 */
export async function GET(_req: Request): Promise<Response> {
  // Resolve the public Socket.IO URL the widget will connect to.
  //   - explicit (NEXT_PUBLIC_REALTIME_URL set) → that absolute URL.
  //   - vercel (VERCEL=1, no explicit URL) → use the Sukhan origin at
  //     runtime (the script's __API_URL__ placeholder is replaced with
  //     API_URL extracted from the script's own src).
  //   - docker/dev (default) → API_URL + "/?XTransformPort=3003" (Caddy).
  const socketUrlOverride = process.env.NEXT_PUBLIC_REALTIME_URL || null
  const isVercel = process.env.VERCEL === '1'
  const script = buildScript(socketUrlOverride, isVercel)
  return new Response(script, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  })
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  })
}

/**
 * Resolve the tenant by API key. Today the API key IS the slug (with an
 * optional `sk_` prefix). When true API keys are introduced in a future
 * schema migration, swap the lookup here — the public contract (data-api-key)
 * stays the same.
 *
 * Exported so other handlers (e.g. the doc page's live preview) can resolve
 * a tenant from a raw API key string.
 */
export async function resolveTenantByApiKey(apiKey: string) {
  const slug = normalizeApiKey(apiKey)
  return db.tenant.findUnique({
    where: { slug },
    include: { widgetConfig: true },
  })
}
