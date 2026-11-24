#!/usr/bin/env node
// Exhaustive geometric linter for the iEEG renderer.
//
// Where ui-geometry-audit.mjs gates hard failures (overlap/overflow/clip/size),
// this audit measures the *quality* axis the gate can't see and enumerates EVERY
// offender (no per-surface cap). It checks, against the live rendered DOM:
//   - row alignment      : controls sharing a row should be vertically centered
//   - column alignment   : stacked controls in a column should share a left edge
//   - size consistency   : peer controls in a group should match width/height
//   - whitespace voids   : space-between dead gaps, oversized controls, empty cards
//   - compression        : cramped gaps, tight padding, truncated text
//
// Output: artifacts/ui-alignment-audit.json (exhaustive) + a console digest.
// Run with a normal node (NOT Codex.app's embedded node, which rejects the
// rolldown native binding): `PATH="/opt/homebrew/bin:$PATH" npm run qa:alignment`
// or point at an already-running server: `UI_GEOMETRY_URL=http://127.0.0.1:5191/`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { chromium } from 'playwright';
import {
  desktopRoot,
  STATES,
  getFreePort,
  parseViewports,
  startVite,
  waitForServer,
  withVisualFixture,
  setState,
} from './lib/ui-audit-harness.mjs';

const artifactsRoot = join(desktopRoot, 'artifacts');
const jsonOutputPath = join(artifactsRoot, 'ui-alignment-audit.json');

// Tolerances (px). Kept as named constants so the product bar is explicit and tunable.
const TOL = {
  rowCenter: 3, // controls in a row should share a vertical center within this
  rowHeight: 2, // peer controls in a row should match height within this
  colLeftMin: 1, // near-miss left-edge window: aligned-looking but off by [min,max]
  colLeftMax: 8,
  groupWidth: 10, // peer buttons/fields in a group should match width within this
  groupHeight: 2,
  voidGap: 64, // a space-between dead gap wider than this with a short side = void
  oversizeAbs: 80, // control box wider than its content by this many px ...
  oversizeRatio: 1.8, // ... AND at least this ratio = oversized
  crampedGap: 3, // 0 < adjacent horizontal gap < this = genuinely crowded (4px is the app's intentional segmented-group gap, not a defect)
  lowDensity: 0.22, // card taller than 80px with child-ink fill below this = bloated
};

