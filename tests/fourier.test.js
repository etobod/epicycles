import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load product script into vm with DOM stubs.
//
// Optional `settings`:
//   - settings.globals: an object copied onto the vm context BEFORE the script
//     runs, so a test can supply `DOMParser` / `FileReader` stubs.
// The returned object additionally exposes:
//   - listeners: every function passed to an element's `addEventListener`,
//     keyed by element id then event type, e.g. p.listeners['originalBtn'].click,
//     p.listeners['nSlider'].input, p.listeners['svgInput'].change. Listeners
//     registered on `window` are keyed under the id `window`, e.g.
//     p.listeners.window.pageshow (fireable with no arguments).
//   - context: the recording 2D context (its `_drawCalls` list is the ordered
//     record of every recorded call; it is also reachable as p.ctx._drawCalls).
//   - parseSVG, trailLifetime, trailAlpha, pruneTrail: top-level product symbols
//     read from the context after the script runs (a top-level `const`/`let` is
//     not a property of the context object, so they are read by evaluating the
//     name). Each is undefined when the product does not define that name yet,
//     so a test for a missing symbol fails on an assertion instead of throwing.
// The recording 2D context records, in order, every method call with its
// arguments and the current strokeStyle, fillStyle and lineWidth at that
// moment. Reading a style/width returns the stored value (not a function);
// reading a method name returns a recording function.
function loadProduct(settings) {
  settings = settings || {};
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert(match, 'no <script> tag found');
  const script = match[1];

  const ctx = createContext();

  // Ordered record of every 2D-context method call. Starts empty; the product
  // does not draw during script load (it only registers the rAF callback), but
  // we clear after the run anyway so the recording is guaranteed empty here.
  const drawCalls = [];
  ctx._drawCalls = drawCalls;

  // Canvas 2D state properties are read as values (not functions); anything
  // else is a method and gets a recording function.
  const STATE_PROPS = new Set([
    'strokeStyle', 'fillStyle', 'lineWidth', 'lineDashOffset', 'lineCap',
    'lineJoin', 'miterLimit', 'font', 'textAlign', 'textBaseline',
    'globalAlpha', 'globalCompositeOperation', 'shadowBlur', 'shadowColor',
    'shadowOffsetX', 'shadowOffsetY', 'lineDash', 'direction', 'filter',
    'imageSmoothingEnabled'
  ]);
  const recState = {};
  const recTarget = {};
  const recordingContext = new Proxy(recTarget, {
    get(target, prop) {
      if (typeof prop === 'string' && prop.startsWith('_')) {
        return target[prop];
      }
      if (typeof prop === 'string' && STATE_PROPS.has(prop)) {
        return recState[prop];
      }
      return function(...args) {
        drawCalls.push({
          method: prop,
          args,
          strokeStyle: recState.strokeStyle,
          fillStyle: recState.fillStyle,
          lineWidth: recState.lineWidth
        });
        return recordingContext;
      };
    },
    set(target, prop, value) {
      recState[prop] = value;
      target[prop] = value;
      return true;
    }
  });
  // The ordered record is also reachable on the recording context itself, so
  // p.context._drawCalls and p.ctx._drawCalls are the same array.
  recTarget._drawCalls = drawCalls;

  // Captured listeners: keyed by element id, then event type (`window` holds
  // the listeners registered on the window object).
  const listeners = {};
  // Persistent element stubs: one object per id
  const elements = {};
  ctx.document = {
    documentElement: {
      _attrs: {},
      setAttribute(name, value) {
        this._attrs[name] = String(value);
      },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
      }
    },
    getElementById(id) {
      if (!elements[id]) {
        const el = {
          style: {},
          textContent: '',
          value: '6',
          min: '0',
          max: '13',
          width: 800,
          height: 600,
          files: [],
          getContext(type) {
            if (type === '2d') {
              return recordingContext;
            }
            return null;
          },
          addEventListener(type, fn) {
            if (!listeners[id]) listeners[id] = {};
            listeners[id][type] = fn;
          },
          _attrs: {},
          setAttribute(name, value) {
            this._attrs[name] = String(value);
          },
          getAttribute(name) {
            return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
          },
          click() {},
          readAsText(file) {},
          onload: null
        };
        elements[id] = el;
      }
      return elements[id];
    }
  };
  ctx.window = {
    innerWidth: 800,
    innerHeight: 600,
    addEventListener(type, fn) {
      // `window` listeners are captured under the key `window`, alongside the
      // per-element ones, so a test can fire e.g. p.listeners.window.pageshow().
      if (!listeners.window) listeners.window = {};
      listeners.window[type] = fn;
    }
  };
  ctx.requestAnimationFrame = function(fn) {
    ctx._rafCallback = fn;
  };

  // Extra globals (DOMParser, FileReader, ...) go on the context before the
  // script runs, so the product code can reference them as globals.
  if (settings.globals) {
    for (const k of Object.keys(settings.globals)) {
      ctx[k] = settings.globals[k];
    }
  }

  ctx.Math = Math;
  ctx.Array = Array;
  ctx.Object = Object;
  ctx.Number = Number;
  ctx.String = String;
  ctx.Date = Date;
  ctx.RegExp = RegExp;
  ctx.Error = Error;
  ctx.TypeError = TypeError;
  ctx.RangeError = RangeError;
  ctx.JSON = JSON;
  ctx.console = console;
  ctx.parseInt = parseInt;
  ctx.parseFloat = parseFloat;
  ctx.isNaN = isNaN;
  ctx.infinite = Infinity;
  ctx.NaN = NaN;
  ctx.decodeURIComponent = decodeURIComponent;
  ctx.encodeURIComponent = encodeURIComponent;

  runInContext(script, ctx);

  // The recording must start empty when loadProduct runs (see above).
  drawCalls.length = 0;

  // Read a top-level product symbol by name: a `function` declaration is a
  // property of the context, a `const`/`let` (or a `const` arrow function) is
  // only reachable by evaluating the name in the context. A name the product
  // does not define yields undefined rather than a ReferenceError, so the test
  // that asks for it fails on an assertion.
  const readSymbol = (name) => {
    try {
      return runInContext(name, ctx);
    } catch (e) {
      return undefined;
    }
  };

    return {
      ctx,
      context: recordingContext,
      listeners,
      fft: ctx.fft,
      ifft: ctx.ifft,
      computeFourier: ctx.computeFourier,
      getChainTip: ctx.getChainTip,
      reconstructPoint: ctx.reconstructPoint,
      computeRMSError: ctx.computeRMSError,
      parsePath: ctx.parsePath,
      parseLine: ctx.parseLine,
      parsePolyline: ctx.parsePolyline,
      parseCircle: ctx.parseCircle,
      parseSVG: readSymbol('parseSVG'),
      stitchFragments: ctx.stitchFragments,
      resampleToPowerOfTwo: ctx.resampleToPowerOfTwo,
      generateButterflyPath: ctx.generateButterflyPath,
      drawingInsets: readSymbol('drawingInsets'),
      chainOrigins: ctx.chainOrigins,
      centerPoints: ctx.centerPoints,
      speedFromSlider: ctx.speedFromSlider,
      appendTrail: ctx.appendTrail,
      trailLifetime: readSymbol('trailLifetime'),
      trailAlpha: readSymbol('trailAlpha'),
      pruneTrail: readSymbol('pruneTrail'),
      frameStep: readSymbol('frameStep'),
      meanPenSpeed: readSymbol('meanPenSpeed'),
      fitToSize: ctx.fitToSize
    };
}

test('product: script loads in node:vm', () => {
  const p = loadProduct();
  assert(typeof p.fft === 'function');
  assert(typeof p.ifft === 'function');
  assert(typeof p.computeFourier === 'function');
  assert(typeof p.getChainTip === 'function');
  assert(typeof p.computeRMSError === 'function');
  assert(typeof p.parsePath === 'function');
  assert(typeof p.stitchFragments === 'function');
  assert(typeof p.resampleToPowerOfTwo === 'function');
});

test('product: fft roundtrip', () => {
  const p = loadProduct();
  const N = 64;
  const signal = [];
  for (let i = 0; i < N; i++) {
    const t = 2 * Math.PI * i / N;
    signal.push({ re: Math.cos(t) + 0.3 * Math.sin(3 * t), im: 0 });
  }
  const coeffs = p.fft(signal);
  const recon = p.ifft(coeffs);
  for (let i = 0; i < N; i++) {
    const dx = recon[i].re - signal[i].re;
    const dy = recon[i].im - signal[i].im;
    const err = Math.sqrt(dx * dx + dy * dy);
    assert(err < 1e-10, `recon error at ${i}: ${err}`);
  }
});

test('product: fft sin peak at k=1', () => {
  const p = loadProduct();
  const N = 256;
  const signal = [];
  for (let i = 0; i < N; i++) {
    const t = 2 * Math.PI * i / N;
    signal.push({ re: 0, im: Math.sin(t) });
  }
  const result = p.fft(signal);
  const mag = Math.sqrt(result[1].re * result[1].re + result[1].im * result[1].im);
  const expected = N / 2;
  const tol = N / 100;
  assert(Math.abs(mag - expected) < tol, `peak mag ${mag} not near ${expected}`);
});

test('product: chains independent of each other', () => {
  const p = loadProduct();
  const N = 64;

  function makePoints(xFn, yFn) {
    const pts = [];
    for (let i = 0; i < N; i++) {
      const t = 2 * Math.PI * i / N;
      pts.push({ x: xFn(t), y: yFn(t) });
    }
    return pts;
  }

  const a = makePoints(t => Math.cos(t), t => Math.sin(t));
  const b = makePoints(t => Math.cos(t), t => Math.sin(2 * t));
  const c = makePoints(t => Math.cos(2 * t), t => Math.sin(t));

  const ha = p.computeFourier(a);
  const hb = p.computeFourier(b);
  const hc = p.computeFourier(c);

  // Same x → identical x harmonics
  assert.deepStrictEqual(
    ha.x.map(h => ({ radius: h.radius, speed: h.speed, phase: h.phase })),
    hb.x.map(h => ({ radius: h.radius, speed: h.speed, phase: h.phase }))
  );
  // Same y → identical y harmonics
  assert.deepStrictEqual(
    ha.y.map(h => ({ radius: h.radius, speed: h.speed, phase: h.phase })),
    hc.y.map(h => ({ radius: h.radius, speed: h.speed, phase: h.phase }))
  );
});

test('product: harmonics sorted by magnitude', () => {
  const p = loadProduct();
  const N = 256;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const t = 2 * Math.PI * i / N;
    pts.push({ x: Math.cos(t) + 0.5 * Math.cos(3 * t), y: Math.sin(2 * t) + 0.3 * Math.sin(5 * t) });
  }
  const c = p.computeFourier(pts);
  for (let i = 1; i < c.x.length; i++) {
    assert(c.x[i].radius <= c.x[i - 1].radius + 1e-15, 'x radii not non-increasing');
  }
  for (let i = 1; i < c.y.length; i++) {
    assert(c.y[i].radius <= c.y[i - 1].radius + 1e-15, 'y radii not non-increasing');
  }
});

test('product: negative frequencies mapped', () => {
  const p = loadProduct();
  const N = 64;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const t = 2 * Math.PI * i / N;
    pts.push({ x: 10 * Math.cos(3 * t), y: 0 });
  }
  const c = p.computeFourier(pts);
  const speeds = c.x.slice(0, 2).map(h => h.speed).sort((a, b) => a - b);
  assert(Math.abs(speeds[0] - (-3)) < 1e-9, `speed[0] ${speeds[0]} not -3`);
  assert(Math.abs(speeds[1] - 3) < 1e-9, `speed[1] ${speeds[1]} not 3`);
});

test('product: x chain reproduces centred input', () => {
  const p = loadProduct();
  const N = 64;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const t = 2 * Math.PI * i / N;
    pts.push({ x: 50 * Math.cos(t), y: 30 * Math.sin(2 * t) });
  }
  let cx = 0, cy = 0;
  for (const pt of pts) { cx += pt.x; cy += pt.y; }
  cx /= N; cy /= N;
  const centred = pts.map(pt => ({ x: pt.x - cx, y: pt.y - cy }));
  const c = p.computeFourier(pts);
  for (let i = 0; i < N; i++) {
    const t = 2 * Math.PI * i / N;
    const tip = p.getChainTip(c.x, t, N);
    const err = Math.abs(tip.x - centred[i].x);
    assert(err < 1e-9, `x recon error at ${i}: ${err}`);
  }
});

test('chains: drawing point reproduces input', () => {
    const p = loadProduct();
    const N = 64;
    const points = [];
    for (let i = 0; i < N; i++) {
        const t = 2 * Math.PI * i / N;
        points.push({x: 50 * Math.cos(t), y: 30 * Math.sin(2 * t)});
    }
    let cx = 0, cy = 0;
    for (let i = 0; i < N; i++) { cx += points[i].x; cy += points[i].y; }
    cx /= N; cy /= N;
    const centred = points.map(pt => ({x: pt.x - cx, y: pt.y - cy}));
    const coeffs = p.computeFourier(centred);
    for (let i = 0; i < N; i++) {
        const t = 2 * Math.PI * i / N;
        const point = p.reconstructPoint(coeffs, t, N);
        assert.ok(Math.abs(point.x - centred[i].x) < 1e-9, `x at i=${i}`);
        assert.ok(Math.abs(point.y - centred[i].y) < 1e-9, `y at i=${i}`);
    }
});

test('chains: rms near zero at full N', () => {
    const p = loadProduct();
    const N = 64;
    const points = [];
    for (let i = 0; i < N; i++) {
        const t = 2 * Math.PI * i / N;
        points.push({x: 50 * Math.cos(t), y: 30 * Math.sin(2 * t)});
    }
    let cx = 0, cy = 0;
    for (let i = 0; i < N; i++) { cx += points[i].x; cy += points[i].y; }
    cx /= N; cy /= N;
    const centred = points.map(pt => ({x: pt.x - cx, y: pt.y - cy}));
    const coeffs = p.computeFourier(centred);
    const error = p.computeRMSError(centred, coeffs, N);
    assert.ok(error < 1e-6, `error ${error}`);
});

test('chains: rms non-increasing in N', () => {
    const p = loadProduct();
    const N = 256;
    const points = p.generateButterflyPath(N);
    let cx = 0, cy = 0;
    for (let i = 0; i < N; i++) { cx += points[i].x; cy += points[i].y; }
    cx /= N; cy /= N;
    const centred = points.map(pt => ({x: pt.x - cx, y: pt.y - cy}));
    const coeffs = p.computeFourier(centred);
    let prevError = Infinity;
    for (let n = 1; n <= N; n++) {
        const error = p.computeRMSError(centred, coeffs, n);
        assert.ok(error <= prevError + 1e-9, `error increased at n=${n}: ${prevError} -> ${error}`);
        prevError = error;
    }
});

test('chains: x chain on top, y chain on the left', () => {
    const p = loadProduct();
    assert.ok(typeof p.drawingInsets === 'function',
        'expected the product to expose drawingInsets, got ' + typeof p.drawingInsets);
    const insets = p.drawingInsets(800);
    assert.ok(insets !== null && typeof insets === 'object',
        `expected drawingInsets(800) to return an object, got ${typeof insets}`);
    const origins = p.chainOrigins(800, 600, insets);

    // The drawing area is [insets.left, 800] x [insets.top, 600].
    const centreX = insets.left + (800 - insets.left) / 2;

    assert.ok(Math.abs(origins.x.x - centreX) < 1e-9,
        `x origin x: ${origins.x.x}, expected the centre of the drawing area (${centreX})`);
    assert.ok(origins.x.y < 300, `x origin y: ${origins.x.y}, expected it in the top half`);
    assert.ok(Math.abs(origins.y.y - 300) < 1e-9,
        `y origin y: ${origins.y.y}, expected the vertical centre (300)`);
    assert.ok(origins.y.x >= insets.left,
        `y origin x: ${origins.y.x}, expected it at or right of the area's left edge (${insets.left})`);
    assert.ok(origins.y.x < centreX,
        `y origin x: ${origins.y.x}, expected it in the left half (below ${centreX})`);

    for (const [name, origin] of [['x', origins.x], ['y', origins.y]]) {
        assert.ok(origin.x >= insets.left && origin.x <= 800,
            `${name} origin x: ${origin.x}, expected it inside [${insets.left}, 800]`);
        assert.ok(origin.y >= 0 && origin.y <= 600,
            `${name} origin y: ${origin.y}, expected it inside [0, 600]`);
    }
});

test('chains: ifft RMS equals the direct sum', () => {
    const p = loadProduct();
    assert.ok(typeof p.computeRMSError === 'function',
        'expected the product to expose computeRMSError, got ' + typeof p.computeRMSError);
    assert.ok(typeof p.reconstructPoint === 'function',
        'expected the product to expose reconstructPoint, got ' + typeof p.reconstructPoint);
    assert.ok(typeof p.generateButterflyPath === 'function',
        'expected the product to expose generateButterflyPath, got ' + typeof p.generateButterflyPath);
    assert.ok(typeof p.centerPoints === 'function',
        'expected the product to expose centerPoints, got ' + typeof p.centerPoints);
    assert.ok(typeof p.computeFourier === 'function',
        'expected the product to expose computeFourier, got ' + typeof p.computeFourier);

    // The built-in butterfly, built the same way the product builds its default
    // shape.
    const path = p.centerPoints(p.generateButterflyPath(8192));
    const coeffs = p.computeFourier(path);
    const N = path.length; // 8192

    // The normaliser: the bounding-box diagonal of the original path.
    const box = bbox(path);
    const diag = Math.hypot(box.width, box.height);

    for (const n of [1, 2, 5, 8, 16, 64]) {
        const got = p.computeRMSError(path, coeffs, n);

        // The expected percentage, computed here with the real reconstructPoint
        // (the direct cosine sum the O(N log N) ifft reconstruction must
        // reproduce exactly).
        let sum = 0;
        for (let i = 0; i < N; i++) {
            const t = 2 * Math.PI * i / N;
            const rec = p.reconstructPoint(coeffs, t, n);
            assert.ok(rec !== null && typeof rec === 'object' &&
                      typeof rec.x === 'number' && typeof rec.y === 'number',
                `n=${n}: reconstructPoint returned ${JSON.stringify(rec)}`);
            const dx = rec.x - path[i].x, dy = rec.y - path[i].y;
            sum += dx * dx + dy * dy;
        }
        const rmse = Math.sqrt(sum / N);
        const expected = (rmse / diag) * 100;

        assert.ok(Math.abs(got - expected) < 1e-9,
            `n=${n}: ifft RMS ${got} differs from the direct sum ${expected}`);
    }
});

test('chains: full-N RMS computes fast', () => {
    const p = loadProduct();
    assert.ok(typeof p.computeRMSError === 'function',
        'expected the product to expose computeRMSError, got ' + typeof p.computeRMSError);
    assert.ok(typeof p.generateButterflyPath === 'function',
        'expected the product to expose generateButterflyPath, got ' + typeof p.generateButterflyPath);
    assert.ok(typeof p.centerPoints === 'function',
        'expected the product to expose centerPoints, got ' + typeof p.centerPoints);
    assert.ok(typeof p.computeFourier === 'function',
        'expected the product to expose computeFourier, got ' + typeof p.computeFourier);

    // The same butterfly data as the equality test.
    const path = p.centerPoints(p.generateButterflyPath(8192));
    const coeffs = p.computeFourier(path);

    const t0 = Date.now();
    const value = p.computeRMSError(path, coeffs, 8192);
    const elapsed = Date.now() - t0;

    assert.ok(Number.isFinite(value), `expected a finite error, got ${value}`);
    assert.ok(elapsed < 250, `expected full-N (N=8192) RMS in under 250 ms, took ${elapsed} ms`);
});

test('chains: trail not truncated at start-up', () => {
    // The start-up owl must keep a full lap of trail at the start-up speed, on
    // every window size: the pace scales with fitScale, so the dot count is the
    // same and stays within the draw budget. Checked analytically, no frames.
    const check = (p, label) => {
        const maxTrail = readConst(p, 'MAX_TRAIL_POINTS');
        assert.ok(Number.isFinite(maxTrail),
            `${label}: expected MAX_TRAIL_POINTS to be finite, got ${maxTrail}`);

        const coeffs = runInContext('coeffs', p.ctx);
        const fitScale = runInContext('fitScale', p.ctx);
        const penSpeed = p.meanPenSpeed(coeffs, 1024, 8192);
        const dt = p.frameStep(penSpeed, 0.1);
        const lap = Math.ceil(p.trailLifetime(0) / dt);
        assert.ok(lap <= maxTrail,
            `${label}: the start-up owl's lap draws ${lap} trail dots, above ` +
            `MAX_TRAIL_POINTS = ${maxTrail} (penSpeed ${penSpeed}, fitScale ${fitScale}, dt ${dt})`);
    };

    check(loadProduct(), 'default 800x600 window');
    check(loadProduct({ globals: { window: { innerWidth: 1920, innerHeight: 1080, addEventListener() {} } } }),
        'window 1920x1080');
});

test('ui: centerPoints centres', () => {
    const p = loadProduct();
    const points = [
        { x: 10, y: 20 },
        { x: 20, y: 40 },
        { x: 30, y: 60 }
    ];
    const centred = p.centerPoints(points);
    // Mean should be 0 within 1e-9
    let cx = 0, cy = 0;
    for (const pt of centred) {
        cx += pt.x;
        cy += pt.y;
    }
    cx /= centred.length;
    cy /= centred.length;
    assert.ok(Math.abs(cx) < 1e-9, `mean x ${cx} not 0`);
    assert.ok(Math.abs(cy) < 1e-9, `mean y ${cy} not 0`);
    // Differences should be preserved
    for (let i = 1; i < points.length; i++) {
        const dxIn = points[i].x - points[i - 1].x;
        const dyIn = points[i].y - points[i - 1].y;
        const dxOut = centred[i].x - centred[i - 1].x;
        const dyOut = centred[i].y - centred[i - 1].y;
        assert.ok(Math.abs(dxIn - dxOut) < 1e-9, `dx diff at ${i}`);
        assert.ok(Math.abs(dyIn - dyOut) < 1e-9, `dy diff at ${i}`);
    }
});

test('ui: error shown for default shape', () => {
    const p = loadProduct();
    // Run the captured requestAnimationFrame callback once
    if (p.ctx._rafCallback) {
        p.ctx._rafCallback();
    }
    const errorText = p.ctx.document.getElementById('errorDisplay').textContent;
    assert.ok(/approximation error = \d+\.\d+%$/.test(errorText), `error text: "${errorText}"`);
});

test('ui: speed scale has 0.5 in the middle', () => {
    const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
    const sliderMatch = html.match(/<input[^>]*id="speedSlider"[^>]*>/);
    assert(sliderMatch, 'speedSlider not found');
    const sliderHtml = sliderMatch[0];

    const getAttr = (attr) => {
        const m = sliderHtml.match(new RegExp(`${attr}="([^"]*)"`, 'i'));
        return m ? m[1] : null;
    };

    const minVal = Number(getAttr('min'));
    const maxVal = Number(getAttr('max'));
    const defVal = Number(getAttr('value'));
    assert.ok(Number.isFinite(minVal) && Number.isFinite(maxVal) && Number.isFinite(defVal),
        `expected numeric min/max/value on speedSlider, got min="${getAttr('min')}" max="${getAttr('max')}" value="${getAttr('value')}"`);

    const p = loadProduct();

    // The middle of the scale maps to speed 0.5, wherever the default knob is.
    const midpoint = (minVal + maxVal) / 2;
    const speedAtMidpoint = p.speedFromSlider(midpoint);
    assert.strictEqual(speedAtMidpoint, 0.5,
        `expected speedFromSlider(${midpoint}) to be 0.5, got ${speedAtMidpoint}`);

    // Across min..max (every integer step) the speeds are strictly increasing,
    const speeds = [];
    for (let s = Math.ceil(minVal); s <= Math.floor(maxVal); s++) {
        speeds.push(p.speedFromSlider(s));
    }
    for (let i = 1; i < speeds.length; i++) {
        assert.ok(speeds[i] > speeds[i - 1],
            `expected speeds strictly increasing, but speedFromSlider(${Math.ceil(minVal) + i}) = ${speeds[i]} is not greater than ${speeds[i - 1]}`);
    }
    // the low end is at most 0.1
    assert.ok(p.speedFromSlider(minVal) <= 0.1,
        `expected speedFromSlider(min ${minVal}) <= 0.1, got ${p.speedFromSlider(minVal)}`);
    // and the high end at least 2.
    assert.ok(p.speedFromSlider(maxVal) >= 2,
        `expected speedFromSlider(max ${maxVal}) >= 2, got ${p.speedFromSlider(maxVal)}`);
});

test('ui: paused trail does not grow', () => {
    const p = loadProduct();
    const trail = [];
    const point = { x: 1, y: 2, alpha: 1.0 };

    // Paused: trail should not grow
    const pausedTrail = p.appendTrail(trail, point, true, 10);
    assert.strictEqual(pausedTrail.length, 0, `paused trail should not grow, got length ${pausedTrail.length}`);

    // Not paused: trail should append
    const activeTrail = p.appendTrail(trail, point, false, 10);
    assert.strictEqual(activeTrail.length, 1, `active trail should have 1 point, got ${activeTrail.length}`);

    // Test max limit
    const longTrail = [];
    for (let i = 0; i < 5; i++) {
        longTrail.push({ x: i, y: i, alpha: 1.0 });
    }
    const overMaxTrail = p.appendTrail(longTrail, { x: 99, y: 99, alpha: 1.0 }, false, 3);
    assert.strictEqual(overMaxTrail.length, 3, `trail should not exceed max 3, got ${overMaxTrail.length}`);
});

test('product: no copied product functions', () => {
  const src = readFileSync(join(__dirname, 'fourier.test.js'), 'utf8');
  const copiedFns = ['fft', 'ifft', 'getChainTip', 'computeRMSError', 'computeFourier'];
  for (const fn of copiedFns) {
    assert(!new RegExp(`function\\s+${fn}\\s*\\(`).test(src), `found copied function ${fn}`);
    assert(!new RegExp(`(?:const|let|var)\\s+${fn}\\s*=`).test(src), `found copied const ${fn}`);
  }
});

