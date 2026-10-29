/**
 * Shared identity runtime for the script-tag widget runtimes.
 *
 * BOTH script endpoints (`src/app/api/widget/[slug]/script/route.ts` and
 * `src/app/api/widget/v1/sukhan.js/route.ts`) inject these exact JS strings
 * into their generated IIFE so the identity behavior is IDENTICAL across
 * the two runtimes (no drift). The contract mirrors the accepted NPM
 * implementation (`packages/widget-npm/src/identity.ts` + `widget.ts`
 * identity methods).
 *
 * - `IDENTITY_HELPERS_JS`: PURE functions (no script state/DOM) — endpoint
 *   resolver, strict response parser, bounded fetcher, login-URL builder,
 *   login-required event dispatch, safe error-code extraction. These are
 *   the security-critical contract.
 * - `IDENTITY_STATEFUL_JS`: the stateful identity logic (mode-aware
 *   bootstrap, verified_visitor OTP/resume, site_user_only customer
 *   endpoint, login-required UI, window.SukhanWidget.setIdentity/
 *   refreshIdentity, mode-aware token refresh, socket policy recovery,
 *   clearIdentityState, single-flight config refresh). Uses the script's
 *   common closure vars (`state`, `API_URL`, `SLUG`, `CONTACT_URL`,
 *   `CONFIG_URL`, `connectSocket`, `loadMessages`, `renderMessages`,
 *   `identifyVisitor`, `refreshVisitorToken`, `getVisitorId`, `el`, `css`,
 *   `bodyEl`, `typingEl`, `panel`, `pulseDot`, `startPolling`) + `typeof`
 *   guards for the few structural differences (`stopPolling`/`pollTimer`).
 *
 * The scripts keep their OWN message-merge pipeline (slug has the mature
 * `mergeIncoming`/`mergeMessageArrays` with optimistic/clientMessageId
 * reconciliation; v1 has a simpler push+dedup). This runtime does NOT touch
 * the merge pipeline — it only drives the BOOTSTRAP decision + token
 * refresh + socket recovery + the OTP/login UI.
 *
 * Generated-JS safety: the strings use String.raw + contain NO backticks
 * (would terminate the host template literal) + NO `${}` (would interpolate
 * the host template). String building uses `+` concat.
 */