function makeEvaluator(tol) {
  return (TOL) => {
    const CONTROL_SELECTOR = 'button,input,select,textarea,[role="button"],[role="switch"],[role="checkbox"],[role="radio"]';
    const SURFACE_SELECTOR = [
      '[data-testid="pyqt-qd_action_rail"]', '[data-testid="pyqt-quick_detection_status_rail"]',
      '[data-testid="pyqt-qd_edfInfo"]', '[data-testid="pyqt-qd_filters"]',
      '[data-testid="pyqt-quick-detector-card"]', '.quick-classifier-card',
      '.quick-detection-export-panel', '.quick-detection-action-strip',
      '[data-testid="pyqt-batch_project_setup_card"]', '[data-testid="pyqt-batch_project_run_card"]',
      '[data-testid="pyqt-batch_project_summary_card"]', '[data-testid="pyqt-batch_project_cases_card"]',
      '[data-testid="pyqt-predictionScopeCard"]', '[data-testid="pyqt-frequency_range_group"]',
      '[data-testid="pyqt-annotation_detail_actions"]', '.annotation-side-stack', '.event-detail-card',
      '[data-testid="pyqt-waveform_shortcuts_scroll_area"]', '.shortcut-actions',
      '[data-testid="pyqt-quick_detection_window"]', '[data-testid="pyqt-annotation_window"]',
      '[data-testid="pyqt-recording_info_dialog"]', '[data-testid="pyqt-status_log_dialog"]',
      '[data-testid="pyqt-load_detection_window"]', '[data-testid="pyqt-waveform_shortcuts_window"]',
      '[data-testid="pyqt-channel_selection_window"]', '[data-testid="pyqt-bipolar_channel_selection_window"]',
      '[data-testid="pyqt-batch_project_window"]', '[data-testid="pyqt-run_stats_dialog"]',
      '[data-testid="agent-panel"]', '.recording-info-panel', '.filter-parameter-panel',
      '.recording-planning-panel', '.statistics-box', '.runtime-log-panel',
      '.detector-mode-header', '.detector-form-card', '.detector-applied-display',
      '.classifier-header-card', '.classifier-controls-card', '.classifier-source-card',
      '.classifier-stack-card', '.prepare-decision-details', '.case-console', '.workflow-progress-strip',
      '.waveform-toolbar', '.waveform-right-sidebar', '.workspace-tabs', '.pyqt-top-toolbar',
      '.waveform-header', '[data-testid="pyqt-main-window"]',
    ].join(',');
    const CARD_SELECTOR = '.panel-card,.case-console,.table-shell,.run-actions-card,.empty-state-card,.pyqt-sidebar-card,.recording-info-grid,.classifier-controls-card';
    const GROUP_SELECTOR = '.button-row,.sidebar-button-row,.modal-actions,.quick-classifier-actions,.quick-detection-action-strip,.detector-field-grid,.field-grid,.classifier-stack-grid,.classifier-control-grid,.annotation-navigation-row,.annotation-detail-actions,.quick-filter-grid,.quick-classifier-param-grid,.quick-classifier-model-grid,.quick-detection-metadata-grid,.recording-info-grid,.sidebar-filter-row,.sidebar-detection-params,.frequency-controls,.classifier-source-list,.detector-display-grid,.quick-detection-action-rail';

    const round = (v) => Math.round(v * 100) / 100;
    const rectOf = (el) => {
      const r = el.getBoundingClientRect();
      return { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height), right: round(r.right), bottom: round(r.bottom), cx: round(r.x + r.width / 2), cy: round(r.y + r.height / 2) };
    };
    const rectIntersection = (a, b) => {
      const x = Math.max(a.x, b.x);
      const y = Math.max(a.y, b.y);
      const right = Math.min(a.right, b.right);
      const bottom = Math.min(a.bottom, b.bottom);
      return { x, y, right, bottom, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
    };
    const clipRectFor = (element, rect) => {
      let clip = { x: 0, y: 0, right: window.innerWidth, bottom: window.innerHeight };
      let parent = element.parentElement;
      while (parent) {
        const style = getComputedStyle(parent);
        const overflow = `${style.overflow} ${style.overflowX} ${style.overflowY}`;
        if (/(auto|scroll|hidden|clip)/.test(overflow)) {
          const parentRect = parent.getBoundingClientRect();
          clip = rectIntersection(clip, { x: parentRect.x, y: parentRect.y, right: parentRect.right, bottom: parentRect.bottom });
        }
        parent = parent.parentElement;
      }
      return rectIntersection({ x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom }, clip);
    };
    const visibleClipRect = (element) => clipRectFor(element, element.getBoundingClientRect());
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (r.width <= 0 || r.height <= 0 || s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity || 1) <= 0.01 || el.getAttribute('aria-hidden') === 'true') return false;
      if (r.bottom <= 0 || r.y >= window.innerHeight || r.right <= 0 || r.x >= window.innerWidth) return false;
      const visibleRect = visibleClipRect(el);
      if (visibleRect.width <= 0 || visibleRect.height <= 0) return false;
      const visibleArea = visibleRect.width * visibleRect.height;
      const area = r.width * r.height;
      if (visibleArea < Math.min(16, area * 0.2)) return false;
      return true;
    };
    const px = (v) => { const n = Number.parseFloat(v); return Number.isFinite(n) ? round(n) : 0; };
    const textOf = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.placeholder || '').replace(/\s+/g, ' ').trim();
    const kindOf = (el) => {
      const t = el.tagName.toLowerCase();
      if (t === 'button' || el.getAttribute('role') === 'button') return 'button';
      if (t === 'select') return 'select';
      if (t === 'textarea') return 'textarea';
      if (t === 'input') return `input:${el.getAttribute('type') || 'text'}`;
      return el.getAttribute('role') || t;
    };
    const selectorPath = (el) => {
      const parts = []; let cur = el;
      while (cur && cur.nodeType === 1 && parts.length < 5) {
        const tid = cur.getAttribute('data-testid');
        if (tid) { parts.unshift(`[data-testid="${tid}"]`); break; }
        const cls = String(cur.className || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
        parts.unshift(`${cur.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`);
        cur = cur.parentElement;
      }
      return parts.join(' > ');
    };
    const nearestSurface = (el) => { const s = el.closest(SURFACE_SELECTOR); return s ? (s.getAttribute('data-testid') || String(s.className).split(/\s+/)[0] || s.tagName.toLowerCase()) : 'document'; };
    const isBinaryInputKind = (kind) => kind === 'input:checkbox' || kind === 'input:radio' || kind === 'checkbox' || kind === 'radio' || kind === 'switch';
    const isFieldKind = (kind) => (kind === 'select' || kind === 'textarea' || kind.startsWith('input:')) && !isBinaryInputKind(kind) && kind !== 'input:range';
    const isIntentionalTitleBar = (el) => el.tagName.toLowerCase() === 'header' && (
      el.classList.contains('agent-panel-header') ||
      !!el.querySelector('.modal-window-close-button,button[data-testid*="close_button"],button[aria-label*="Close"]')
    );
    const isVisualCard = (el) => el.classList.contains('annotation-plot-card') || !!el.querySelector('svg,canvas,.review-svg');

    // shared canvas for measuring rendered text width of input/select values
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const measureText = (text, font) => { ctx.font = font; return text ? round(ctx.measureText(text).width) : 0; };
    const contentWidthOf = (el, kind, style) => {
      if (kind === 'button') {
        try { const range = document.createRange(); range.selectNodeContents(el); const r = range.getBoundingClientRect(); range.detach?.(); if (r.width > 0) return round(r.width) + px(style.paddingLeft) + px(style.paddingRight); } catch { /* noop */ }
        return measureText(textOf(el), style.font) + px(style.paddingLeft) + px(style.paddingRight);
      }
      const val = el.value || el.placeholder || '';
      return measureText(val, style.font) + px(style.paddingLeft) + px(style.paddingRight);
    };

    // When a modal/dialog is open, scope the audit to it — the dimmed background is not
    // something the user sees or acts on, so counting its defects per-modal-state would
    // double-count the same background controls across every dialog.
    const DIALOG_SELECTOR = '[data-testid="pyqt-quick_detection_window"],[data-testid="pyqt-annotation_window"],[data-testid="pyqt-recording_info_dialog"],[data-testid="pyqt-status_log_dialog"],[data-testid="pyqt-load_detection_window"],[data-testid="pyqt-waveform_shortcuts_window"],[data-testid="pyqt-channel_selection_window"],[data-testid="pyqt-bipolar_channel_selection_window"],[data-testid="pyqt-batch_project_window"],[data-testid="pyqt-run_stats_dialog"]';
    const root = document.querySelector(DIALOG_SELECTOR) || document;

    const items = Array.from(root.querySelectorAll(CONTROL_SELECTOR)).filter((el) => visible(el) && el.getAttribute('type') !== 'hidden').map((el) => {
      const style = getComputedStyle(el);
      const kind = kindOf(el);
      return {
        el, kind, rect: rectOf(el), surface: nearestSurface(el),
        testid: el.getAttribute('data-testid') || '', text: textOf(el).slice(0, 60), selector: selectorPath(el),
        readOnly: !!el.readOnly, disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
        clientW: el.clientWidth, scrollW: el.scrollWidth,
        contentW: contentWidthOf(el, kind, style),
      };
    });

    const findings = [];
    const add = (rule, severity, item, message, detail = {}) => findings.push({ rule, severity, surface: item?.surface || detail.surface || '', testid: item?.testid || '', text: item?.text || '', selector: item?.selector || detail.selector || '', rect: item?.rect || null, ...detail, message });

    // group by surface for row/column analysis
    const bySurface = new Map();
    for (const it of items) { const a = bySurface.get(it.surface) || []; a.push(it); bySurface.set(it.surface, a); }

    // ---- 1. ROW alignment (horizontal): controls in a row share a vertical center ----
    for (const [surface, list] of bySurface) {
      // Only short, control-height elements participate in row analysis. Tall elements
      // (vertical scrollbars, channel lists, canvases) aren't "row" members; including
      // them produces bogus rows. A real row-alignment defect is a few px, never >40px,
      // so spreads beyond that are a clustering artifact, not a finding.
      const sorted = [...list].filter((it) => it.rect.height <= 60).sort((a, b) => a.rect.cy - b.rect.cy);
      let row = [];
      const flushRow = () => {
        if (row.length >= 2) {
          const cys = row.map((r) => r.rect.cy); const spread = round(Math.max(...cys) - Math.min(...cys));
          if (spread > TOL.rowCenter && spread <= 40) add('row-misaligned', 'error', row[0], `Row of ${row.length} controls is not vertically centered (center-Y spread ${spread}px > ${TOL.rowCenter}px)`, { surface, spread, members: row.map((r) => ({ testid: r.testid, text: r.text, cy: r.rect.cy })).slice(0, 8) });
          const heightPeers = row.filter((r) => !isBinaryInputKind(r.kind));
          if (heightPeers.length >= 2) {
            const hs = heightPeers.map((r) => r.rect.height); const hspread = round(Math.max(...hs) - Math.min(...hs));
            if (hspread > TOL.rowHeight && hspread <= 40) add('row-height-mismatch', 'warning', heightPeers[0], `Row of ${heightPeers.length} non-checkbox controls has uneven heights (spread ${hspread}px > ${TOL.rowHeight}px)`, { surface, spread: hspread, members: heightPeers.map((r) => ({ testid: r.testid, h: r.rect.height })).slice(0, 8) });
          }
          // cramped horizontal gaps within the row
          const byX = [...row].sort((a, b) => a.rect.x - b.rect.x);
          for (let i = 1; i < byX.length; i += 1) { const gap = round(byX[i].rect.x - byX[i - 1].rect.right); if (gap > 0 && gap < TOL.crampedGap) add('cramped-gap', 'warning', byX[i - 1], `Only ${gap}px gap to the next control (< ${TOL.crampedGap}px)`, { surface, gap, other: byX[i].testid || byX[i].text }); }
        }
        row = [];
      };
      for (const it of sorted) {
        if (!row.length) { row = [it]; continue; }
        const top = Math.min(...row.map((r) => r.rect.y)); const bot = Math.max(...row.map((r) => r.rect.bottom));
        const overlap = Math.min(bot, it.rect.bottom) - Math.max(top, it.rect.y);
        if (overlap > Math.min(it.rect.height, bot - top) * 0.5) row.push(it); else flushRow(), row.push(it);
      }
      flushRow();
    }

    // ---- 2. COLUMN alignment (vertical): stacked controls should share a left edge ----
    for (const [surface, list] of bySurface) {
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          const a = list[i]; const b = list[j];
          if (a.kind === 'button' || b.kind === 'button') continue; // toolbars flow horizontally; only stacked form fields share a column
          if (isBinaryInputKind(a.kind) || isBinaryInputKind(b.kind)) continue; // checkbox/radio glyphs have intrinsic offsets; they are not text-field columns
          const vDisjoint = a.rect.bottom <= b.rect.y + 1 || b.rect.bottom <= a.rect.y + 1; // stacked
          if (!vDisjoint) continue;
          const xOverlap = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.x, b.rect.x);
          if (xOverlap < Math.min(a.rect.width, b.rect.width) * 0.3) continue; // same column band only
          const dLeft = round(Math.abs(a.rect.x - b.rect.x));
          if (dLeft >= TOL.colLeftMin && dLeft <= TOL.colLeftMax) add('col-misaligned', 'error', a, `Left edge off by ${dLeft}px from a stacked control in the same column (should be flush)`, { surface, dLeft, other: b.testid || b.text, otherLeft: b.rect.x, thisLeft: a.rect.x });
        }
      }
    }

    // ---- 3. SIZE consistency within explicit layout groups ----
    for (const group of Array.from(root.querySelectorAll(GROUP_SELECTOR)).filter(visible)) {
      const gsurface = nearestSurface(group);
      const gsel = selectorPath(group);
      const kids = Array.from(group.querySelectorAll(CONTROL_SELECTOR)).filter(visible);
      const byKind = new Map();
      for (const k of kids) { const kind = kindOf(k); const a = byKind.get(kind) || []; a.push(k); byKind.set(kind, a); }
      for (const [kind, ks] of byKind) {
        if (ks.length < 2) continue;
        const rects = ks.map(rectOf);
        const ws = rects.map((r) => r.width); const wspread = round(Math.max(...ws) - Math.min(...ws));
        const hs = rects.map((r) => r.height); const hspread = round(Math.max(...hs) - Math.min(...hs));
        if (kind === 'button' && wspread > TOL.groupWidth) add('group-width-mismatch', 'warning', null, `${ks.length} peer ${kind}s in a group differ in width by ${wspread}px (${Math.min(...ws)}–${Math.max(...ws)}px)`, { surface: gsurface, selector: gsel, spread: wspread, widths: ws.map(round) });
        if (hspread > TOL.groupHeight) add('group-height-mismatch', 'warning', null, `${ks.length} peer ${kind}s in a group differ in height by ${hspread}px`, { surface: gsurface, selector: gsel, spread: hspread, heights: hs.map(round) });
      }

      const fieldKids = kids.filter((k) => isFieldKind(kindOf(k)));
      const columns = [];
      for (const field of fieldKids) {
        const r = rectOf(field);
        let col = columns.find((candidate) => Math.abs(candidate.x - r.x) <= TOL.colLeftMax);
        if (!col) { col = { x: r.x, fields: [] }; columns.push(col); }
        col.fields.push({ el: field, kind: kindOf(field), rect: r, testid: field.getAttribute('data-testid') || '', text: textOf(field).slice(0, 60) });
      }
      for (const col of columns) {
        const stacked = col.fields.filter((field, index, arr) => arr.some((other, otherIndex) => otherIndex !== index && (field.rect.bottom <= other.rect.y + 1 || other.rect.bottom <= field.rect.y + 1)));
        if (stacked.length < 2) continue;
        const ws = stacked.map((field) => field.rect.width); const wspread = round(Math.max(...ws) - Math.min(...ws));
        if (wspread > TOL.groupWidth) add('field-column-width-mismatch', 'warning', null, `${stacked.length} fields in the same visual column differ in width by ${wspread}px (${Math.min(...ws)}–${Math.max(...ws)}px)`, { surface: gsurface, selector: gsel, spread: wspread, widths: ws.map(round), members: stacked.map((field) => ({ testid: field.testid, kind: field.kind, w: field.rect.width, x: field.rect.x })).slice(0, 8) });
      }
    }

    // ---- 4a. WHITESPACE: space-between dead gaps ----
    for (const el of Array.from(root.querySelectorAll('*')).filter(visible)) {
      const s = getComputedStyle(el);
      if (s.display.indexOf('flex') === -1) continue;
      if (s.justifyContent !== 'space-between' && s.justifyContent !== 'space-around') continue;
      if (isIntentionalTitleBar(el)) continue;
      const kids = Array.from(el.children).filter(visible);
      if (kids.length < 2 || s.flexDirection.indexOf('column') === 0) continue;
      const kr = kids.map((k) => ({ k, r: k.getBoundingClientRect() })).sort((a, b) => a.r.x - b.r.x);
      let maxGap = 0; let flank = null;
      for (let i = 1; i < kr.length; i += 1) { const gap = kr[i].r.x - kr[i - 1].r.right; if (gap > maxGap) { maxGap = gap; flank = [kr[i - 1].k, kr[i].k]; } }
      if (maxGap > TOL.voidGap) {
        const shortSide = flank && (textOf(flank[0]).length <= 24 || textOf(flank[1]).length <= 24);
        if (shortSide) add('space-between-void', 'warning', null, `space-between leaves a ${Math.round(maxGap)}px dead gap (> ${TOL.voidGap}px) between a short label and the opposite cluster`, { surface: nearestSurface(el), selector: selectorPath(el), gap: Math.round(maxGap), between: flank.map((f) => textOf(f).slice(0, 24)) });
      }
    }

    // ---- 4b. WHITESPACE: oversized controls (box much wider than content) ----
    // Buttons: box-vs-label is always meaningful. Inputs: only when read-only/disabled
    // (the shown value IS the content); an editable field is meant to be wider than its
    // current value, so flagging those would be noise. Selects vary by option, so skip.
    for (const it of items) {
      const isButton = it.kind === 'button';
      const isDeadField = it.kind.startsWith('input:') && !/checkbox|radio|range/.test(it.kind) && (it.readOnly || it.disabled);
      if (!isButton && !isDeadField) continue;
      const slack = round(it.rect.width - it.contentW);
      if (it.contentW > 6 && slack > TOL.oversizeAbs && it.rect.width > it.contentW * TOL.oversizeRatio) add(isButton ? 'oversized-button' : 'oversized-field', 'warning', it, `Box is ${it.rect.width}px wide but content needs ~${it.contentW}px (${slack}px slack, ${round(it.rect.width / it.contentW)}×) — oversized`, { surface: it.surface, boxW: it.rect.width, contentW: it.contentW, slack });
    }

    // ---- 4c. WHITESPACE: low-density cards (mostly empty) ----
    for (const card of Array.from(root.querySelectorAll(CARD_SELECTOR)).filter(visible)) {
      if (isVisualCard(card)) continue;
      const cr = card.getBoundingClientRect(); if (cr.height < 80 || cr.width < 80 || cr.height > window.innerHeight) continue; // skip scroll regions taller than the viewport (they aren't cards)
      if (cr.y < 0 || cr.bottom > window.innerHeight || cr.x < 0 || cr.right > window.innerWidth) continue; // partial scroll-viewport exposure cannot prove the full card is empty
      const kids = Array.from(card.querySelectorAll(CONTROL_SELECTOR + ',p,h1,h2,h3,h4,dt,dd,span,label,td,th,li')).filter(visible);
      let ink = 0; for (const k of kids) { const r = k.getBoundingClientRect(); ink += Math.max(0, Math.min(r.right, cr.right) - Math.max(r.x, cr.x)) * Math.max(0, Math.min(r.bottom, cr.bottom) - Math.max(r.y, cr.y)); }
      const structuralBlocks = Array.from(card.children).filter((k) => visible(k) && (textOf(k) || k.querySelector(CONTROL_SELECTOR + ',p,h1,h2,h3,h4,dt,dd,span,label,td,th,li')));
      let structuralInk = 0; for (const k of structuralBlocks) { const r = k.getBoundingClientRect(); structuralInk += Math.max(0, Math.min(r.right, cr.right) - Math.max(r.x, cr.x)) * Math.max(0, Math.min(r.bottom, cr.bottom) - Math.max(r.y, cr.y)); }
      const fill = round(Math.max(ink, structuralInk) / (cr.width * cr.height));
      if (fill < TOL.lowDensity) add('low-density-card', 'info', null, `Card is ${Math.round(cr.width)}×${Math.round(cr.height)}px but only ~${Math.round(fill * 100)}% filled with content`, { surface: nearestSurface(card), selector: selectorPath(card), fill });
    }

    // ---- 5. COMPRESSION: truncated text ---- (clientW>12 skips collapsed 0–1px elements)
    for (const it of items) {
      if (it.scrollW > it.clientW + 1 && it.clientW > 12) add('text-truncated', 'error', it, `Text is clipped/truncated (content ${it.scrollW}px > visible ${it.clientW}px)`, { surface: it.surface, scrollW: it.scrollW, clientW: it.clientW });
    }
    // truncated non-control text (labels/headings with ellipsis)
    for (const el of Array.from(root.querySelectorAll('h1,h2,h3,h4,dt,dd,span,p,strong,em,td,th,label')).filter(visible)) {
      if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 12 && getComputedStyle(el).textOverflow === 'ellipsis') add('text-truncated', 'error', null, `Text is truncated with ellipsis (content ${el.scrollWidth}px > visible ${el.clientWidth}px)`, { surface: nearestSurface(el), selector: selectorPath(el), text: textOf(el).slice(0, 60), scrollW: el.scrollWidth, clientW: el.clientWidth });
    }

    return { viewport: { width: window.innerWidth, height: window.innerHeight }, controls: items.length, findings };
  };
}