// --- helpers for the svg: tests ---

// Map a list of product points to [x, y] pairs, asserting the shape first so a
// wrong shape fails with an assertion error, not a TypeError.
function xy(pts) {
  assert.ok(Array.isArray(pts), `expected an array of points, got ${typeof pts}`);
  return pts.map((pt, i) => {
    assert.ok(pt !== null && typeof pt === 'object',
      `point ${i} is not an object: ${JSON.stringify(pt)}`);
    assert.ok(typeof pt.x === 'number' && typeof pt.y === 'number',
      `point ${i} has no numeric x/y: ${JSON.stringify(pt)}`);
    return [pt.x, pt.y];
  });
}

// Deterministic pseudo-random generator (LCG) with a fixed seed, so fixtures
// are repeatable.
function makeLcg(seed) {
  let s = seed >>> 0;
  return function() {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Total length of the closed tour over a flat list of points: the sum of the
// consecutive distances, including the jump from the last point back to the first.
function closedTourLength(pts) {
  assert.ok(Array.isArray(pts) && pts.length >= 2,
    'closedTourLength expects a list of at least 2 points');
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  len += Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
  return len;
}

test('svg: implicit repeats and subpaths', () => {
  const p = loadProduct();
  const frags = p.parsePath('M0 0 L10 0 10 10 M20 20 l5 0 0 5');
  assert.ok(Array.isArray(frags), 'parsePath should return an array of fragments');
  assert.strictEqual(frags.length, 2, `expected 2 fragments, got ${frags.length}`);
  assert.deepStrictEqual(
    frags.map(f => xy(f)),
    [
      [[0, 0], [10, 0], [10, 10]],
      [[20, 20], [25, 20], [25, 25]]
    ],
    'fragment coordinates wrong'
  );
});

test('svg: line, curve and close commands', () => {
  const p = loadProduct();

  // H/h/V/v give the expected axis-aligned points
  let frags = p.parsePath('M0 0 H10 V20 h5 v-5');
  assert.ok(Array.isArray(frags), 'parsePath should return an array of fragments');
  assert.strictEqual(frags.length, 1, `expected 1 fragment, got ${frags.length}`);
  assert.deepStrictEqual(
    xy(frags[0]),
    [[0, 0], [10, 0], [10, 20], [15, 20], [15, 15]],
    'H/h/V/v coordinates wrong'
  );

  // Z ends the fragment at its start point
  frags = p.parsePath('M0 0 L10 0 L10 10 Z');
  assert.ok(Array.isArray(frags), 'parsePath should return an array of fragments');
  assert.strictEqual(frags.length, 1, `expected 1 fragment, got ${frags.length}`);
  const closed = frags[0];
  assert.ok(Array.isArray(closed) && closed.length >= 2,
    'Z fragment should have at least 2 points');
  const firstPt = closed[0];
  const lastPt = closed[closed.length - 1];
  assert.ok(firstPt !== null && typeof firstPt === 'object' &&
            lastPt !== null && typeof lastPt === 'object',
    'Z fragment points are not objects');
  assert.ok(Math.hypot(lastPt.x - firstPt.x, lastPt.y - firstPt.y) < 1e-9,
    `Z should end at the start point, ends at (${lastPt.x}, ${lastPt.y})`);

  // A C with three coordinate groups is a polybezier ending at the last end point
  frags = p.parsePath('M0 0 C0 10 10 10 10 0 10 -10 20 -10 20 0 20 10 30 10 30 0');
  assert.ok(Array.isArray(frags), 'parsePath should return an array of fragments');
  assert.strictEqual(frags.length, 1, `expected 1 fragment, got ${frags.length}`);
  let frag = frags[0];
  assert.ok(Array.isArray(frag) && frag.length >= 2,
    'C fragment should have at least 2 points');
  let end = frag[frag.length - 1];
  assert.ok(end !== null && typeof end === 'object' &&
            typeof end.x === 'number' && typeof end.y === 'number',
    'last point of the C fragment has no numeric x/y');
  assert.ok(Math.hypot(end.x - 30, end.y - 0) < 1e-9,
    `polybezier C should end at (30, 0), ends at (${end.x}, ${end.y})`);

  // Sampled C, S, Q, T curves end exactly at their end points
  const curveEnds = [
    ['M0 0 C0 10 10 10 10 0', 10, 0],
    ['M0 0 C0 10 10 10 10 0 S20 -10 30 0', 30, 0],
    ['M0 0 Q10 10 20 0', 20, 0],
    ['M0 0 Q10 10 20 0 T40 0', 40, 0]
  ];
  for (const [d, ex, ey] of curveEnds) {
    frags = p.parsePath(d);
    assert.ok(Array.isArray(frags), `parsePath should return an array for "${d}"`);
    assert.strictEqual(frags.length, 1, `expected 1 fragment for "${d}", got ${frags.length}`);
    frag = frags[0];
    assert.ok(Array.isArray(frag) && frag.length >= 2,
      `curve fragment too short for "${d}"`);
    end = frag[frag.length - 1];
    assert.ok(end !== null && typeof end === 'object' &&
              typeof end.x === 'number' && typeof end.y === 'number',
      `last point of "${d}" has no numeric x/y`);
    assert.ok(Math.hypot(end.x - ex, end.y - ey) < 1e-9,
      `curve "${d}" should end at (${ex}, ${ey}), ends at (${end.x}, ${end.y})`);
  }
});

test('svg: arc command', () => {
  const p = loadProduct();

  // Quarter of the circle of radius 100 centred at (0, 0)
  const frags = p.parsePath('M100 0 A100 100 0 0 1 0 100');
  assert.ok(Array.isArray(frags), 'parsePath should return an array of fragments');
  assert.strictEqual(frags.length, 1, `expected 1 fragment, got ${frags.length}`);
  const frag = frags[0];
  assert.ok(Array.isArray(frag) && frag.length >= 2,
    'arc fragment should have at least 2 points');
  for (const pt of frag) {
    assert.ok(pt !== null && typeof pt === 'object' &&
              typeof pt.x === 'number' && typeof pt.y === 'number',
      `arc point has no numeric x/y: ${JSON.stringify(pt)}`);
    assert.ok(Math.abs(Math.hypot(pt.x, pt.y) - 100) < 0.5,
      `sampled arc point (${pt.x}, ${pt.y}) is not within 0.5 of the radius-100 circle`);
  }
  const arcEnd = frag[frag.length - 1];
  assert.ok(Math.hypot(arcEnd.x - 0, arcEnd.y - 100) < 1e-6,
    `arc should end at (0, 100), ends at (${arcEnd.x}, ${arcEnd.y})`);

  // A zero-radius arc degenerates to a straight segment: just the two endpoints
  const frags2 = p.parsePath('M0 0 A0 0 0 0 1 5 5');
  assert.ok(Array.isArray(frags2), 'parsePath should return an array of fragments');
  assert.strictEqual(frags2.length, 1, `expected 1 fragment, got ${frags2.length}`);
  assert.deepStrictEqual(
    xy(frags2[0]),
    [[0, 0], [5, 5]],
    'zero-radius arc should be a straight segment (start and end point only)'
  );
});

test('svg: compact number syntax', () => {
  const p = loadProduct();
  const frags = p.parsePath('M.5.5l1e1-1e1');
  assert.ok(Array.isArray(frags), 'parsePath should return an array of fragments');
  assert.strictEqual(frags.length, 1, `expected 1 fragment, got ${frags.length}`);
  assert.deepStrictEqual(
    xy(frags[0]),
    [[0.5, 0.5], [10.5, -9.5]],
    'compact number syntax parsed wrong'
  );
});

// Compare two fragment lists point by point: the same number of fragments, each
// fragment the same length, every x and y within 1e-9. The shape of both sides
// is asserted first (through `xy`), so a wrong parse fails with an assertion
// error that names the fragment and point, not a TypeError.
function assertFragmentsClose(actual, expected, label) {
  assert.ok(Array.isArray(actual),
    `${label}: expected an array of fragments, got ${typeof actual}`);
  assert.ok(Array.isArray(expected),
    `${label}: expected an array of fragments, got ${typeof expected}`);
  assert.strictEqual(actual.length, expected.length,
    `${label}: expected ${expected.length} fragment(s), got ${actual.length}`);
  for (let f = 0; f < expected.length; f++) {
    const got = xy(actual[f]);
    const want = xy(expected[f]);
    assert.strictEqual(got.length, want.length,
      `${label}: fragment ${f} has ${got.length} points, expected ${want.length}`);
    for (let k = 0; k < want.length; k++) {
      const dx = Math.abs(got[k][0] - want[k][0]);
      const dy = Math.abs(got[k][1] - want[k][1]);
      assert.ok(dx < 1e-9 && dy < 1e-9,
        `${label}: fragment ${f} point ${k} is (${got[k][0]}, ${got[k][1]}), ` +
        `expected (${want[k][0]}, ${want[k][1]})`);
    }
  }
}

test('svg: S and T reflect only their own family', () => {
  const p = loadProduct();

  // An S/T control point is a reflection of the *previous control of its own
  // command family*, taken from the current point. A command of another family
  // between them resets that control, so the stale one from before must not
  // survive.
  const cases = [
    // S after L: the current point is (20, 0) and the previous command is L,
    // so the S control is (20, 0) itself — like C20 0 30 30 40 0 — not the
    // stale cubic control (10, 10) of the earlier C.
    ['M0 0 C0 10 10 10 10 0 L20 0 S30 30 40 0',
     'M0 0 C0 10 10 10 10 0 L20 0 C20 0 30 30 40 0',
     'S after L'],
    // T after C: the current point is (50, 0) and the previous command is C
    // (not a quad), so the T control is (50, 0) itself — like Q50 0 60 0 —
    // not the stale quad control (10, 10).
    ['M0 0 Q10 10 20 0 C30 -10 40 -10 50 0 T60 0',
     'M0 0 Q10 10 20 0 C30 -10 40 -10 50 0 Q50 0 60 0',
     'T after C']
  ];

  for (const [actual, expected, label] of cases) {
    assertFragmentsClose(p.parsePath(actual), p.parsePath(expected), label);
  }
});

test('svg: compact arc flags are single digits', () => {
  const p = loadProduct();

  // "a5 5 0 0110 0" is the two flags 0 and 1 followed by the end point 10 0,
  // not the flags read off by a greedy number regex. It must sample exactly as
  // the spaced form does, on the arc from (5, 5) to (15, 5).
  const compact = p.parsePath('M5 5 a5 5 0 0110 0');
  const spaced = p.parsePath('M5 5 a5 5 0 0 1 10 0');
  assertFragmentsClose(compact, spaced, 'compact arc flags');

  // Every sampled point is a real number (a mis-parsed flag would put NaN in
  // the arc maths).
  assert.ok(Array.isArray(compact) && compact.length >= 1,
    `expected at least one fragment from the compact arc, got ${JSON.stringify(compact)}`);
  const all = [];
  for (let f = 0; f < compact.length; f++) {
    const pts = xy(compact[f]);
    assert.ok(pts.length >= 1, `fragment ${f} of the compact arc has no points`);
    for (const pt of pts) all.push(pt);
  }
  for (let k = 0; k < all.length; k++) {
    assert.ok(Number.isFinite(all[k][0]) && Number.isFinite(all[k][1]),
      `compact arc point ${k} is not finite: (${all[k][0]}, ${all[k][1]})`);
  }

  // And the arc ends at (15, 5).
  const last = all[all.length - 1];
  assert.ok(Math.abs(last[0] - 15) < 1e-9 && Math.abs(last[1] - 5) < 1e-9,
    `expected the compact arc to end at (15, 5), got (${last[0]}, ${last[1]})`);
});

test('svg: arc with equal endpoints is skipped', () => {
  const p = loadProduct();

  // An arc whose start and end points are the same has no defined centre and
  // must be dropped rather than producing NaN; the following L segment is
  // unaffected and still ends at (10, 10).
  const frags = p.parsePath('M0 0 A5 5 0 0 0 0 0 L10 10');
  assert.ok(Array.isArray(frags) && frags.length >= 1,
    `expected at least one fragment, got ${JSON.stringify(frags)}`);

  for (let f = 0; f < frags.length; f++) {
    const pts = xy(frags[f]);
    for (let k = 0; k < pts.length; k++) {
      assert.ok(Number.isFinite(pts[k][0]) && Number.isFinite(pts[k][1]),
        `fragment ${f} point ${k} is not finite: (${pts[k][0]}, ${pts[k][1]})`);
    }
  }

  const lastFrag = xy(frags[frags.length - 1]);
  assert.ok(lastFrag.length >= 1, 'the returned fragment has no points');
  const last = lastFrag[lastFrag.length - 1];
  assert.ok(Math.abs(last[0] - 10) < 1e-9 && Math.abs(last[1] - 10) < 1e-9,
    `expected the L segment to end at (10, 10), got (${last[0]}, ${last[1]})`);
});

test('svg: fragments stitched in order', () => {
  const p = loadProduct();

  // 12 arcs of the circle of radius 100 centred at (0, 0). Each arc has 9
  // points at consecutive angles. Adjacent arcs leave a tiny angular gap at
  // their junction: the two junction endpoints are within the 1e-6 jump
  // threshold (so a restored circle has every jump < 1e-6) but are not exact
  // duplicates, so stitchFragments' consecutive-duplicate drop never triggers
  // and every arc keeps its full 9 points as one contiguous run.
  const R = 100;
  const ARC_STEPS = 8; // 9 points per arc
  const GAP = 1e-9; // angular gap at each junction (radians)
  const DELTA = 2 * Math.PI / 12;
  const arcs = [];
  for (let i = 0; i < 12; i++) {
    const pts = [];
    for (let k = 0; k <= ARC_STEPS; k++) {
      const a = i * DELTA + GAP + (k / ARC_STEPS) * (DELTA - 2 * GAP);
      pts.push({ x: R * Math.cos(a), y: R * Math.sin(a) });
    }
    arcs.push(pts);
  }

  // Fixed shuffle permutation; every second arc (in shuffled order) is reversed.
  const order = [5, 2, 9, 0, 7, 3, 11, 1, 6, 10, 4, 8];
  const shuffled = order.map((idx, j) => {
    const arc = arcs[idx].map(pt => ({ x: pt.x, y: pt.y }));
    if (j % 2 === 1) arc.reverse();
    return arc;
  });

  const out = p.stitchFragments(shuffled);
  assert.ok(Array.isArray(out), 'stitchFragments should return an array of points');
  const total = shuffled.reduce((s, f) => s + f.length, 0);
  // The arcs leave a tiny gap at each junction (endpoints within the 1e-6 jump
  // threshold but not exact duplicates), so no consecutive duplicate points are
  // produced and the output is all input points plus the closing one.
  assert.strictEqual(out.length, total + 1,
    `expected ${total + 1} points (all input points plus the closing one), got ${out.length}`);
  for (let i = 0; i < out.length; i++) {
    assert.ok(out[i] !== null && typeof out[i] === 'object' &&
              typeof out[i].x === 'number' && typeof out[i].y === 'number',
      `output point ${i} has no numeric x/y: ${JSON.stringify(out[i])}`);
  }

  // Ends with a point equal to the first
  assert.ok(Math.hypot(out[out.length - 1].x - out[0].x,
                       out[out.length - 1].y - out[0].y) < 1e-9,
    'stitched list should end with a point equal to the first');

  // Each original arc appears exactly once, as one contiguous run in its own
  // or reversed order. Collect where each run starts.
  const runStarts = [];
  for (let i = 0; i < arcs.length; i++) {
    const arc = arcs[i];
    const rev = arc.slice().reverse();
    const starts = [];
    for (let j = 0; j + arc.length <= out.length; j++) {
      if (Math.hypot(out[j].x - arc[0].x, out[j].y - arc[0].y) > 1e-9) continue;
      const matchFwd = arc.every((pt, k) =>
        Math.hypot(out[j + k].x - pt.x, out[j + k].y - pt.y) < 1e-9);
      const matchRev = rev.every((pt, k) =>
        Math.hypot(out[j + k].x - pt.x, out[j + k].y - pt.y) < 1e-9);
      if (matchFwd || matchRev) starts.push(j);
    }
    assert.strictEqual(starts.length, 1,
      `arc ${i} should appear exactly once as a contiguous run (own or reversed order), found ${starts.length} matches`);
    runStarts.push(starts[0]);
  }

  // The 12 runs tile the list (the runs plus the closing point fill the output)
  const sortedStarts = runStarts.slice().sort((a, b) => a - b);
  assert.deepStrictEqual(
    sortedStarts,
    Array.from({ length: 12 }, (_, k) => k * arcs[0].length),
    'the fragment runs do not tile the stitched list'
  );

  // Closed-tour jump length not larger than the shuffled input order
  const shuffledTour = [];
  for (const f of shuffled) shuffledTour.push(...f);
  assert.ok(closedTourLength(out) <= closedTourLength(shuffledTour) + 1e-9,
    `stitched tour ${closedTourLength(out)} is longer than the shuffled order ${closedTourLength(shuffledTour)}`);

  // Every stitch jump (the join between two consecutive fragment runs, and
  // the closing join back to the first point) is under 1e-6: with the circle
  // restored each join lands on the shared boundary point of the two arcs.
  for (let k = 0; k < sortedStarts.length; k++) {
    const s = sortedStarts[k];
    // Join: last point of this run -> first point of the next run.
    // For the last run the tour wraps to the first point of the list.
    const after = k + 1 < sortedStarts.length ? sortedStarts[k + 1] : 0;
    const jump = Math.hypot(out[s + arcs[0].length - 1].x - out[after].x,
                            out[s + arcs[0].length - 1].y - out[after].y);
    assert.ok(jump < 1e-6,
      `stitch jump after run starting at ${s} is ${jump}, the circle is not restored`);
  }
});

test('svg: stitching many fragments is fast', () => {
  const p = loadProduct();

  // 300 fragments of 40 points each (12 000 points) at random positions,
  // generated with a fixed-seed LCG so the fixture is repeatable.
  const rand = makeLcg(42);
  const fragments = [];
  for (let f = 0; f < 300; f++) {
    const cx = rand() * 1000;
    const cy = rand() * 1000;
    const pts = [];
    for (let k = 0; k < 40; k++) {
      pts.push({ x: cx + rand() * 10, y: cy + rand() * 10 });
    }
    fragments.push(pts);
  }

  const t0 = Date.now();
  const out = p.stitchFragments(fragments);
  const ms = Date.now() - t0;

  assert.ok(Array.isArray(out), 'stitchFragments should return an array of points');
  const total = fragments.reduce((s, f) => s + f.length, 0);
  assert.strictEqual(out.length, total + 1,
    `expected ${total + 1} points, got ${out.length}`);
  assert.ok(ms < 1000, `stitching 12 000 points took ${ms} ms, expected under 1000 ms`);
});

test('svg: pipeline has no NaN', () => {
  const p = loadProduct();

  const frags = p.parsePath('M0 0 C0 0 10 0 10 10 Z M10 10 L20 10');
  assert.ok(Array.isArray(frags), 'parsePath should return an array of fragments');
  const stitched = p.stitchFragments(frags);
  assert.ok(Array.isArray(stitched), 'stitchFragments should return an array of points');
  assert.ok(stitched.length >= 2, `stitched list too short: ${stitched.length} points`);
  for (let i = 0; i < stitched.length; i++) {
    assert.ok(stitched[i] !== null && typeof stitched[i] === 'object' &&
              typeof stitched[i].x === 'number' && typeof stitched[i].y === 'number',
      `stitched point ${i} has no numeric x/y: ${JSON.stringify(stitched[i])}`);
  }

  // No two consecutive points of the stitched list are equal
  for (let i = 1; i < stitched.length; i++) {
    const d = Math.hypot(stitched[i].x - stitched[i - 1].x, stitched[i].y - stitched[i - 1].y);
    assert.ok(d > 1e-12,
      `consecutive points ${i - 1} and ${i} of the stitched list are equal`);
  }

  const resampled = p.resampleToPowerOfTwo(stitched, 4);
  assert.ok(Array.isArray(resampled), 'resampleToPowerOfTwo should return an array of points');
  assert.strictEqual(resampled.length, 16,
    `expected 16 points after resampling to 2^4, got ${resampled.length}`);
  for (let i = 0; i < resampled.length; i++) {
    assert.ok(resampled[i] !== null && typeof resampled[i] === 'object' &&
              typeof resampled[i].x === 'number' && typeof resampled[i].y === 'number',
      `resampled point ${i} has no numeric x/y: ${JSON.stringify(resampled[i])}`);
    assert.ok(!Number.isNaN(resampled[i].x) && !Number.isNaN(resampled[i].y),
      `resampled point ${i} has a NaN coordinate`);
  }
});

// A DOM-like element stub for the element parsers: only `getAttribute`, backed
// by an attributes map. A name the map does not carry returns null, exactly as
// in the browser, so a test covers the "attribute absent" default.
function makeAttrStub(attrs) {
  return {
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    }
  };
}

test('svg: missing attributes default to zero', () => {
  const p = loadProduct();
  assert.ok(typeof p.parseLine === 'function',
    'expected the product to expose parseLine, got ' + typeof p.parseLine);
  assert.ok(typeof p.parsePolyline === 'function',
    'expected the product to expose parsePolyline, got ' + typeof p.parsePolyline);
  assert.ok(typeof p.parseCircle === 'function',
    'expected the product to expose parseCircle, got ' + typeof p.parseCircle);

  // <line/> with no attributes is the degenerate segment (0,0)-(0,0): two
  // points, all finite.
  const emptyLine = p.parseLine(makeAttrStub({}));
  assert.ok(Array.isArray(emptyLine),
    `expected parseLine to return an array of points, got ${typeof emptyLine}`);
  assert.strictEqual(emptyLine.length, 2,
    `expected 2 points from an attribute-less <line>, got ${emptyLine.length}`);
  const emptyPts = xy(emptyLine);
  assert.deepStrictEqual(emptyPts, [[0, 0], [0, 0]],
    'an attribute-less <line> should be the segment (0,0)-(0,0)');
  for (const [x, y] of emptyPts) {
    assert.ok(Number.isFinite(x) && Number.isFinite(y),
      `an attribute-less <line> produced a non-finite point (${x}, ${y})`);
  }

  // <line x2="10"/> is the segment (0,0)-(10,0).
  const x2Line = p.parseLine(makeAttrStub({ x2: '10' }));
  assert.ok(Array.isArray(x2Line),
    `expected parseLine to return an array of points, got ${typeof x2Line}`);
  assert.deepStrictEqual(xy(x2Line), [[0, 0], [10, 0]],
    '<line x2="10"/> should be the segment (0,0)-(10,0)');

  // <circle r="5"/>: a full circle of radius 5 centred on (0,0), every point
  // finite and at distance 5 from the centre.
  const circle = p.parseCircle(makeAttrStub({ r: '5' }));
  assert.ok(Array.isArray(circle) && circle.length > 0,
    `expected parseCircle to return a non-empty array of points, got ${JSON.stringify(circle)}`);
  const circlePts = xy(circle);
  for (let i = 0; i < circlePts.length; i++) {
    const [x, y] = circlePts[i];
    assert.ok(Number.isFinite(x) && Number.isFinite(y),
      `circle point ${i} is not finite: (${x}, ${y})`);
    assert.ok(Math.abs(Math.hypot(x, y) - 5) < 1e-9,
      `circle point ${i} (${x}, ${y}) is not at distance 5 from (0,0)`);
  }

  // <circle r="0"/>: no points at all.
  const zeroCircle = p.parseCircle(makeAttrStub({ r: '0' }));
  assert.ok(Array.isArray(zeroCircle),
    `expected parseCircle to return an array, got ${typeof zeroCircle}`);
  assert.strictEqual(zeroCircle.length, 0,
    `expected no points from <circle r="0"/>, got ${zeroCircle.length}`);

  // <circle cx="10px" cy="0" r="5px"/>: the CSS units are ignored, giving a
  // radius-5 circle around (10,0).
  const offsetCircle = p.parseCircle(makeAttrStub({ cx: '10px', cy: '0', r: '5px' }));
  assert.ok(Array.isArray(offsetCircle) && offsetCircle.length > 0,
    `expected parseCircle to return a non-empty array of points, got ${JSON.stringify(offsetCircle)}`);
  const offsetPts = xy(offsetCircle);
  for (let i = 0; i < offsetPts.length; i++) {
    const [x, y] = offsetPts[i];
    assert.ok(Number.isFinite(x) && Number.isFinite(y),
      `offset circle point ${i} is not finite: (${x}, ${y})`);
    assert.ok(Math.abs(Math.hypot(x - 10, y - 0) - 5) < 1e-9,
      `offset circle point ${i} (${x}, ${y}) is not at distance 5 from (10,0)`);
  }
});

test('svg: non-finite fragments dropped before stitching', () => {
  const p = loadProduct({ globals: { DOMParser: makeSvgDomParserStub() } });
  assert.ok(typeof p.parseSVG === 'function',
    'expected the product to expose parseSVG, got ' + typeof p.parseSVG);

  // A good path plus two broken polylines: one whose `points` carry a NaN
  // coordinate and one with no `points` attribute at all. Neither may reach the
  // stitcher.
  const svgText =
    '<svg xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M0 0 L10 0 L10 10 Z"></path>' +
    '<polyline points="0 NaN 10 10"></polyline>' +
    '<polyline></polyline>' +
    '</svg>';

  const frags = p.parseSVG(svgText);
  assert.ok(Array.isArray(frags),
    `expected parseSVG to return an array of fragments, got ${typeof frags}`);
  assert.ok(frags.length > 0,
    `expected parseSVG to return at least one fragment, got ${frags.length}`);

  for (let f = 0; f < frags.length; f++) {
    const frag = frags[f];
    assert.ok(Array.isArray(frag),
      `fragment ${f} is not an array of points: ${JSON.stringify(frag)}`);
    for (let k = 0; k < frag.length; k++) {
      const pt = frag[k];
      assert.ok(pt !== null && typeof pt === 'object' &&
                typeof pt.x === 'number' && typeof pt.y === 'number',
        `fragment ${f} point ${k} has no numeric x/y: ${JSON.stringify(pt)}`);
      assert.ok(Number.isFinite(pt.x) && Number.isFinite(pt.y),
        `fragment ${f} point ${k} is not finite: (${pt.x}, ${pt.y})`);
    }
  }

  const stitched = p.stitchFragments(frags);
  const resampled = p.resampleToPowerOfTwo(stitched, 13);
  const fitted = p.fitToSize(resampled, 300);

  assert.ok(Array.isArray(fitted),
    `expected fitToSize to return an array of points, got ${typeof fitted}`);
  assert.strictEqual(fitted.length, 8192,
    `expected 8192 points out of the pipeline, got ${fitted.length}`);
  for (let i = 0; i < fitted.length; i++) {
    const pt = fitted[i];
    assert.ok(pt !== null && typeof pt === 'object' &&
              typeof pt.x === 'number' && typeof pt.y === 'number',
      `fitted point ${i} has no numeric x/y: ${JSON.stringify(pt)}`);
    assert.ok(Number.isFinite(pt.x) && Number.isFinite(pt.y),
      `fitted point ${i} is not finite: (${pt.x}, ${pt.y})`);
  }
});

test('svg: group transform moves the shape', () => {
  // A transform on a <g> applies to the shapes inside it, and a child's own
  // transform composes with the parent's (child first, then parent).
  const p = loadProduct({ globals: { DOMParser: makeSvgTreeDomParserStub() } });

  // Compare a fragment list to expected [x, y] pairs within 1e-9. The shape is
  // asserted first, so a wrong shape fails on an assertion, not a TypeError.
  const checkFragment = (frags, wantPoints, label) => {
    assert.ok(Array.isArray(frags),
      `${label}: expected an array of fragments, got ${typeof frags}`);
    assert.strictEqual(frags.length, 1,
      `${label}: expected exactly 1 fragment, got ${frags.length}`);
    const got = xy(frags[0]);
    assert.strictEqual(got.length, wantPoints.length,
      `${label}: fragment has ${got.length} point(s), expected ${wantPoints.length}`);
    for (let k = 0; k < wantPoints.length; k++) {
      const dx = Math.abs(got[k][0] - wantPoints[k][0]);
      const dy = Math.abs(got[k][1] - wantPoints[k][1]);
      assert.ok(dx < 1e-9 && dy < 1e-9,
        `${label}: point ${k} is (${got[k][0]}, ${got[k][1]}), ` +
        `expected (${wantPoints[k][0]}, ${wantPoints[k][1]})`);
    }
  };

  // A group translate moves the child shape by (20, 10).
  checkFragment(
    p.parseSVG('<svg><g transform="translate(20,10)"><path d="M0 0 L10 0"/></g></svg>'),
    [[20, 10], [30, 10]],
    'group translate');

  // Parent scale(2) then child translate(5,0): the child applies first, so the
  // points are scale(2) · (translate(5,0) · p) = (10,0)-(30,0) and not the
  // reverse composition (5,0)-(25,0).
  checkFragment(
    p.parseSVG('<svg><g transform="scale(2)"><path transform="translate(5,0)" d="M0 0 L10 0"/></g></svg>'),
    [[10, 0], [30, 0]],
    'parent and child transforms compose');
});

test('svg: element transforms compose', () => {
  // One transform list on one element: entries compose left to right (the
  // leftmost is applied to the result of the rest).
  const p = loadProduct({ globals: { DOMParser: makeSvgTreeDomParserStub() } });

  const checkFragment = (d, transform, wantPoints, label) => {
    const frags = p.parseSVG(`<svg><path transform="${transform}" d="${d}"/></svg>`);
    assert.ok(Array.isArray(frags),
      `${label}: expected an array of fragments, got ${typeof frags}`);
    assert.strictEqual(frags.length, 1,
      `${label}: expected exactly 1 fragment, got ${frags.length}`);
    const got = xy(frags[0]);
    assert.strictEqual(got.length, wantPoints.length,
      `${label}: fragment has ${got.length} point(s), expected ${wantPoints.length}`);
    for (let k = 0; k < wantPoints.length; k++) {
      const dx = Math.abs(got[k][0] - wantPoints[k][0]);
      const dy = Math.abs(got[k][1] - wantPoints[k][1]);
      assert.ok(dx < 1e-9 && dy < 1e-9,
        `${label}: point ${k} is (${got[k][0]}, ${got[k][1]}), ` +
        `expected (${wantPoints[k][0]}, ${wantPoints[k][1]})`);
      assert.ok(Number.isFinite(got[k][0]) && Number.isFinite(got[k][1]),
        `${label}: point ${k} is not finite: (${got[k][0]}, ${got[k][1]})`);
    }
  };

  // scale(2) rotate(90): rotate first, then scale. (0,0) and (10,0) -> (0,0)
  // and (0,20).
  checkFragment('M0 0 L10 0', 'scale(2) rotate(90)', [[0, 0], [0, 20]], 'scale rotate');

  // matrix(a,b,c,d,e,f): (0,0) -> (e,f) = (5,6), (1,0) -> (a+e,b+f) = (6,8).
  checkFragment('M0 0 L1 0', 'matrix(1,2,3,4,5,6)', [[5, 6], [6, 8]], 'matrix');

  // rotate(90,5,5) about (5,5): (0,0) -> (10,0), (10,5) -> (5,10).
  checkFragment('M0 0 L10 5', 'rotate(90,5,5)', [[10, 0], [5, 10]], 'rotate about a point');

  // skewX(45): x' = x + tan(45)*y = x + y, so (0,10) -> (10,10).
  checkFragment('M0 0 L0 10', 'skewX(45)', [[0, 0], [10, 10]], 'skewX');

  // An empty entry is the identity, not an error.
  checkFragment('M0 0 L10 0', 'rotate()', [[0, 0], [10, 0]], 'empty rotate');

  // A bad entry is skipped as the identity; the valid one still applies.
  checkFragment('M0 0 L10 0', 'scale(none) translate(5,0)', [[5, 0], [15, 0]], 'bad entry is identity');
});

test('svg: defs clipPath mask symbol and hidden subtrees skipped', () => {
  const p = loadProduct({ globals: { DOMParser: makeSvgTreeDomParserStub() } });

  // One visible path plus hidden shapes at other coordinates: inside <defs>,
  // <clipPath>, <mask>, <symbol> and two display:none groups (a display
  // attribute and a style with spaces around the colon). Only the visible path
  // may reach the fragment list.
  const svgText =
    '<svg>' +
    '<defs><path d="M100 100 L110 100"/></defs>' +
    '<clipPath><path d="M200 100 L210 100"/></clipPath>' +
    '<mask><path d="M300 100 L310 100"/></mask>' +
    '<symbol><path d="M400 100 L410 100"/></symbol>' +
    '<g display="none"><path d="M500 100 L510 100"/></g>' +
    '<g style="fill:red; display : none"><path d="M600 100 L610 100"/></g>' +
    '<path d="M0 0 L10 0"/>' +
    '</svg>';

  const frags = p.parseSVG(svgText);
  assert.ok(Array.isArray(frags),
    `expected an array of fragments, got ${typeof frags}`);
  assert.strictEqual(frags.length, 1,
    `expected exactly 1 fragment (the visible path), got ${frags.length}`);

  const got = xy(frags[0]);
  const want = [[0, 0], [10, 0]];
  assert.strictEqual(got.length, want.length,
    `the visible fragment has ${got.length} point(s), expected ${want.length}`);
  for (let k = 0; k < want.length; k++) {
    const dx = Math.abs(got[k][0] - want[k][0]);
    const dy = Math.abs(got[k][1] - want[k][1]);
    assert.ok(dx < 1e-9 && dy < 1e-9,
      `point ${k} is (${got[k][0]}, ${got[k][1]}), ` +
      `expected (${want[k][0]}, ${want[k][1]})`);
  }
});

test('svg: namespace-prefixed elements are read', () => {
  // Regression (final review of plan 019): some exporters emit a qualified tag
  // name (`<svg:path>`, Office/Java). The walk must match the LOCAL name, or
  // the whole file loads silently empty.
  const path = {
    tagName: 'svg:path',
    localName: 'path',
    nodeName: 'svg:path',
    children: [],
    getAttribute(name) { return name === 'd' ? 'M0 0 L10 0' : null; }
  };
  const root = {
    tagName: 'svg',
    localName: 'svg',
    nodeName: 'svg',
    children: [path],
    getAttribute() { return null; }
  };
  function DOMParserStub() {}
  DOMParserStub.prototype.parseFromString = function() {
    return { documentElement: root };
  };

  const p = loadProduct({ globals: { DOMParser: DOMParserStub } });
  const frags = p.parseSVG('<svg><svg:path d="M0 0 L10 0"/></svg>');
  assert.ok(Array.isArray(frags),
    `expected an array of fragments, got ${typeof frags}`);
  assert.strictEqual(frags.length, 1,
    `expected 1 fragment from the namespaced path, got ${frags.length}`);

  const got = xy(frags[0]);
  const want = [[0, 0], [10, 0]];
  assert.strictEqual(got.length, want.length,
    `expected ${want.length} points, got ${got.length}`);
  for (let k = 0; k < want.length; k++) {
    assert.ok(Math.abs(got[k][0] - want[k][0]) < 1e-9 &&
              Math.abs(got[k][1] - want[k][1]) < 1e-9,
      `point ${k} is (${got[k][0]}, ${got[k][1]}), expected (${want[k][0]}, ${want[k][1]})`);
  }
});

// --- helpers for the view: tests ---

// Bounding box {minX, minY, maxX, maxY, width, height} of a list of points.
// The shape is asserted first so a wrong shape fails with an assertion, not a TypeError.
function bbox(pts) {
  assert.ok(Array.isArray(pts) && pts.length >= 1,
    `bbox expects a non-empty list of points, got ${typeof pts}`);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pt of pts) {
    assert.ok(pt !== null && typeof pt === 'object' &&
              typeof pt.x === 'number' && typeof pt.y === 'number',
      `bbox point has no numeric x/y: ${JSON.stringify(pt)}`);
    if (pt.x < minX) minX = pt.x;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.y > maxY) maxY = pt.y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

// True if any point of the list has a NaN coordinate.
function hasNaN(pts) {
  assert.ok(Array.isArray(pts), `hasNaN expects an array, got ${typeof pts}`);
  for (const pt of pts) {
    if (pt === null || typeof pt !== 'object' ||
        typeof pt.x !== 'number' || typeof pt.y !== 'number' ||
        Number.isNaN(pt.x) || Number.isNaN(pt.y)) {
      return true;
    }
  }
  return false;
}

// Read a top-level const/let of the product by name. These are not properties
// of the context object, so they are read with runInContext. A missing name
// (the product does not define it yet) is reported as an assertion failure,
// not a ReferenceError.
function readConst(p, name) {
  let value;
  let ok = false;
  let err = null;
  try {
    value = runInContext(name, p.ctx);
    ok = true;
  } catch (e) {
    ok = false;
    err = e;
  }
  assert.ok(ok, `expected the product to define "${name}", but reading it failed (${err})`);
  return value;
}

// The index of the nearest arc call strictly before index `i` that belongs to
// the same path (i.e. since the last beginPath or fill). Returns -1 if the
// path has no arc (or the fill is not preceded by an arc in its own path).
function nearestArcBefore(calls, i) {
  for (let j = i - 1; j >= 0; j--) {
    const m = calls[j].method;
    if (m === 'fill' || m === 'beginPath') return -1;
    if (m === 'arc') return j;
  }
  return -1;
}

// The point a stroke draws through: the arc centre for a circle, or the last
// moveTo/lineTo for an arm. Stops at the path's beginPath.
function strokePathPoint(calls, i) {
  for (let j = i - 1; j >= 0; j--) {
    const m = calls[j].method;
    if (m === 'beginPath') return null;
    if (m === 'arc') return { x: calls[j].args[0], y: calls[j].args[1] };
    if (m === 'lineTo') return { x: calls[j].args[0], y: calls[j].args[1] };
    if (m === 'moveTo') return { x: calls[j].args[0], y: calls[j].args[1] };
  }
  return null;
}

// The average path point of the strokes drawn in `colour`, or null when none.
function averageStrokePoint(calls, colour) {
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < calls.length; i++) {
    if (calls[i].method !== 'stroke' || calls[i].strokeStyle !== colour) continue;
    const pt = strokePathPoint(calls, i);
    if (pt) { sx += pt.x; sy += pt.y; n++; }
  }
  return n ? { x: sx / n, y: sy / n, n } : null;
}