// ─── PURE helpers (no script state/DOM) ─────────────────────────────────
export const IDENTITY_HELPERS_JS = String.raw`
  // ─── Pure identity helpers (shared across both script runtimes) ────────
  // Resolve the customer identity endpoint URL. Priority:
  //   1. explicit override (script-tag data-identity-endpoint / options)
  //   2. public config identityEndpointPath
  // Resolution: relative /... → CUSTOMER page origin (window.location.origin);
  // absolute URL → same-origin only. Reject //, javascript:, data:, backslash,
  // control chars. Returns absolute URL or null (fail closed).
  function __sk_resolveIdentityEndpoint(explicit, configPath, pageOrigin){
    var raw = (typeof explicit === 'string' && explicit.trim().length > 0) ? explicit
      : (typeof configPath === 'string' && configPath.trim().length > 0) ? configPath : null;
    if (!raw) return null;
    if (!pageOrigin) pageOrigin = (typeof window !== 'undefined' && window.location) ? window.location.origin : '';
    if (raw.indexOf('\\') >= 0) return null;
    if (/[\x00-\x1f\x7f]/.test(raw)) return null;
    if (raw === '/' || /^\/[^\/]/.test(raw)) {
      if (!pageOrigin) return null;
      try { return new URL(raw, pageOrigin).href; } catch(e){ return null; }
    }
    if (/^https?:\/\//i.test(raw)) {
      try { var u = new URL(raw); if (!pageOrigin || u.origin !== pageOrigin) return null; return u.href; } catch(e){ return null; }
    }
    return null;
  }
  // Strict parser for the customer identity response. Accepts ONLY:
  //   { authenticated: false }  |  { authenticated: true, token: "<non-empty>" }
  // Returns null on every malformed shape (no String() coercion).
  function __sk_parseIdentityResponse(body){
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
    if (typeof body.authenticated !== 'boolean') return null;
    if (body.authenticated === true) {
      if (typeof body.token !== 'string') return null;
      if (body.token.length === 0 || body.token.trim().length === 0) return null;
      if (body.token.length > 8192) return null;
      return { authenticated: true, token: body.token };
    }
    if (body.token !== undefined && body.token !== null) return null;
    return { authenticated: false };
  }
  // Bounded (AbortController, 5s default) GET fetcher. credentials:
  // same-origin, Accept: application/json. Sends NO Sukhan secret /
  // externalUserId / visitorId / Contact id. Returns result or null (fail
  // closed on timeout / network / non-2xx / malformed).
  function __sk_fetchIdentity(endpoint, timeoutMs){
    if (typeof fetch !== 'function') return Promise.resolve(null);
    if (!timeoutMs || timeoutMs <= 0) timeoutMs = 5000;
    return new Promise(function(resolve){
      var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function(){ try { ctrl.abort(); } catch(e){} }, timeoutMs) : null;
      fetch(endpoint, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        signal: ctrl ? ctrl.signal : undefined
      }).then(function(r){
        if (!r.ok) return null;
        return r.json();
      }).then(function(body){
        if (timer) clearTimeout(timer);
        resolve(__sk_parseIdentityResponse(body));
      }).catch(function(){
        if (timer) clearTimeout(timer);
        resolve(null);
      });
    });
  }
  // Build the login URL defensively. Relative → CUSTOMER origin; absolute
  // must be http/https. If loginReturnUrlParam configured, append
  // <param>=window.location.href via URLSearchParams. Returns null if unsafe.
  function __sk_buildLoginUrl(loginUrl, returnUrlParam, pageOrigin){
    if (!loginUrl) return null;
    if (!pageOrigin) pageOrigin = (typeof window !== 'undefined' && window.location) ? window.location.origin : '';
    var base;
    if (loginUrl === '/' || /^\/[^\/]/.test(loginUrl)) {
      if (!pageOrigin) return null;
      try { base = new URL(loginUrl, pageOrigin); } catch(e){ return null; }
    } else if (/^https?:\/\//i.test(loginUrl)) {
      try { base = new URL(loginUrl); if (base.protocol !== 'http:' && base.protocol !== 'https:') return null; } catch(e){ return null; }
    } else { return null; }
    if (returnUrlParam && typeof window !== 'undefined' && window.location) {
      try { base.searchParams.set(returnUrlParam, window.location.href); } catch(e){}
    }
    return base.href;
  }
  // Dispatch sukhan:login-required window CustomEvent with SAFE detail.
  function __sk_dispatchLoginRequired(config){
    var detail = {
      accessMode: 'site_user_only',
      loginUrl: (config && typeof config.loginUrl === 'string') ? config.loginUrl : null,
      loginButtonLabel: (config && typeof config.loginButtonLabel === 'string') ? config.loginButtonLabel : null,
      loginReturnUrlParam: (config && typeof config.loginReturnUrlParam === 'string') ? config.loginReturnUrlParam : null
    };
    try {
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent('sukhan:login-required', { detail: detail }));
      }
    } catch(e){}
    return detail;
  }
  // Safe API error-code extraction. Parses ONLY JSON {error:string}; returns
  // 'unknown' for malformed bodies — NEVER leaks the raw response body.
  function __sk_safeApiCode(res){
    return res.json().then(function(body){
      if (body && typeof body === 'object' && !Array.isArray(body) && typeof body.error === 'string' && body.error.length > 0 && body.error.length <= 200) return body.error;
      return 'unknown';
    }).catch(function(){ return 'unknown'; });
  }
`;

