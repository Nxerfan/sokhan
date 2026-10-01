import { db } from '@/lib/db'
import { normalizeApiKey } from '@/lib/widget/widget-utils'

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

function buildScript(socketUrlOverride: string | null): string {
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
  var SOCKET_IO_JS = API_URL + "/socket.io.min.js";
  // SOCKET_URL is resolved server-side from NEXT_PUBLIC_REALTIME_URL.
  //   - docker/dev (no env set) → API_URL + "/?XTransformPort=3003" (Caddy).
  //   - vercel (env set to public realtime host) → that absolute URL.
  var SOCKET_URL = ${socketUrlOverride ? JSON.stringify(socketUrlOverride) : 'API_URL + "/?XTransformPort=3003"'};
  var SOCKET_PATH = SOCKET_URL.indexOf("/api/realtime") >= 0 ? "/api/realtime" : "/";

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
  };

  var STORAGE_KEY = 'sukhan_visitor_' + SLUG;

  function getVisitorId(){
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      if (v) return v;
      v = 'vis_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(STORAGE_KEY, v);
      return v;
    } catch(e) {
      return 'vis_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
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
    state.locale = config.defaultLocale === 'en' ? 'en' : 'fa';
    state.dir = config.defaultDirection === 'ltr' ? 'ltr' : 'rtl';
    var accent = config.accentColor || '#E09A2B';
    var pos = config.position || 'bottom-start';
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
    var titleText = el('div', '', config.name || (state.locale==='fa'?'گفت‌وگو':'Chat'));
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
      state.messages.push({ senderType:'system', content:{ text: greeting }, createdAt: new Date().toISOString() });
    }

    // Typing indicator
    typingEl = el('div', 'sk-typing');
    css(typingEl, { display:'none', padding:'4px 16px', fontSize:'11px', color:'#888', background:'#f7f5f1' });
    typingEl.innerHTML = '<span style="display:inline-flex;gap:3px"><span class="sk-dot"></span><span class="sk-dot"></span><span class="sk-dot"></span></span>';
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

    panel.appendChild(header); panel.appendChild(bodyEl);

    // Free-plan "Powered by" badge
    if (!config.plan || config.plan === 'free') {
      var badge = el('a', 'sk-powered');
      badge.href = 'https://sukhan.chat';
      badge.target = '_blank';
      badge.rel = 'noopener noreferrer';
      css(badge, { display:'block', padding:'4px 12px 6px', background:'#fff', borderTop:'1px solid #f0eee9', fontSize:'10px', color:'#999', textAlign:'center', textDecoration:'none', flexShrink:'0' });
      badge.textContent = state.locale === 'fa' ? 'نیرو گرفته از سُخن' : 'Powered by Sukhan';
      panel.appendChild(badge);
    }

    panel.appendChild(inputBar);
    root.appendChild(panel); root.appendChild(launcher);
    document.body.appendChild(root);

    renderMessages();
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

  function connectSocket(){
    loadSocketIO(function(){
      if (state.socket) return;
      state.socket = window.io(SOCKET_URL, {
        path: SOCKET_PATH,
        auth: { token: state.token },
        transports: SOCKET_URL.indexOf("/api/realtime") >= 0 ? ["websocket"] : ["websocket", "polling"],
        reconnection: true,
      });
      state.socket.on('connect', function(){
        state.connected = true;
        if (state.conversationId) {
          state.socket.emit('conversation:join', state.conversationId);
        }
      });
      state.socket.on('disconnect', function(){ state.connected = false; });
      state.socket.on('message:new', function(msg){
        state.messages.push(msg);
        renderMessages();
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
    fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
      body: JSON.stringify({ text: text }),
    })
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (data.message) {
        state.messages.push(data.message);
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
    .catch(function(e){ console.error('[sukhan] send failed', e); });
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
        var bg = isVisitor ? '#0E1116' : '#fff';
        var color = isVisitor ? '#FAF7F2' : '#0E1116';
        var radius = isVisitor ? '12px 12px 4px 12px' : '12px 12px 12px 4px';
        css(bubble, { alignSelf:align, background:bg, color:color, borderRadius:radius, padding:'8px 12px', fontSize:'13px', maxWidth:'75%', boxShadow:'0 1px 2px rgba(0,0,0,.06)', wordBreak:'break-word' });
        bubble.setAttribute('dir', 'auto');
        if (msg.content.text) {
          var p = el('p', '', esc(msg.content.text));
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
              var a = el('a', '', esc(att.name));
              a.href = att.url; a.setAttribute('download', att.name);
              css(a, { display:'block', marginTop:'4px', fontSize:'11px', color: isVisitor ? '#FAF7F2' : '#1F8F8F' });
              bubble.appendChild(a);
            }
          }
        }
        var ts = el('span', '', fmt(msg.createdAt));
        css(ts, { display:'block', fontSize:'10px', marginTop:'2px', opacity:'.6' });
        bubble.appendChild(ts);
      }
      bodyEl.insertBefore(bubble, typingEl);
    }
    scrollBody();
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
  //   - docker/dev (no env set) → null → script uses API_URL + Caddy pattern.
  //   - vercel (env set to public realtime host) → that absolute URL.
  const socketUrlOverride = process.env.NEXT_PUBLIC_REALTIME_URL || null
  const script = buildScript(socketUrlOverride)
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