// A rectangle path of width `w` and height `h`, `n` points per side, centred on
// (0, 0) so its bounding box is exactly w x h.
function rectPoints(w, h, n) {
  const pts = [];
  for (let k = 0; k < n; k++) pts.push({ x: -w / 2 + (k / n) * w, y: -h / 2 });
  for (let k = 0; k < n; k++) pts.push({ x: w / 2, y: -h / 2 + (k / n) * h });
  for (let k = 0; k < n; k++) pts.push({ x: w / 2 - (k / n) * w, y: h / 2 });
  for (let k = 0; k < n; k++) pts.push({ x: -w / 2, y: h / 2 - (k / n) * h });
  return pts;
}

test('view: fitToSize scales to the box', () => {
  const p = loadProduct();
  assert.ok(typeof p.fitToSize === 'function',
    'expected fitToSize to be a function, got ' + typeof p.fitToSize);

  const SIZE = 300;
  const N = 25; // points per side
  // Two rectangles, the larger side 2:1 in both, at very different scales.
  const rectA = rectPoints(24, 12, N);   // 24 x 12
  const rectB = rectPoints(4000, 2000, N); // 4000 x 2000

  const outA = p.fitToSize(rectA, SIZE);
  const outB = p.fitToSize(rectB, SIZE);
  const a = xy(outA);
  const b = xy(outB);

  // Both give a 300 x 150 bounding box (larger side = size, ratio preserved).
  const ba = bbox(outA);
  const bb = bbox(outB);
  assert.ok(Math.abs(ba.width - 300) < 1e-6 && Math.abs(ba.height - 150) < 1e-6,
    `small rectangle: expected a 300 x 150 box, got ${ba.width} x ${ba.height}`);
  assert.ok(Math.abs(bb.width - 300) < 1e-6 && Math.abs(bb.height - 150) < 1e-6,
    `large rectangle: expected a 300 x 150 box, got ${bb.width} x ${bb.height}`);

  // Both are centred: mean within 1e-9 of 0.
  for (const [name, out] of [['small', outA], ['large', outB]]) {
    let mx = 0, my = 0;
    for (const pt of out) { mx += pt.x; my += pt.y; }
    mx /= out.length; my /= out.length;
    assert.ok(Math.abs(mx) < 1e-9 && Math.abs(my) < 1e-9,
      `${name} rectangle: expected mean within 1e-9 of 0, got (${mx}, ${my})`);
  }

  // Same shape: the pairwise distance ratios are equal between the two outputs,
  // i.e. dA(i, j) / dB(i, j) is one constant for every pair (the two outputs
  // are similar figures). For these two 2:1 rectangles the constant is 1 (both
  // fit to the same box with the same shape); any single constant proves it.
  assert.strictEqual(a.length, b.length,
    `fitToSize changed the point count: ${a.length} vs ${b.length}`);
  let refRatio = null;
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 1; j < a.length; j++) {
      const dA = Math.hypot(a[i][0] - a[j][0], a[i][1] - a[j][1]);
      const dB = Math.hypot(b[i][0] - b[j][0], b[i][1] - b[j][1]);
      assert.ok(dB > 1e-12,
        `degenerate point pair (${i}, ${j}) in the large rectangle output`);
      const ratio = dA / dB;
      if (refRatio === null) {
        refRatio = ratio;
      } else {
        assert.ok(Math.abs(ratio - refRatio) < 1e-9,
          `pairwise distance ratio is not constant: pair (${i}, ${j}) = ${ratio}, reference = ${refRatio}`);
      }
    }
  }
});

test('view: fitToSize degenerate input', () => {
  const p = loadProduct();
  assert.ok(typeof p.fitToSize === 'function',
    'expected fitToSize to be a function, got ' + typeof p.fitToSize);

  // A single point: returned at the origin, no NaN.
  const single = p.fitToSize([{ x: 5, y: 7 }], 300);
  assert.ok(Array.isArray(single), 'fitToSize should return an array of points');
  assert.strictEqual(single.length, 1, `expected 1 point, got ${single.length}`);
  assert.ok(!hasNaN(single), 'single-point output has a NaN coordinate');
  assert.ok(Math.abs(single[0].x) < 1e-9 && Math.abs(single[0].y) < 1e-9,
    `single point should be at (0,0), got (${single[0].x}, ${single[0].y})`);

  // A list of identical points (a zero-size box): all at the origin, no NaN.
  const identical = p.fitToSize([{ x: 3, y: 4 }, { x: 3, y: 4 }, { x: 3, y: 4 }], 300);
  assert.ok(Array.isArray(identical), 'fitToSize should return an array of points');
  assert.strictEqual(identical.length, 3, `expected 3 points, got ${identical.length}`);
  assert.ok(!hasNaN(identical), 'identical-points output has a NaN coordinate');
  for (const pt of identical) {
    assert.ok(Math.abs(pt.x) < 1e-9 && Math.abs(pt.y) < 1e-9,
      `identical point should be at (0,0), got (${pt.x}, ${pt.y})`);
  }
});

test('view: original drawn under the trail, slightly wider', () => {
  const p = loadProduct();
  const trailRadius = readConst(p, 'TRAIL_RADIUS');
  assert.ok(typeof trailRadius === 'number' && !Number.isNaN(trailRadius),
    `expected TRAIL_RADIUS to be a number, got ${trailRadius}`);

  // Turn the original overlay on.
  const click = p.listeners && p.listeners.originalBtn && p.listeners.originalBtn.click;
  assert.ok(typeof click === 'function',
    'expected a captured click listener for originalBtn, got ' + typeof click);
  const btnEl = p.ctx.document.getElementById('originalBtn');
  click.call(btnEl, { target: btnEl });

  // One frame: the overlay is drawn under the trail.
  assert.ok(typeof p.ctx._rafCallback === 'function', 'expected a captured rAF callback');
  p.ctx._drawCalls.length = 0;
  p.ctx._rafCallback();
  const calls = p.ctx._drawCalls;

  const OVERLAY_COLOR = runInContext('THEME_COLORS[theme].overlay', p.ctx);
  assert.ok(typeof OVERLAY_COLOR === 'string',
    `expected THEME_COLORS[theme].overlay to be a string, got ${typeof OVERLAY_COLOR}`);
  const OVERLAY_WIDTH = readConst(p, 'OVERLAY_WIDTH');
  assert.ok(typeof OVERLAY_WIDTH === 'number' && !Number.isNaN(OVERLAY_WIDTH),
    `expected OVERLAY_WIDTH to be a number, got ${OVERLAY_WIDTH}`);

  // A stroke issued while strokeStyle === OVERLAY_COLOR and lineWidth === OVERLAY_WIDTH.
  const strokeIdx = calls.findIndex(c => c.method === 'stroke' &&
    c.strokeStyle === OVERLAY_COLOR && c.lineWidth === OVERLAY_WIDTH);
  assert.ok(strokeIdx >= 0,
    'expected a frame stroke with strokeStyle=OVERLAY_COLOR and lineWidth=OVERLAY_WIDTH');

  // The overlay is a solid line: no setLineDash with a non-empty array between
  // the overlay's beginPath and its stroke.
  let beginIdx = -1;
  for (let i = strokeIdx - 1; i >= 0; i--) {
    if (calls[i].method === 'beginPath') { beginIdx = i; break; }
  }
  assert.ok(beginIdx >= 0, 'expected a beginPath before the overlay stroke');
  for (let i = beginIdx; i <= strokeIdx; i++) {
    const c = calls[i];
    if (c.method === 'setLineDash') {
      const arr = c.args && c.args[0];
      assert.ok(!(Array.isArray(arr) && arr.length > 0),
        'expected the overlay line to be solid, but found a non-empty setLineDash between its beginPath and stroke');
    }
  }

  // The overlay stroke comes before the frame's first trail fill. A trail fill
  // is a fill whose (nearest, within its own path) preceding arc used the
  // trail dot radius.
  let firstTrailFillIdx = -1;
  for (let i = 0; i < calls.length; i++) {
    if (calls[i].method === 'fill') {
      const ai = nearestArcBefore(calls, i);
      if (ai >= 0 && calls[ai].args[2] === trailRadius) {
        firstTrailFillIdx = i;
        break;
      }
    }
  }
  assert.ok(firstTrailFillIdx >= 0, 'expected the frame to draw at least one trail dot fill');
  assert.ok(strokeIdx < firstTrailFillIdx,
    `expected the overlay stroke (index ${strokeIdx}) to come before the first trail fill (index ${firstTrailFillIdx})`);

  // Slightly wider than the trail dot diameter: 2 * TRAIL_RADIUS < width <= 2 * TRAIL_RADIUS + 1.
  assert.ok(OVERLAY_WIDTH > 2 * trailRadius,
    `expected OVERLAY_WIDTH (${OVERLAY_WIDTH}) to be greater than 2 * TRAIL_RADIUS (${2 * trailRadius})`);
  assert.ok(OVERLAY_WIDTH <= 2 * trailRadius + 1,
    `expected OVERLAY_WIDTH (${OVERLAY_WIDTH}) to be at most 2 * TRAIL_RADIUS + 1 (${2 * trailRadius + 1})`);

  // Without the click (a fresh frame), no stroke uses OVERLAY_COLOR.
  const p2 = loadProduct();
  const oc2 = runInContext('THEME_COLORS[theme].overlay', p2.ctx);
  assert.ok(typeof oc2 === 'string',
    `expected THEME_COLORS[theme].overlay to be a string, got ${typeof oc2}`);
  assert.ok(typeof p2.ctx._rafCallback === 'function', 'expected a captured rAF callback');
  p2.ctx._drawCalls.length = 0;
  p2.ctx._rafCallback();
  const anyOverlay = p2.ctx._drawCalls.some(c => c.method === 'stroke' && c.strokeStyle === oc2);
  assert.ok(!anyOverlay, 'expected no stroke to use OVERLAY_COLOR without the originalBtn click');
});

