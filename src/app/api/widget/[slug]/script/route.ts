import { db } from '@/lib/db'

/**
 * Embeddable widget script (Module-1 skeleton).
 *
 * Customers embed a single tag:
 *   <script async defer src="https://app/api/widget/<slug>/script"></script>
 *
 * The script self-resolves its own slug from the src URL, fetches the tenant's
 * WidgetConfig, and injects a themed launcher + panel into the host page. It is
 * fully self-contained (no framework, ~6KB) and RTL-aware via the config's
 * defaultDirection. Real-time messaging lands in Module 2 (Socket.IO).
 */

function buildScript(origin: string, slug: string): string {
  return `(function(){
  "use strict";
  var ORIGIN = ${JSON.stringify(origin)};
  var SLUG = ${JSON.stringify(slug)};
  var CONFIG_URL = ORIGIN + "/api/widget/" + SLUG + "/config";
  var state = { open: false, config: null };

  function $(sel, root){ return (root||document).querySelector(sel); }
  function el(tag, cls, html){
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function css(node, props){ for (var k in props) node.style[k] = props[k]; }

  function shapeClass(s){
    if (s === 'pill') return 'sk-pill';
    if (s === 'rounded') return 'sk-rounded';
    return 'sk-tab';
  }

  function mount(config){
    if (window.__sukhan_mounted) return;
    window.__sukhan_mounted = true;
    state.config = config;
    var dir = config.defaultDirection === 'ltr' ? 'ltr' : 'rtl';
    var locale = config.defaultLocale || 'fa';
    var accent = config.accentColor || '#E09A2B';
    var pos = config.position || 'bottom-end';
    var side = pos === 'bottom-start' ? 'left' : 'right';
    if (dir === 'rtl') side = pos === 'bottom-start' ? 'right' : 'left';

    injectStyles(accent, dir);

    var root = el('div', 'sk-root');
    root.setAttribute('dir', dir);
    css(root, { position: 'fixed', bottom: '20px', zIndex: '2147483000' });
    root.style[side] = '20px';

    var launcher = el('button', 'sk-launcher ' + shapeClass(config.launcherShape));
    launcher.setAttribute('aria-label', 'Open chat');
    css(launcher, {
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#0E1116', color: '#FAF7F2', cursor: 'pointer',
      border: 'none', boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
      transition: 'transform .15s ease', padding: '0'
    });
    launcher.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    launcher.onmouseenter = function(){ launcher.style.transform = 'scale(1.05)'; };
    launcher.onmouseleave = function(){ launcher.style.transform = 'scale(1)'; };

    var panel = el('div', 'sk-panel');
    css(panel, {
      position: 'absolute', bottom: '64px', width: '340px', maxWidth: 'calc(100vw - 40px)',
      background: '#fff', borderRadius: '16px', boxShadow: '0 20px 60px rgba(0,0,0,0.22)',
      overflow: 'hidden', fontFamily: 'system-ui, sans-serif',
      opacity: '0', transform: 'translateY(8px) scale(.98)', pointerEvents: 'none',
      transition: 'opacity .18s ease, transform .18s ease'
    });
    panel.style[side] = '0';

    var header = el('div', 'sk-header');
    css(header, { display: 'flex', alignItems: 'center', gap: '10px', padding: '14px 16px', color: '#fff' });
    css(header, { background: accent });
    var logo = el('div', 'sk-logo');
    css(logo, { width: '28px', height: '28px', borderRadius: '50%', background: 'rgba(255,255,255,.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: '0' });
    logo.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    var title = el('div', '', config.name || 'Chat');
    css(title, { fontSize: '14px', fontWeight: '600' });
    header.appendChild(logo); header.appendChild(title);

    var body = el('div', 'sk-body');
    css(body, { padding: '16px', background: '#f7f5f1', minHeight: '180px', display: 'flex', flexDirection: 'column', gap: '10px' });
    var greeting = config.greetingTexts && config.greetingTexts[locale];
    if (greeting) {
      var bubble = el('div', 'sk-bubble', escapeHtml(greeting));
      css(bubble, { background: '#fff', padding: '10px 12px', borderRadius: '12px', borderBottomStartRadius: '4px', fontSize: '13px', color: '#0E1116', maxWidth: '80%', boxShadow: '0 1px 2px rgba(0,0,0,.06)' });
      body.appendChild(bubble);
    }
    var note = el('div', 'sk-note', dir === 'rtl' ? 'پیام‌رسانی زنده به‌زودی' : 'Live messaging coming soon');
    css(note, { marginTop: 'auto', fontSize: '11px', color: '#8a8a8a', textAlign: 'center' });
    body.appendChild(note);

    var inputBar = el('div', 'sk-input');
    css(inputBar, { display: 'flex', padding: '10px 12px', background: '#fff', borderTop: '1px solid #eee', gap: '8px' });
    var input = el('input');
    input.setAttribute('placeholder', dir === 'rtl' ? 'پیام بنویسید…' : 'Type a message…');
    css(input, { flex: '1', border: 'none', outline: 'none', fontSize: '13px', background: 'transparent', color: '#0E1116' });
    var send = el('button', '', '→');
    css(send, { background: accent, color: '#fff', border: 'none', borderRadius: '8px', width: '32px', height: '32px', cursor: 'pointer', fontSize: '16px' });
    inputBar.appendChild(input); inputBar.appendChild(send);

    panel.appendChild(header); panel.appendChild(body); panel.appendChild(inputBar);
    root.appendChild(panel); root.appendChild(launcher);
    document.body.appendChild(root);

    function toggle(){
      state.open = !state.open;
      if (state.open) {
        css(panel, { opacity: '1', transform: 'translateY(0) scale(1)', pointerEvents: 'auto' });
        setTimeout(function(){ input.focus(); }, 200);
      } else {
        css(panel, { opacity: '0', transform: 'translateY(8px) scale(.98)', pointerEvents: 'none' });
      }
    }
    launcher.addEventListener('click', toggle);

    // Launcher unread pulse (saffron) on first paint
    var pulse = el('span', 'sk-pulse');
    css(pulse, { position: 'absolute', top: '-2px', right: '-2px', width: '10px', height: '10px', borderRadius: '50%', background: accent, border: '2px solid #fff' });
    if (config.launcherShape !== 'pill') launcher.style.position = 'relative';
    launcher.appendChild(pulse);
  }

  function injectStyles(accent, dir){
    var style = el('style');
    style.textContent = ''
      + '.sk-root{font-family:Vazirmatn,system-ui,sans-serif;}'
      + '.sk-launcher.sk-tab{width:60px;height:52px;border-radius:14px;border-bottom-start-radius:4px;}'
      + '.sk-launcher.sk-rounded{width:52px;height:52px;border-radius:16px;}'
      + '.sk-launcher.sk-pill{width:64px;height:48px;border-radius:999px;}'
      + '.sk-pulse{animation:skpulse 2s ease-in-out infinite;}'
      + '@keyframes skpulse{0%,100%{box-shadow:0 0 0 0 ' + hexA(accent, .5) + ';}50%{box-shadow:0 0 0 6px ' + hexA(accent, 0) + ';}}';
    document.head.appendChild(style);
  }

  function escapeHtml(s){ return String(s).replace(/[&<>"]/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); }
  function hexA(hex, a){
    var h = hex.replace('#','');
    if (h.length === 3) h = h.split('').map(function(c){return c+c;}).join('');
    var r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  function fetchConfig(){
    var xhr = new XMLHttpRequest();
    xhr.open('GET', CONFIG_URL, true);
    xhr.onreadystatechange = function(){
      if (xhr.readyState !== 4) return;
      if (xhr.status === 200) {
        try { mount(JSON.parse(xhr.responseText)); } catch(e){}
      }
    };
    xhr.send();
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

  const origin = new URL(_req.url).origin
  const script = buildScript(origin, slug)

  return new Response(script, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
  })
}
