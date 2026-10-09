import { db } from '@/lib/db'

/**
 * Embeddable widget script (Module 2 — real two-way chat client).
 *
 * Customers embed a single tag:
 *   <script async defer src="https://app/api/widget/<slug>/script"></script>
 *
 * The script:
 *   1. Fetches the tenant's WidgetConfig (theme)
 *   2. Generates a visitorId (stored in localStorage) and identifies the visitor
 *   3. Loads socket.io-client from the same origin
 *   4. Connects to the realtime service via the Caddy gateway (XTransformPort=3003)
 *   5. Renders a full chat UI (message list, input, typing indicator)
 *   6. Sends/receives messages in real time via REST + Socket.IO
 *
 * Fully self-contained (no framework), RTL-aware via the config's defaultDirection.
 */

function buildScript(_origin: string, slug: string, disablePolling: boolean, socketUrl: string, isVercel: boolean): string {
  // The baked SOCKET_URL value can be one of THREE things:
  //   1. The literal placeholder string "__API_URL__" (Vercel, no explicit
  //      override) — the script replaces this with API_URL at runtime.
  //   2. A JSON-stringified absolute URL (when NEXT_PUBLIC_REALTIME_URL is
  //      set — explicit override).
  //   3. The raw JavaScript expression `API_URL + "/?XTransformPort=3003"`
  //      (Docker/dev default) — NOT a JSON string, this is live JS code
  //      that builds an absolute URL against the Sukhan origin at runtime
  //      (so the widget works when embedded on a customer's website with
  //      a different origin from the page itself).
  const vercelPlaceholder = '__API_URL__'
  // Determine the literal text that goes between `var SOCKET_URL = ` and `;`.
  let bakedSocketUrlExpr: string
  if (isVercel) {
    bakedSocketUrlExpr = JSON.stringify(vercelPlaceholder)
  } else if (socketUrl && socketUrl !== '/?XTransformPort=3003') {
    // Explicit override (NEXT_PUBLIC_REALTIME_URL set) — bake as JSON string.
    bakedSocketUrlExpr = JSON.stringify(socketUrl)
  } else {
    // Docker/dev default — bake the raw JavaScript expression (NOT a JSON
    // string) so it's evaluated at runtime. This makes the socket URL
    // absolute (prefixed with API_URL) — consistent with the v1 widget,
    // and works for cross-origin widget embedding.
    bakedSocketUrlExpr = 'API_URL + "/?XTransformPort=3003"'
  }
  return `(function(){
  "use strict";
  var SLUG = ${JSON.stringify(slug)};
  // DISABLE_POLLING is set to true when the script is loaded with ?nopoll=1 —
  // used ONLY by the Socket.IO verification test to isolate real-time delivery
  // from the polling safety net. In normal operation polling stays enabled.
  var DISABLE_POLLING = ${disablePolling ? 'true' : 'false'};
  // Resolve the Sukhan/API origin from the script's own src attribute.
  // The widget's <script src="https://sukhan.app/api/widget/<slug>/script">
  // is loaded FROM the Sukhan origin — extracting the origin from the src
  // lets the widget work even when embedded on a customer's website that
  // lives on a different origin from the page itself.
  var thisScript = document.currentScript || (function(){
    var scripts = document.getElementsByTagName('script');
    return scripts[scripts.length - 1];
  })();
  var API_URL = '';
  if (thisScript && thisScript.src) {
    // Strip everything from "/api/widget/" onward — leaves the origin.
    API_URL = thisScript.src.split('/api/widget/')[0];
  }
  // REST URLs are prefixed with API_URL so the widget works when embedded
  // on a customer's website (different origin from the Sukhan app). When
  // API_URL is empty (script src couldn't be resolved), the URLs become
  // relative — which works behind Caddy reverse proxy where the page
  // origin IS the Sukhan origin.
  var CONFIG_URL = API_URL + "/api/widget/" + SLUG + "/config";
  var CONTACT_URL = API_URL + "/api/widget/" + SLUG + "/contact";
  var MESSAGES_URL = API_URL + "/api/widget/" + SLUG + "/messages";
  var CSAT_URL = API_URL + "/api/widget/" + SLUG + "/csat";
  var SOCKET_IO_JS = API_URL ? API_URL + "/socket.io.min.js" : "/socket.io.min.js";
  // SOCKET_URL is resolved server-side and baked in.
  //   - docker/dev (no env, VERCEL!=1) -> the runtime expression
  //     'API_URL + "/?XTransformPort=3003"' (the gateway reverse-proxies to
  //     the realtime service on port 3003). Using the absolute Sukhan
  //     origin (not a relative URL) means the widget works on a customer
  //     website with a different page origin.
  //   - vercel (VERCEL=1, no NEXT_PUBLIC_REALTIME_URL) → the placeholder
  //     "__API_URL__", replaced at runtime with the Sukhan origin. We
  //     must NOT bake "/api/realtime" — passing it to io() as the URL
  //     creates a NAMESPACE, not a path, and silently breaks on Vercel.
  //     Connecting to the Sukhan origin with path /api/realtime
  //     lets Vercel's edge route the WebSocket request to the Function.
  //   - explicit (NEXT_PUBLIC_REALTIME_URL set) → that absolute URL.
  var SOCKET_URL = ${bakedSocketUrlExpr};
  if (SOCKET_URL === ${JSON.stringify(vercelPlaceholder)}) {
    SOCKET_URL = API_URL;
  }
  var SOCKET_PATH = SOCKET_URL.indexOf("/api/realtime") >= 0 ? "/api/realtime" : "/";
  // On Vercel, SOCKET_URL is API_URL (just an origin — no /api/realtime
  // substring), so SOCKET_PATH defaults to "/". Force it to the Vercel
  // WebSocket Function path.
  if (${isVercel ? 'true' : 'false'} && SOCKET_PATH === '/') {
    SOCKET_PATH = "/api/realtime";
  }

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
    // Monotonic counter for optimistic (not-yet-persisted) message
    // placeholders. Each optimistic send gets a unique local id like
    // "__local_1" so the central merge can reconcile it with the
    // persisted server message that arrives later (the optimistic
    // entry's text + senderType match the persisted message; the merge
    // replaces the optimistic entry with the persisted one by id +
    // content equality).
    optimisticSeq: 0,
    // Active polling timer handle (or null). The polling lifecycle is:
    //   - start whenever a valid conversation exists (identify-
    //     restoration OR first-message-creation), even before the
    //     socket connects — so a customer behind a proxy that blocks
    //     websockets still receives agent replies.
    //   - when the socket connects + the conversation room is joined,
    //     stop polling (realtime is the primary path).
    //   - when the socket disconnects, restart polling.
    //   - never start two polling timers concurrently.
    pollTimer: null,
  };

  // ============================================================
  // Central message merge — the SINGLE ingestion chokepoint.
  // ============================================================
  // All paths that add messages to the widget state MUST route through
  //   mergeIncoming(incoming)
  // which:
  //   - deduplicates persisted messages by 'message.id'
  //   - preserves chronological order using 'createdAt'
  //   - reconciles an optimistic visitor message with its persisted
  //     server response (the optimistic entry has id "__local_N" and
  //     senderType "contact" with the same text; the persisted server
  //     message has a real id + matching text + senderType "contact"
  //     + a slightly later createdAt — mergeIncoming replaces the
  //     optimistic entry with the persisted one based on
  //     id+senderType+content+approximate-createdAt)
  //   - never renders one persisted message twice (a Socket.IO echo
  //     of a message that already arrived via the POST response is a
  //     no-op)
  //   - tolerates events arriving in different orders (POST response
  //     before Socket.IO echo, polling catch-up after realtime, etc.)
  //
  // We do NOT use array length as identity (the previous polling
  // strategy 'data.messages.slice(state.messages.length)' was unsafe
  // — it assumed the server's order matches the local order, which
  // breaks when an optimistic message is at index N locally but the
  // server's persisted message is at index N-1).
  //
  // Returns the new messages array (does NOT mutate state.messages
  // directly — the caller assigns the result back so React-like
  // referential change detection works if we ever wrap this in a
  // framework).
  function mergeIncoming(incoming){
    var existing = state.messages;
    var merged = mergeMessageArrays(existing, incoming);
    return merged;
  }

  // Pure merge of two message arrays — extracted so it can be
  // unit-tested if we ever extract the widget logic into a shared
  // module. Returns a NEW array; does NOT mutate inputs.
  //
  // Messages WITHOUT an id (e.g. the greeting system message, which
  // is created locally and never persisted) are ALWAYS kept — they
  // are not subject to dedup (there's nothing to dedup against).
  function mergeMessageArrays(existing, incoming){
    // Build a Map of persisted messages by id (from both existing
    // and incoming). Persisted messages have real ids (NOT starting
    // with __local_).
    var byId = {};
    // Track optimistic entries (id starts with __local_) by their
    // senderType+text key, so an incoming persisted message with the
    // same text can reconcile (supersede) the optimistic placeholder.
    var optimisticByKey = {};

    // Index existing messages.
    for (var i = 0; i < existing.length; i++) {
      var m = existing[i];
      if (!m) continue;
      if (m.id && String(m.id).indexOf('__local_') === 0) {
        // Optimistic placeholder — key by text+senderType so the
        // persisted response can find it.
        var key = (m.senderType || '') + '\u0001' + (m.content && m.content.text || '');
        if (!optimisticByKey[key]) {
          optimisticByKey[key] = m;
        }
      } else if (m.id) {
        byId[m.id] = m;
      }
      // Messages without an id are NOT indexed — they pass through
      // the output phase unchanged (kept as-is).
    }

    // Process incoming messages.
    for (var j = 0; j < incoming.length; j++) {
      var im = incoming[j];
      if (!im) continue;
      if (im.id && String(im.id).indexOf('__local_') === 0) {
        // Incoming optimistic message (from sendMessage). Add it to
        // the optimistic set — it's a NEW placeholder that should
        // appear in the output.
        var ikey = (im.senderType || '') + '\u0001' + (im.content && im.content.text || '');
        if (!optimisticByKey[ikey]) {
          optimisticByKey[ikey] = im;
        }
        continue;
      }
      if (!im.id) continue; // no-id messages (greeting) skip the merge
      // Persisted incoming message.
      var cur = byId[im.id];
      if (!cur) {
        // New persisted message. Check if there's an optimistic
        // placeholder with the same text+senderType that should be
        // reconciled (superseded).
        var pkey = (im.senderType || '') + '\u0001' + (im.content && im.content.text || '');
        if (optimisticByKey[pkey]) {
          // Mark the optimistic entry as superseded by this persisted id.
          optimisticByKey[pkey]._supersededBy = im.id;
        }
        byId[im.id] = im;
      } else {
        // Same id — keep the newer copy (by createdAt). On a tie,
        // the incoming copy wins.
        if (!cur.createdAt || (im.createdAt && im.createdAt >= cur.createdAt)) {
          byId[im.id] = im;
        }
      }
    }

    // Build the output: walk existing in order. For each entry:
    //   - No id → keep as-is (greeting).
    //   - Optimistic + superseded → emit the persisted counterpart.
    //   - Optimistic + NOT superseded → keep the optimistic entry.
    //   - Persisted → emit the latest copy from byId.
    // Then append any incoming messages (persisted OR optimistic OR
    // no-id) that weren't already in existing.
    var out = [];
    var seenPersistedIds = {};
    var seenOptimisticKeys = {};
    var seenNoIdKeys = {}; // dedup no-id messages by a composite key
    for (var k = 0; k < existing.length; k++) {
      var em = existing[k];
      if (!em) continue;
      if (!em.id) {
        // No-id message (greeting) — keep it. Dedup by a composite key
        // so the same greeting doesn't appear twice if merge is called
        // multiple times with the greeting in both existing and incoming.
        var nkey = (em.senderType || '') + '\u0001' + (em.content && em.content.text || '') + '\u0001' + (em.createdAt || '');
        if (!seenNoIdKeys[nkey]) {
          out.push(em);
          seenNoIdKeys[nkey] = true;
        }
      } else if (String(em.id).indexOf('__local_') === 0) {
        // Optimistic entry.
        var ekey = (em.senderType || '') + '\u0001' + (em.content && em.content.text || '');
        seenOptimisticKeys[ekey] = true;
        if (em._supersededBy && byId[em._supersededBy]) {
          // Superseded — emit the persisted counterpart.
          var persisted = byId[em._supersededBy];
          if (!seenPersistedIds[persisted.id]) {
            out.push(persisted);
            seenPersistedIds[persisted.id] = true;
          }
        } else {
          // Pending or failed — keep it.
          out.push(em);
        }
      } else {
        // Persisted entry — emit the latest copy from byId.
        var latest = byId[em.id];
        if (latest && !seenPersistedIds[latest.id]) {
          out.push(latest);
          seenPersistedIds[latest.id] = true;
        }
      }
    }
    // Append incoming messages not already emitted.
    for (var l = 0; l < incoming.length; l++) {
      var im2 = incoming[l];
      if (!im2) continue;
      if (!im2.id) {
        // No-id incoming message (e.g. greeting via addMessage).
        var nkey2 = (im2.senderType || '') + '\u0001' + (im2.content && im2.content.text || '') + '\u0001' + (im2.createdAt || '');
        if (!seenNoIdKeys[nkey2]) {
          out.push(im2);
          seenNoIdKeys[nkey2] = true;
        }
      } else if (String(im2.id).indexOf('__local_') === 0) {
        // Incoming optimistic message (from sendMessage). If it
        // wasn't already in existing, add it now.
        var ikey2 = (im2.senderType || '') + '\u0001' + (im2.content && im2.content.text || '');
        if (!seenOptimisticKeys[ikey2]) {
          out.push(im2);
          seenOptimisticKeys[ikey2] = true;
        }
      } else {
        if (!seenPersistedIds[im2.id]) {
          out.push(im2);
          seenPersistedIds[im2.id] = true;
        }
      }
    }
    // Sort chronologically by createdAt ASC, id ASC tie-break.
    // No-id messages (greeting) sort by their createdAt too.
    out.sort(function(a, b){
      var ca = a.createdAt || '';
      var cb = b.createdAt || '';
      if (ca < cb) return -1;
      if (ca > cb) return 1;
      var ia = a.id || '';
      var ib = b.id || '';
      if (ia < ib) return -1;
      if (ia > ib) return 1;
      return 0;
    });
    return out;
  }

  var STORAGE_KEY = 'sukhan_visitor_' + SLUG;

  function getVisitorId(){
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      if (v) return v;
      // Cryptographically strong visitor ID — prefer crypto.randomUUID()
      // (available in all modern browsers over https and localhost).
      // Fall back to a CSPRNG-style ID if crypto.randomUUID is unavailable.
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

  // ---- DOM refs (created in mount) ----
  var bodyEl, inputEl, sendBtn, typingEl, launcher, panel, pulseDot;

  function mount(config){
    if (window.__sukhan_mounted) return;
    window.__sukhan_mounted = true;
    state.config = config;
    state.locale = config.defaultLocale || 'fa';
    state.dir = config.defaultDirection === 'ltr' ? 'ltr' : 'rtl';
    var accent = config.accentColor || '#E09A2B';
    var pos = config.position || 'bottom-end';
    var side = pos === 'bottom-start' ? 'left' : 'right';
    if (state.dir === 'rtl') side = pos === 'bottom-start' ? 'right' : 'left';

    injectStyles(accent);

    var root = el('div', 'sk-root');
    root.setAttribute('dir', state.dir);
    css(root, { position: 'fixed', bottom: '20px', zIndex: '2147483000' });
    root.style[side] = '20px';

    launcher = el('button', 'sk-launcher ' + shapeClass(config.launcherShape));
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
    panel.style[side] = '0';

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

    // Messages area
    bodyEl = el('div', 'sk-body');
    css(bodyEl, { flex:'1', overflowY:'auto', padding:'16px', background:'#f7f5f1', display:'flex', flexDirection:'column', gap:'8px' });

    // Greeting message
    var greeting = config.greetingTexts && config.greetingTexts[state.locale];
    if (greeting) {
      addMessage({ senderType:'system', content:{ text: greeting }, createdAt: new Date().toISOString() });
    }

    // Typing indicator
    typingEl = el('div', 'sk-typing');
    css(typingEl, { display:'none', padding:'4px 16px', fontSize:'11px', color:'#888', background:'#f7f5f1' });
    typingEl.innerHTML = '<span style="display:inline-flex;gap:3px"><span class="sk-dot"></span><span class="sk-dot"></span><span class="sk-dot"></span></span>';
    bodyEl.parentNode && bodyEl.parentNode.insertBefore(typingEl, bodyEl.nextSibling);
    // Actually append typing indicator inside body, at the bottom
    bodyEl.appendChild(typingEl);

    // Input bar
    var inputBar = el('div', 'sk-input');
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

    panel.appendChild(header); panel.appendChild(bodyEl); panel.appendChild(inputBar);
    root.appendChild(panel); root.appendChild(launcher);
    document.body.appendChild(root);

    // Identify visitor and connect
    identifyVisitor();
  }

  function toggle(){
    state.open = !state.open;
    if (state.open) {
      css(panel, { opacity:'1', transform:'translateY(0) scale(1)', pointerEvents:'auto' });
      pulseDot.style.display = 'none';
      setTimeout(function(){ inputEl && inputEl.focus(); }, 200);
    } else {
      css(panel, { opacity:'0', transform:'translateY(8px) scale(.98)', pointerEvents:'none' });
    }
  }

  // ---- Visitor identification ----
  function identifyVisitor(){
    var visitorId = getVisitorId();
    fetch(CONTACT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId: visitorId }),
    })
    .then(function(r){
      // Proper response handling: check r.ok before parsing JSON. A 401
      // /403/429/500 path is a failure — do NOT silently treat a JSON
      // error body as success data.
      if (!r.ok) {
        // Safe error code extraction — never log the request body (it
        // might contain a token in a future variant) or headers.
        console.error('[sukhan] identify POST failed with status ' + r.status);
        throw new Error('identify_failed_' + r.status);
      }
      return r.json();
    })
    .then(function(data){
      state.contactId = data.contactId;
      state.conversationId = data.conversationId;
      state.token = data.realtimeToken;

      // WARM UP the socket connection IMMEDIATELY after identification —
      // BEFORE any conversation exists. This fixes the race condition where
      // an agent replies faster than the socket can load+connect+join, causing
      // the reply to be missed (only caught later by the 10s polling fallback).
      // The socket connects to the tenant room now; when a conversation is
      // created later, we emit conversation:join on the already-connected socket.
      connectSocket();

      // Load existing messages if there's an open conversation
      if (state.conversationId) {
        loadMessages();
        // #4 polling lifecycle: when identify returns an existing
        // conversationId, start the polling fallback immediately. The
        // socket may still be connecting (or may never connect if the
        // customer is behind a proxy that blocks websockets). Polling
        // is the safety net that ensures agent replies still arrive.
        // When the socket connects + joins the conversation room,
        // stopPolling() is called (realtime is primary).
        startPolling();
      }
    })
    .catch(function(e){
      // e.message is the safe 'identify_failed_<status>' string — no
      // token, no headers, no body. Safe to log.
      console.error('[sukhan] identify failed', e && e.message ? e.message : e);
    });
  }

  function loadMessages(){
    if (!state.conversationId) return;
    fetch(MESSAGES_URL + '?conversationId=' + state.conversationId, {
      headers: { 'Authorization': 'Bearer ' + state.token },
    })
    .then(function(r){
      if (!r.ok) {
        console.error('[sukhan] loadMessages GET failed with status ' + r.status);
        throw new Error('load_failed_' + r.status);
      }
      return r.json();
    })
    .then(function(data){
      if (data.messages) {
        // #2 central merge path: route history through mergeIncoming
        // so it deduplicates against any optimistic entries already
        // present + preserves chronological order. Never assigns the
        // raw array directly (the old 'state.messages = data.messages'
        // would erase optimistic entries).
        state.messages = mergeIncoming(data.messages);
        renderMessages();
      }
    })
    .catch(function(){});
  }

  // ---- Socket.IO connection ----
  function loadSocketIO(callback){
    if (window.io) { callback(); return; }
    var s = document.createElement('script');
    s.src = SOCKET_IO_JS;
    s.onload = callback;
    s.onerror = function(){ console.error('[sukhan] failed to load socket.io-client'); };
    document.head.appendChild(s);
  }

  function refreshVisitorToken(callback){
    // Re-identify using the SAME visitorId — this does NOT create a new
    // Contact (the visitorId already exists in the DB). It just issues
    // a fresh realtime token with a new expiry.
    var visitorId = getVisitorId();
    fetch(CONTACT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId: visitorId }),
    })
    .then(function(r){
      if (!r.ok) {
        console.error('[sukhan] token refresh POST failed with status ' + r.status);
        throw new Error('refresh_failed_' + r.status);
      }
      return r.json();
    })
    .then(function(data){
      if (data.realtimeToken) {
        state.token = data.realtimeToken;
        if (state.contactId) data.contactId = state.contactId;
        if (data.conversationId && !state.conversationId) state.conversationId = data.conversationId;
      }
      if (callback) callback(data);
    })
    .catch(function(e){
      // Safe error message — no token, no headers.
      console.error('[sukhan] token refresh failed', e && e.message ? e.message : e);
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
        transports: (${isVercel ? "true" : "false"} || SOCKET_PATH.indexOf("/api/realtime") >= 0) ? ["websocket"] : ["websocket", "polling"],
        reconnection: true,
      });
      state.socket.on('connect', function(){
        state.connected = true;
        // #5 safe health log — no token, no auth header.
        console.log('[sukhan] socket connected');
        if (state.conversationId) {
          state.socket.emit('conversation:join', state.conversationId);
        }
        // #4 disconnected-only polling: when the socket is connected +
        // the conversation room is joined, realtime is the primary
        // path — stop the polling safety net to avoid redundant
        // fetches. (Polling restarts automatically on disconnect.)
        stopPolling();
      });
      state.socket.on('disconnect', function(){
        state.connected = false;
        // #5 safe health log.
        console.warn('[sukhan] socket disconnected — polling fallback active');
        // #4 restart the polling safety net whenever the socket drops.
        // If realtime is unavailable (proxy block, server down,
        // Vercel-no-Redis degraded mode), polling is how agent replies
        // still arrive without a page refresh.
        startPolling();
      });
      // When a reconnect fails due to an expired token, refresh the token
      // When the server middleware rejects the connection (invalid/expired
      // token), Socket.IO does NOT auto-reconnect. We must:
      //   1. Re-identify using the SAME visitorId (no new Contact)
      //   2. Update socket.auth with the fresh token
      //   3. Manually call socket.connect()
      // For membership_inactive, do NOT retry — remain disconnected.
      var visitorMembershipRevoked = false;
      state.socket.on('connect_error', function(err){
        if (!err) return;
        // #5 safe health log — only the error MESSAGE (which is a
        // short, safe error code like 'invalid_token' / 'no_token' /
        // 'membership_inactive'). NEVER log err.context or err.data
        // (which could contain auth details in a future variant).
        console.error('[sukhan] socket connect_error:', err.message);
        if (err.message === 'membership_inactive' || err.message === 'membership_check_failed') {
          visitorMembershipRevoked = true;
          if (state.socket) { state.socket.io.opts.reconnection = false; state.socket.disconnect(); }
          // Membership revoked — realtime is permanently unavailable
          // for this visitor. Ensure the polling fallback is active
          // so they still receive agent replies (if any).
          startPolling();
          return;
        }
        if (visitorMembershipRevoked) return;
        if (err.message === 'invalid_token' || err.message === 'no_token') {
          refreshVisitorToken(function(data){
            if (data && data.realtimeToken && state.socket) {
              state.socket.auth = { token: data.realtimeToken };
              state.socket.connect();
            }
          });
        }
      });
      state.socket.on('message:new', function(msg){
        // #2 central merge path: route realtime messages through
        // mergeIncoming so a Socket.IO echo of a message that
        // already arrived via the POST response is a no-op (the
        // message id is already in state.messages). This also handles
        // the case where the visitor's OWN message is echoed back via
        // the conversation room — mergeIncoming sees the optimistic
        // entry (id "__local_N", same text+senderType) and reconciles
        // it with the persisted echo.
        if (!msg || !msg.id) return;
        state.messages = mergeIncoming([msg]);
        renderMessages();
        if (!state.open) {
          pulseDot.style.display = 'block';
        }
        // If this is a system message about conversation closure, show CSAT survey
        if (msg.senderType === 'system' && msg.content && msg.content.text &&
            (msg.content.text.indexOf('closed') >= 0 || msg.content.text.indexOf('بسته') >= 0 ||
             msg.content.text.indexOf('resolved') >= 0 || msg.content.text.indexOf('حل') >= 0)) {
          showCsatSurvey();
        }
      });
      // Listen for conversation status changes (closed → show CSAT)
      state.socket.on('conversation:updated', function(data){
        if (data && data.changes && data.changes.status === 'closed') {
          showCsatSurvey();
        }
      });
      state.socket.on('typing:start', function(data){
        if (data.senderType === 'agent') {
          typingEl.style.display = 'block';
          scrollBody();
        }
      });
      state.socket.on('typing:stop', function(){
        typingEl.style.display = 'none';
      });
    });
  }

  // ---- Send message (optimistic + failed-send UX) ----
  // #1 visitor messages must render immediately. The visitor's bubble
  // appears in the chat area BEFORE the POST completes. The bubble
  // carries a local pending state while the POST is in flight. When
  // the POST responds, the optimistic entry is reconciled with the
  // persisted server message (the visitor's bubble stays in place —
  // no flicker, no duplicate).
  //
  // #8 failed-send UX. If the POST fails (network error, 4xx/5xx,
  // non-JSON response), the optimistic bubble is NOT silently treated
  // as sent. It transitions to a visibly failed state with a retry
  // affordance, and the user's original text is preserved (the retry
  // button re-submits the same text). The text is NOT irretrievably
  // discarded — the user can edit + retry, or copy it out.
  function sendMessage(){
    var text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';

    // #1 Optimistic send: push a local placeholder IMMEDIATELY so the
    // visitor's bubble renders before the POST resolves. The id is
    // "__local_<seq>" so the central merge can later reconcile it
    // with the persisted server message (same text+senderType).
    var optimisticId = '__local_' + (++state.optimisticSeq);
    var optimisticMsg = {
      id: optimisticId,
      conversationId: state.conversationId || null,
      senderType: 'contact',
      senderUserId: null,
      contentType: 'text',
      content: { text: text },
      createdAt: new Date().toISOString(),
      status: 'sent',
      // Local-only metadata: tracks the optimistic state + the
      // original text for retry. NEVER sent to the server.
      _optimistic: true,
      _optimisticStatus: 'pending',
      _optimisticText: text,
    };
    state.messages = mergeIncoming([optimisticMsg]);
    renderMessages();

    // If no conversation yet, create one by sending the first message
    fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
      body: JSON.stringify({ text: text }),
    })
    .then(function(r){
      // #5 proper response handling: check r.ok before parsing. A
      // 401/403/429/500 is a failure — do NOT silently treat a JSON
      // error body as success data.
      if (!r.ok) {
        // Extract a safe error code if possible (the body may be
        // JSON like { error: 'rate_limited' }). NEVER log the
        // Authorization header or the request body (which contained
        // only the visitor's text, but defensive).
        return r.json().catch(function(){ return {}; }).then(function(errBody){
          var safeCode = (errBody && errBody.error) ? errBody.error : ('http_' + r.status);
          throw new Error('send_failed_' + safeCode);
        });
      }
      return r.json();
    })
    .then(function(data){
      // #1 successful POST reconciles the optimistic message with the
      // persisted server message. Route the persisted message through
      // mergeIncoming — it matches the optimistic entry by
      // senderType+text and replaces the placeholder with the real id.
      // The visitor's bubble stays in place (same array slot), so
      // there's no flicker + no duplicate.
      if (data.message) {
        state.messages = mergeIncoming([data.message]);
        renderMessages();
      }
      if (data.conversationId && data.conversationId !== state.conversationId) {
        state.conversationId = data.conversationId;
        // New conversation just created. The socket was already warmed up
        // during identifyVisitor(). If it's connected, join the conversation
        // room NOW so we don't miss rapid agent replies. If it's still
        // connecting, the 'connect' handler will join the room automatically
        // (it checks state.conversationId on connect).
        if (state.socket && state.connected) {
          state.socket.emit('conversation:join', state.conversationId);
        }
      }
      // #4 polling lifecycle: after the first successful message creates
      // a conversation, initialize the polling fallback (if the socket
      // is connected, startPolling is a no-op that immediately returns
      // OR the socket 'connect' handler already called stopPolling).
      // If the socket is NOT connected, polling is the safety net.
      startPolling();
    })
    .catch(function(e){
      // #8 failed-send UX. The optimistic bubble transitions to a
      // visibly failed state with a retry affordance. The user's
      // original text is preserved in the bubble's _optimisticText
      // field — the retry button re-submits it. The text is NOT
      // irretrievably discarded.
      var safeMsg = e && e.message ? e.message : 'send_failed_unknown';
      // #5 safe error log — never the token, never the request body,
      // never the Authorization header. Only the safe error code.
      console.error('[sukhan] message POST failed:', safeMsg);
      // Mark the optimistic entry as failed + attach the safe error code.
      for (var i = 0; i < state.messages.length; i++) {
        var m = state.messages[i];
        if (m.id === optimisticId) {
          m._optimisticStatus = 'failed';
          m._optimisticError = safeMsg;
          break;
        }
      }
      renderMessages();
    });
  }

  // ---- Polling fallback (safety net — see DISABLE_POLLING flag above) ----
  // Primary delivery is Socket.IO. This polling runs only as a resilience
  // fallback in case the realtime connection drops or is blocked by a proxy.
  // Interval is 10s in normal operation — long enough to not be chatty, short
  // enough to recover within a tolerable window if Socket.IO fails silently.
  //
  // #4 polling lifecycle:
  //   - start whenever a valid conversation exists (identify restoration
  //     OR first-message creation), even before the socket connects.
  //   - stop when the socket connects + the conversation room is joined
  //     (realtime is the primary path).
  //   - restart when the socket disconnects.
  //   - never start two timers concurrently (startPolling is idempotent).
  //
  // #2 central merge: polling uses mergeIncoming (ID-based dedup +
  // chronological order). The previous 'data.messages.slice(state.messages.length)'
  // strategy was unsafe — it assumed server order matches local order,
  // which breaks when an optimistic message is at index N locally but
  // the server's persisted message is at index N-1.
  function startPolling(){
    if (DISABLE_POLLING) return; // test-only bypass
    if (state.pollTimer) return; // idempotent — never two timers
    if (!state.conversationId || !state.token) return;
    state.pollTimer = setInterval(function(){
      if (!state.conversationId || !state.token) return;
      fetch(MESSAGES_URL + '?conversationId=' + state.conversationId, {
        headers: { 'Authorization': 'Bearer ' + state.token },
      })
      .then(function(r){
        if (!r.ok) {
          // #5 safe error log — only the status, never the body.
          console.error('[sukhan] polling GET failed with status ' + r.status);
          return null;
        }
        return r.json();
      })
      .then(function(data){
        if (!data || !data.messages) return;
        // #2 central merge path — ID-based dedup + chronological order.
        // This handles: agent replies, visitor echoes, system messages,
        // and reconciles any pending optimistic entries.
        var prevCount = state.messages.length;
        state.messages = mergeIncoming(data.messages);
        if (state.messages.length !== prevCount || true) {
          // Re-render always — the merge may have replaced an optimistic
          // entry with a persisted one (same count, but the bubble's
          // _optimistic flag is gone, so the visual state changed).
          renderMessages();
          if (!state.open) {
            pulseDot.style.display = 'block';
          }
        }
      })
      .catch(function(e){
        // #5 safe error log — never the token, never the body.
        console.error('[sukhan] polling fetch failed:', e && e.message ? e.message : 'network_error');
      });
    }, 10000); // 10s safety net — Socket.IO is the primary delivery path
  }

  function stopPolling(){
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  // ---- Rendering ----
  function addMessage(msg){
    // #2 route through the central merge so addMessage is also
    // dedup-safe (used by the greeting flow + any future caller).
    state.messages = mergeIncoming([msg]);
    renderMessages();
  }

  // Retry a failed optimistic send. Re-submits the original text
  // and re-uses the SAME optimistic id so the merge reconciles the
  // retry's persisted response with the existing bubble (no
  // duplicate, no flicker).
  function retrySendMessage(optimisticId, text){
    // Reset the optimistic entry to pending state for the retry.
    for (var i = 0; i < state.messages.length; i++) {
      var m = state.messages[i];
      if (m.id === optimisticId) {
        m._optimisticStatus = 'pending';
        m._optimisticError = null;
        break;
      }
    }
    renderMessages();
    fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
      body: JSON.stringify({ text: text }),
    })
    .then(function(r){
      if (!r.ok) {
        return r.json().catch(function(){ return {}; }).then(function(errBody){
          var safeCode = (errBody && errBody.error) ? errBody.error : ('http_' + r.status);
          throw new Error('send_failed_' + safeCode);
        });
      }
      return r.json();
    })
    .then(function(data){
      if (data.message) {
        state.messages = mergeIncoming([data.message]);
        renderMessages();
      }
      if (data.conversationId && data.conversationId !== state.conversationId) {
        state.conversationId = data.conversationId;
        if (state.socket && state.connected) {
          state.socket.emit('conversation:join', state.conversationId);
        }
      }
      startPolling();
    })
    .catch(function(e){
      var safeMsg = e && e.message ? e.message : 'send_failed_unknown';
      console.error('[sukhan] message POST retry failed:', safeMsg);
      for (var j = 0; j < state.messages.length; j++) {
        var m2 = state.messages[j];
        if (m2.id === optimisticId) {
          m2._optimisticStatus = 'failed';
          m2._optimisticError = safeMsg;
          break;
        }
      }
      renderMessages();
    });
  }

  function renderMessages(){
    // Clear body except typing indicator
    var children = bodyEl.children;
    for (var i = children.length - 1; i >= 0; i--) {
      if (children[i] !== typingEl) bodyEl.removeChild(children[i]);
    }
    // Render messages before the typing indicator
    for (var j = 0; j < state.messages.length; j++) {
      var msg = state.messages[j];
      var isVisitor = msg.senderType === 'contact';
      var isSystem = msg.senderType === 'system';
      // Optimistic state: pending (in-flight) | failed (POST errored)
      // | undefined (persisted / not optimistic).
      var optStatus = msg._optimistic ? msg._optimisticStatus : null;
      var isFailed = optStatus === 'failed';
      var isPending = optStatus === 'pending';
      var bubble = el('div', 'sk-msg ' + (isSystem ? 'sk-sys' : (isVisitor ? 'sk-vis' : 'sk-agt')) + (isPending ? ' sk-pending' : '') + (isFailed ? ' sk-failed' : ''));
      if (isSystem) {
        css(bubble, { alignSelf:'center', background:'transparent', color:'#888', fontSize:'11px', padding:'4px 0' });
        bubble.textContent = msg.content.text || '';
      } else {
        var align = isVisitor ? 'flex-end' : 'flex-start';
        var bg = isVisitor ? '#0E1116' : '#fff';
        var color = isVisitor ? '#FAF7F2' : '#0E1116';
        var radius = isVisitor ? '12px 12px 4px 12px' : '12px 12px 12px 4px';
        // #1 + #8 visual state: pending → slightly dimmed + a
        // "sending…" caption; failed → red border + retry button +
        // "failed" caption. Persisted messages render normally.
        if (isPending) {
          // Dim the bubble while the POST is in flight.
          bg = isVisitor ? 'rgba(14,17,22,.55)' : 'rgba(255,255,255,.6)';
        }
        if (isFailed) {
          // Red border to signal the failed state.
          radius = isVisitor ? '12px 12px 4px 12px' : '12px 12px 12px 4px';
        }
        css(bubble, {
          alignSelf:align, background:bg, color:color, borderRadius:radius,
          padding:'8px 12px', fontSize:'13px', maxWidth:'75%',
          boxShadow:'0 1px 2px rgba(0,0,0,.06)', wordBreak:'break-word',
          border: isFailed ? '1px solid #dc2626' : 'none',
          opacity: isPending ? '.7' : '1',
        });
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
              // SECURITY: att.name is user-controlled — use textContent, not innerHTML.
              a.textContent = att.name;
              a.href = att.url; a.setAttribute('download', att.name);
              css(a, { display:'block', marginTop:'4px', fontSize:'11px', color: isVisitor ? '#FAF7F2' : '#1F8F8F' });
              bubble.appendChild(a);
            }
          }
        }
        var ts = el('span', '');
        // #1 + #8 status caption: pending → "sending…", failed →
        // "failed — tap retry", persisted → timestamp.
        if (isPending) {
          ts.textContent = state.locale === 'fa' ? 'در حال ارسال…' : 'sending…';
          css(ts, { display:'block', fontSize:'10px', marginTop:'2px', opacity:'.7', fontStyle:'italic' });
        } else if (isFailed) {
          var errCode = msg._optimisticError || 'send_failed';
          ts.textContent = state.locale === 'fa' ? ('ارسال ناموفق — ' + errCode) : ('failed — ' + errCode);
          css(ts, { display:'block', fontSize:'10px', marginTop:'2px', color:'#dc2626' });
        } else {
          ts.textContent = fmt(msg.createdAt);
          css(ts, { display:'block', fontSize:'10px', marginTop:'2px', opacity:'.6' });
        }
        bubble.appendChild(ts);

        // #8 retry affordance for failed optimistic sends.
        if (isFailed) {
          var retryRow = el('div', 'sk-retry-row');
          css(retryRow, { display:'flex', gap:'6px', marginTop:'6px' });
          var retryBtn = el('button', 'sk-retry-btn');
          retryBtn.textContent = state.locale === 'fa' ? 'تلاش دوباره' : 'Retry';
          css(retryBtn, {
            background:'#dc2626', color:'#fff', border:'none', borderRadius:'6px',
            padding:'4px 10px', fontSize:'11px', cursor:'pointer', flex:'1',
          });
          // Capture the original text in the closure so the retry
          // re-submits exactly what the user typed.
          (function(oid, originalText){
            retryBtn.onclick = function(){ retrySendMessage(oid, originalText); };
          })(msg.id, msg._optimisticText || msg.content && msg.content.text || '');
          retryRow.appendChild(retryBtn);

          // Also offer "edit" — restore the text to the input so the
          // user can modify + re-send. The failed bubble stays until
          // the user either retries or sends a new message.
          var editBtn = el('button', 'sk-edit-btn');
          editBtn.textContent = state.locale === 'fa' ? 'ویرایش' : 'Edit';
          css(editBtn, {
            background:'transparent', color:'#dc2626', border:'1px solid #dc2626',
            borderRadius:'6px', padding:'4px 10px', fontSize:'11px', cursor:'pointer',
          });
          (function(originalText){
            editBtn.onclick = function(){
              if (inputEl) {
                inputEl.value = originalText;
                inputEl.focus();
              }
            };
          })(msg._optimisticText || msg.content && msg.content.text || '');
          retryRow.appendChild(editBtn);

          bubble.appendChild(retryRow);
        }
      }
      bodyEl.insertBefore(bubble, typingEl);
    }
    scrollBody();
  }

  function scrollBody(){
    if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  // ---- CSAT Survey (shown when conversation is closed) ----
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
    css(csatCard, {
      background:'#fff', borderRadius:'16px', padding:'24px', maxWidth:'280px', width:'90%',
      textAlign:'center', fontFamily:'inherit', boxShadow:'0 20px 60px rgba(0,0,0,.3)'
    });

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
          // Highlight selected + all lower stars
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
          // Submit after a short delay
          setTimeout(function() { submitCsat(rating, null); }, 300);
        };
        stars.appendChild(star);
      })(i);
    }

    var skip = el('button', '', state.locale === 'fa' ? 'نادیده بگیر' : 'Skip');
    css(skip, { background:'none', border:'none', color:'#888', fontSize:'12px', cursor:'pointer', marginTop:'8px' });
    skip.onclick = function() { removeCsat(); };

    csatCard.appendChild(title);
    csatCard.appendChild(stars);
    csatCard.appendChild(skip);
    csatOverlay.appendChild(csatCard);
    panel.appendChild(csatOverlay);

    // Fade in
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
      .then(function(data) {
        var msg = data.ok
          ? (state.locale === 'fa' ? 'ممنون از بازخورد شما!' : 'Thanks for your feedback!')
          : (state.locale === 'fa' ? 'خطا در ثبت امتیاز' : 'Error submitting rating');
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
      + '.sk-body::-webkit-scrollbar{width:4px;} .sk-body::-webkit-scrollbar-thumb{background:rgba(0,0,0,.15);border-radius:2px;}';
    document.head.appendChild(style);
  }

  // ---- Bootstrap ----
  function fetchConfig(){
    fetch(CONFIG_URL)
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

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params
  const tenant = await db.tenant.findUnique({
    where: { slug },
    include: { widgetConfig: true },
  })
  if (!tenant || !tenant.widgetConfig) {
    return new Response('// workspace not found', {
      status: 404,
      headers: { 'Content-Type': 'application/javascript' },
    })
  }

  const url = new URL(_req.url)
  const disablePolling = url.searchParams.get('nopoll') === '1'
  const origin = url.origin
  // Resolve the public Socket.IO URL the widget will connect to.
  //   - explicit (NEXT_PUBLIC_REALTIME_URL set) → that absolute URL.
  //   - vercel (VERCEL=1, no explicit URL) → use the Sukhan origin at
  //     runtime (the script's __API_URL__ placeholder is replaced with
  //     API_URL extracted from the script's own src).
  //   - docker/dev (default) → "/?XTransformPort=3003" (Caddy forwards).
  // The value is baked into the script as a JSON-encoded string literal so
  // it cannot be tampered with client-side.
  const isVercel = process.env.VERCEL === '1'
  const socketUrl = process.env.NEXT_PUBLIC_REALTIME_URL || '/?XTransformPort=3003'
  const script = buildScript(origin, slug, disablePolling, socketUrl, isVercel && !process.env.NEXT_PUBLIC_REALTIME_URL)

  return new Response(script, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
      'Access-Control-Allow-Origin': '*',
    },
  })
}