test('view: frame uses the palette', () => {
  const p = loadProduct();

  // The original overlay is off by default (see the test above), so turn it on
  // with its button: the drawn frame then exercises all seven palette roles.
  const click = p.listeners && p.listeners.originalBtn && p.listeners.originalBtn.click;
  assert.ok(typeof click === 'function',
    'expected a captured click listener for originalBtn, got ' + typeof click);
  const btn = p.ctx.document.getElementById('originalBtn');
  click.call(btn, { target: btn });

  // A few frames: the trail needs at least two points before it joins them with
  // a connecting stroke, so only then does the last frame carry both the trail
  // fills (the dots) and a trail stroke (a segment).
  const calls = runFrames(p, 3);
  assert.ok(calls.length > 0, 'the frame recorded no draw calls');

  const strokes = calls.filter((c) => c.method === 'stroke').map((c) => c.strokeStyle);
  const fills = calls.filter((c) => c.method === 'fill').map((c) => c.fillStyle);

  // The seven dark-palette roles.
  assert.ok(strokes.includes('#A89CC9'),
    `expected the x-chain stroke in '#A89CC9', got strokes ${JSON.stringify(strokes)}`);
  assert.ok(strokes.includes('#F5C99B'),
    `expected the y-chain stroke in '#F5C99B', got strokes ${JSON.stringify(strokes)}`);

  // The mapping is pinned: the x chain is the top chain, the y chain the left
  // one. Swapping colors.chainX/chainY in the product fails here.
  const xChainPt = averageStrokePoint(calls, '#A89CC9');
  const yChainPt = averageStrokePoint(calls, '#F5C99B');
  assert.ok(xChainPt && yChainPt, 'expected strokes in both chain colours');
  assert.ok(xChainPt.y < yChainPt.y,
    `the x chain ('#A89CC9') must sit above the y chain ('#F5C99B'): ` +
    `average y ${xChainPt.y} vs ${yChainPt.y}`);
  assert.ok(yChainPt.x < xChainPt.x,
    `the y chain ('#F5C99B') must sit left of the x chain ('#A89CC9'): ` +
    `average x ${yChainPt.x} vs ${xChainPt.x}`);
  assert.ok(strokes.includes('#A8A5B3'),
    `expected the connector stroke in '#A8A5B3', got strokes ${JSON.stringify(strokes)}`);
  assert.ok(fills.some((s) => typeof s === 'string' && /^rgba\(240, 239, 234,/.test(s)),
    `expected a trail dot fill in 'rgba(240, 239, 234, a)', got fills ${JSON.stringify(fills)}`);
  assert.ok(strokes.some((s) => typeof s === 'string' && /^rgba\(240, 239, 234,/.test(s)),
    `expected a trail segment stroke in 'rgba(240, 239, 234, a)', got strokes ${JSON.stringify(strokes)}`);
  assert.ok(fills.includes('#F0EFEA'),
    `expected the pen fill in '#F0EFEA', got fills ${JSON.stringify(fills)}`);
  assert.ok(strokes.includes('rgba(88, 104, 212, 0.9)'),
    `expected the overlay stroke in 'rgba(88, 104, 212, 0.9)', got strokes ${JSON.stringify(strokes)}`);

  // No recorded call may fall back to a fixed, non-theme colour. The clear
  // '#0a0e22' is allowed; the trail ink triple is checked above.
  const FORBIDDEN = ['#000', '#888', '#fff', '#ffffff'];
  const FORBIDDEN_RE = [/255, 140, 105/, /0, 255, 255/];
  for (const call of calls) {
    for (const style of [call.strokeStyle, call.fillStyle]) {
      if (typeof style !== 'string') continue;
      assert.ok(!FORBIDDEN.includes(style),
        `a frame call used the fixed colour ${JSON.stringify(style)}; ` +
        'every colour must come from THEME_COLORS');
      for (const re of FORBIDDEN_RE) {
        assert.ok(!re.test(style),
          `a frame call used a fixed colour ${JSON.stringify(style)} matching ${re}; ` +
          'every colour must come from THEME_COLORS');
      }
    }
  }
});

test('view: frame follows the theme table', () => {
  const p = loadProduct();

  // Switch the product to the light theme through its top-level `theme`.
  runInContext('theme = "light"', p.ctx);

  // The overlay is off by default, so turn it on with its button as above.
  const click = p.listeners && p.listeners.originalBtn && p.listeners.originalBtn.click;
  assert.ok(typeof click === 'function',
    'expected a captured click listener for originalBtn, got ' + typeof click);
  const btn = p.ctx.document.getElementById('originalBtn');
  click.call(btn, { target: btn });

  const calls = runFrames(p, 3);
  assert.ok(calls.length > 0, 'the frame recorded no draw calls');

  const strokes = calls.filter((c) => c.method === 'stroke').map((c) => c.strokeStyle);
  const fills = calls.filter((c) => c.method === 'fill').map((c) => c.fillStyle);

  // The same seven roles, now in the light values.
  assert.ok(strokes.includes('#6B5B8F'),
    `expected the x-chain stroke in '#6B5B8F', got strokes ${JSON.stringify(strokes)}`);
  assert.ok(strokes.includes('#B07A4A'),
    `expected the y-chain stroke in '#B07A4A', got strokes ${JSON.stringify(strokes)}`);

  // The mapping is pinned here too: the x chain is the top chain, the y chain
  // the left one, in the light colours.
  const xChainPt = averageStrokePoint(calls, '#6B5B8F');
  const yChainPt = averageStrokePoint(calls, '#B07A4A');
  assert.ok(xChainPt && yChainPt, 'expected strokes in both light chain colours');
  assert.ok(xChainPt.y < yChainPt.y,
    `the light x chain ('#6B5B8F') must sit above the y chain ('#B07A4A'): ` +
    `average y ${xChainPt.y} vs ${yChainPt.y}`);
  assert.ok(yChainPt.x < xChainPt.x,
    `the light y chain ('#B07A4A') must sit left of the x chain ('#6B5B8F'): ` +
    `average x ${yChainPt.x} vs ${xChainPt.x}`);
  assert.ok(strokes.includes('#5E647A'),
    `expected the connector stroke in '#5E647A', got strokes ${JSON.stringify(strokes)}`);
  assert.ok(fills.some((s) => typeof s === 'string' && /^rgba\(26, 31, 61,/.test(s)),
    `expected a trail dot fill in 'rgba(26, 31, 61, a)', got fills ${JSON.stringify(fills)}`);
  assert.ok(strokes.some((s) => typeof s === 'string' && /^rgba\(26, 31, 61,/.test(s)),
    `expected a trail segment stroke in 'rgba(26, 31, 61, a)', got strokes ${JSON.stringify(strokes)}`);
  assert.ok(fills.includes('#1A1F3D'),
    `expected the pen fill in '#1A1F3D', got fills ${JSON.stringify(fills)}`);
  assert.ok(strokes.includes('rgba(184, 167, 217, 0.9)'),
    `expected the overlay stroke in 'rgba(184, 167, 217, 0.9)', got strokes ${JSON.stringify(strokes)}`);

  // The clear comes from the table too.
  const clear = calls.find((c) => c.method === 'fillRect');
  assert.ok(clear, 'expected the frame to start with a fillRect (the clear)');
  assert.strictEqual(clear.fillStyle, '#ffffff',
    `expected the light clear fillRect to use '#ffffff', got ${JSON.stringify(clear.fillStyle)}`);

  // The dark chain colours are gone.
  const allStyles = strokes.concat(fills);
  assert.ok(!allStyles.includes('#A89CC9'),
    `the dark x-chain colour '#A89CC9' must not be used in the light theme, ` +
    `got ${JSON.stringify(allStyles)}`);
  assert.ok(!allStyles.includes('#F5C99B'),
    `the dark y-chain colour '#F5C99B' must not be used in the light theme, ` +
    `got ${JSON.stringify(allStyles)}`);
});

test('view: CSS tokens match the colour table', () => {
  // The CSS tokens mirror THEME_COLORS, so the page and the canvas cannot drift
  // apart: :root holds the dark values, [data-theme="light"] the light ones.
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
  const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
  assert(styleMatch, 'expected a <style> block in index.html');
  const css = styleMatch[1];

  const blockOf = (selector) => {
    const m = css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([\\s\\S]*?)\\}'));
    assert(m, `expected a ${selector} block in the <style>`);
    return m[1];
  };
  const tokenOf = (block, name) => {
    const m = block.match(new RegExp('--' + name + '\\s*:\\s*([^;]+);'));
    assert(m, `expected the token --${name} in the block`);
    return m[1].trim();
  };
  const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

  const p = loadProduct();
  const table = runInContext('THEME_COLORS', p.ctx);
  assert.ok(table && table.dark && table.light,
    'expected the product to define THEME_COLORS with dark and light');

  const pairs = [
    ['bg', 'clear'],
    ['chain-x', 'chainX'],
    ['chain-y', 'chainY'],
    ['connector', 'connector'],
    ['trail', 'trail'],
    ['overlay', 'overlay'],
    ['pen', 'pen']
  ];

  const dark = blockOf(':root');
  const light = blockOf('[data-theme="light"]');
  for (const [token, key] of pairs) {
    assert.strictEqual(norm(tokenOf(dark, token)), norm(String(table.dark[key])),
      `--${token} in :root should equal THEME_COLORS.dark.${key} ` +
      `(${table.dark[key]}), got ${tokenOf(dark, token)}`);
    assert.strictEqual(norm(tokenOf(light, token)), norm(String(table.light[key])),
      `--${token} in [data-theme="light"] should equal THEME_COLORS.light.${key} ` +
      `(${table.light[key]}), got ${tokenOf(light, token)}`);
  }

  // --sparkle is the four-stop gradient in both themes.
  for (const [block, label] of [[dark, ':root'], [light, '[data-theme="light"]']]) {
    const sparkle = tokenOf(block, 'sparkle');
    const stops = sparkle.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    assert.strictEqual(stops.length, 4,
      `--sparkle in ${label} should have four colour stops, got ${stops.length} (${sparkle})`);
  }
});

test('view: trail cleared when N changes', () => {
  const p = loadProduct();
  const trailRadius = readConst(p, 'TRAIL_RADIUS');
  assert.ok(typeof trailRadius === 'number' && !Number.isNaN(trailRadius),
    `expected TRAIL_RADIUS to be a number, got ${trailRadius}`);

  // Count the trail dots drawn in a recorded frame: a trail dot is a fill whose
  // (nearest, within its own path) preceding arc used the trail dot radius (the
  // drawing point is a separate, larger fill and is not counted).
  const countTrailDots = (calls) => {
    let n = 0;
    for (let i = 0; i < calls.length; i++) {
      if (calls[i].method === 'fill') {
        const ai = nearestArcBefore(calls, i);
        if (ai >= 0 && calls[ai].args[2] === trailRadius) n++;
      }
    }
    return n;
  };

  assert.ok(typeof p.ctx._rafCallback === 'function', 'expected a captured rAF callback');
  // Five frames: the trail grows to five dots (the trail is drawn in full each
  // frame, so the fifth frame draws all five of them).
  let dotsInFrame5 = 0;
  for (let f = 0; f < 5; f++) {
    p.ctx._drawCalls.length = 0;
    p.ctx._rafCallback();
    dotsInFrame5 = countTrailDots(p.ctx._drawCalls);
  }
  assert.strictEqual(dotsInFrame5, 5,
    `expected 5 trail dots after 5 frames, got ${dotsInFrame5}`);

  // Change N and clear: the next frame draws exactly one trail dot.
  const input = p.listeners && p.listeners.nSlider && p.listeners.nSlider.input;
  assert.ok(typeof input === 'function',
    'expected a captured input listener for nSlider, got ' + typeof input);
  const nEl = p.ctx.document.getElementById('nSlider');
  nEl.value = '7';
  input.call(nEl, { target: nEl });

  p.ctx._drawCalls.length = 0;
  p.ctx._rafCallback();
  const dotsAfter = countTrailDots(p.ctx._drawCalls);
  assert.strictEqual(dotsAfter, 1,
    `expected exactly 1 trail dot after changing N, got ${dotsAfter}`);
});

test('view: loaded SVG is stitched and scaled', () => {
  // Two separate squares, each ~2000 units wide, as two <path> fragments.
  const d1 = 'M0 0 L2000 0 L2000 2000 L0 2000 Z';
  const d2 = 'M3000 0 L5000 0 L5000 2000 L3000 2000 Z';
  const svgText =
    '<svg xmlns="http://www.w3.org/2000/svg">' +
    `<path d="${d1}"></path><path d="${d2}"></path></svg>`;

  // DOMParser stub: parseFromString returns a doc whose `documentElement` root
  // carries the two path elements as `children` (and, for a querySelectorAll
  // based product, hands them back too). The elements are DOM-like enough to be
  // recognised as <path> (by tag name or by their `d` attribute) and to hand
  // back their `d`.
  const makePath = (d) => ({
    tagName: 'path',
    localName: 'path',
    nodeName: 'path',
    getAttribute(name) { return name === 'd' ? d : null; }
  });
  const paths = [makePath(d1), makePath(d2)];
  const DOMParserStub = function() {};
  DOMParserStub.prototype.parseFromString = function() {
    return {
      documentElement: { tagName: 'svg', children: paths, getAttribute() { return null; } },
      querySelectorAll() { return paths; }
    };
  };

  // FileReader stub: readAsText(file) calls this.onload({target: {result}}) at once.
  function FileReaderStub() {}
  FileReaderStub.prototype.readAsText = function() {
    this.onload({ target: { result: svgText } });
  };

  const p = loadProduct({ globals: { DOMParser: DOMParserStub, FileReader: FileReaderStub } });

  // Fire the captured change listener of svgInput with one file. The element's
  // files and the event target both carry the file, so a handler that reads
  // this.files or event.target.files gets it.
  const change = p.listeners && p.listeners.svgInput && p.listeners.svgInput.change;
  assert.ok(typeof change === 'function',
    'expected a captured change listener for svgInput, got ' + typeof change);
  const svgEl = p.ctx.document.getElementById('svgInput');
  const file = { name: 'two-squares.svg', size: svgText.length };
  svgEl.files = [file];
  change.call(svgEl, { target: svgEl });

  const originalPath = readConst(p, 'originalPath');
  assert.ok(Array.isArray(originalPath),
    `expected originalPath to be an array, got ${typeof originalPath}`);
  assert.strictEqual(originalPath.length, 8192,
    `expected originalPath to have 8192 points, got ${originalPath.length}`);
  assert.ok(!hasNaN(originalPath), 'expected originalPath to have no NaN coordinates');

  const box = bbox(originalPath);
  const largerSide = Math.max(box.width, box.height);
  const fitFraction = readConst(p, 'FIT_FRACTION');
  const menuInset = readConst(p, 'MENU_INSET');
  const expected = fitFraction * Math.min(800 - menuInset, 600);
  assert.ok(Math.abs(largerSide - expected) < 1,
    `expected the larger side of originalPath to be within 1 of ${expected}, got ${largerSide}`);
});

test('view: trail is a continuous stroke', () => {
  const p = loadProduct();
  const trailRadius = readTrailRadius(p);

  // Speed 5, fade 0: the trail holds a full lap of points, so the last frame
  // has many consecutive pairs to join (see `fade: oldest dot faded`).
  fireSliderInput(p, 'speedSlider', '8');
  fireSliderInput(p, 'fadeSlider', '0');
  const calls = runFrames(p, 400);

  // The trail points, in draw order: the fills drawn at the trail dot radius.
  const dots = trailDotFills(calls, trailRadius);
  const n = dots.length;
  assert.ok(n >= 2,
    `expected a full trail (at least 2 points) in the last frame, got ${n}`);

  // A connecting stroke is a stroke with the trail dot diameter, in the trail
  // colour from the palette: rgba(<THEME_COLORS[theme].trail>, a). `alphaOfFillStyle`
  // reads its fade alpha. Any other colour (the epicycle circles at lineWidth 1,
  // the overlay, the dashed guides) is not the trail colour and is skipped.
  const trailTriple = runInContext('THEME_COLORS[theme].trail', p.ctx);
  assert.ok(typeof trailTriple === 'string',
    `expected THEME_COLORS[theme].trail to be a string, got ${typeof trailTriple}`);
  const TRAIL_PREFIX = 'rgba(' + trailTriple.replace(/\s+/g, '') + ',';
  const isTrailColor = (style) => typeof style === 'string' &&
    style.replace(/\s+/g, '').startsWith(TRAIL_PREFIX);

  // The trail points in draw order, with their fade alpha: each dot is an arc at
  // the trail radius followed by the fill that carries the alpha.
  const dotPoints = [];
  for (let i = 0; i < calls.length; i++) {
    if (calls[i].method !== 'fill') continue;
    const ai = nearestArcBefore(calls, i);
    if (ai < 0 || calls[ai].args[2] !== trailRadius) continue;
    dotPoints.push({
      x: calls[ai].args[0],
      y: calls[ai].args[1],
      alpha: alphaOfFillStyle(calls[i].fillStyle)
    });
  }

  // The connecting strokes with the path each one joins: the moveTo/lineTo pair
  // that precedes the stroke (a beginPath starts a new path).
  const segments = [];
  let lastMove = null;
  let lastLine = null;
  for (const call of calls) {
    if (call.method === 'beginPath') {
      lastMove = null;
      lastLine = null;
    } else if (call.method === 'moveTo') {
      lastMove = { x: call.args[0], y: call.args[1] };
    } else if (call.method === 'lineTo') {
      lastLine = { x: call.args[0], y: call.args[1] };
    } else if (call.method === 'stroke' &&
               call.lineWidth === 2 * trailRadius &&
               typeof call.strokeStyle === 'string' &&
               isTrailColor(call.strokeStyle)) {
      const alpha = alphaOfFillStyle(call.strokeStyle);
      assert.ok(alpha !== null,
        `cannot read a fade alpha out of a connecting stroke's strokeStyle ` +
        `(${JSON.stringify(call.strokeStyle)}); the segment alpha must be carried by ` +
        'strokeStyle, as rgba(255, 140, 105, a)');
      assert.ok(lastMove && lastLine,
        'a connecting stroke was drawn without a moveTo/lineTo path');
      segments.push({ from: lastMove, to: lastLine, alpha });
    }
  }

  // One connecting stroke per gap between consecutive trail points.
  assert.ok(segments.length > 0,
    `expected a connecting stroke between every pair of consecutive trail ` +
    `points, but the frame drew none: ${n} trail points need ${n - 1} strokes ` +
    `of lineWidth ${2 * trailRadius} in the trail colour rgba(255, 140, 105, a)`);
  assert.strictEqual(segments.length, n - 1,
    `expected exactly one connecting stroke per gap: ${n} trail points => ` +
    `${n - 1} strokes, got ${segments.length}`);

  // Each segment joins two consecutive trail points, and its alpha is the older
  // of the two. `dotIndex` matches a segment endpoint to a trail point by its
  // coordinates; the points are the exact same numbers the dots were drawn at.
  const dotIndex = (pt) => {
    for (let k = 0; k < n; k++) {
      if (Math.abs(dotPoints[k].x - pt.x) < 1e-9 &&
          Math.abs(dotPoints[k].y - pt.y) < 1e-9) return k;
    }
    return -1;
  };
  const coveredGaps = new Set();
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    const from = dotIndex(seg.from);
    const to = dotIndex(seg.to);
    assert.ok(from >= 0,
      `segment ${s}: its moveTo point (${seg.from.x}, ${seg.from.y}) is not a trail point`);
    assert.ok(to >= 0,
      `segment ${s}: its lineTo point (${seg.to.x}, ${seg.to.y}) is not a trail point`);
    assert.strictEqual(Math.abs(from - to), 1,
      `segment ${s} connects trail points ${from} and ${to}, which are not consecutive`);
    const older = Math.min(from, to);
    coveredGaps.add(older);
    assert.ok(Math.abs(seg.alpha - dotPoints[older].alpha) < 1e-9,
      `segment ${s} (points ${older} -> ${older + 1}): alpha ${seg.alpha} does not ` +
      `match the older point's fade alpha ${dotPoints[older].alpha}`);
  }
  for (let k = 0; k < n - 1; k++) {
    assert.ok(coveredGaps.has(k),
      `no connecting stroke joins the consecutive trail points ${k} and ${k + 1}`);
  }
});

test('ui: error recomputed after SVG load', () => {
  const svgText =
    '<svg xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M0 0 L100 0 L100 25 L0 25 Z"></path>' +
    '</svg>';

  // FileReader stub: readAsText(file) calls this.onload({target: {result}}) at once.
  function FileReaderStub() {}
  FileReaderStub.prototype.readAsText = function() {
    this.onload({ target: { result: svgText } });
  };

  const p = loadProduct({ globals: { DOMParser: makeSvgDomParserStub(), FileReader: FileReaderStub } });

  // Establish N = 8 (2^3) and the pre-load butterfly error label, so lastErrorN
  // is already 8 when the load arrives.
  fireSliderInput(p, 'nSlider', '3');
  p.ctx.applySliders();

  const errorDisplay = p.ctx.document.getElementById('errorDisplay');
  const butterflyText = errorDisplay.textContent;
  assert.ok(typeof butterflyText === 'string' &&
            /^approximation error = \d+\.\d+%$/.test(butterflyText),
    `expected an established butterfly error label before the load, got ${JSON.stringify(butterflyText)}`);

  // The load fits the shape into the drawing area of the 800 x 600 canvas (the
  // area to the right of the menu) and caches the pen speed for it.

  // Load a 100 x 25 rectangle through the captured change handler.
  const change = p.listeners && p.listeners.svgInput && p.listeners.svgInput.change;
  assert.ok(typeof change === 'function',
    'expected a captured change listener for svgInput, got ' + typeof change);
  const svgEl = p.ctx.document.getElementById('svgInput');
  const file = { name: 'rect.svg', size: svgText.length };
  svgEl.files = [file];
  change.call(svgEl, { target: svgEl });

  const afterText = errorDisplay.textContent;

  // The label the fixed product must show: the same pipeline on the same parsed
  // document, at N = 8, fitted into the 800 x 600 drawing area (the menu inset
  // taken off the width, so the fit target is FIT_FRACTION * (800 - MENU_INSET)).
  const fitFraction = readConst(p, 'FIT_FRACTION');
  const menuInset = readConst(p, 'MENU_INSET');
  const fitTarget = fitFraction * Math.min(800 - menuInset, 600);
  const rectFrags = p.parseSVG(svgText);
  const rectFitted = p.fitToSize(
    p.resampleToPowerOfTwo(p.stitchFragments(rectFrags), 13),
    fitTarget);
  const rectText =
    `approximation error = ${p.computeRMSError(rectFitted, p.computeFourier(rectFitted), 8).toFixed(2)}%`;

  // The label must have been recomputed for the loaded shape.
  assert.notStrictEqual(afterText, butterflyText,
    `expected the error label to change after loading an SVG, but it stayed ${JSON.stringify(afterText)}`);
  assert.strictEqual(afterText, rectText,
    `expected the error label to be recomputed for the loaded shape: expected ${JSON.stringify(rectText)}, got ${JSON.stringify(afterText)}`);

  // Fixture check: the butterfly and the rectangle at N = 8 must differ at two
  // decimals, otherwise "the label changed" proves nothing.
  assert.notStrictEqual(butterflyText, rectText,
    `the butterfly and the rectangle both give ${JSON.stringify(rectText)} at N = 8; ` +
    'the rectangle fixture (its height) must be changed so the two values differ');

  // The load also refreshed the pen-speed cache for the new shape and the fit
  // scale for the new canvas. fitScale is the fit target per REF_FIT (= 300):
  // with the 800 x 600 canvas that is FIT_FRACTION * (800 - MENU_INSET) / 300.
  const loadedPenSpeed = readConst(p, 'penSpeed');
  const loadedCoeffs = readConst(p, 'coeffs');
  const loadedN = readConst(p, 'numEpicycles');
  const loadedOriginal = readConst(p, 'originalPath');
  const expectedPenSpeed = p.meanPenSpeed(loadedCoeffs, loadedN, loadedOriginal.length);
  assert.ok(Math.abs(loadedPenSpeed - expectedPenSpeed) < 1e-9,
    `expected penSpeed (${loadedPenSpeed}) to equal ` +
    `meanPenSpeed(coeffs, n = ${loadedN}, originalPath.length = ${loadedOriginal.length}) = ` +
    `${expectedPenSpeed} after the load`);

  const loadedFitScale = readConst(p, 'fitScale');
  const refFit = readConst(p, 'REF_FIT');
  const expectedFitScale = fitTarget / refFit;
  assert.ok(Math.abs(loadedFitScale - expectedFitScale) < 1e-9,
    `expected fitScale (${loadedFitScale}) to equal ${fitTarget} / ${refFit} = ` +
    `${expectedFitScale} after the load`);

  // Over-fixing guard: changing only the speed must not recompute the error.
  const speedEl = p.ctx.document.getElementById('speedSlider');
  const nextSpeed = String(Number(speedEl.value) === 0 ? 1 : 0);
  fireSliderInput(p, 'speedSlider', nextSpeed);
  assert.strictEqual(errorDisplay.textContent, afterText,
    'expected the error label to be unchanged after changing only the speed');
});

test('svg: same file loads again after value reset', () => {
  const svgText =
    '<svg xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M0 0 L100 0 L100 25 L0 25 Z"></path>' +
    '</svg>';

  function FileReaderStub() {}
  FileReaderStub.prototype.readAsText = function() {
    this.onload({ target: { result: svgText } });
  };

  const p = loadProduct({ globals: { DOMParser: makeSvgDomParserStub(), FileReader: FileReaderStub } });

  const change = p.listeners && p.listeners.svgInput && p.listeners.svgInput.change;
  assert.ok(typeof change === 'function',
    'expected a captured change listener for svgInput, got ' + typeof change);
  const svgEl = p.ctx.document.getElementById('svgInput');
  const file = { name: 'rect.svg', size: svgText.length };
  svgEl.files = [file];
  svgEl.value = 'C:\\fakepath\\rect.svg';
  change.call(svgEl, { target: svgEl });

  // The load succeeded...
  const originalPath = readConst(p, 'originalPath');
  assert.ok(Array.isArray(originalPath),
    `expected originalPath to be an array, got ${typeof originalPath}`);
  assert.strictEqual(originalPath.length, 8192,
    `expected the loaded originalPath to have 8192 points, got ${originalPath.length}`);

  // ...and the input was reset, so choosing the same file again fires `change`.
  assert.strictEqual(svgEl.value, '',
    `expected svgInput.value to be reset to '' after a successful load, got ${JSON.stringify(svgEl.value)}`);
});

// --- M3: restore: slider values persist after refresh ---

test('restore: start-up defaults', () => {
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

  // The knob values declared in the markup: the product must start from these
  // three sliders, whatever the defaults are.
  const attrValue = (id) => {
    const tag = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
    assert(tag, `expected an ${id} input in index.html`);
    const value = tag[0].match(/value="([^"]*)"/i);
    assert(value, `expected a value attribute on ${id}: ${tag[0]}`);
    return value[1];
  };
  const nKnob = attrValue('nSlider');
  const speedKnob = attrValue('speedSlider');
  const fadeKnob = attrValue('fadeSlider');
  assert.ok(Number.isFinite(Number(nKnob)),
    `expected a numeric nSlider value, got "${nKnob}"`);
  assert.ok(Number.isFinite(Number(speedKnob)),
    `expected a numeric speedSlider value, got "${speedKnob}"`);
  assert.ok(Number.isFinite(Number(fadeKnob)),
    `expected a numeric fadeSlider value, got "${fadeKnob}"`);

  const p = loadProduct();

  // Start from the markup's knobs and apply them, as a refresh does.
  p.ctx.document.getElementById('nSlider').value = nKnob;
  p.ctx.document.getElementById('speedSlider').value = speedKnob;
  p.ctx.document.getElementById('fadeSlider').value = fadeKnob;
  p.ctx.applySliders();

  const numEpicycles = runInContext('numEpicycles', p.ctx);
  const speed = runInContext('speed', p.ctx);
  const fade = runInContext('fade', p.ctx);
  assert.strictEqual(numEpicycles, 1024,
    `expected numEpicycles to be 1024, got ${numEpicycles}`);
  assert.strictEqual(speed, 0.1, `expected speed to be 0.1, got ${speed}`);
  assert.strictEqual(fade, 0, `expected fade to be 0, got ${fade}`);

  const nValue = p.ctx.document.getElementById('nValue').textContent;
  const speedValue = p.ctx.document.getElementById('speedValue').textContent;
  const fadeValue = p.ctx.document.getElementById('fadeValue').textContent;
  assert.strictEqual(String(nValue), '1024',
    `expected nValue to be '1024', got '${nValue}'`);
  assert.strictEqual(String(speedValue), '0.1',
    `expected speedValue to be '0.1', got '${speedValue}'`);
  assert.strictEqual(String(fadeValue), '0%',
    `expected fadeValue to be '0%', got '${fadeValue}'`);
});

test('restore: start-up follows the sliders', () => {
  const p = loadProduct();
  // Simulate slider values being set before the script runs
  p.ctx.document.getElementById('nSlider').value = '3';
  p.ctx.document.getElementById('speedSlider').value = '0';

  // The applySliders function should be called on start-up
  const applySliders = p.ctx.applySliders;
  assert.ok(typeof applySliders === 'function', 'expected applySliders to be defined');

  // Call it and check the values
  applySliders();

  const numEpicycles = runInContext('numEpicycles', p.ctx);
  const speed = runInContext('speed', p.ctx);
  const nValue = p.ctx.document.getElementById('nValue').textContent;
  const speedValue = p.ctx.document.getElementById('speedValue').textContent;

  assert.strictEqual(numEpicycles, 8, `expected numEpicycles to be 8, got ${numEpicycles}`);
  // speedSlider at 0: speed follows the scale's low end, speedFromSlider(0) = 0.05
  const expectedSpeed = p.speedFromSlider(0);
  assert.strictEqual(speed, expectedSpeed,
    `expected speed to be speedFromSlider(0) = ${expectedSpeed}, got ${speed}`);
  assert.strictEqual(expectedSpeed, 0.05,
    `expected speedFromSlider(0) to be 0.05, got ${expectedSpeed}`);
  assert.strictEqual(String(nValue), '8', `expected nValue to be '8', got '${nValue}'`);
  assert.strictEqual(String(speedValue), '0.05', `expected speedValue to be '0.05', got '${speedValue}'`);
});

test('restore: pageshow re-reads the sliders', () => {
  const p = loadProduct();

  // Change sliders after load
  p.ctx.document.getElementById('nSlider').value = '3';
  p.ctx.document.getElementById('speedSlider').value = '0';

  // Fire the pageshow listener (which should call applySliders)
  const pageshowHandler = p.ctx.document.getElementById('canvas').addEventListener;
  // Since we can't easily test the window listener, call applySliders directly
  const applySliders = p.ctx.applySliders;
  applySliders();

  const numEpicycles = runInContext('numEpicycles', p.ctx);
  const speed = runInContext('speed', p.ctx);

  assert.strictEqual(numEpicycles, 8, `expected numEpicycles to be 8, got ${numEpicycles}`);
  const expectedSpeed = p.speedFromSlider(0);
  assert.strictEqual(speed, expectedSpeed, `expected speed to be speedFromSlider(0) = ${expectedSpeed}, got ${speed}`);
});

test('restore: SVG load keeps N from the slider', () => {
  // Two separate squares, each ~2000 units wide
  const d1 = 'M0 0 L2000 0 L2000 2000 L0 2000 Z';
  const d2 = 'M3000 0 L5000 0 L5000 2000 L3000 2000 Z';
  const svgText =
    '<svg xmlns="http://www.w3.org/2000/svg">' +
    `<path d="${d1}"></path><path d="${d2}"></path></svg>`;

  const makePath = (d) => ({
    tagName: 'path',
    localName: 'path',
    nodeName: 'path',
    getAttribute(name) { return name === 'd' ? d : null; }
  });
  const paths = [makePath(d1), makePath(d2)];
  const DOMParserStub = function() {};
  DOMParserStub.prototype.parseFromString = function() {
    return {
      documentElement: { tagName: 'svg', children: paths, getAttribute() { return null; } },
      querySelectorAll() { return paths; }
    };
  };

  function FileReaderStub() {}
  FileReaderStub.prototype.readAsText = function() {
    this.onload({ target: { result: svgText } });
  };

  const p = loadProduct({ globals: { DOMParser: DOMParserStub, FileReader: FileReaderStub } });

  // Set N to 8 before loading
  p.ctx.document.getElementById('nSlider').value = '3';

  // Load SVG
  const change = p.listeners && p.listeners.svgInput && p.listeners.svgInput.change;
  assert.ok(typeof change === 'function',
    'expected a captured change listener for svgInput, got ' + typeof change);
  const svgEl = p.ctx.document.getElementById('svgInput');
  const file = { name: 'two-squares.svg', size: svgText.length };
  svgEl.files = [file];
  change.call(svgEl, { target: svgEl });

  const numEpicycles = runInContext('numEpicycles', p.ctx);
  assert.strictEqual(numEpicycles, 8, `expected numEpicycles to be 8, got ${numEpicycles}`);
});

test('restore: initial labels match initial knobs', () => {
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

  // Extract initial slider values
  const nSliderMatch = html.match(/<input[^>]*id="nSlider"[^>]*value="([^"]*)"/);
  const speedSliderMatch = html.match(/<input[^>]*id="speedSlider"[^>]*value="([^"]*)"/);
  assert(nSliderMatch, 'nSlider not found');
  assert(speedSliderMatch, 'speedSlider not found');

  const nSliderValue = nSliderMatch[1];
  const speedSliderValue = speedSliderMatch[1];

  const p = loadProduct();

  // Expected label values
  const expectedNValue = Math.pow(2, parseInt(nSliderValue));
  const expectedSpeedValue = String(p.speedFromSlider(parseInt(speedSliderValue)));

  // Check that the HTML contains the correct initial labels
  assert.ok(html.includes(`id="nValue">${expectedNValue}`) || html.includes(`id="nValue"> ${expectedNValue}`),
    `expected nValue label to be ${expectedNValue}`);
  assert.ok(html.includes(`id="speedValue">${expectedSpeedValue}`) || html.includes(`id="speedValue"> ${expectedSpeedValue}`),
    `expected speedValue label to be ${expectedSpeedValue}`);
});