// ─── STATEFUL identity runtime (uses closure vars + __sk_ pure helpers) ─
export const IDENTITY_STATEFUL_JS = String.raw`
  // ─── Stateful identity runtime (shared; uses the script's closure) ─────
  // Identity-specific state (kept SEPARATE from the script's state so the
  // existing merge pipeline / PR5/PR9 reliability is untouched).
  var __sk_identity = {
    state: 'anonymous_ready',
    generation: 0,            // bumped on every identity change (SPA user-switch guard)
    memoryToken: null,        // site_user_only external identity token (MEMORY-ONLY)
    otp: null,                // { requestId, email, expiresAt }
    resendInFlight: false,    // single-flight resend
    loginEmitted: false,      // emit sukhan:login-required ONCE per entry
    configRefreshInFlight: null
  };
  var __sk_OTP_START_URL = API_URL + '/api/widget/' + SLUG + '/verify-identity/start';
  var __sk_OTP_VERIFY_URL = API_URL + '/api/widget/' + SLUG + '/verify-identity/verify';
  var __sk_OTP_RESEND_URL = API_URL + '/api/widget/' + SLUG + '/verify-identity/resend';
  var __sk_IDENTITY_TIMEOUT_MS = 5000;
  var __sk_POLICY_REASONS = { policy_changed:1, verification_required:1, website_login_required:1, identity_token_invalid:1, policy_unavailable:1 };

  // Bilingual UI strings (safe, non-tenant-controlled).
  var __sk_STR = {
    fa: { verifyTitle:'تأیید ایمیل', verifyName:'نام', verifyEmail:'ایمیل', verifyContinue:'ادامه', codeTitle:'کد تأیید', codePlaceholder:'کد ۶ رقمی', verifyCode:'تأیید', resend:'ارسال مجدد', back:'بازگشت', verifying:'در حال بررسی…', sending:'در حال ارسال…', loginTitle:'برای ادامه وارد شوید', loginButton:'ورود', unavailable:'سرویس هم‌اکنون در دسترس نیست', invalidEmail:'ایمیل نامعتبر', verifyFailed:'کد نامعتبر بود', expired:'کد منقضی شد — دوباره تلاش کنید', rateLimited:'تلاش بیش از حد — کمی بعد تلاش کنید', defaultError:'خطایی رخ داد' },
    en: { verifyTitle:'Verify your email', verifyName:'Name', verifyEmail:'Email', verifyContinue:'Continue', codeTitle:'Verification code', codePlaceholder:'6-digit code', verifyCode:'Verify', resend:'Resend', back:'Back', verifying:'Verifying…', sending:'Sending…', loginTitle:'Sign in to continue', loginButton:'Sign in', unavailable:'Service unavailable', invalidEmail:'Invalid email', verifyFailed:'Incorrect code', expired:'Code expired — try again', rateLimited:'Too many attempts — try later', defaultError:'Something went wrong' }
  };
  function __sk_L(){ return (state.locale === 'en') ? __sk_STR.en : __sk_STR.fa; }

  // Resume credential storage (separate localStorage key, opaque).
  function __sk_resumeKey(){ return 'sukhan_verified_resume_' + SLUG; }
  function __sk_getResume(){ try { var v = localStorage.getItem(__sk_resumeKey()); return (v && v.length > 0 && v.length <= 8192) ? v : null; } catch(e){ return null; } }
  function __sk_setResume(cred){ try { localStorage.setItem(__sk_resumeKey(), cred); } catch(e){} }
  function __sk_clearResume(){ try { localStorage.removeItem(__sk_resumeKey()); } catch(e){} }

  // Clear all identity-derived state (user-switch / logout safety). Uses
  // typeof guards for the structural difference: slug has stopPolling();
  // v1 has a top-level pollTimer var. Re-renders so old bubbles vanish.
  function __sk_clearIdentityState(){
    try { if (typeof stopPolling === 'function') stopPolling(); else if (typeof pollTimer !== 'undefined' && pollTimer) { clearInterval(pollTimer); pollTimer = null; } } catch(e){}
    if (state.socket) { try { state.socket.disconnect(); } catch(e){} state.socket = null; }
    state.token = null;
    state.contactId = null;
    state.conversationId = null;
    state.messages = [];
    state.connected = false;
    __sk_identity.otp = null;
    __sk_identity.resendInFlight = false;
    try { renderMessages(); } catch(e){}
  }

  // Single-flight config refresh (socket error + send error + refreshIdentity
  // collapse to ONE /config fetch).
  function __sk_configRefresh(cb){
    if (__sk_identity.configRefreshInFlight) {
      __sk_identity.configRefreshInFlight.then(function(cfg){ if (cb) cb(cfg); return cfg; });
      return __sk_identity.configRefreshInFlight;
    }
    __sk_identity.configRefreshInFlight = new Promise(function(resolve){
      fetch(CONFIG_URL).then(function(r){ if (!r.ok) return null; return r.json(); }).then(function(cfg){ resolve(cfg); }).catch(function(){ resolve(null); });
    }).then(function(cfg){
      __sk_identity.configRefreshInFlight = null;
      if (cfg) state.config = cfg;
      if (cb) cb(cfg);
      return cfg;
    });
    return __sk_identity.configRefreshInFlight;
  }

  // ─── Identity UI helpers ───────────────────────────────────────────────
  function __sk_clearBody(){ var c = bodyEl.children; for (var i = c.length - 1; i >= 0; i--) { if (c[i] !== typingEl) bodyEl.removeChild(c[i]); } }
  function __sk_makeCard(){ var card = el('div', 'sk-id-card'); css(card, { alignSelf:'stretch', background:'#fff', borderRadius:'12px', padding:'20px', margin:'8px', boxShadow:'0 1px 3px rgba(0,0,0,.06)', display:'flex', flexDirection:'column', gap:'10px' }); return card; }
  function __sk_styleInput(i){ css(i, { width:'100%', boxSizing:'border-box', padding:'10px 12px', border:'1px solid #ddd', borderRadius:'8px', fontSize:'14px', outline:'none', fontFamily:'inherit', background:'#fff', color:'#0E1116' }); }
  function __sk_styleBtn(b){ var accent = (state.config && state.config.accentColor) || '#E09A2B'; css(b, { width:'100%', padding:'10px 12px', border:'none', borderRadius:'8px', background:accent, color:'#fff', fontSize:'14px', fontWeight:'600', cursor:'pointer' }); }
  function __sk_styleTextBtn(b){ css(b, { background:'none', border:'none', color:'#888', fontSize:'12px', cursor:'pointer', padding:'4px', alignSelf:'center' }); }

  function __sk_renderLoginRequired(){
    __sk_clearBody();
    var card = __sk_makeCard();
    var title = el('div',''); title.textContent = __sk_L().loginTitle;
    css(title, { fontSize:'15px', fontWeight:'600', marginBottom:'12px', color:'#0E1116', textAlign:'center' });
    card.appendChild(title);
    var loginUrl = __sk_buildLoginUrl((state.config && state.config.loginUrl) || null, (state.config && state.config.loginReturnUrlParam) || null);
    if (loginUrl) {
      var a = document.createElement('a'); a.href = loginUrl;
      var label = (state.config && state.config.loginButtonLabel && state.config.loginButtonLabel.trim().length > 0) ? state.config.loginButtonLabel : __sk_L().loginButton;
      a.textContent = label;
      var accent = (state.config && state.config.accentColor) || '#E09A2B';
      css(a, { display:'block', textAlign:'center', textDecoration:'none', padding:'10px 12px', borderRadius:'8px', background:accent, color:'#fff', fontSize:'14px', fontWeight:'600' });
      card.appendChild(a);
    }
    bodyEl.appendChild(card);
  }
  function __sk_renderIntegrationUnavailable(){
    __sk_clearBody();
    var card = __sk_makeCard();
    var t = el('div',''); t.textContent = __sk_L().unavailable;
    css(t, { fontSize:'14px', color:'#666', textAlign:'center', padding:'24px 8px' });
    card.appendChild(t); bodyEl.appendChild(card);
  }
  function __sk_enterLoginRequired(){
    __sk_identity.state = 'site_login_required';
    __sk_renderLoginRequired();
    if (__sk_identity.loginEmitted) return;
    __sk_identity.loginEmitted = true;
    __sk_dispatchLoginRequired(state.config);
  }

  // ─── Verified-visitor OTP UI + flow ────────────────────────────────────
  function __sk_showVerificationForm(){
    __sk_identity.state = 'verified_required';
    __sk_clearBody();
    var L = __sk_L(); var card = __sk_makeCard();
    var title = el('div',''); title.textContent = L.verifyTitle; css(title, {fontSize:'15px',fontWeight:'600',marginBottom:'12px',color:'#0E1116'}); card.appendChild(title);
    var nameI = document.createElement('input'); nameI.setAttribute('placeholder', L.verifyName); __sk_styleInput(nameI); card.appendChild(nameI);
    var emailI = document.createElement('input'); emailI.setAttribute('type','email'); emailI.setAttribute('placeholder', L.verifyEmail); __sk_styleInput(emailI); card.appendChild(emailI);
    var errEl = el('div','sk-verify-err'); css(errEl, {color:'#c0392b',fontSize:'12px',minHeight:'16px'}); card.appendChild(errEl);
    var btn = el('button','',L.verifyContinue); __sk_styleBtn(btn);
    btn.onclick = function(){
      var name = nameI.value.trim(); var email = emailI.value.trim().toLowerCase();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errEl.textContent = L.invalidEmail; return; }
      btn.disabled = true; var oldT = btn.textContent; btn.textContent = L.sending;
      var visitorId = getVisitorId();
      fetch(__sk_OTP_START_URL, { method:'POST', headers:{'Content-Type':'application/json','Accept':'application/json'}, body: JSON.stringify({ visitorId: visitorId, email: email, name: name || undefined }) })
        .then(function(r){ if (!r.ok) return r.json().then(function(b){ return (b && typeof b.error === 'string') ? b.error : 'error'; }).catch(function(){ return 'error'; }); return r.json(); })
        .then(function(res){
          btn.disabled = false; btn.textContent = oldT;
          if (typeof res === 'string') { errEl.textContent = __sk_mapVerifyError(res, L); return; }
          __sk_identity.otp = { requestId: res.requestId, email: email, expiresAt: res.expiresAt };
          __sk_showCodeForm();
        });
    };
    card.appendChild(btn); bodyEl.appendChild(card);
  }

  function __sk_showCodeForm(){
    __sk_identity.state = 'verified_code';
    __sk_clearBody();
    var L = __sk_L(); var card = __sk_makeCard();
    var title = el('div',''); title.textContent = L.codeTitle; css(title, {fontSize:'15px',fontWeight:'600',marginBottom:'12px',color:'#0E1116'}); card.appendChild(title);
    var codeI = document.createElement('input'); codeI.setAttribute('inputmode','numeric'); codeI.setAttribute('placeholder', L.codePlaceholder); codeI.setAttribute('autocomplete','one-time-code'); __sk_styleInput(codeI); card.appendChild(codeI);
    var errEl = el('div','sk-verify-err'); css(errEl, {color:'#c0392b',fontSize:'12px',minHeight:'16px'}); card.appendChild(errEl);
    var btn = el('button','',L.verifyCode); __sk_styleBtn(btn);
    btn.onclick = function(){
      if (!__sk_identity.otp) return; var code = codeI.value.trim(); if (!code) return;
      btn.disabled = true; var oldT = btn.textContent; btn.textContent = L.verifying;
      var gen = __sk_identity.generation;
      var visitorId = getVisitorId();
      fetch(__sk_OTP_VERIFY_URL, { method:'POST', headers:{'Content-Type':'application/json','Accept':'application/json'}, body: JSON.stringify({ visitorId: visitorId, email: __sk_identity.otp.email, requestId: __sk_identity.otp.requestId, code: code }) })
        .then(function(r){ if (!r.ok) return r.json().then(function(b){ return (b && typeof b.error === 'string') ? b.error : 'error'; }).catch(function(){ return 'error'; }); return r.json(); })
        .then(function(res){
          if (typeof res === 'string') {
            errEl.textContent = __sk_mapVerifyError(res, L);
            if (res === 'expired' || res === 'request_superseded') { __sk_identity.otp = null; setTimeout(function(){ __sk_showVerificationForm(); }, 600); }
            btn.disabled = false; btn.textContent = oldT; return;
          }
          if (gen !== __sk_identity.generation) return;
          __sk_setResume(res.resumeCredential);
          __sk_identity.generation++; // OTP success is an identity change → bump guard
          // Canonical bootstrap: authenticated /contact is AUTHORITATIVE.
          fetch(CONTACT_URL, { method:'POST', headers:{'Content-Type':'application/json','Accept':'application/json','Authorization':'Bearer '+res.resumeCredential}, body: JSON.stringify({}) })
            .then(function(r2){ if (!r2.ok) return null; return r2.json(); })
            .then(function(data){
              if (gen !== __sk_identity.generation - 1) return; // guard
              if (!data) { __sk_clearResume(); __sk_showVerificationForm(); return; }
              state.contactId = data.contactId; state.conversationId = data.conversationId; state.token = data.realtimeToken;
              __sk_identity.state = 'verified_ready';
              connectSocket(); if (state.conversationId) loadMessages();
            });
        });
    };
    card.appendChild(btn);
    var resend = el('button','',L.resend); __sk_styleTextBtn(resend);
    resend.onclick = function(){
      if (__sk_identity.resendInFlight || !__sk_identity.otp) return;
      __sk_identity.resendInFlight = true; resend.disabled = true;
      var visitorId = getVisitorId();
      fetch(__sk_OTP_RESEND_URL, { method:'POST', headers:{'Content-Type':'application/json','Accept':'application/json'}, body: JSON.stringify({ visitorId: visitorId, email: __sk_identity.otp.email, requestId: __sk_identity.otp.requestId }) })
        .then(function(r){ if (!r.ok) return r.json().then(function(b){ return (b && typeof b.error === 'string') ? b.error : 'error'; }).catch(function(){ return 'error'; }); return r.json(); })
        .then(function(res){
          if (typeof res === 'string') { errEl.textContent = __sk_mapVerifyError(res, L); }
          else { __sk_identity.otp = { requestId: res.requestId, email: __sk_identity.otp.email, expiresAt: res.expiresAt }; errEl.textContent = ''; }
        })
        .catch(function(){})
        .then(function(){ __sk_identity.resendInFlight = false; resend.disabled = false; });
    };
    card.appendChild(resend);
    var back = el('button','',L.back); __sk_styleTextBtn(back);
    back.onclick = function(){ __sk_identity.otp = null; __sk_showVerificationForm(); };
    card.appendChild(back);
    bodyEl.appendChild(card);
  }

  function __sk_mapVerifyError(code, L){
    switch(code){
      case 'code_mismatch': return L.verifyFailed;
      case 'expired': case 'request_superseded': case 'already_used': return L.expired;
      case 'attempt_limit_reached': case 'rate_limited': case 'resend_limit': return L.rateLimited;
      case 'policy_unavailable': case 'mode_mismatch': return L.unavailable;
      default: return L.defaultError;
    }
  }

  // ─── Mode-aware bootstrap (replaces the identifyVisitor() call in mount) ─
  function __sk_bootstrap(){
    var mode = (state.config && state.config.accessMode) ? state.config.accessMode : null;
    if (mode === 'anonymous') { __sk_identity.state = 'anonymous_ready'; identifyVisitor(); }
    else if (mode === 'verified_visitor') { __sk_verifiedBootstrap(); }
    else if (mode === 'site_user_only') { __sk_siteUserBootstrap(__sk_identity.memoryToken || null); }
    else { __sk_identity.state = 'integration_unavailable'; __sk_renderIntegrationUnavailable(); }
  }

  function __sk_verifiedBootstrap(){
    var resume = __sk_getResume();
    if (!resume) { __sk_showVerificationForm(); return; }
    __sk_identity.state = 'verified_ready';
    var gen = __sk_identity.generation;
    fetch(CONTACT_URL, { method:'POST', headers:{'Content-Type':'application/json','Accept':'application/json','Authorization':'Bearer '+resume}, body: JSON.stringify({}) })
      .then(function(r){ if (!r.ok) return null; return r.json(); })
      .then(function(data){
        if (gen !== __sk_identity.generation) return;
        if (!data) { __sk_clearResume(); __sk_showVerificationForm(); return; }
        state.contactId = data.contactId; state.conversationId = data.conversationId; state.token = data.realtimeToken;
        connectSocket(); if (state.conversationId) loadMessages();
      });
  }

  function __sk_siteUserBootstrap(token){
    __sk_identity.state = 'site_loading';
    var gen = __sk_identity.generation;
    var doBootstrap = function(bearer){
      fetch(CONTACT_URL, { method:'POST', headers:{'Content-Type':'application/json','Accept':'application/json','Authorization':'Bearer '+bearer}, body: JSON.stringify({}) })
        .then(function(r){ if (!r.ok) return null; return r.json(); })
        .then(function(data){
          if (gen !== __sk_identity.generation) return;
          if (!data) { __sk_identity.memoryToken = null; __sk_enterLoginRequired(); return; }
          __sk_identity.memoryToken = bearer;
          state.contactId = data.contactId; state.conversationId = data.conversationId; state.token = data.realtimeToken;
          __sk_identity.state = 'site_ready';
          connectSocket(); if (state.conversationId) loadMessages();
        });
    };
    if (token) { doBootstrap(token); return; }
    // Resolve the customer identity endpoint (same-origin only, fail closed).
    // v1 script supports a data-identity-endpoint override on its <script> tag.
    var explicitEndpoint = null;
    try { var ts = document.currentScript; if (ts) explicitEndpoint = ts.getAttribute('data-identity-endpoint'); } catch(e){}
    var endpoint = __sk_resolveIdentityEndpoint(explicitEndpoint, (state.config && state.config.identityEndpointPath) || null);
    if (!endpoint) { __sk_enterLoginRequired(); return; }
    __sk_fetchIdentity(endpoint, __sk_IDENTITY_TIMEOUT_MS).then(function(result){
      if (gen !== __sk_identity.generation) return;
      if (result === null) { __sk_identity.state = 'integration_unavailable'; __sk_renderIntegrationUnavailable(); return; }
      if (!result.authenticated || !result.token) { __sk_enterLoginRequired(); return; }
      doBootstrap(result.token);
    });
  }

  // ─── Mode-aware token refresh (replaces refreshVisitorToken for auth modes) ─
  function __sk_modeAwareRefreshToken(cb){
    var mode = (state.config && state.config.accessMode) ? state.config.accessMode : null;
    if (mode === 'anonymous') { refreshVisitorToken(cb); return; }
    if (mode === 'verified_visitor') {
      var resume = __sk_getResume();
      if (!resume) { __sk_showVerificationForm(); if (cb) cb(null); return; }
      fetch(CONTACT_URL, { method:'POST', headers:{'Content-Type':'application/json','Accept':'application/json','Authorization':'Bearer '+resume}, body: JSON.stringify({}) })
        .then(function(r){ if (!r.ok) return null; return r.json(); })
        .then(function(data){
          if (!data) { __sk_clearResume(); __sk_showVerificationForm(); if (cb) cb(null); return; }
          state.token = data.realtimeToken; if (data.conversationId && !state.conversationId) state.conversationId = data.conversationId;
          if (cb) cb(data);
        })
        .catch(function(){ if (cb) cb(null); });
      return;
    }
    if (mode === 'site_user_only') {
      var endpoint = __sk_resolveIdentityEndpoint(null, (state.config && state.config.identityEndpointPath) || null);
      if (!endpoint) { __sk_enterLoginRequired(); if (cb) cb(null); return; }
      __sk_fetchIdentity(endpoint, __sk_IDENTITY_TIMEOUT_MS).then(function(result){
        if (result === null || !result.authenticated || !result.token) { __sk_enterLoginRequired(); if (cb) cb(null); return; }
        fetch(CONTACT_URL, { method:'POST', headers:{'Content-Type':'application/json','Accept':'application/json','Authorization':'Bearer '+result.token}, body: JSON.stringify({}) })
          .then(function(r){ if (!r.ok) return null; return r.json(); })
          .then(function(data){ if (!data) { if (cb) cb(null); return; } __sk_identity.memoryToken = result.token; state.token = data.realtimeToken; if (data.conversationId && !state.conversationId) state.conversationId = data.conversationId; if (cb) cb(data); })
          .catch(function(){ if (cb) cb(null); });
      });
      return;
    }
    if (cb) cb(null);
  }

  // ─── Authorization recovery (socket connect_error policy + send policy) ──
  function __sk_authorizationRecovery(reason){
    if (!__sk_POLICY_REASONS[reason]) return Promise.resolve(null);
    return __sk_configRefresh().then(function(cfg){
      if (!cfg) return null;
      __sk_identity.generation++;
      __sk_clearIdentityState();
      __sk_bootstrap();
      return null;
    });
  }

  // ─── Public SPA surface: window.SukhanWidget ────────────────────────────
  function __sk_setIdentity(token){
    __sk_identity.generation++;
    __sk_clearIdentityState();
    if (token === null || token === undefined || token === '') {
      __sk_identity.memoryToken = null;
      __sk_enterLoginRequired();
      return Promise.resolve();
    }
    __sk_siteUserBootstrap(token);
    return Promise.resolve();
  }
  function __sk_refreshIdentity(){
    __sk_identity.generation++;
    __sk_clearIdentityState();
    __sk_identity.loginEmitted = false;
    __sk_siteUserBootstrap(__sk_identity.memoryToken || null);
    return Promise.resolve();
  }
  try { window.SukhanWidget = { setIdentity: __sk_setIdentity, refreshIdentity: __sk_refreshIdentity }; } catch(e){}
`;
