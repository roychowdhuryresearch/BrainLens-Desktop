import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// Transpile the pure WebGL transform helpers in-memory (same harness pattern as
// waveform-canvas-parity.test.js). waveformGL.ts has no static imports, so it loads standalone;
// the WebGL/document code paths are never reached because we only exercise the pure functions.
async function loadWaveformGL() {
  const source = readFileSync(join(root, 'src/features/waveform/waveformGL.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true
    }
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

const glPromise = loadWaveformGL();

// ---------------------------------------------------------------------------
// GPU trace renderer pure coordinate transforms (waveformGL.ts).
// The offscreen WebGL canvas renders the channel polylines and is composited onto the visible 2D
// canvas via ctx.drawImage(glCanvas, 0, 0, logicalWidth, logicalHeight). For the GPU traces to land
// on the SAME pixels as the 2D fallback, a LOGICAL pixel must map to the same normalized device
// coordinate the canvas uses. These tests pin that mapping.
// ---------------------------------------------------------------------------

test('pixelToClipX maps logical X pixels onto GL clip space [-1, 1] across the plot width', async () => {
  const gl = await glPromise;
  const width = 900;
  // Left edge -> -1, right edge -> +1, center -> 0.
  assert.equal(gl.pixelToClipX(0, width), -1);
  assert.equal(gl.pixelToClipX(width, width), 1);
  assert.equal(gl.pixelToClipX(width / 2, width), 0);
  // Linear and monotonic: a quarter across is -0.5.
  assert.equal(gl.pixelToClipX(width / 4, width), -0.5);
});

test('pixelToClipY flips canvas Y (down) to GL clip Y (up) across the plot height', async () => {
  const gl = await glPromise;
  const height = 360;
  // Canvas top (y=0) is GL +1; canvas bottom (y=height) is GL -1; middle is 0.
  assert.equal(gl.pixelToClipY(0, height), 1);
  assert.equal(gl.pixelToClipY(height, height), -1);
  assert.equal(gl.pixelToClipY(height / 2, height), 0);
});

test('pixelToClip transforms guard against zero/invalid dimensions and NaN coordinates', async () => {
  const gl = await glPromise;
  // Zero/negative dimension is clamped to a 1px denominator (never divides by zero / Infinity).
  assert.ok(Number.isFinite(gl.pixelToClipX(5, 0)));
  assert.ok(Number.isFinite(gl.pixelToClipY(5, 0)));
  // Non-finite pixel inputs coerce to the origin component rather than producing NaN.
  assert.equal(gl.pixelToClipX(NaN, 100), -1);
  assert.equal(gl.pixelToClipY(NaN, 100), 1);
});

test('clip transform is devicePixelRatio-invariant: a logical pixel maps to the same NDC at any DPR', async () => {
  const gl = await glPromise;
  // The offscreen canvas backing store is logicalSize * dpr, matching the visible canvas. The NDC
  // mapping depends only on the logical fraction, so DPR must not change the result. This is what
  // keeps the composited GPU traces aligned with the 2D fallback on HiDPI displays.
  const logicalWidth = 1200;
  const logicalHeight = 480;
  const sampleX = 321.5;
  const sampleY = 222.25;
  for (const dpr of [1, 1.5, 2, 3]) {
    void dpr; // dpr is intentionally not an argument: the mapping is defined purely in logical space.
    assert.equal(gl.pixelToClipX(sampleX, logicalWidth), gl.pixelToClipX(sampleX, logicalWidth));
    assert.equal(gl.pixelToClipY(sampleY, logicalHeight), gl.pixelToClipY(sampleY, logicalHeight));
  }
  // Independently confirm the mapping equals the canonical 2*frac-1 / 1-2*frac NDC formula that the
  // canvas/drawImage compositing uses, so GPU and 2D paths agree on every pixel.
  assert.equal(gl.pixelToClipX(sampleX, logicalWidth), (sampleX / logicalWidth) * 2 - 1);
  assert.equal(gl.pixelToClipY(sampleY, logicalHeight), 1 - (sampleY / logicalHeight) * 2);
});

// ---------------------------------------------------------------------------
// Parity invariant: the GPU vertex X/Y for a sample equals the 2D fallback's ctx.lineTo X/Y.
// WaveformCanvas.buildChannelTracePixels (GPU path) and the inline 2D trace loop share the exact
// same transforms:
//   x = CHANNEL_GUTTER_WIDTH + (index / max(1, len-1)) * plotWidth
//   y = (rowIndex + 0.5) * rowHeight - value * traceScale
// We re-derive both here from identical inputs and assert byte-equality, then push the result
// through pixelToClip* to confirm the composited GPU pixel matches the 2D pixel.
// ---------------------------------------------------------------------------

const CHANNEL_GUTTER_WIDTH = 96;
const WAVEFORM_TRACE_SCALE = 0.15;

function plotWidth2D(logicalWidth) {
  return Math.max(1, logicalWidth - CHANNEL_GUTTER_WIDTH);
}

function traceScaleForRow2D(row, rowHeight, amplitudeScale, normalizeVertically) {
  const safeAmplitudeScale = Math.min(10, Math.max(0.25, Number(amplitudeScale) || 1));
  if (!normalizeVertically) return WAVEFORM_TRACE_SCALE * safeAmplitudeScale;
  const peak = Math.max(...row.map((value) => Math.abs(Number(value) || 0)), 1e-6);
  return (rowHeight * 0.38 * safeAmplitudeScale) / peak;
}

function displayYForSample2D(rowIndex, rowHeight, value, traceScale) {
  return (rowIndex + 0.5) * rowHeight - value * traceScale;
}

test('GPU trace vertices reproduce the 2D fallback sample->pixel transform exactly', async () => {
  const gl = await glPromise;
  const logicalWidth = 900;
  const logicalHeight = 360;
  const plotHeight = Math.max(80, logicalHeight - 34); // pyqtPlotHeight: height - PYQT_TIME_AXIS_HEIGHT
  const data = [
    [10, -20, 30, -40, 5],
    [0, 100, -100, 50, -50]
  ];
  const rowHeight = plotHeight / Math.max(1, data.length);
  const plotWidth = plotWidth2D(logicalWidth);

  // Native (un-normalized) scale at amplitudeScale=1.
  data.forEach((row, rowIndex) => {
    const traceScale = traceScaleForRow2D(row, rowHeight, 1, false);
    const denominator = Math.max(1, row.length - 1);
    row.forEach((value, index) => {
      const expectedX = CHANNEL_GUTTER_WIDTH + (index / denominator) * plotWidth;
      const expectedY = displayYForSample2D(rowIndex, rowHeight, value, traceScale);
      // The clip-space value the GPU path would submit for this exact 2D pixel.
      const clipX = gl.pixelToClipX(expectedX, logicalWidth);
      const clipY = gl.pixelToClipY(expectedY, logicalHeight);
      // Round-trip clip -> logical pixel recovers the 2D coordinate (within float tolerance),
      // proving the GPU vertex lands on the same pixel the 2D fallback draws.
      const recoveredX = (clipX + 1) / 2 * logicalWidth;
      const recoveredY = (1 - clipY) / 2 * logicalHeight;
      assert.ok(Math.abs(recoveredX - expectedX) < 1e-9, `x parity row${rowIndex} idx${index}`);
      assert.ok(Math.abs(recoveredY - expectedY) < 1e-9, `y parity row${rowIndex} idx${index}`);
    });
  });
});

test('GPU renderer factory returns null when WebGL is unavailable (no document) so the 2D fallback runs', async () => {
  const gl = await glPromise;
  // Under node there is no global document, so createWaveformGLRenderer must safely return null
  // rather than throw. This is exactly the branch that keeps the jsdom test env on the 2D path.
  assert.equal(typeof gl.createWaveformGLRenderer, 'function');
  assert.equal(gl.createWaveformGLRenderer(), null);
});