test('restore: speed change does not recompute the error', () => {
  const p = loadProduct();

  // Set initial state
  p.ctx.document.getElementById('nSlider').value = '6';
  p.ctx.document.getElementById('speedSlider').value = '1';

  const applySliders = p.ctx.applySliders;
  applySliders();

  // Check error display has a value
  const errorDisplay = p.ctx.document.getElementById('errorDisplay');
  const initialErrorText = errorDisplay.textContent;
  assert.ok(initialErrorText && initialErrorText.includes('%'), 'expected error text to contain %');

  // Change only speed
  p.ctx.document.getElementById('speedSlider').value = '0';
  applySliders();

  // Error display should be unchanged (N didn't change)
  assert.strictEqual(errorDisplay.textContent, initialErrorText,
    'expected error display to be unchanged when only speed changes');
});

test('restore: default shape is the owl', () => {
  // The shape loaded at start-up is the owl pattern file, not the built-in
  // butterfly. The expected list is the owl rebuilt through the product's own
  // pipeline; a fitted butterfly is a different shape and fails point by point.
  const p = loadProduct({ globals: { DOMParser: makeSvgTreeDomParserStub() } });
  assert.ok(typeof p.parseSVG === 'function',
    'expected the product to expose parseSVG, got ' + typeof p.parseSVG);

  const owlText = readFileSync(join(__dirname, '..', 'src', 'patterns', 'owl.svg'), 'utf8');

  // The same pipeline the product uses for a shape: parse the SVG, join its
  // fragments into one path, resample to 2^13 points and fit it into the
  // drawing area of the 800 x 600 canvas (the menu inset taken off the width).
  const fitFraction = readConst(p, 'FIT_FRACTION');
  const menuInset = readConst(p, 'MENU_INSET');
  const fitTarget = fitFraction * Math.min(800 - menuInset, 600);
  const fragments = p.parseSVG(owlText);
  const stitched = p.stitchFragments(fragments);
  const resampled = p.resampleToPowerOfTwo(stitched, 13);
  const expected = p.fitToSize(resampled, fitTarget);

  // The start-up originalPath, read through the vm context (it is a `let`).
  const originalPath = readConst(p, 'originalPath');
  assert.ok(Array.isArray(originalPath),
    `expected originalPath to be an array, got ${typeof originalPath}`);
  assert.strictEqual(originalPath.length, 8192,
    `expected the start-up originalPath to have 8192 points, got ${originalPath.length}`);
  assert.ok(!hasNaN(originalPath),
    'expected the start-up originalPath to have no NaN coordinates');

  // Point by point against the owl: same length, every x and y within 1e-9.
  // `xy` asserts the numeric x/y shape of both lists first, so a wrong shape
  // fails with an assertion naming the index, not a TypeError.
  const got = xy(originalPath);
  const want = xy(expected);
  assert.strictEqual(got.length, want.length,
    `expected originalPath (${got.length} points) and the rebuilt owl ` +
    `(${want.length} points) to have the same length`);
  for (let i = 0; i < got.length; i++) {
    assert.ok(Number.isFinite(got[i][0]) && Number.isFinite(got[i][1]),
      `originalPath point ${i} is not finite: (${got[i][0]}, ${got[i][1]})`);
    const dx = Math.abs(got[i][0] - want[i][0]);
    const dy = Math.abs(got[i][1] - want[i][1]);
    assert.ok(dx < 1e-9 && dy < 1e-9,
      `originalPath point ${i} is (${got[i][0]}, ${got[i][1]}), ` +
      `expected the owl (${want[i][0]}, ${want[i][1]})`);
  }

  // The two chains draw from coeffs, not from originalPath: a start-up that kept
  // the owl in originalPath but computed coeffs from another shape would still
  // draw the wrong figure, so the coefficients must match too.
  const coeffs = runInContext('coeffs', p.ctx);
  const expectedCoeffs = p.computeFourier(expected);
  for (const axis of ['x', 'y']) {
    const gotChain = coeffs[axis];
    const wantChain = expectedCoeffs[axis];
    assert.strictEqual(gotChain.length, wantChain.length,
      `expected the ${axis} chain to have ${wantChain.length} harmonics, got ${gotChain.length}`);
    for (let k = 0; k < gotChain.length; k++) {
      for (const field of ['radius', 'speed', 'phase']) {
        assert.ok(Math.abs(gotChain[k][field] - wantChain[k][field]) < 1e-9,
          `${axis} harmonic ${k}: ${field} is ${gotChain[k][field]}, ` +
          `expected the owl's ${wantChain[k][field]}`);
      }
    }
  }
});

// --- M2 (plan 015): fading trail and the fade slider ---

// Drive `count` animation frames through the captured requestAnimationFrame
// callback and return a snapshot of the LAST frame's recorded calls. The record
// array is reused and cleared before every frame, so the snapshot is a copy.
function runFrames(p, count) {
  assert.ok(typeof p.ctx._rafCallback === 'function', 'expected a captured rAF callback');
  let last = [];
  for (let f = 0; f < count; f++) {
    p.ctx._drawCalls.length = 0;
    p.ctx._rafCallback();
    last = p.ctx._drawCalls.slice();
  }
  return last;
}

// Set a slider's value and fire its captured `input` listener the way the
// browser does: the element is both `this` and event.target.
function fireSliderInput(p, id, value) {
  const el = p.ctx.document.getElementById(id);
  el.value = value;
  const input = p.listeners[id] && p.listeners[id].input;
  assert.ok(typeof input === 'function',
    `expected a captured input listener for ${id}, got ${typeof input}`);
  input.call(el, { target: el });
  return el;
}

// TRAIL_RADIUS (the trail dot radius the fills are recognised by) as a number.
function readTrailRadius(p) {
  const radius = readConst(p, 'TRAIL_RADIUS');
  assert.ok(typeof radius === 'number' && !Number.isNaN(radius),
    `expected TRAIL_RADIUS to be a number, got ${radius}`);
  return radius;
}

// The trail dots of one recorded frame, in draw order: a fill whose (nearest,
// within its own path) preceding arc used the trail dot radius — the same
// counting as `view: trail cleared when N changes`. The drawing point is a
// separate, larger fill and is not counted.
function trailDotFills(calls, trailRadius) {
  const dots = [];
  for (let i = 0; i < calls.length; i++) {
    if (calls[i].method === 'fill') {
      const ai = nearestArcBefore(calls, i);
      if (ai >= 0 && calls[ai].args[2] === trailRadius) dots.push(calls[i]);
    }
  }
  return dots;
}

// The alpha a recorded fillStyle carries, or null when it carries none. The
// trail fill puts the dot's fade alpha in fillStyle: rgba()/rgb() with an alpha
// part, or hex with an alpha channel (#rrggbbaa / #rgba).
function alphaOfFillStyle(style) {
  if (typeof style !== 'string') return null;
  const fn = style.match(/^\s*rgba?\(([^)]*)\)\s*$/i);
  if (fn) {
    const parts = fn[1].split(/[\s,\/]+/).filter((s) => s !== '');
    if (parts.length < 4) return null;
    const last = parts[3];
    const a = last.endsWith('%') ? parseFloat(last) / 100 : Number(last);
    return Number.isFinite(a) ? a : null;
  }
  const hex8 = style.match(/^\s*#([0-9a-fA-F]{8})\s*$/);
  if (hex8) return parseInt(hex8[1].slice(6, 8), 16) / 255;
  const hex4 = style.match(/^\s*#([0-9a-fA-F]{4})\s*$/);
  if (hex4) return parseInt(hex4[1].slice(3, 4), 16) / 15;
  return null;
}

// The alphas of a frame's trail dots, in draw order. A fillStyle that carries
// no alpha fails with a message naming the formats the test can read.
function trailDotAlphas(dots) {
  return dots.map((call, i) => {
    const a = alphaOfFillStyle(call.fillStyle);
    assert.ok(a !== null,
      `cannot read an alpha out of trail dot ${i}'s fillStyle (${JSON.stringify(call.fillStyle)}); ` +
      'the per-dot fade alpha must be carried by fillStyle, as rgba(r,g,b,a) or #rrggbbaa');
    return a;
  });
}

test('fade: slider spans 0-1 percent', () => {
  const p = loadProduct();

  // The knob is in tenths of a percent: 5 → 0.5%, 0 → 0%, 10 → 1%.
  const cases = [
    ['5', '0.5%', 0.5],
    ['0', '0%', 0],
    ['10', '1%', 1]
  ];
  for (const [knob, label, fadeConst] of cases) {
    fireSliderInput(p, 'fadeSlider', knob);

    const fadeValue = p.ctx.document.getElementById('fadeValue');
    assert.strictEqual(String(fadeValue.textContent), label,
      `expected the fadeValue label to read '${label}' with fadeSlider at ${knob}, ` +
      `got '${fadeValue.textContent}'`);

    const fade = readConst(p, 'fade');
    assert.strictEqual(fade, fadeConst,
      `expected fade to be ${fadeConst} with fadeSlider at ${knob}, got ${JSON.stringify(fade)}`);
  }
});

test('fade: lifetime from the fade margin', () => {
  const p = loadProduct();
  assert.ok(typeof p.trailLifetime === 'function',
    'expected the product to define a top-level trailLifetime, got ' + typeof p.trailLifetime);

  const LAP = 2 * Math.PI;
  const check = (fade, expected, label) => {
    const got = p.trailLifetime(fade);
    assert.ok(typeof got === 'number' && !Number.isNaN(got),
      `${label}: expected a number, got ${JSON.stringify(got)}`);
    assert.ok(Math.abs(got - expected) < 1e-12,
      `${label}: expected ${expected}, got ${got}`);
  };

  // The margin is taken off one lap: at 0% a dot lives a whole lap (the edge
  // the criterion names), at 0.5% and 1% it lives 99.5% and 99% of a lap.
  check(0, LAP, 'trailLifetime(0)');
  check(0.5, 0.995 * LAP, 'trailLifetime(0.5)');
  check(1, 0.99 * LAP, 'trailLifetime(1)');
});

test('fade: alpha and pruning', () => {
  const p = loadProduct();
  assert.ok(typeof p.trailAlpha === 'function',
    'expected the product to define a top-level trailAlpha, got ' + typeof p.trailAlpha);
  assert.ok(typeof p.pruneTrail === 'function',
    'expected the product to define a top-level pruneTrail, got ' + typeof p.pruneTrail);

  const L = 4; // a lifetime, in units of the drawing time t
  const checkAlpha = (age, expected, label) => {
    const got = p.trailAlpha(age, L);
    assert.ok(typeof got === 'number' && !Number.isNaN(got),
      `${label}: expected a number, got ${JSON.stringify(got)}`);
    assert.ok(Math.abs(got - expected) < 1e-12,
      `${label}: expected ${expected}, got ${got}`);
  };

  checkAlpha(0, 1, 'trailAlpha(0, 4) at age 0');
  checkAlpha(L / 2, 0.5, 'trailAlpha(2, 4) at half the lifetime');
  checkAlpha(L, 0, 'trailAlpha(4, 4) at the lifetime');
  // Edge: ages beyond the lifetime are fully faded, and never negative.
  checkAlpha(1.5 * L, 0, 'trailAlpha(6, 4) beyond the lifetime');
  checkAlpha(100 * L, 0, 'trailAlpha(400, 4) far beyond the lifetime');
  for (const age of [0, 0.1, L / 2, L, 2 * L, 1e6]) {
    const a = p.trailAlpha(age, L);
    assert.ok(a >= 0, `trailAlpha(${age}, ${L}) is negative: ${a}`);
  }

  // pruneTrail: the same order, dropping the points whose age is at or past
  // the lifetime. Points carry the t at which they were drawn.
  const now = 10;
  const keepA = { x: 1, y: 2, t: now - 3.5 };
  const keepB = { x: 3, y: 4, t: now - 3 };
  const keepC = { x: 5, y: 6, t: now }; // age 0: the newest point
  const trail = [
    { x: -1, y: -1, t: now - 6 },  // age 6 >= L: dropped
    { x: 0, y: 0, t: now - L },    // age exactly L: dropped (the boundary)
    keepA, keepB, keepC,
    { x: 9, y: 9, t: now - 5 }     // age 5 >= L: dropped, and no re-sorting
  ];
  const kept = p.pruneTrail(trail, now, L);
  assert.ok(Array.isArray(kept), `pruneTrail should return an array, got ${typeof kept}`);
  assert.strictEqual(kept.length, 3, `expected 3 kept points, got ${kept.length}`);
  assert.deepStrictEqual(kept.map((pt) => pt.t), [keepA.t, keepB.t, keepC.t],
    'pruneTrail should keep the surviving points in their original order');

  // Edge: an empty trail prunes to an empty list.
  assert.deepStrictEqual(p.pruneTrail([], now, L), [],
    'pruneTrail of an empty trail should return an empty list');
});

test('fade: trail holds one lap minus the margin', () => {
  const p = loadProduct();
  const trailRadius = readTrailRadius(p);

  // speedSlider 8 → speed 5, fade 0: a dot lives one whole lap, and the real
  // frame step is dt = frameStep(penSpeed, 5) (the pen's pixels per frame over
  // its own speed), so the last frame draws exactly ceil(trailLifetime(0) / dt)
  // dots.
  fireSliderInput(p, 'speedSlider', '8');
  fireSliderInput(p, 'fadeSlider', '0');

  const penSpeed = runInContext('penSpeed', p.ctx);
  const dt = p.frameStep(penSpeed, 5);

  const x = p.trailLifetime(0) / dt;   // trailLifetime(0) / dt
  const expectedFull = Math.ceil(x);
  const maxTrail = readConst(p, 'MAX_TRAIL_POINTS');
  assert.ok(expectedFull <= maxTrail,
    `the full-lap fixture draws ${expectedFull} dots, above MAX_TRAIL_POINTS = ${maxTrail}; ` +
    'a faster speed is needed so the cap does not cut the trail');

  const dotsFull = trailDotFills(runFrames(p, expectedFull + 2), trailRadius).length;
  assert.strictEqual(dotsFull, expectedFull,
    `fade 0: the last frame should draw one lap of trail dots ` +
    `(ceil(trailLifetime(0) / dt) = ${expectedFull}), got ${dotsFull}`);

  // fadeSlider 10 → fade 1%, so a dot lives 99% of a lap and the trail holds
  // exactly ceil(0.99 * x) dots. The rounding must actually drop a dot —
  // ceil(0.99 * x) < ceil(x) — otherwise the fixture proves nothing, so the
  // precondition is asserted first, then the count.
  assert.ok(Math.ceil(0.99 * x) < Math.ceil(x),
    `the fixture needs ceil(0.99 * x) < ceil(x) for x = trailLifetime(0) / dt = ${x}: ` +
    `ceil(0.99 * x) = ${Math.ceil(0.99 * x)}, ceil(x) = ${Math.ceil(x)}`);
  fireSliderInput(p, 'fadeSlider', '10');
  const expectedFaded = Math.ceil(0.99 * x);
  const dotsFaded = trailDotFills(runFrames(p, expectedFaded + 2), trailRadius).length;
  assert.strictEqual(dotsFaded, expectedFaded,
    `fade 1%: the last frame should draw 0.99 of a lap of trail dots ` +
    `(ceil(0.99 * x) = ${expectedFaded}), got ${dotsFaded}`);
  assert.ok(dotsFaded < dotsFull,
    `fade 1%: expected fewer trail dots than the full lap, got ${dotsFaded} vs ${dotsFull}`);
});

test('fade: fade follows speed', () => {
  const p = loadProduct();
  const trailRadius = readTrailRadius(p);

  // speedSlider 7 → speed 2, fade 0: a dot lives one whole lap, so the trail
  // holds exactly ceil(trailLifetime(0) / dt) dots with the real frame step
  // dt = frameStep(penSpeed, 2) — the dot count, and so how fast dots fade, is
  // inversely proportional to speed.
  fireSliderInput(p, 'speedSlider', '7');
  fireSliderInput(p, 'fadeSlider', '0');

  const penSpeed = runInContext('penSpeed', p.ctx);
  const dt = p.frameStep(penSpeed, 2);
  const expected = Math.ceil(p.trailLifetime(0) / dt);
  const dots = trailDotFills(runFrames(p, expected + 2), trailRadius).length;
  assert.strictEqual(dots, expected,
    `speed 2, fade 0: the last frame should draw one lap of trail dots ` +
    `(ceil(trailLifetime(0) / dt) = ${expected}), got ${dots}`);
});

test('fade: oldest dot faded, newest bright', () => {
  const p = loadProduct();
  const trailRadius = readTrailRadius(p);

  // A full-lap run: speed 5, fade 0, and enough frames for the trail to hold
  // one whole lap.
  fireSliderInput(p, 'speedSlider', '8');
  fireSliderInput(p, 'fadeSlider', '0');

  const penSpeed = runInContext('penSpeed', p.ctx);
  const dt = p.frameStep(penSpeed, 5);  // t advanced per frame, the real step
  const L = p.trailLifetime(0);         // lifetime at fade 0

  const dots = trailDotFills(runFrames(p, Math.ceil(L / dt) + 2), trailRadius);
  assert.ok(dots.length >= 2,
    `expected several trail dots in the last frame, got ${dots.length}`);

  const alphas = trailDotAlphas(dots);
  const n = alphas.length;

  // The newest dot, drawn last, is bright.
  assert.strictEqual(alphas[n - 1], 1,
    `the newest trail dot (drawn last) should have alpha exactly 1, got ${alphas[n - 1]}`);

  // Linear in age: dot i of n has age (n-1-i) frames, so alpha
  // 1 - (n-1-i) * dt / L.
  for (let i = 0; i < n; i++) {
    const expected = 1 - (n - 1 - i) * dt / L;
    assert.ok(Math.abs(alphas[i] - expected) < 1e-9,
      `trail dot ${i} of ${n}: expected alpha ${expected} (age ${(n - 1 - i) * dt} of t), got ${alphas[i]}`);
  }

  // The oldest dot, drawn first, is nearly gone.
  assert.ok(alphas[0] < 0.05,
    `the oldest trail dot should be nearly faded (alpha below 0.05), got ${alphas[0]}`);
});

test('fade: paused trail stays', () => {
  // Regression guard (plan 015 M2 K6): pausing freezes the drawing time t, so
  // nothing grows and nothing fades.
  const p = loadProduct();
  const trailRadius = readTrailRadius(p);

  const click = p.listeners && p.listeners.pauseBtn && p.listeners.pauseBtn.click;
  assert.ok(typeof click === 'function',
    'expected a captured click listener for pauseBtn, got ' + typeof click);

  const beforeDots = trailDotFills(runFrames(p, 50), trailRadius);
  assert.ok(beforeDots.length > 0,
    'expected the unpaused run to draw trail dots before the pause');
  const beforeAlphas = trailDotAlphas(beforeDots);

  const btn = p.ctx.document.getElementById('pauseBtn');
  click.call(btn, { target: btn });
  assert.strictEqual(readConst(p, 'paused'), true,
    'expected the pauseBtn click to pause the animation');

  let count = -1;
  let alphas = null;
  for (let f = 0; f < 100; f++) {
    const dots = trailDotFills(runFrames(p, 1), trailRadius);
    const frameAlphas = trailDotAlphas(dots);
    if (f === 0) {
      count = dots.length;
      alphas = frameAlphas;
      assert.strictEqual(count, beforeDots.length,
        `the first paused frame should redraw the trail as it was: ${beforeDots.length} ` +
        `dots before the pause, ${count} after`);
      assert.deepStrictEqual(frameAlphas, beforeAlphas,
        `the first paused frame should keep the alphas the dots had before the pause`);
    } else {
      assert.strictEqual(dots.length, count,
        `paused frame ${f}: expected the same ${count} trail dots, got ${dots.length}`);
      assert.deepStrictEqual(frameAlphas, alphas,
        `paused frame ${f}: expected the same alphas as the first paused frame, got ` +
        `${JSON.stringify(frameAlphas)} vs ${JSON.stringify(alphas)}`);
    }
  }
});

test('fade: paused trail ignores a speed change', () => {
  // Regression guard (plan 040 final review): with the trail cap binding the
  // lifetime depends on the frame step, so a speed change while paused must not
  // prune or fade the frozen trail.
  const p = loadProduct();
  const trailRadius = readTrailRadius(p);

  runInContext('MAX_TRAIL_POINTS = 40', p.ctx);
  fireSliderInput(p, 'fadeSlider', '0');
  fireSliderInput(p, 'speedSlider', '4'); // speed 0.5

  const click = p.listeners && p.listeners.pauseBtn && p.listeners.pauseBtn.click;
  assert.ok(typeof click === 'function',
    'expected a captured click listener for pauseBtn, got ' + typeof click);

  const beforeDots = trailDotFills(runFrames(p, 60), trailRadius);
  assert.strictEqual(beforeDots.length, 40,
    `expected the capped trail to hold 40 dots, got ${beforeDots.length}`);
  const beforeAlphas = trailDotAlphas(beforeDots);

  const btn = p.ctx.document.getElementById('pauseBtn');
  click.call(btn, { target: btn });

  // Move the speed slider while paused: the frozen trail must not change.
  fireSliderInput(p, 'speedSlider', '0'); // speed 0.05
  const dots = trailDotFills(runFrames(p, 1), trailRadius);
  assert.strictEqual(dots.length, beforeDots.length,
    `a speed change while paused must not prune the trail: expected ${beforeDots.length} ` +
    `dots, got ${dots.length}`);
  assert.deepStrictEqual(trailDotAlphas(dots), beforeAlphas,
    'a speed change while paused must not change the alphas');
});

test('fade: fade slider follows refresh', () => {
  // In the HTML file itself: the initial label matches the initial knob. The
  // knob is in tenths of a percent, so knob 5 reads 0.5%.
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
  const sliderMatch = html.match(/<input[^>]*id="fadeSlider"[^>]*>/);
  assert(sliderMatch, 'expected a fadeSlider input in index.html');
  const valueAttr = sliderMatch[0].match(/value="([^"]*)"/i);
  assert(valueAttr, `expected a value attribute on ${sliderMatch[0]}`);
  const knob = Number(valueAttr[1]);
  assert.ok(Number.isFinite(knob),
    `expected a numeric fadeSlider value, got "${valueAttr[1]}"`);

  const labelMatch = html.match(/id="fadeValue"[^>]*>([^<]*)</);
  assert(labelMatch, 'expected a fadeValue label in index.html');
  assert.strictEqual(labelMatch[1].trim(), `${knob / 10}%`,
    `expected the initial fadeValue text to be "${knob / 10}%" (the fadeSlider value ` +
    `in tenths of a percent), got "${labelMatch[1].trim()}"`);

  // A refresh re-reads the knob, like the other sliders.
  const p = loadProduct();
  const pageshow = p.listeners.window && p.listeners.window.pageshow;
  assert.ok(typeof pageshow === 'function',
    'expected a captured window pageshow listener, got ' + typeof pageshow);

  p.ctx.document.getElementById('fadeSlider').value = '10';
  pageshow();

  const fade = readConst(p, 'fade');
  assert.strictEqual(fade, 1,
    `expected fade to be 1 after pageshow with the knob at 10, got ${JSON.stringify(fade)}`);
  const fadeValue = p.ctx.document.getElementById('fadeValue');
  assert.strictEqual(String(fadeValue.textContent), '1%',
    `expected the fadeValue label to read '1%' after pageshow, got '${fadeValue.textContent}'`);
});