async function main() {
  mkdirSync(artifactsRoot, { recursive: true });
  const externalUrl = process.env.UI_GEOMETRY_URL || process.env.PYHFO_UI_GEOMETRY_URL || '';
  const port = Number(process.env.UI_GEOMETRY_PORT || (externalUrl ? 0 : await getFreePort()));
  const baseUrl = externalUrl || `http://127.0.0.1:${port}/`;
  const fixtureUrl = withVisualFixture(baseUrl);
  const viewports = parseViewports();
  let vite; let browser;
  try {
    if (!externalUrl) { vite = startVite(port); await waitForServer(fixtureUrl); }
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const runs = [];
    const evaluator = makeEvaluator();
    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const state of STATES) {
        try {
          await setState(page, fixtureUrl, state);
          const res = await page.evaluate(evaluator, TOL);
          runs.push({ viewport, state, controls: res.controls, findings: res.findings.map((f) => ({ ...f, viewport: viewport.name, state })) });
        } catch (error) {
          runs.push({ viewport, state, controls: 0, findings: [], error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    const all = runs.flatMap((r) => r.findings);
    const byRule = {}; const bySurface = {}; const bySeverity = { error: 0, warning: 0, info: 0 };
    for (const f of all) { byRule[f.rule] = (byRule[f.rule] || 0) + 1; bySurface[`${f.state}|${f.surface}`] = (bySurface[`${f.state}|${f.surface}`] || 0) + 1; bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1; }
    const report = {
      generated_at: new Date().toISOString(), fixture_url: fixtureUrl, viewports, states: STATES,
      tolerances: TOL,
      summary: { runs: runs.length, controls: runs.reduce((s, r) => s + r.controls, 0), findings: all.length, ...bySeverity, by_rule: byRule },
      findings: all, runs: runs.map((r) => ({ viewport: r.viewport, state: r.state, controls: r.controls, count: r.findings.length, error: r.error })),
    };
    writeFileSync(jsonOutputPath, `${JSON.stringify(report, null, 2)}\n`);

    // console digest — totals are exhaustive; per-rule shows examples, full set is in JSON
    console.log(`\nUI alignment audit: ${all.length} findings across ${runs.length} state/viewport runs (${bySeverity.error} error, ${bySeverity.warning} warning, ${bySeverity.info} info).`);
    console.log(`JSON (exhaustive): ${relative(desktopRoot, jsonOutputPath)}\n`);
    console.log('By rule:');
    for (const [rule, count] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(4)}  ${rule}`);
    console.log('\nTop offending surfaces (state|surface):');
    for (const [k, c] of Object.entries(bySurface).sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${String(c).padStart(4)}  ${k}`);
    console.log('\nExamples per rule (first 6; see JSON for all):');
    for (const rule of Object.keys(byRule)) {
      console.log(`\n  [${rule}]`);
      for (const f of all.filter((x) => x.rule === rule).slice(0, 6)) console.log(`    - ${f.viewport}/${f.state} ${f.surface}: ${f.message}${f.testid ? ` (${f.testid})` : ''}`);
    }
  } finally {
    if (browser) await browser.close();
    if (vite) vite.child.kill();
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.stack || error.message : String(error)); process.exit(1); });
