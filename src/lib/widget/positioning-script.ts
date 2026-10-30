/**
 * Widget V2 Positioning — JS function source for script-tag injection.
 *
 * The slug-script (`/api/widget/[slug]/script`) and v1-script
 * (`/api/widget/v1/sukhan.js`) routes bake JS into template strings.
 * They cannot import TS modules at runtime, so the geometry function
 * is inlined as a string constant.
 *
 * This string MUST be kept in sync with:
 *   - `src/lib/widget/positioning-geometry.ts` (server TS copy)
 *   - `packages/widget-npm/src/positioning.ts` (NPM TS copy)
 *
 * Parity tests verify all three produce identical output.
 *
 * The string defines a self-contained `__skPositioning(opts)` function
 * that takes a plain object + returns `{ left, bottom, panelSide }`.
 */

/**
 * The geometry function source as a JS string (no imports, no TS syntax).
 * Injected into the script routes via template-literal interpolation.
 */
export const POSITIONING_FN_SOURCE = `
function __skComputePosition(opts) {
  var anchor = opts.anchor;
  var offsetX = opts.offsetX || 0;
  var offsetY = opts.offsetY || 0;
  var dir = opts.dir || 'ltr';
  var vw = opts.viewportWidth || window.innerWidth;
  var vh = opts.viewportHeight || window.innerHeight;
  var lw = opts.launcherWidth || 52;
  var lh = opts.launcherHeight || 52;
  var sab = opts.safeAreaBottom || 0;
  var bm = opts.baseMargin != null ? opts.baseMargin : 20;

  var baseLeft;
  if (anchor === 'bottom-center') {
    baseLeft = (vw - lw) / 2;
  } else {
    var isStart = anchor === 'bottom-start';
    var startIsLeft = dir === 'ltr' ? isStart : !isStart;
    if (startIsLeft) {
      baseLeft = bm;
    } else {
      baseLeft = vw - lw - bm;
    }
  }

  var left = baseLeft + offsetX;
  var bottom = bm + offsetY + sab;

  var maxLeft = Math.max(0, vw - lw);
  if (left < 0) left = 0;
  if (left > maxLeft) left = maxLeft;

  var minBottom = sab;
  var maxBottom = Math.max(minBottom, vh - lh - sab);
  if (bottom < minBottom) bottom = minBottom;
  if (bottom > maxBottom) bottom = maxBottom;

  var panelSide;
  if (anchor === 'bottom-center') {
    panelSide = 'center';
  } else {
    var launcherCenter = left + lw / 2;
    panelSide = launcherCenter < vw / 2 ? 'right' : 'left';
  }

  return { left: left, bottom: bottom, panelSide: panelSide };
}

function __skOffsetXFromLeft(anchor, absoluteLeft, dir, vw, lw, bm) {
  if (anchor === 'bottom-center') {
    var baseLeft = (vw - lw) / 2;
    return absoluteLeft - baseLeft;
  }
  var isStart = anchor === 'bottom-start';
  var startIsLeft = dir === 'ltr' ? isStart : !isStart;
  if (startIsLeft) {
    return absoluteLeft - bm;
  } else {
    return (vw - lw - bm) - absoluteLeft;
  }
}

function __skGetSafeAreaBottom() {
  try {
    var style = getComputedStyle(document.documentElement);
    var sab = style.getPropertyValue('env') || '';
    // env(safe-area-inset-bottom) is not directly readable via
    // getComputedStyle in all browsers. Use a CSS variable fallback
    // approach: we inject a custom property --sk-sab via a media query.
    // For now, use a conservative 0 — the widget still works; the
    // launcher just sits at the base margin. Real safe-area handling
    // is done via CSS env() in the injected styles.
    return 0;
  } catch (e) {
    return 0;
  }
}

function __skDetectDevice() {
  try {
    if (window.matchMedia && window.matchMedia('(max-width: 768px)').matches) {
      return 'mobile';
    }
  } catch (e) {}
  return window.innerWidth <= 768 ? 'mobile' : 'desktop';
}
`