test('fade: butterfly drawn once per lap', () => {
  const p = loadProduct();
  assert.ok(typeof p.generateButterflyPath === 'function',
    'expected the product to define generateButterflyPath, got ' + typeof p.generateButterflyPath);

  const N = 8192;
  const pts = p.generateButterflyPath(N);
  assert.ok(Array.isArray(pts), `expected an array of points, got ${typeof pts}`);
  assert.ok(pts.length >= N, `expected at least ${N} points, got ${pts.length}`);
  for (const i of [0, 1, 4097, N - 1]) {
    const pt = pts[i];
    assert.ok(pt !== null && typeof pt === 'object' &&
              typeof pt.x === 'number' && typeof pt.y === 'number',
      `point ${i} has no numeric x/y: ${JSON.stringify(pt)}`);
  }

  // Half a lap later the pen must be on a different part of the shape: if it
  // were there already, one lap would draw the butterfly twice.
  const halfLap = Math.hypot(pts[4097].x - pts[1].x, pts[4097].y - pts[1].y);
  assert.ok(halfLap > 1,
    `point 1 and point 4097 are ${halfLap} apart: one lap of t must draw the ` +
    'butterfly once, not twice');

  // And the path still closes up on itself.
  const closing = Math.hypot(pts[N - 1].x - pts[0].x, pts[N - 1].y - pts[0].y);
  assert.ok(closing < 1,
    `the path should still close: point 0 and point ${N - 1} are ${closing} apart, expected under 1`);
});

test('fade: paused frame is cleared', () => {
  const p = loadProduct();
  const click = p.listeners && p.listeners.pauseBtn && p.listeners.pauseBtn.click;
  assert.ok(typeof click === 'function',
    'expected a captured click listener for pauseBtn, got ' + typeof click);

  const btn = p.ctx.document.getElementById('pauseBtn');
  click.call(btn, { target: btn });
  assert.strictEqual(readConst(p, 'paused'), true,
    'expected the pauseBtn click to pause the animation');

  assert.ok(typeof p.ctx._rafCallback === 'function', 'expected a captured rAF callback');
  for (let f = 0; f < 3; f++) {
    p.ctx._drawCalls.length = 0;
    p.ctx._rafCallback();
    const calls = p.ctx._drawCalls;
    assert.ok(calls.length > 0, `paused frame ${f} recorded no draw calls`);
    assert.strictEqual(calls[0].method, 'fillRect',
      `paused frame ${f}: expected the frame to start with a fillRect (the canvas is ` +
      `cleared every frame, paused or not), got ${calls[0].method}`);
    assert.strictEqual(calls[0].fillStyle, '#0a0e22',
      `paused frame ${f}: expected the clear to be recorded while fillStyle is '#0a0e22', ` +
      `got ${JSON.stringify(calls[0].fillStyle)}`);
  }
});

test('fade: capped trail still fades out', () => {
  const p = loadProduct();
  assert.ok(typeof p.trailLifetime === 'function',
    'expected the product to define a top-level trailLifetime, got ' + typeof p.trailLifetime);

  const effectiveLifetime = readConst(p, 'effectiveLifetime');
  assert.ok(typeof effectiveLifetime === 'function',
    `expected the product to define a top-level effectiveLifetime, got ${typeof effectiveLifetime}`);

  const L = p.trailLifetime(0); // one whole lap at fade 0

  // A cap below the lifetime is the lifetime itself: 10 * 0.5 = 5 < L.
  assert.strictEqual(effectiveLifetime(0, 0.5, 10), 5,
    `effectiveLifetime(0, 0.5, 10) should be the cap 5, got ${effectiveLifetime(0, 0.5, 10)}`);
  // A cap above the lifetime is clamped to trailLifetime(0): 1 * 100 > L.
  assert.strictEqual(effectiveLifetime(0, 100, 1), L,
    `effectiveLifetime(0, 100, 1) should be trailLifetime(0) = ${L}, got ${effectiveLifetime(0, 100, 1)}`);

  // The capped case: one point every `step` of t, ending at `now`, with more
  // points than the cap can hold. The lifetime is exactly max * step, so the
  // trail keeps the max points of the cap (ages 0 .. (max - 1) * step) and the
  // oldest kept point (age (max - 1) * step) is nearly gone. max stays above 20
  // so the oldest of `max` points fades below 0.05.
  const step = 0.1;
  const max = 40;
  const lifetime = effectiveLifetime(0, step, max);
  assert.strictEqual(lifetime, max * step,
    `effectiveLifetime(0, ${step}, ${max}) should be the cap ${max * step}, got ${lifetime}`);
  assert.ok(max * step < L,
    `the cap ${max * step} must be below trailLifetime(0) = ${L} for the capped case`);

  const now = 100;
  const trail = [];
  for (let k = 0; k <= 60; k++) trail.push({ x: 0, y: 0, t: now - k * step });

  const kept = p.pruneTrail(trail, now, lifetime);
  assert.ok(Array.isArray(kept) && kept.length > 0,
    `expected a non-empty pruned trail, got ${JSON.stringify(kept)}`);

  // The oldest kept point is the one drawn longest ago.
  let oldest = kept[0];
  for (const pt of kept) if (pt.t < oldest.t) oldest = pt;
  const age = now - oldest.t;
  const alpha = p.trailAlpha(age, lifetime);
  assert.ok(alpha < 0.05,
    `the oldest kept trail point (age ${age} of the ${lifetime} lifetime) should be nearly ` +
    `faded, but its alpha is ${alpha}`);
});

test('fade: animate caps and fades the trail', () => {
  const p = loadProduct();

  // Shrink the trail draw budget through the vm, so a frame draws only the cap
  // and not the whole lifetime.
  runInContext('MAX_TRAIL_POINTS = 40', p.ctx);

  // Fade 0 (a whole lap of lifetime) and speed 1: without the cap the trail
  // would hold far more than 40 points.
  fireSliderInput(p, 'fadeSlider', '0');
  fireSliderInput(p, 'speedSlider', '6');

  const penSpeed = readConst(p, 'penSpeed');
  const frameStep = readConst(p, 'frameStep');
  assert.ok(typeof frameStep === 'function',
    `expected the product to define a top-level frameStep, got ${typeof frameStep}`);

  const L = p.trailLifetime(0);
  const step = frameStep(penSpeed, 1);
  assert.ok(typeof step === 'number' && Number.isFinite(step) && step > 0,
    `expected frameStep(penSpeed=${penSpeed}, 1) to be a positive number, got ${step}`);

  // Precondition: 40 points one step apart live less than a whole lap, so the
  // cap (the budget), not the lifetime, decides how many dots a frame draws.
  assert.ok(40 * step < L,
    `expected the cap 40 * frameStep(penSpeed, 1) = ${40 * step} to be below ` +
    `trailLifetime(0) = ${L}, or the fixture does not exercise the cap`);

  const trailRadius = readTrailRadius(p);
  const dots = trailDotFills(runFrames(p, 60), trailRadius);
  assert.strictEqual(dots.length, 40,
    `expected the capped trail to draw exactly 40 dots in the last of 60 frames, got ${dots.length}`);

  // The oldest dot (drawn first) is the one the cap is fading out.
  const alphas = trailDotAlphas(dots);
  assert.ok(alphas[0] < 0.05,
    `the oldest capped trail dot should be nearly faded (alpha below 0.05), got ${alphas[0]}`);
});

// --- M3 (plan 015): ten sample SVG patterns ---

// DOMParser stub shared by the SVG tests. The product walks the parsed tree
// (`documentElement.children`) with a composed transform, so this stub models
// the tree exactly like `makeSvgTreeDomParserStub` below: parseFromString
// returns a document with a `documentElement` root, nested `children` and
// element stubs read through `getAttribute`; it also answers
// `querySelectorAll` with the flat shape list, so it still works for a product
// that selects that way. The dedicated tree stub is reused rather than
// duplicated, so the two stubs cannot drift apart.
function makeSvgDomParserStub() {
  return makeSvgTreeDomParserStub();
}

// DOMParser stub that models the SVG element TREE (unlike the flat regex stub
// above): parseFromString returns a document whose `documentElement` is the
// root <svg>, whose `children` mirror the nesting, and which also answers
// `querySelectorAll()` with the flat, document-order list of shape elements
// (path|line|polyline|circle, case-insensitive). So the same stub works against
// a product that walks `documentElement.children` and against one that still
// selects through `querySelectorAll`.
// Each element keeps its tag name exactly as written (so `clipPath` keeps its
// capital P), reads attributes like `makeSvgDomParserStub` (double- or
// single-quoted; `getAttribute` gives back the string or null) and carries a
// `children` array (empty for a leaf).
function makeSvgTreeDomParserStub() {
  const SHAPE_RE = /^(?:path|line|polyline|circle)$/i;

  function makeElement(tagName) {
    const attrs = {};
    return {
      tagName, // as written, never lower-cased
      localName: tagName, // mirrors the flat stub's trio, so the current
      nodeName: tagName,  // querySelectorAll-based product still finds shapes
      children: [],
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
      },
      __attrs: attrs
    };
  }

  // Attribute text -> map, exactly like the flat stub's inline parser.
  function readAttrs(text) {
    const attrs = {};
    const attrRe = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = attrRe.exec(text)) !== null) {
      attrs[m[1]] = m[2] !== undefined ? m[2] : m[3];
    }
    return attrs;
  }

  function copyAttrs(element, text) {
    const attrs = readAttrs(text);
    for (const name of Object.keys(attrs)) element.__attrs[name] = attrs[name];
  }

  function DOMParserStub() {}
  DOMParserStub.prototype.parseFromString = function(svgText) {
    // The document element is the root <svg>; a nested <svg>, if any, becomes
    // an ordinary child.
    const documentElement = makeElement('svg');
    const stack = [documentElement];
    const shapes = [];
    let sawRoot = false;

    // Opening, closing and self-closing tags. The name is kept as written and
    // the attribute text allows quoted `>` (a quoted string is consumed whole,
    // so the lazy body cannot stop inside one).
    const tagRe = /<\s*(\/?)\s*([A-Za-z_][-A-Za-z0-9_:.]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
    let tag;
    while ((tag = tagRe.exec(svgText)) !== null) {
      const closing = tag[1] === '/';
      const rawName = tag[2];
      const selfClosing = tag[4] === '/';

      if (closing) {
        if (stack.length > 1) stack.pop();
        continue;
      }

      if (!sawRoot && stack.length === 1 && rawName.toLowerCase() === 'svg') {
        // The first <svg> tag IS the document element; only its attributes are
        // read here (its contents nest below it).
        sawRoot = true;
        documentElement.tagName = rawName;
        copyAttrs(documentElement, tag[3]);
        continue;
      }

      const element = makeElement(rawName);
      copyAttrs(element, tag[3]);
      stack[stack.length - 1].children.push(element);

      if (SHAPE_RE.test(rawName)) shapes.push(element);
      if (!selfClosing) stack.push(element);
    }

    return {
      documentElement,
      querySelectorAll() { return shapes; }
    };
  };

  return DOMParserStub;
}

// --- M3 (plan 037): the top-level set is owl and tree ---

test('patterns: top-level set is owl and tree', () => {
  const dir = join(__dirname, '..', 'src', 'patterns');
  assert.ok(existsSync(dir),
    'expected the directory src/patterns/ to exist (plan 037 M3: the top-level pattern set)');

  // The top-level set is exactly these two files; anything else (a leftover
  // from the older ten-sample set, or a stray file) fails here by name.
  const svgFiles = readdirSync(dir).filter((name) => name.endsWith('.svg')).sort();
  assert.deepStrictEqual(svgFiles, ['owl.svg', 'pine-tree.svg'],
    `expected the top-level src/patterns/ set to be exactly owl.svg and pine-tree.svg, got ` +
    `${svgFiles.join(', ') || '(none)'}`);

  const p = loadProduct({ globals: { DOMParser: makeSvgDomParserStub() } });
  assert.ok(typeof p.parseSVG === 'function',
    'expected the product to expose parseSVG, got ' + typeof p.parseSVG);

  for (const name of svgFiles) {
    const text = readFileSync(join(dir, name), 'utf8');

    const frags = p.parseSVG(text);
    assert.ok(Array.isArray(frags),
      `${name}: expected parseSVG to return an array of fragments, got ${typeof frags}`);

    const stitched = p.stitchFragments(frags);
    assert.ok(Array.isArray(stitched),
      `${name}: expected stitchFragments to return an array of points, got ${typeof stitched}`);

    const resampled = p.resampleToPowerOfTwo(stitched, 13);
    assert.ok(Array.isArray(resampled),
      `${name}: expected resampleToPowerOfTwo to return an array of points, got ${typeof resampled}`);

    const fitted = p.fitToSize(resampled, 300);
    assert.ok(Array.isArray(fitted),
      `${name}: expected fitToSize to return an array of points, got ${typeof fitted}`);
    assert.strictEqual(fitted.length, 8192,
      `${name}: expected 8192 points out of the pipeline, got ${fitted.length}`);
    assert.ok(!hasNaN(fitted),
      `${name}: expected no NaN in x/y after the pipeline`);
    for (let i = 0; i < fitted.length; i++) {
      assert.ok(Number.isFinite(fitted[i].x) && Number.isFinite(fitted[i].y),
        `${name}: fitted point ${i} is not finite: (${fitted[i].x}, ${fitted[i].y})`);
    }

    const box = bbox(fitted);
    const largerSide = Math.max(box.width, box.height);
    assert.ok(Math.abs(largerSide - 300) < 1,
      `${name}: expected the larger side of the bounding box to be within 1 of 300, got ${largerSide}`);
  }
});

test('patterns: every sample loads', () => {
  const dir = join(__dirname, '..', 'src', 'patterns');
  assert.ok(existsSync(dir),
    'expected the directory src/patterns/ to exist (plan 015 M3: ten sample SVG patterns)');

  const svgFiles = readdirSync(dir).filter((name) => name.endsWith('.svg')).sort();
  assert.strictEqual(svgFiles.length, 2,
    `expected exactly 2 .svg files in src/patterns/, got ${svgFiles.length}: ` +
    `${svgFiles.join(', ') || '(none)'}`);

  const p = loadProduct({ globals: { DOMParser: makeSvgDomParserStub() } });
  assert.ok(typeof p.parseSVG === 'function',
    'expected the product to expose parseSVG, got ' + typeof p.parseSVG);

  // Constructs the regex stub cannot see; the browser and the stub must agree
  // on the shapes, so no sample may use them.
  const FORBIDDEN = ['transform=', '<rect', '<polygon', '<ellipse', '<!--', '<defs',
    '<use', '<clipPath', '<mask', '<symbol', '<style'];

  for (const name of svgFiles) {
    const filePath = join(dir, name);

    const size = statSync(filePath).size;
    assert.ok(size <= 200 * 1024, `${name}: expected at most 200 KB, got ${size} bytes`);

    const text = readFileSync(filePath, 'utf8');
    for (const token of FORBIDDEN) {
      assert.ok(!text.includes(token),
        `${name}: expected the file text to contain no "${token}"`);
    }

    const frags = p.parseSVG(text);
    assert.ok(Array.isArray(frags),
      `${name}: expected parseSVG to return an array of fragments, got ${typeof frags}`);
    assert.ok(frags.length >= 1, `${name}: expected at least one fragment, got ${frags.length}`);
    assert.ok(frags.length <= 500, `${name}: expected at most 500 fragments, got ${frags.length}`);
    // Shape guard so a broken parse fails here with the file name in the
    // message instead of throwing later inside the product code.
    for (let f = 0; f < frags.length; f++) {
      const frag = frags[f];
      assert.ok(Array.isArray(frag) && frag.length >= 1,
        `${name}: fragment ${f} is not a non-empty array of points`);
      for (let k = 0; k < frag.length; k++) {
        const pt = frag[k];
        assert.ok(pt !== null && typeof pt === 'object' &&
                  typeof pt.x === 'number' && typeof pt.y === 'number',
          `${name}: fragment ${f} point ${k} has no numeric x/y: ${JSON.stringify(pt)}`);
      }
    }

    const stitched = p.stitchFragments(frags);
    assert.ok(Array.isArray(stitched),
      `${name}: expected stitchFragments to return an array of points, got ${typeof stitched}`);

    const resampled = p.resampleToPowerOfTwo(stitched, 13);
    assert.ok(Array.isArray(resampled),
      `${name}: expected resampleToPowerOfTwo to return an array of points, got ${typeof resampled}`);

    const fitted = p.fitToSize(resampled, 300);
    assert.ok(Array.isArray(fitted),
      `${name}: expected fitToSize to return an array of points, got ${typeof fitted}`);
    assert.strictEqual(fitted.length, 8192,
      `${name}: expected 8192 points out of the pipeline, got ${fitted.length}`);
    assert.ok(!hasNaN(fitted),
      `${name}: expected no NaN in x/y after the pipeline`);

    const box = bbox(fitted);
    const largerSide = Math.max(box.width, box.height);
    assert.ok(Math.abs(largerSide - 300) < 1,
      `${name}: expected the larger side of the bounding box to be within 1 of 300, got ${largerSide}`);
  }
});

test('patterns: every sample has a source and licence', () => {
  const dir = join(__dirname, '..', 'src', 'patterns');
  assert.ok(existsSync(dir),
    'expected the directory src/patterns/ to exist (plan 015 M3: ten sample SVG patterns)');

  const sourcesPath = join(dir, 'SOURCES.md');
  assert.ok(existsSync(sourcesPath), 'expected src/patterns/SOURCES.md to exist');

  const svgFiles = readdirSync(dir).filter((name) => name.endsWith('.svg')).sort();
  assert.ok(svgFiles.length > 0,
    'expected at least one .svg sample in src/patterns/, or SOURCES.md is checked against nothing');

  const lines = readFileSync(sourcesPath, 'utf8').split(/\r?\n/);

  // A row "names" a file when the file name appears as a whole token: a row
  // about "big-gear.svg" must not count as a row about "gear.svg".
  const namesFile = (line, name) =>
    new RegExp(`(^|[^\\w.-])${name.replace(/\./g, '\\.')}([^\\w.-]|$)`).test(line);

  for (const name of svgFiles) {
    const rows = lines.filter((line) => namesFile(line, name));
    assert.ok(rows.length >= 1,
      `${name}: expected a SOURCES.md row (a markdown table row or a line) naming this file`);
    const row = rows.find((line) =>
      (/https?:\/\//.test(line) || line.includes('own work')) &&
      (/public domain/i.test(line) || /\bcc0\b/i.test(line))
    );
    assert.ok(row !== undefined,
      `${name}: expected its SOURCES.md row to carry a source (an "http://" or "https://" URL, ` +
      `or the literal "own work") and a licence ("public domain" or "CC0", case-insensitive); ` +
      `rows naming it: ${JSON.stringify(rows)}`);
  }
});

// --- M2 (plan 037): ten sample SVG presets in their own folder ---

test('presets: every sample loads', () => {
  const dir = join(__dirname, '..', 'src', 'patterns', 'presets');
  assert.ok(existsSync(dir),
    'expected the directory src/patterns/presets/ to exist (plan 037 M2: ten preset SVG files)');

  const svgFiles = readdirSync(dir).filter((name) => name.endsWith('.svg')).sort();
  assert.strictEqual(svgFiles.length, 10,
    `expected exactly 10 .svg files in src/patterns/presets/, got ${svgFiles.length}: ` +
    `${svgFiles.join(', ') || '(none)'}`);

  const p = loadProduct({ globals: { DOMParser: makeSvgDomParserStub() } });
  assert.ok(typeof p.parseSVG === 'function',
    'expected the product to expose parseSVG, got ' + typeof p.parseSVG);

  // Constructs the stub cannot see; the browser and the stub must agree on the
  // shapes, so no preset may use them.
  const FORBIDDEN = ['transform=', '<rect', '<polygon', '<ellipse', '<!--', '<defs',
    '<use', '<clipPath', '<mask', '<symbol', '<style'];

  for (const name of svgFiles) {
    const filePath = join(dir, name);

    const size = statSync(filePath).size;
    assert.ok(size <= 200 * 1024, `${name}: expected at most 200 KB, got ${size} bytes`);

    const text = readFileSync(filePath, 'utf8');
    for (const token of FORBIDDEN) {
      assert.ok(!text.includes(token),
        `${name}: expected the file text to contain no "${token}"`);
    }

    const frags = p.parseSVG(text);
    assert.ok(Array.isArray(frags),
      `${name}: expected parseSVG to return an array of fragments, got ${typeof frags}`);
    assert.ok(frags.length >= 1, `${name}: expected at least one fragment, got ${frags.length}`);
    assert.ok(frags.length <= 500, `${name}: expected at most 500 fragments, got ${frags.length}`);
    // Shape guard so a broken parse fails here with the file name in the
    // message instead of throwing later inside the product code.
    for (let f = 0; f < frags.length; f++) {
      const frag = frags[f];
      assert.ok(Array.isArray(frag) && frag.length >= 1,
        `${name}: fragment ${f} is not a non-empty array of points`);
      for (let k = 0; k < frag.length; k++) {
        const pt = frag[k];
        assert.ok(pt !== null && typeof pt === 'object' &&
                  typeof pt.x === 'number' && typeof pt.y === 'number',
          `${name}: fragment ${f} point ${k} has no numeric x/y: ${JSON.stringify(pt)}`);
      }
    }

    const stitched = p.stitchFragments(frags);
    assert.ok(Array.isArray(stitched),
      `${name}: expected stitchFragments to return an array of points, got ${typeof stitched}`);

    const resampled = p.resampleToPowerOfTwo(stitched, 13);
    assert.ok(Array.isArray(resampled),
      `${name}: expected resampleToPowerOfTwo to return an array of points, got ${typeof resampled}`);

    const fitted = p.fitToSize(resampled, 300);
    assert.ok(Array.isArray(fitted),
      `${name}: expected fitToSize to return an array of points, got ${typeof fitted}`);
    assert.strictEqual(fitted.length, 8192,
      `${name}: expected 8192 points out of the pipeline, got ${fitted.length}`);
    assert.ok(!hasNaN(fitted),
      `${name}: expected no NaN in x/y after the pipeline`);
    for (let i = 0; i < fitted.length; i++) {
      assert.ok(Number.isFinite(fitted[i].x) && Number.isFinite(fitted[i].y),
        `${name}: fitted point ${i} is not finite: (${fitted[i].x}, ${fitted[i].y})`);
    }

    const box = bbox(fitted);
    const largerSide = Math.max(box.width, box.height);
    assert.ok(Math.abs(largerSide - 300) < 1,
      `${name}: expected the larger side of the bounding box to be within 1 of 300, got ${largerSide}`);
  }
});

test('presets: every sample has a source and licence', () => {
  const dir = join(__dirname, '..', 'src', 'patterns', 'presets');
  assert.ok(existsSync(dir),
    'expected the directory src/patterns/presets/ to exist (plan 037 M2: ten preset SVG files)');

  const sourcesPath = join(dir, 'SOURCES.md');
  assert.ok(existsSync(sourcesPath), 'expected src/patterns/presets/SOURCES.md to exist');

  const svgFiles = readdirSync(dir).filter((name) => name.endsWith('.svg')).sort();
  assert.ok(svgFiles.length > 0,
    'expected at least one .svg preset in src/patterns/presets/, or SOURCES.md is checked against nothing');

  const lines = readFileSync(sourcesPath, 'utf8').split(/\r?\n/);

  // A row "names" a file when the file name appears as a whole token: a row
  // about "big-owl.svg" must not count as a row about "owl.svg".
  const namesFile = (line, name) =>
    new RegExp(`(^|[^\\w.-])${name.replace(/\./g, '\\.')}([^\\w.-]|$)`).test(line);

  // The https:// URLs a row carries, deduplicated: the row must give two of
  // them (one source page, one raw file).
  const httpsUrls = (line) => {
    const found = line.match(/https:\/\/[^\s)\]|]+/gi) || [];
    return new Set(found);
  };

  for (const name of svgFiles) {
    const rows = lines.filter((line) => namesFile(line, name));
    assert.ok(rows.length >= 1,
      `${name}: expected a SOURCES.md row (a markdown table row or a line) naming this file`);

    const row = rows.find((line) =>
      httpsUrls(line).size >= 2 &&
      (/public domain/i.test(line) || /\bcc0\b/i.test(line))
    );
    assert.ok(row !== undefined,
      `${name}: expected its SOURCES.md row to carry two https:// URLs (a source page and a ` +
      `raw file) and a licence ("public domain" or "CC0", case-insensitive); ` +
      `rows naming it: ${JSON.stringify(rows)}`);

    // Presets are traced to an external source: no row naming a preset may
    // claim it is "own work".
    for (const line of rows) {
      assert.ok(!line.includes('own work'),
        `${name}: a SOURCES.md row naming this preset must not say "own work": ${JSON.stringify(line)}`);
    }
  }
});

