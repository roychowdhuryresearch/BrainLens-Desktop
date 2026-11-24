// GPU-accelerated channel-trace renderer for the iEEG waveform plot.
//
// This module owns ONLY the many-channel polyline rasterization (the N channels × M samples
// bottleneck). It renders into an OFFSCREEN canvas; WaveformCanvas.tsx composites the result onto
// the visible 2D canvas via ctx.drawImage(...) and then paints every existing 2D overlay on top.
//
// Parity contract: the vertex positions produced here MUST land on the same logical pixels as the
// 2D fallback in WaveformCanvas.tsx. The 2D path computes, for sample `index` of channel row
// `rowIndex`:
//   x = CHANNEL_GUTTER_WIDTH + (index / max(1, row.length - 1)) * plotWidth          (logical px)
//   y = (rowIndex + 0.5) * rowHeight - value * traceScale                            (logical px)
// We reuse those exact logical-pixel coordinates and convert them to GL clip space with
// `pixelToClipX` / `pixelToClipY` below. Because the offscreen canvas is sized to the SAME backing
// store as the visible canvas (logical size × devicePixelRatio), the devicePixelRatio factor
// cancels out of the clip-space mapping and the composited traces are pixel-identical to the 2D
// fallback regardless of DPR.

// Pure transform: logical X pixel -> GL clip-space X in [-1, 1].
// logicalWidth is the CSS-pixel width of the plot canvas (metrics.width). Independent of DPR
// because both the backing store and this mapping scale by the same factor.
export function pixelToClipX(xPixel: number, logicalWidth: number): number {
  const width = Math.max(1, Number(logicalWidth) || 1);
  return (Number(xPixel) || 0) / width * 2 - 1;
}

// Pure transform: logical Y pixel -> GL clip-space Y in [-1, 1]. GL clip space is +Y up while
// canvas pixels are +Y down, so we flip: pixel y=0 (top) -> clip +1, y=height (bottom) -> clip -1.
export function pixelToClipY(yPixel: number, logicalHeight: number): number {
  const height = Math.max(1, Number(logicalHeight) || 1);
  return 1 - (Number(yPixel) || 0) / height * 2;
}

const TRACE_VERTEX_SHADER = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const TRACE_FRAGMENT_SHADER = `
precision mediump float;
uniform vec4 u_color;
void main() {
  gl_FragColor = u_color;
}
`;

export type WaveformGLRenderer = {
  canvas: HTMLCanvasElement;
  // Resize the offscreen backing store to match the visible canvas backing store (logical × dpr).
  resize: (backingWidth: number, backingHeight: number) => void;
  // Draw every channel polyline. `rows` are arrays of [x0,y0,x1,y1,...] LOGICAL-pixel coordinates
  // (the same coordinates the 2D fallback would lineTo). color is {r,g,b,a} with channels in 0..1.
  drawTraces: (rows: Float32Array[], logicalWidth: number, logicalHeight: number, color: { r: number; g: number; b: number; a: number }) => void;
  dispose: () => void;
  // True once the GPU context has been lost — the caller should then fall back to the 2D
  // trace path instead of drawing into a dead context (which would silently blank traces).
  isLost?: () => boolean;
};

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(gl: WebGLRenderingContext): WebGLProgram | null {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, TRACE_VERTEX_SHADER);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, TRACE_FRAGMENT_SHADER);
  if (!vertexShader || !fragmentShader) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  // Shaders are linked into the program; flag them for deletion so the GL keeps them only while
  // the program lives.
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

// Acquire a WebGL context with antialiasing + transparent premultiplied alpha so the composited
// drawImage blends cleanly over the 2D background. Returns null in any environment where WebGL is
// unavailable (jsdom test runner, GPU-less machines), which drives the 2D fallback in the caller.
function acquireGLContext(canvas: HTMLCanvasElement): WebGLRenderingContext | null {
  const options: WebGLContextAttributes = { alpha: true, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: true };
  try {
    const gl = canvas.getContext('webgl', options) || canvas.getContext('experimental-webgl', options);
    return (gl as WebGLRenderingContext | null) || null;
  } catch {
    return null;
  }
}

// Create the offscreen GPU trace renderer. Returns null whenever WebGL cannot be initialized; the
// caller MUST then fall back to the existing 2D trace-drawing path. This never throws.
export function createWaveformGLRenderer(): WaveformGLRenderer | null {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  let canvas: HTMLCanvasElement;
  try {
    canvas = document.createElement('canvas');
  } catch {
    return null;
  }
  const gl = acquireGLContext(canvas);
  if (!gl) return null;
  const program = createProgram(gl);
  if (!program) return null;
  const buffer = gl.createBuffer();
  if (!buffer) {
    gl.deleteProgram(program);
    return null;
  }
  const positionLocation = gl.getAttribLocation(program, 'a_position');
  const colorLocation = gl.getUniformLocation(program, 'u_color');
  if (positionLocation < 0 || !colorLocation) {
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
    return null;
  }

  const resize = (backingWidth: number, backingHeight: number) => {
    const width = Math.max(1, Math.round(Number(backingWidth) || 1));
    const height = Math.max(1, Math.round(Number(backingHeight) || 1));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    gl.viewport(0, 0, width, height);
  };

  const drawTraces: WaveformGLRenderer['drawTraces'] = (rows, logicalWidth, logicalHeight, color) => {
    // Transparent clear so only the trace pixels composite onto the 2D background.
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!rows.length) return;
    gl.useProgram(program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
    gl.uniform4f(colorLocation, color.r, color.g, color.b, color.a);
    for (const row of rows) {
      // row is [xPx0, yPx0, xPx1, yPx1, ...] in LOGICAL pixels; convert to clip space in place.
      const pointCount = row.length >> 1;
      if (pointCount < 2) continue;
      const clip = new Float32Array(pointCount * 2);
      for (let i = 0; i < pointCount; i += 1) {
        clip[i * 2] = pixelToClipX(row[i * 2], logicalWidth);
        clip[i * 2 + 1] = pixelToClipY(row[i * 2 + 1], logicalHeight);
      }
      gl.bufferData(gl.ARRAY_BUFFER, clip, gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.LINE_STRIP, 0, pointCount);
    }
  };

  const dispose = () => {
    try {
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    } catch {
      /* context already lost; nothing to release */
    }
  };

  // Latch GPU context loss so the caller falls back to the 2D path. The program/buffers are
  // invalid after a loss, so we don't try to keep using this renderer (preventDefault keeps
  // the context restorable for a future remount).
  let contextLost = false;
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    contextLost = true;
  });
  const isLost = () => contextLost || gl.isContextLost();

  return { canvas, resize, drawTraces, dispose, isLost };
}
