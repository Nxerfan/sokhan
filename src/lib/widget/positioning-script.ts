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
  // Compute the same baseLeft as __skComputePosition.
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
  // Inverse: offsetX = absoluteLeft - baseLeft (same for all anchors).
  return absoluteLeft - baseLeft;
}

function __skGetSafeAreaBottom() {
  // Measure the actual safe-area-inset-bottom by creating a hidden
  // element with padding-bottom: env(safe-area-inset-bottom) and
  // reading its computed padding. This works on iOS Safari + Chrome
  // mobile (which support env() in computed styles). Returns 0 on
  // browsers without safe-area support or desktop.
  try {
    var div = document.createElement('div');
    div.style.cssText = 'position:fixed;bottom:0;left:0;width:0;height:0;padding-bottom:env(safe-area-inset-bottom);visibility:hidden;pointer-events:none;';
    document.body.appendChild(div);
    var val = getComputedStyle(div).paddingBottom;
    document.body.removeChild(div);
    var px = parseInt(val, 10);
    return isNaN(px) ? 0 : px;
  } catch (e) {
    return 0;
  }
}

function __skComputePanelVertical(rootBottom, launcherHeight, viewportHeight, panelGap, panelPreferredHeight, safeAreaBottom) {
  var spaceAbove = Math.max(0, viewportHeight - rootBottom - launcherHeight - safeAreaBottom);
  var spaceBelow = Math.max(0, rootBottom - safeAreaBottom);
  var viewportClampedHeight = Math.max(120, Math.min(panelPreferredHeight, viewportHeight - safeAreaBottom * 2 - panelGap * 2));

  if (spaceAbove >= viewportClampedHeight + panelGap) {
    return { bottom: launcherHeight + panelGap, maxHeight: viewportClampedHeight, opensBelow: false };
  }
  if (spaceBelow >= viewportClampedHeight + panelGap) {
    return { bottom: -(viewportClampedHeight + panelGap), maxHeight: viewportClampedHeight, opensBelow: true };
  }
  if (spaceAbove >= spaceBelow) {
    var ch = Math.max(120, spaceAbove - panelGap);
    return { bottom: launcherHeight + panelGap, maxHeight: ch, opensBelow: false };
  } else {
    var ch2 = Math.max(120, spaceBelow - panelGap);
    return { bottom: -(ch2 + panelGap), maxHeight: ch2, opensBelow: true };
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