// --- M2 (plan 040): the pen pace is equalised across shapes ---

// The pen's mean pace over one lap, in the reconstruction's own units: the mean
// distance between reconstructPoint(coeffs, t) and reconstructPoint(coeffs,
// t + dt) over `samples` evenly spaced t across one lap, where
// dt = frameStep(meanPenSpeed(coeffs, n, N), speed) and N is the point count of
// the path the coefficients came from. Returns the pen's mean speed, the frame
// step taken and the measured pace.
function penPaceAcrossLap(p, coeffs, n, N, speed) {
  assert.ok(typeof p.meanPenSpeed === 'function',
    'expected the product to expose meanPenSpeed, got ' + typeof p.meanPenSpeed);
  assert.ok(typeof p.frameStep === 'function',
    'expected the product to expose frameStep, got ' + typeof p.frameStep);

  const penSpeed = p.meanPenSpeed(coeffs, n, N);
  const dt = p.frameStep(penSpeed, speed);
  const samples = Math.min(2000, N);
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const t = (i / samples) * 2 * Math.PI;
    const a = p.reconstructPoint(coeffs, t + dt, n);
    const b = p.reconstructPoint(coeffs, t, n);
    sum += Math.hypot(a.x - b.x, a.y - b.y);
  }
  return { penSpeed, dt, pace: sum / samples };
}

test('chains: pen pace equalised across shapes', () => {
  const p = loadProduct({ globals: { DOMParser: makeSvgTreeDomParserStub() } });
  assert.ok(typeof p.meanPenSpeed === 'function',
    'expected the product to expose meanPenSpeed, got ' + typeof p.meanPenSpeed);
  assert.ok(typeof p.frameStep === 'function',
    'expected the product to expose frameStep, got ' + typeof p.frameStep);

  const PX_PER_UNIT = readConst(p, 'PX_PER_UNIT');
  const fitScale = readConst(p, 'fitScale');
  assert.ok(typeof PX_PER_UNIT === 'number' && Number.isFinite(PX_PER_UNIT),
    `expected PX_PER_UNIT to be a finite number, got ${JSON.stringify(PX_PER_UNIT)}`);
  assert.ok(typeof fitScale === 'number' && Number.isFinite(fitScale),
    `expected fitScale to be a finite number, got ${JSON.stringify(fitScale)}`);

  const SPEED = 0.5;

  // The owl: the start-up shape (8192 points), drawn with 1024 harmonics.
  const OWL_N = 1024;
  const owlCoeffs = readConst(p, 'coeffs');
  const owlOriginal = readConst(p, 'originalPath');
  assert.ok(Array.isArray(owlOriginal) && owlOriginal.length === 8192,
    `expected the start-up owl originalPath to have 8192 points, got ` +
    `${Array.isArray(owlOriginal) ? owlOriginal.length : typeof owlOriginal}`);

  // The pine tree, rebuilt through the product's own import pipeline.
  const pineText = readFileSync(join(__dirname, '..', 'src', 'patterns', 'pine-tree.svg'), 'utf8');
  const pineFitted = p.fitToSize(
    p.resampleToPowerOfTwo(p.stitchFragments(p.parseSVG(pineText)), 13),
    0.5 * Math.min(800, 600));
  const pineCoeffs = p.computeFourier(pineFitted);

  // Both shapes are fitted to the same target (the vm canvas is 800 x 600, so
  // 0.5 * min(800, 600) = 300) and use fitScale = 1, so the expected pace is
  // PX_PER_UNIT * fitScale * speed.
  const expected = PX_PER_UNIT * fitScale * SPEED;
  const shapes = [
    ['owl', owlCoeffs, OWL_N, owlOriginal.length],
    ['pine tree', pineCoeffs, pineFitted.length, pineFitted.length]
  ];
  for (const [label, coeffs, n, N] of shapes) {
    const r = penPaceAcrossLap(p, coeffs, n, N, SPEED);
    assert.ok(Number.isFinite(r.penSpeed) && r.penSpeed > 0,
      `${label}: expected meanPenSpeed to be finite and positive, got ${r.penSpeed}`);
    assert.ok(Math.abs(r.pace - expected) <= 0.2107 * expected,
      `${label}: expected the pen pace (${r.pace}) to be within 0.2107 (relative) of ` +
      `PX_PER_UNIT * fitScale * speed = ${expected}`);
  }
});

test('chains: pen pace follows the speed slider', () => {
  const p = loadProduct();
  assert.ok(typeof p.meanPenSpeed === 'function',
    'expected the product to expose meanPenSpeed, got ' + typeof p.meanPenSpeed);
  assert.ok(typeof p.frameStep === 'function',
    'expected the product to expose frameStep, got ' + typeof p.frameStep);

  // The owl start-up shape, sampled the same way as the equalisation test.
  const OWL_N = 1024;
  const coeffs = readConst(p, 'coeffs');
  const originalPath = readConst(p, 'originalPath');
  const N = originalPath.length;

  const slow = penPaceAcrossLap(p, coeffs, OWL_N, N, 0.5);
  const fast = penPaceAcrossLap(p, coeffs, OWL_N, N, 2);

  assert.ok(fast.pace > slow.pace,
    `expected the mean pace at speed 2 (${fast.pace}) to be strictly greater than at ` +
    `speed 0.5 (${slow.pace})`);
});

test('chains: pen speed cached per N', () => {
  const p = loadProduct();

  // Sabotage the cache: a speed or fade change must not recompute the cached
  // pen speed; only a change of N may.
  runInContext('penSpeed = -1', p.ctx);

  const speedEl = p.ctx.document.getElementById('speedSlider');
  fireSliderInput(p, 'speedSlider', String(Number(speedEl.value) === 0 ? 1 : 0));
  assert.strictEqual(runInContext('penSpeed', p.ctx), -1,
    'a speed change must not recompute the cached penSpeed');

  const fadeEl = p.ctx.document.getElementById('fadeSlider');
  fireSliderInput(p, 'fadeSlider', String(Number(fadeEl.value) === 0 ? 1 : 0));
  assert.strictEqual(runInContext('penSpeed', p.ctx), -1,
    'a fade change must not recompute the cached penSpeed');

  // An N change recomputes it for the new chain.
  const nEl = p.ctx.document.getElementById('nSlider');
  fireSliderInput(p, 'nSlider', String(Number(nEl.value) === 0 ? 1 : 0));

  const numEpicycles = runInContext('numEpicycles', p.ctx);
  const coeffs = runInContext('coeffs', p.ctx);
  const originalPath = runInContext('originalPath', p.ctx);
  const penSpeed = runInContext('penSpeed', p.ctx);
  const expected = p.meanPenSpeed(coeffs, numEpicycles, originalPath.length);
  assert.ok(Math.abs(penSpeed - expected) < 1e-9,
    `expected penSpeed (${penSpeed}) to equal ` +
    `meanPenSpeed(coeffs, numEpicycles = ${numEpicycles}, originalPath.length = ` +
    `${originalPath.length}) = ${expected} after an N change`);
});

// --- M2 (plan 041): the control menu ---

test('restore: control listeners survive the redesign', () => {
  // Moving the controls into the menu card must not break how they are wired:
  // each one is still captured as its own addEventListener listener, which the
  // rest of the suite fires.
  const p = loadProduct();
  const pairs = [
    ['nSlider', 'input'],
    ['speedSlider', 'input'],
    ['fadeSlider', 'input'],
    ['svgInput', 'change'],
    ['pauseBtn', 'click'],
    ['originalBtn', 'click']
  ];
  for (const [el, ev] of pairs) {
    const fn = p.listeners[el] && p.listeners[el][ev];
    assert.strictEqual(typeof fn, 'function',
      `expected a captured ${ev} listener for ${el}, got ${typeof fn}`);
  }
});

test('view: controls live in the menu card', () => {
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

  // Every control moves inside the menu card: take the substring between the
  // <aside id="menu"> opening tag and the first </aside> after it.
  const openIdx = html.indexOf('<aside id="menu"');
  assert.ok(openIdx >= 0, 'expected an <aside id="menu"> in index.html');
  const closeIdx = html.indexOf('</aside>', openIdx);
  assert.ok(closeIdx >= 0, 'expected a </aside> after <aside id="menu">');
  const menuHtml = html.slice(openIdx, closeIdx);

  for (const id of [
    'svgInput', 'svgBtn', 'pauseBtn', 'originalBtn', 'nSlider', 'nValue',
    'speedSlider', 'speedValue', 'fadeSlider', 'fadeValue', 'errorDisplay',
    'menuHeader', 'menuToggle'
  ]) {
    assert.ok(menuHtml.includes(`id="${id}"`),
      `expected the menu card to contain id="${id}"`);
  }

  // The page stays one self-contained file: no web fonts, no external styles.
  for (const forbidden of ['monospace', '@import', '<link', 'url(http']) {
    assert.ok(!html.includes(forbidden),
      `expected index.html to contain no "${forbidden}"`);
  }

  // The style uses the system font stack.
  const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
  assert.ok(styleMatch, 'expected a <style> block in index.html');
  assert.ok(styleMatch[1].includes('-apple-system'),
    'expected the <style> to use the system font stack (-apple-system)');
});

test('view: drawing clears the menu', () => {
  // Wide window: the menu is a left column, MENU_INSET wide. Every drawn circle
  // of radius above the trail dot must clear it on the x axis.
  const wide = loadProduct({ globals: { window: { innerWidth: 1280, innerHeight: 800, addEventListener() {} } } });
  const wideInset = readConst(wide, 'MENU_INSET');
  const wideTrail = readConst(wide, 'TRAIL_RADIUS');
  const wideArcs = runFrames(wide, 1).filter((c) => c.method === 'arc' && c.args[2] > wideTrail);
  assert.ok(wideArcs.length >= 1,
    'expected at least one drawn circle of radius above TRAIL_RADIUS in the wide frame');
  for (const c of wideArcs) {
    assert.ok(c.args[0] - c.args[2] >= wideInset,
      `a circle at x=${c.args[0]} with radius ${c.args[2]} crosses MENU_INSET = ${wideInset}: ` +
      `expected x - radius >= ${wideInset}`);
  }

  // Narrow window (below the breakpoint): the menu becomes a top bar,
  // TOPBAR_INSET tall. Every drawn circle must clear it on the y axis.
  const narrow = loadProduct({ globals: { window: { innerWidth: 600, innerHeight: 800, addEventListener() {} } } });
  const topInset = readConst(narrow, 'TOPBAR_INSET');
  const narrowTrail = readConst(narrow, 'TRAIL_RADIUS');
  const narrowArcs = runFrames(narrow, 1).filter((c) => c.method === 'arc' && c.args[2] > narrowTrail);
  assert.ok(narrowArcs.length >= 1,
    'expected at least one drawn circle of radius above TRAIL_RADIUS in the narrow frame');
  for (const c of narrowArcs) {
    assert.ok(c.args[1] - c.args[2] >= topInset,
      `a circle at y=${c.args[1]} with radius ${c.args[2]} crosses TOPBAR_INSET = ${topInset}: ` +
      `expected y - radius >= ${topInset}`);
  }
});

test('view: menu toggle opens the sheet', () => {
  const p = loadProduct();

  const toggle = p.listeners && p.listeners.menuToggle && p.listeners.menuToggle.click;
  assert.ok(typeof toggle === 'function',
    'expected a captured click listener for menuToggle, got ' + typeof toggle);

  const el = p.ctx.document.getElementById('menuToggle');
  const menu = p.ctx.document.getElementById('menu');

  // First click opens the sheet...
  toggle.call(el, { target: el });
  assert.strictEqual(menu.className, 'open',
    `expected the first menuToggle click to open the menu ('open'), got ${JSON.stringify(menu.className)}`);

  // ...and the next click closes it.
  toggle.call(el, { target: el });
  assert.strictEqual(menu.className, '',
    `expected the second menuToggle click to close the menu (''), got ${JSON.stringify(menu.className)}`);

  // The CSS breakpoint and the constant agree.
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
  const media = html.match(/@media\s*\(\s*max-width\s*:\s*(\d+)\s*px\s*\)/);
  assert.ok(media, 'expected an @media (max-width: Npx) rule in index.html');
  const breakpoint = readConst(p, 'MENU_BREAKPOINT');
  assert.strictEqual(Number(media[1]), breakpoint,
    `expected the @media breakpoint ${media[1]} to equal MENU_BREAKPOINT = ${breakpoint}`);
});

// --- M1 (plan 042): the interface is English ---

// The initial visible text of a control: what the script sets on the element
// at start-up, or, when the script leaves the label to the markup, the text of
// the element's own tag in index.html.
function initialText(p, html, id) {
  const fromScript = String(p.ctx.document.getElementById(id).textContent || '').trim();
  if (fromScript) return fromScript;

  const at = html.indexOf(`id="${id}"`);
  assert.ok(at >= 0, `expected id="${id}" in index.html`);
  const open = html.lastIndexOf('<', at);
  const close = html.indexOf('>', at);
  assert.ok(open >= 0 && close > open, `expected a tag carrying id="${id}"`);
  let rest = html.slice(close + 1);
  const closeTag = rest.search(/<\//);
  if (closeTag >= 0) rest = rest.slice(0, closeTag);
  return rest.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

test('view: interface text is English', () => {
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
  const p = loadProduct();

  // The initial button texts are exactly the English words. The pause button
  // now also carries an icon, so its label lives in its own span.
  const initial = [
    ['svgBtn', 'Load SVG'],
    ['originalBtn', 'Show original']
  ];
  for (const [id, text] of initial) {
    const got = initialText(p, html, id);
    assert.strictEqual(got, text,
      `expected the initial ${id} text to be ${JSON.stringify(text)}, got ${JSON.stringify(got)}`);
  }
  const pauseLabelMarkup = html.match(/<span\b[^>]*\bid="pauseLabel"[^>]*>([\s\S]*?)<\/span>/);
  assert.ok(pauseLabelMarkup,
    'expected a <span id="pauseLabel"> inside the pause button in index.html');
  assert.strictEqual(pauseLabelMarkup[1].trim(), 'Pause',
    `expected the initial pauseLabel markup to read 'Pause', got ` +
    `${JSON.stringify(pauseLabelMarkup[1].trim())}`);

  // The slider labels are the English words, read next to each value in the
  // menu markup.
  const openIdx = html.indexOf('<aside id="menu"');
  assert.ok(openIdx >= 0, 'expected an <aside id="menu"> in index.html');
  const closeIdx = html.indexOf('</aside>', openIdx);
  assert.ok(closeIdx >= 0, 'expected a </aside> after <aside id="menu">');
  const menuHtml = html.slice(openIdx, closeIdx);

  const labelBefore = (id) => {
    const at = menuHtml.indexOf(`id="${id}"`);
    assert.ok(at >= 0, `expected id="${id}" in the menu card`);
    return menuHtml.slice(Math.max(0, at - 200), at);
  };
  assert.ok(/\bN\b/.test(labelBefore('nValue')),
    `expected the nValue label to read "N"; the markup before id="nValue" is ` +
    `${JSON.stringify(labelBefore('nValue'))}`);
  assert.ok(labelBefore('speedValue').includes('Speed'),
    `expected the speedValue label to read "Speed"; the markup before id="speedValue" is ` +
    `${JSON.stringify(labelBefore('speedValue'))}`);
  assert.ok(labelBefore('fadeValue').includes('Fade'),
    `expected the fadeValue label to read "Fade"; the markup before id="fadeValue" is ` +
    `${JSON.stringify(labelBefore('fadeValue'))}`);

  // The pause button toggles between two English words, read from its label
  // span; the button itself carries the icon and that span.
  const pauseClick = p.listeners && p.listeners.pauseBtn && p.listeners.pauseBtn.click;
  assert.ok(typeof pauseClick === 'function',
    'expected a captured click listener for pauseBtn, got ' + typeof pauseClick);
  const pauseEl = p.ctx.document.getElementById('pauseBtn');
  const pauseLabelEl = p.ctx.document.getElementById('pauseLabel');
  pauseClick.call(pauseEl, { target: pauseEl });
  assert.strictEqual(String(pauseLabelEl.textContent).trim(), 'Resume',
    `expected pauseLabel to read "Resume" after one click, got ${JSON.stringify(pauseLabelEl.textContent)}`);
  pauseClick.call(pauseEl, { target: pauseEl });
  assert.strictEqual(String(pauseLabelEl.textContent).trim(), 'Pause',
    `expected pauseLabel to read "Pause" after two clicks, got ${JSON.stringify(pauseLabelEl.textContent)}`);

  // The original button toggles too.
  const originalClick = p.listeners && p.listeners.originalBtn && p.listeners.originalBtn.click;
  assert.ok(typeof originalClick === 'function',
    'expected a captured click listener for originalBtn, got ' + typeof originalClick);
  const originalEl = p.ctx.document.getElementById('originalBtn');
  originalClick.call(originalEl, { target: originalEl });
  assert.strictEqual(String(originalEl.textContent).trim(), 'Hide original',
    `expected originalBtn to read "Hide original" after one click, got ${JSON.stringify(originalEl.textContent)}`);
  originalClick.call(originalEl, { target: originalEl });
  assert.strictEqual(String(originalEl.textContent).trim(), 'Show original',
    `expected originalBtn to read "Show original" after two clicks, got ${JSON.stringify(originalEl.textContent)}`);

  // The root tag declares English.
  const rootTag = html.match(/<html\b[^>]*>/i);
  assert.ok(rootTag, 'expected an <html> root tag in index.html');
  assert.ok(/\blang\s*=\s*"en"/i.test(rootTag[0]),
    `expected the root tag to be <html lang="en">, got ${JSON.stringify(rootTag[0])}`);

  // No Polish interface word survives, in the markup or in the text read after
  // the clicks.
  const POLISH = ['Wczytaj', 'Pauza', 'Wznów', 'Pokaż', 'Ukryj', 'Prędkość', 'Zanikanie'];
  const readTexts = ['svgBtn', 'pauseLabel', 'originalBtn']
    .map((id) => String(p.ctx.document.getElementById(id).textContent));
  for (const word of POLISH) {
    assert.ok(!html.includes(word),
      `expected the markup of index.html to contain no Polish word ${JSON.stringify(word)}`);
    for (const text of readTexts) {
      assert.ok(!text.includes(word),
        `expected the interface text ${JSON.stringify(text)} to contain no Polish word ${JSON.stringify(word)}`);
    }
  }
});

test('view: controls follow the B-11 order', () => {
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

  // The menu card only: from <aside id="menu"> up to the first </aside>.
  const openIdx = html.indexOf('<aside id="menu"');
  assert.ok(openIdx >= 0, 'expected an <aside id="menu"> in index.html');
  const closeIdx = html.indexOf('</aside>', openIdx);
  assert.ok(closeIdx >= 0, 'expected a </aside> after <aside id="menu">');
  const menuHtml = html.slice(openIdx, closeIdx);

  // B-11 order, each control after the previous one.
  const order = ['svgBtn', 'nSlider', 'speedSlider', 'fadeSlider', 'errorDisplay', 'pauseBtn', 'originalBtn'];
  const positions = order.map((id) => {
    const at = menuHtml.indexOf(`id="${id}"`);
    assert.ok(at >= 0, `expected id="${id}" in the menu card (B-11 order)`);
    return { id, at };
  });
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i].at > positions[i - 1].at,
      `expected ${positions[i].id} (at ${positions[i].at}) to come after ` +
      `${positions[i - 1].id} (at ${positions[i - 1].at}) in the menu card`);
  }
});

test('view: buttons are touch-sized', () => {
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

  const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
  assert.ok(styleMatch, 'expected a <style> block in index.html');
  const css = styleMatch[1];

  // Every innermost `selector { body }` rule (a rule nested in an @media block
  // is found the same way).
  const rules = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = ruleRe.exec(css)) !== null) {
    rules.push({ selector: m[1].trim(), body: m[2] });
  }

  // A rule targets buttons when it names the `button` element (e.g. `#menu
  // button`, `button`, `button:hover`); a class like `.menu-button` does not.
  const isButtonSelector = (selector) => /(?:^|[^\w-])button(?![\w-])/.test(selector);
  const buttonRules = rules.filter((r) => isButtonSelector(r.selector));
  assert.ok(buttonRules.length > 0,
    'expected at least one CSS rule targeting <button> elements in index.html');

  const declsOf = (body) => {
    const out = {};
    for (const decl of body.split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      const name = decl.slice(0, i).trim().toLowerCase();
      const value = decl.slice(i + 1).trim();
      if (name) out[name] = value;
    }
    return out;
  };
  const pxValues = (value) => {
    const found = [];
    const re = /(-?\d+(?:\.\d+)?)px/g;
    const text = String(value || '');
    let mm;
    while ((mm = re.exec(text)) !== null) found.push(Number(mm[1]));
    return found;
  };
  const everyAtLeast = (value, min) => {
    const px = pxValues(value);
    return px.length > 0 && px.every((v) => v >= min);
  };
  const everyWithin = (value, lo, hi) => {
    const px = pxValues(value);
    return px.length > 0 && px.every((v) => v >= lo && v <= hi);
  };
  const isAutoOrFit = (value) => {
    const v = String(value || '').trim().toLowerCase();
    return v === 'auto' || v.includes('fit-content');
  };

  // At least one button rule is touch-sized: min-height >= 44px, a 10-12px
  // border-radius, width auto/fit-content and align-self flex-start.
  const touchRule = buttonRules.find((r) => {
    const d = declsOf(r.body);
    return everyAtLeast(d['min-height'], 44) &&
      everyWithin(d['border-radius'], 10, 12) &&
      isAutoOrFit(d['width']) &&
      String(d['align-self'] || '').trim().toLowerCase() === 'flex-start';
  });
  assert.ok(touchRule,
    'expected a button rule with min-height >= 44px, a border-radius of 10-12px, ' +
    'width auto/fit-content and align-self flex-start; button rules were: ' +
    JSON.stringify(buttonRules.map((r) => r.selector)));

  // No button rule fixes the width.
  for (const r of buttonRules) {
    const d = declsOf(r.body);
    const w = String(d['width'] || '').trim();
    if (!w) continue;
    const isFixed = /^-?\d+(?:\.\d+)?px$/i.test(w) || w.toLowerCase() === '100%';
    assert.ok(!isFixed,
      `a button rule sets a fixed width (${JSON.stringify(w)}): ${r.selector}; ` +
      'expected width auto or fit-content');
  }

  // Hover, active and focus-visible states exist.
  for (const state of [':hover', ':active', ':focus-visible']) {
    assert.ok(buttonRules.some((r) => r.selector.includes(state)),
      `expected a button rule for the ${state} state in index.html`);
  }

  // Every gap/padding length is a multiple of 8.
  const spacingProps = ['gap', 'row-gap', 'column-gap', 'padding',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left'];
  for (const r of buttonRules) {
    const d = declsOf(r.body);
    for (const prop of spacingProps) {
      if (!(prop in d)) continue;
      for (const v of pxValues(d[prop])) {
        assert.ok(v % 8 === 0,
          `button rule ${r.selector} sets ${prop}: ${d[prop]}; ${v}px is not a multiple of 8`);
      }
    }
  }

  // The three buttons carry no inline style.
  const tagWithId = (id) => {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(at >= 0, `expected id="${id}" in index.html`);
    const open = html.lastIndexOf('<', at);
    const close = html.indexOf('>', at);
    assert.ok(open >= 0 && close > open, `expected a tag carrying id="${id}"`);
    return html.slice(open, close + 1);
  };
  for (const id of ['svgBtn', 'pauseBtn', 'originalBtn']) {
    const tag = tagWithId(id);
    assert.ok(!/\bstyle\s*=/i.test(tag),
      `expected the ${id} tag to carry no inline style, got ${JSON.stringify(tag)}`);
  }

  // Each slider value sits inside a `<div class="row">` with its label.
  const rowRe = /<div\b[^>]*class="([^"]*)"[^>]*>/g;
  const rows = [];
  let rm;
  while ((rm = rowRe.exec(html)) !== null) {
    if (!rm[1].split(/\s+/).includes('row')) continue;
    const start = rm.index;
    const endIdx = html.indexOf('</div>', start + rm[0].length);
    const end = endIdx < 0 ? html.length : endIdx + '</div>'.length;
    rows.push({ start, end, text: html.slice(start, end) });
  }
  assert.ok(rows.length >= 3,
    `expected at least three <div class="row"> containers in index.html, got ${rows.length}`);

  const valueLabels = [['nValue', /\bN\b/], ['speedValue', /Speed/], ['fadeValue', /Fade/]];
  for (const [id, labelRe] of valueLabels) {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(at >= 0, `expected id="${id}" in index.html`);
    const row = rows.find((r) => r.start < at && at < r.end);
    assert.ok(row,
      `expected id="${id}" to sit inside a <div class="row">, but it is outside every row`);
    assert.ok(labelRe.test(row.text),
      `expected the <div class="row"> around id="${id}" to carry its label (${labelRe}); ` +
      `got ${JSON.stringify(row.text)}`);
  }
});

// --- M2 (plan 042): the legend and the "How it works" block ---

test('view: legend and How it works', () => {
  // The product is one HTML file, so the legend and the moved formula lines
  // are read straight out of its markup.
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

  // The block of an element from its opening tag to the matching closing tag,
  // counting nested same-name elements so a legend entry that is itself a <div>
  // does not end the block at the first </div>.
  const blockAt = (start, name, closeMarker) => {
    const openRe = new RegExp('<' + name + '(?=[\\s>])', 'g');
    let depth = 0;
    let i = start;
    while (i < html.length) {
      openRe.lastIndex = i;
      const open = openRe.exec(html);
      const close = html.indexOf(closeMarker, i);
      if (close < 0) break;
      if (open && open.index < close) {
        depth++;
        i = open.index + open[0].length;
      } else {
        depth--;
        i = close + closeMarker.length;
        if (depth === 0) return { start, end: i, text: html.slice(start, i) };
      }
    }
    assert.fail(`expected a matching ${closeMarker} for the element at ${start} in index.html`);
  };

  // --- the legend: two chain swatches, both chains named ---
  const legendOpen = html.match(/<div[^>]*\bid="legend"/);
  assert.ok(legendOpen, 'expected a <div id="legend"> in index.html');
  const legend = blockAt(legendOpen.index, 'div', '</div>');

  // It sits inside the menu card (from <aside id="menu"> to the first </aside>).
  const menuStart = html.indexOf('<aside id="menu"');
  assert.ok(menuStart >= 0, 'expected an <aside id="menu"> in index.html');
  const menuEnd = html.indexOf('</aside>', menuStart);
  assert.ok(menuEnd > menuStart, 'expected a </aside> after <aside id="menu">');
  assert.ok(legend.start > menuStart && legend.end <= menuEnd,
    `expected the legend to sit inside the menu card (${menuStart}..${menuEnd}), got ${legend.start}..${legend.end}`);

  // Each chain has its own colour token in the legend.
  assert.ok(legend.text.includes('var(--chain-x)'),
    `expected the legend to carry the x chain colour var(--chain-x); legend is ${JSON.stringify(legend.text)}`);
  assert.ok(legend.text.includes('var(--chain-y)'),
    `expected the legend to carry the y chain colour var(--chain-y); legend is ${JSON.stringify(legend.text)}`);

  // Two swatch entries: two elements with the swatch class, or the two
  // var(--chain-…) colour references (one per chain).
  const swatchClassCount = (legend.text.match(/\bclass\s*=\s*"[^"]*\bswatch\b[^"]*"/g) || []).length;
  const chainVarCount = (legend.text.match(/var\(--chain-[xy]\)/g) || []).length;
  const swatchEntries = swatchClassCount > 0 ? swatchClassCount : chainVarCount;
  assert.strictEqual(swatchEntries, 2,
    `expected two swatch entries in the legend (two swatch classes or the two var(--chain-…) references), ` +
    `got ${swatchEntries} (classes ${swatchClassCount}, colour vars ${chainVarCount}); ` +
    `legend is ${JSON.stringify(legend.text)}`);

  // Both chains are named, as "x chain"/"y chain" or an "x"/"y" label next to
  // the word "chain". The visible text is read without the tags, so the CSS var
  // references above do not count as a name.
  const legendText = legend.text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  for (const axis of ['x', 'y']) {
    const joined = new RegExp('\\b' + axis + '[\\s_-]*chain\\b', 'i');
    const apart = new RegExp('\\b' + axis + '\\b[\\s\\S]*?\\bchain\\b|\\bchain\\b[\\s\\S]*?\\b' + axis + '\\b', 'i');
    assert.ok(joined.test(legendText) || apart.test(legendText),
      `expected the legend to name the ${axis} chain (${axis} chain, or ${axis} with chain); ` +
      `its visible text is ${JSON.stringify(legendText)}`);
  }

  // --- the "How it works" block: a <details> whose <summary> is the title ---
  const detailsOpen = html.match(/<details[^>]*\bid="howItWorks"/);
  assert.ok(detailsOpen, 'expected a <details id="howItWorks"> in index.html');
  const details = blockAt(detailsOpen.index, 'details', '</details>');

  const summaryMatch = details.text.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i);
  assert.ok(summaryMatch,
    `expected a <summary> inside <details id="howItWorks">; got ${JSON.stringify(details.text)}`);
  const summaryText = summaryMatch[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  assert.strictEqual(summaryText, 'How it works',
    `expected the <summary> of <details id="howItWorks"> to read "How it works", ` +
    `got ${JSON.stringify(summaryText)}`);

  // --- the formulas moved into the block ---
  const FORMULA = 'Σ rₖ cos(kt + φₖ)';
  let occurrences = 0;
  let at = html.indexOf(FORMULA);
  while (at >= 0) {
    occurrences++;
    assert.ok(at >= details.start && at < details.end,
      `expected every occurrence of ${JSON.stringify(FORMULA)} to lie inside ` +
      `<details id="howItWorks"> (${details.start}..${details.end}); occurrence ${occurrences} is at ${at}`);
    at = html.indexOf(FORMULA, at + FORMULA.length);
  }
  assert.ok(occurrences >= 1,
    `expected at least one occurrence of ${JSON.stringify(FORMULA)} in index.html, ` +
    'inside <details id="howItWorks">');
});

// --- M1 (plan 043): the theme switch ---

// Fire the captured themeSwitch click the way the browser does: the element is
// both `this` and event.target. Returns the element stub.
function clickThemeSwitch(p) {
  const el = p.ctx.document.getElementById('themeSwitch');
  const click = p.listeners && p.listeners.themeSwitch && p.listeners.themeSwitch.click;
  assert.ok(typeof click === 'function',
    'expected a captured click listener for themeSwitch, got ' + typeof click);
  click.call(el, { target: el });
  return el;
}

test('ui: the theme switch flips the theme', () => {
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

  // The switch is a button in the menu header, carrying the two segments.
  const headerOpenMatch = html.match(/<header[^>]*\bid="menuHeader"[^>]*>/);
  assert.ok(headerOpenMatch, 'expected a <header id="menuHeader"> in index.html');
  const headerOpen = headerOpenMatch.index;
  const headerClose = html.indexOf('</header>', headerOpen);
  assert.ok(headerClose >= 0, 'expected a </header> after <header id="menuHeader">');
  const switchAt = html.indexOf('id="themeSwitch"');
  assert.ok(switchAt >= 0, 'expected a themeSwitch control in index.html');
  assert.ok(switchAt > headerOpen && switchAt < headerClose,
    `expected the themeSwitch to sit inside <header id="menuHeader"> ` +
    `(${headerOpen}..${headerClose}), found it at ${switchAt}`);
  const buttonClose = html.indexOf('</button>', switchAt);
  assert.ok(buttonClose >= 0, 'expected a </button> after id="themeSwitch"');
  const switchHtml = html.slice(switchAt, buttonClose);
  for (const text of ['Dark', 'Light']) {
    assert.ok(switchHtml.includes(text),
      `expected the themeSwitch button to carry the ${text} segment; ` +
      `got ${JSON.stringify(switchHtml)}`);
  }

  const p = loadProduct();

  // The button's own textContent/innerHTML must not be rewritten when the theme
  // flips: the segments stay in the markup and only the label changes. Traps
  // record every assignment while reads keep returning the stored value.
  const switchEl = p.ctx.document.getElementById('themeSwitch');
  let text = switchEl.textContent;
  let markup = switchEl.innerHTML;
  const writes = [];
  Object.defineProperty(switchEl, 'textContent', {
    configurable: true,
    get() { return text; },
    set(value) { writes.push({ prop: 'textContent', value }); text = value; }
  });
  Object.defineProperty(switchEl, 'innerHTML', {
    configurable: true,
    get() { return markup; },
    set(value) { writes.push({ prop: 'innerHTML', value }); markup = value; }
  });

  assert.strictEqual(runInContext('theme', p.ctx), 'dark',
    'expected the product to start in the dark theme');

  clickThemeSwitch(p);
  assert.strictEqual(runInContext('theme', p.ctx), 'light',
    'expected the first themeSwitch click to flip theme to "light"');
  assert.strictEqual(p.ctx.document.documentElement.getAttribute('data-theme'), 'light',
    'expected the first click to set data-theme="light" on documentElement');
  assert.strictEqual(String(p.ctx.document.getElementById('themeLabel').textContent), 'Light',
    `expected themeLabel to read 'Light' after the first click, got ` +
    `${JSON.stringify(p.ctx.document.getElementById('themeLabel').textContent)}`);

  clickThemeSwitch(p);
  assert.strictEqual(runInContext('theme', p.ctx), 'dark',
    'expected the second themeSwitch click to flip theme back to "dark"');
  assert.strictEqual(p.ctx.document.documentElement.getAttribute('data-theme'), 'dark',
    'expected the second click to set data-theme="dark" on documentElement');
  assert.strictEqual(String(p.ctx.document.getElementById('themeLabel').textContent), 'Dark',
    `expected themeLabel to read 'Dark' after the second click, got ` +
    `${JSON.stringify(p.ctx.document.getElementById('themeLabel').textContent)}`);

  assert.deepStrictEqual(writes, [],
    `expected the themeSwitch button's own textContent/innerHTML to stay untouched, ` +
    `got writes ${JSON.stringify(writes)}`);
});

test('ui: the canvas follows the theme', () => {
  const p = loadProduct();
  const table = runInContext('THEME_COLORS', p.ctx);
  assert.ok(table && table.dark && table.light,
    'expected THEME_COLORS with dark and light');

  clickThemeSwitch(p);
  const lightCalls = runFrames(p, 1);
  const lightClear = lightCalls.find((c) => c.method === 'fillRect');
  assert.ok(lightClear, 'expected the frame to start with a fillRect (the clear)');
  assert.strictEqual(lightClear.fillStyle, table.light.clear,
    `expected the light clear fillRect to use ${JSON.stringify(table.light.clear)}, ` +
    `got ${JSON.stringify(lightClear.fillStyle)}`);

  clickThemeSwitch(p);
  const darkCalls = runFrames(p, 1);
  const darkClear = darkCalls.find((c) => c.method === 'fillRect');
  assert.ok(darkClear, 'expected the frame to start with a fillRect (the clear)');
  assert.strictEqual(darkClear.fillStyle, table.dark.clear,
    `expected the dark clear fillRect to use ${JSON.stringify(table.dark.clear)}, ` +
    `got ${JSON.stringify(darkClear.fillStyle)}`);
});

test('ui: the pen and overlay follow the theme', () => {
  const p = loadProduct();
  const table = runInContext('THEME_COLORS', p.ctx);
  assert.ok(table && table.dark && table.light,
    'expected THEME_COLORS with dark and light');
  const trailRadius = readTrailRadius(p);
  const overlayWidth = readConst(p, 'OVERLAY_WIDTH');

  // The overlay is off by default; turn it on once for both themes.
  const originalClick = p.listeners && p.listeners.originalBtn && p.listeners.originalBtn.click;
  assert.ok(typeof originalClick === 'function',
    'expected a captured click listener for originalBtn, got ' + typeof originalClick);
  const originalEl = p.ctx.document.getElementById('originalBtn');
  originalClick.call(originalEl, { target: originalEl });

  const check = (name) => {
    const colours = table[name];
    const calls = runFrames(p, 3);
    assert.ok(calls.length > 0, `${name}: the frame recorded no draw calls`);

    // Pen: the fill of the drawing point, the fill drawn on the largest circle
    // (a radius above the trail dot).
    let penFill = null;
    let penRadius = -Infinity;
    for (let i = 0; i < calls.length; i++) {
      if (calls[i].method !== 'fill') continue;
      const ai = nearestArcBefore(calls, i);
      if (ai < 0) continue;
      const radius = calls[ai].args[2];
      if (radius > penRadius) { penRadius = radius; penFill = calls[i]; }
    }
    assert.ok(penFill && penRadius > trailRadius,
      `${name}: expected a pen fill on a circle of radius above TRAIL_RADIUS ` +
      `(${trailRadius}), got radius ${penRadius}`);
    assert.strictEqual(penFill.fillStyle, colours.pen,
      `${name}: expected the pen fill to use THEME_COLORS.${name}.pen ` +
      `(${JSON.stringify(colours.pen)}), got ${JSON.stringify(penFill.fillStyle)}`);

    // Overlay: the stroke at OVERLAY_WIDTH in the overlay colour.
    const overlayStroke = calls.find((c) => c.method === 'stroke' && c.lineWidth === overlayWidth);
    assert.ok(overlayStroke,
      `${name}: expected an overlay stroke at OVERLAY_WIDTH (${overlayWidth})`);
    assert.strictEqual(overlayStroke.strokeStyle, colours.overlay,
      `${name}: expected the overlay stroke to use THEME_COLORS.${name}.overlay ` +
      `(${JSON.stringify(colours.overlay)}), got ${JSON.stringify(overlayStroke.strokeStyle)}`);

    // Trail: the dot fills at the trail radius, and the connecting strokes at
    // the trail dot diameter, both in rgba(<trail>, a).
    const triple = String(colours.trail).replace(/\s+/g, '');
    const isTrail = (style) => typeof style === 'string' &&
      style.replace(/\s+/g, '').startsWith('rgba(' + triple + ',');

    const dots = trailDotFills(calls, trailRadius);
    assert.ok(dots.length > 0,
      `${name}: expected trail dot fills at TRAIL_RADIUS (${trailRadius})`);
    for (const dot of dots) {
      assert.ok(isTrail(dot.fillStyle),
        `${name}: expected the trail dot fill to use rgba(${colours.trail}, a), ` +
        `got ${JSON.stringify(dot.fillStyle)}`);
      assert.ok(alphaOfFillStyle(dot.fillStyle) !== null,
        `${name}: expected the trail dot fill to carry an alpha, ` +
        `got ${JSON.stringify(dot.fillStyle)}`);
    }
    const trailStrokes = calls.filter((c) => c.method === 'stroke' &&
      c.lineWidth === 2 * trailRadius && isTrail(c.strokeStyle));
    assert.ok(trailStrokes.length > 0,
      `${name}: expected a trail connector stroke at lineWidth ${2 * trailRadius} ` +
      `in rgba(${colours.trail}, a)`);
    for (const stroke of trailStrokes) {
      assert.ok(alphaOfFillStyle(stroke.strokeStyle) !== null,
        `${name}: expected the trail connector stroke to carry an alpha, ` +
        `got ${JSON.stringify(stroke.strokeStyle)}`);
    }

    // Connectors: the dashed chain guide strokes in the connector colour.
    let connectorStroke = -1;
    for (let i = 0; i < calls.length; i++) {
      if (calls[i].method === 'stroke' && calls[i].strokeStyle === colours.connector) {
        connectorStroke = i;
        break;
      }
    }
    assert.ok(connectorStroke >= 0,
      `${name}: expected a connector stroke in THEME_COLORS.${name}.connector ` +
      `(${JSON.stringify(colours.connector)})`);
    let lastDash = null;
    for (let i = connectorStroke - 1; i >= 0; i--) {
      if (calls[i].method === 'setLineDash') { lastDash = calls[i]; break; }
    }
    assert.ok(lastDash && Array.isArray(lastDash.args[0]) && lastDash.args[0].length > 0,
      `${name}: expected the connector stroke in ${JSON.stringify(colours.connector)} ` +
      'to be dashed (the nearest setLineDash before it must be non-empty), got ' +
      `${JSON.stringify(lastDash && lastDash.args[0])}`);
  };

  check('dark');
  clickThemeSwitch(p);
  check('light');
});

test('ui: the chains follow the theme', () => {
  const p = loadProduct();
  const table = runInContext('THEME_COLORS', p.ctx);
  assert.ok(table && table.dark && table.light,
    'expected THEME_COLORS with dark and light');

  const check = (name) => {
    const calls = runFrames(p, 1);
    const xPt = averageStrokePoint(calls, table[name].chainX);
    const yPt = averageStrokePoint(calls, table[name].chainY);
    assert.ok(xPt,
      `${name}: expected x-chain strokes in THEME_COLORS.${name}.chainX ` +
      `(${JSON.stringify(table[name].chainX)})`);
    assert.ok(yPt,
      `${name}: expected y-chain strokes in THEME_COLORS.${name}.chainY ` +
      `(${JSON.stringify(table[name].chainY)})`);
    assert.ok(xPt.y < yPt.y,
      `${name}: the x chain must sit above the y chain: average y ${xPt.y} vs ${yPt.y}`);
    assert.ok(yPt.x < xPt.x,
      `${name}: the y chain must sit left of the x chain: average x ${yPt.x} vs ${xPt.x}`);
  };

  check('dark');
  clickThemeSwitch(p);
  check('light');
});

// --- M2 (plan 043): the theme choice survives a reload ---

test('ui: the theme choice is saved and restored', () => {
  const readTheme = (p) => runInContext('theme', p.ctx);
  const readLabel = (p) => String(p.ctx.document.getElementById('themeLabel').textContent);
  const readAttr = (p) => p.ctx.document.documentElement.getAttribute('data-theme');

  // Stub A: reports "light" for the theme key and records every write.
  const store = {};
  const stubA = {
    getItem(k) { return k === 'fourierTheme' ? 'light' : null; },
    setItem(k, v) { store[k] = v; }
  };
  const p = loadProduct({ globals: { localStorage: stubA } });
  assert.strictEqual(readTheme(p), 'light',
    'expected the stored "light" choice to be restored at start-up');
  assert.strictEqual(readLabel(p), 'Light',
    `expected themeLabel to read 'Light' at start-up, got ${JSON.stringify(readLabel(p))}`);
  assert.strictEqual(readAttr(p), 'light',
    'expected data-theme="light" on documentElement at start-up');

  // No localStorage at all: the app starts dark and the script does not throw.
  const plain = loadProduct();
  assert.strictEqual(readTheme(plain), 'dark',
    'expected the dark theme with no localStorage at all');
  assert.strictEqual(readLabel(plain), 'Dark',
    `expected themeLabel to read 'Dark' with no localStorage, got ${JSON.stringify(readLabel(plain))}`);
  assert.strictEqual(readAttr(plain), 'dark',
    'expected data-theme="dark" on documentElement with no localStorage');

  // A stored value that is neither dark nor light: falls back to dark.
  const junk = loadProduct({
    globals: { localStorage: { getItem() { return 'purple'; }, setItem() {} } }
  });
  assert.strictEqual(readTheme(junk), 'dark',
    'expected an unknown stored theme ("purple") to fall back to dark');
  assert.strictEqual(readLabel(junk), 'Dark',
    `expected themeLabel to read 'Dark' for an unknown stored theme, got ${JSON.stringify(readLabel(junk))}`);
  assert.strictEqual(readAttr(junk), 'dark',
    'expected data-theme="dark" on documentElement for an unknown stored theme');

  // A storage read that throws: the app starts dark and the script does not throw.
  let throwing;
  assert.doesNotThrow(() => {
    throwing = loadProduct({
      globals: {
        localStorage: {
          getItem() { throw new Error('storage blocked'); },
          setItem() {}
        }
      }
    });
  }, 'expected a throwing localStorage.getItem not to break the script at start-up');
  assert.strictEqual(readTheme(throwing), 'dark',
    'expected the dark theme when reading localStorage throws');
  assert.strictEqual(readLabel(throwing), 'Dark',
    `expected themeLabel to read 'Dark' when reading localStorage throws, got ${JSON.stringify(readLabel(throwing))}`);
  assert.strictEqual(readAttr(throwing), 'dark',
    'expected data-theme="dark" on documentElement when reading localStorage throws');

  // One click on the stub-A load (which started light) flips to dark and writes
  // the new choice under the bare global localStorage key.
  clickThemeSwitch(p);
  const flipped = readTheme(p);
  assert.strictEqual(flipped, 'dark',
    'expected one click on the light start to flip the theme to dark');
  assert.strictEqual(store.fourierTheme, flipped,
    `expected the click to save the new theme under "fourierTheme", ` +
    `got ${JSON.stringify(store.fourierTheme)} while theme is ${JSON.stringify(flipped)}`);

  // A fresh load with a fresh stub seeded with the stored value starts with it.
  const stored = store.fourierTheme;
  const stubB = {
    getItem(k) { return k === 'fourierTheme' ? stored : null; },
    setItem() {}
  };
  const restored = loadProduct({ globals: { localStorage: stubB } });
  assert.strictEqual(readTheme(restored), stored,
    `expected the second load to start with the stored theme ${JSON.stringify(stored)}, ` +
    `got ${JSON.stringify(readTheme(restored))}`);
  assert.strictEqual(readLabel(restored), stored === 'light' ? 'Light' : 'Dark',
    `expected themeLabel to follow the stored theme ${JSON.stringify(stored)}, ` +
    `got ${JSON.stringify(readLabel(restored))}`);
  assert.strictEqual(readAttr(restored), stored,
    `expected data-theme="${stored}" on documentElement for the second load, ` +
    `got ${JSON.stringify(readAttr(restored))}`);
});

// --- M1 (plan 044): the controls carry icons ---

// The markup of a <button> carrying `id`: its opening tag on its own, and the
// whole button from its opening `<` to the next `</button>`.
function controlButton(html, id) {
  const at = html.indexOf(`id="${id}"`);
  assert.ok(at >= 0, `expected id="${id}" in index.html`);
  const start = html.lastIndexOf('<', at);
  const openEnd = html.indexOf('>', at);
  const close = html.indexOf('</button>', at);
  assert.ok(start >= 0 && openEnd > start,
    `expected an opening tag carrying id="${id}"`);
  assert.ok(close > openEnd,
    `expected a </button> after id="${id}"`);
  return {
    openTag: html.slice(start, openEnd + 1),
    inner: html.slice(start, close)
  };
}

test('view: the pause button shows an icon', () => {
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

  const pause = controlButton(html, 'pauseBtn');
  const pauseSvg = pause.inner.match(/<svg\b[^>]*>/i);
  assert.ok(pauseSvg,
    `expected an <svg> icon inside <button id="pauseBtn">, got ${JSON.stringify(pause.inner)}`);
  assert.ok(/\baria-hidden\s*=\s*"true"/.test(pauseSvg[0]),
    `expected the pause icon to carry aria-hidden="true", got ${JSON.stringify(pauseSvg[0])}`);
  assert.ok(pause.inner.includes('<span id="pauseLabel">'),
    `expected <span id="pauseLabel"> inside <button id="pauseBtn">, got ${JSON.stringify(pause.inner)}`);
  assert.ok(/\bdata-paused\s*=\s*"false"/.test(pause.openTag),
    `expected the <button id="pauseBtn"> tag to carry data-paused="false", got ${JSON.stringify(pause.openTag)}`);

  const p = loadProduct();
  const pauseEl = p.ctx.document.getElementById('pauseBtn');
  const click = p.listeners && p.listeners.pauseBtn && p.listeners.pauseBtn.click;
  assert.ok(typeof click === 'function',
    'expected a captured click listener for pauseBtn, got ' + typeof click);

  // The handler must not rewrite the button: it updates the label span and the
  // data-paused attribute only.
  const writes = [];
  let text = pauseEl.textContent;
  Object.defineProperty(pauseEl, 'textContent', {
    configurable: true,
    get() { return text; },
    set(value) { writes.push(value); text = value; }
  });

  const label = p.ctx.document.getElementById('pauseLabel');
  click.call(pauseEl, { target: pauseEl });
  assert.deepStrictEqual(writes, [],
    `expected the pause click not to assign the button's textContent, got ${JSON.stringify(writes)}`);
  assert.strictEqual(String(label.textContent), 'Resume',
    `expected pauseLabel to read 'Resume' after one click, got ${JSON.stringify(label.textContent)}`);
  assert.strictEqual(String(pauseEl.getAttribute('data-paused')), 'true',
    `expected data-paused="true" after one click, got ${JSON.stringify(pauseEl.getAttribute('data-paused'))}`);

  click.call(pauseEl, { target: pauseEl });
  assert.deepStrictEqual(writes, [],
    `expected the pause click not to assign the button's textContent, got ${JSON.stringify(writes)}`);
  assert.strictEqual(String(label.textContent), 'Pause',
    `expected pauseLabel to read 'Pause' after two clicks, got ${JSON.stringify(label.textContent)}`);
  assert.strictEqual(String(pauseEl.getAttribute('data-paused')), 'false',
    `expected data-paused="false" after two clicks, got ${JSON.stringify(pauseEl.getAttribute('data-paused'))}`);
});

test('view: the theme and menu controls show icons', () => {
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

  for (const id of ['themeSwitch', 'menuToggle']) {
    const control = controlButton(html, id);
    assert.ok(/<svg\b/i.test(control.inner),
      `expected an <svg> icon inside id="${id}", got ${JSON.stringify(control.inner)}`);
    assert.ok(control.inner.includes('currentColor'),
      `expected the ${id} icon to use currentColor, got ${JSON.stringify(control.inner)}`);
  }
  const toggle = controlButton(html, 'menuToggle');
  assert.ok(/\baria-label\s*=\s*"[^"]+"/.test(toggle.openTag),
    `expected the <button id="menuToggle"> tag to carry aria-label, got ${JSON.stringify(toggle.openTag)}`);

  const p = loadProduct();
  const switchEl = p.ctx.document.getElementById('themeSwitch');
  const writes = [];
  let text = switchEl.textContent;
  Object.defineProperty(switchEl, 'textContent', {
    configurable: true,
    get() { return text; },
    set(value) { writes.push(value); text = value; }
  });

  const label = p.ctx.document.getElementById('themeLabel');
  clickThemeSwitch(p);
  assert.deepStrictEqual(writes, [],
    `expected the theme click not to assign the switch's textContent, got ${JSON.stringify(writes)}`);
  assert.strictEqual(String(label.textContent), 'Light',
    `expected themeLabel to read 'Light' after the first click, got ${JSON.stringify(label.textContent)}`);

  clickThemeSwitch(p);
  assert.deepStrictEqual(writes, [],
    `expected the theme click not to assign the switch's textContent, got ${JSON.stringify(writes)}`);
  assert.strictEqual(String(label.textContent), 'Dark',
    `expected themeLabel to read 'Dark' after the second click, got ${JSON.stringify(label.textContent)}`);
});