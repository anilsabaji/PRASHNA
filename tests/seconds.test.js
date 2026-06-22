import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import vm from 'vm';
import { JSDOM } from 'jsdom';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let KPApp;

// ---------------------------------------------------------------------------
// Harness: load KPApp from the inline <script> via JSDOM + vm (mirrors the
// existing tests/catalog.test.js + tests/mooka.test.js bootstrap pattern).
// ---------------------------------------------------------------------------
function loadKPApp() {
  const htmlPath = path.resolve(__dirname, '..', 'kp-prashna.html');
  const html = fs.readFileSync(htmlPath, 'utf-8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('No <script> block found in HTML file');

  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost',
    runScripts: 'outside-only'
  });
  const win = dom.window;

  const storage = new Map();
  const localStorageStub = {
    getItem: (key) => storage.has(key) ? storage.get(key) : null,
    setItem: (key, val) => storage.set(key, String(val)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear()
  };

  const ctx = vm.createContext({
    window: null,
    document: win.document,
    navigator: win.navigator,
    localStorage: localStorageStub,
    Math: Math, Date: Date, JSON: JSON,
    parseInt: parseInt, parseFloat: parseFloat, console: console,
    Number: Number, String: String, Array: Array, Object: Object,
    Error: Error, TypeError: TypeError, RangeError: RangeError,
    isFinite: isFinite, isNaN: isNaN, Infinity: Infinity, NaN: NaN,
    undefined: undefined, RegExp: RegExp, Boolean: Boolean, Map: Map, Set: Set
  });
  ctx.window = ctx;

  const wrappedScript = `(function() {\n${match[1]}\n; return (typeof KPApp !== 'undefined') ? KPApp : null;\n})()`;
  const script = new vm.Script(wrappedScript);
  const result = script.runInContext(ctx);
  if (!result) throw new Error('KPApp namespace not initialized');
  return result;
}

beforeAll(() => {
  KPApp = loadKPApp();
});

// Fixed location used across the compute-pipeline tests (Mumbai, IST).
const LAT = 19.0760;
const LON = 72.8777;
const TZ = 5.5;
const DATE = '2024-03-21';

// ===========================================================================
// (a) validateInput accepts seconds and preserves the seconds string.
// ===========================================================================
describe('Seconds precision: validateInput', () => {
  it('accepts a time with seconds and preserves the full HH:MM:SS string', () => {
    const raw = {
      date: DATE, time: '14:30:45',
      lat: String(LAT), lon: String(LON), tz: String(TZ),
      category: 'health', questionId: '', horary: '', mode: 'manual'
    };
    const v = KPApp.ui.validateInput(raw);
    expect(v.ok).toBe(true);
    expect(v.value.time).toBe('14:30:45');
  });

  it('still accepts a time without seconds (HH:MM) for backward compatibility', () => {
    const raw = {
      date: DATE, time: '14:30',
      lat: String(LAT), lon: String(LON), tz: String(TZ),
      category: 'health', questionId: '', horary: '', mode: 'manual'
    };
    const v = KPApp.ui.validateInput(raw);
    expect(v.ok).toBe(true);
    expect(v.value.time).toBe('14:30');
  });

  it('mooka mode also preserves the seconds string', () => {
    const raw = {
      date: DATE, time: '09:05:07',
      lat: String(LAT), lon: String(LON), tz: String(TZ),
      place: 'Mumbai', mode: 'mooka'
    };
    const v = KPApp.ui.validateInput(raw);
    expect(v.ok).toBe(true);
    expect(v.value.time).toBe('09:05:07');
  });
});

// ===========================================================================
// (b) The compute pipeline reflects seconds: charts for the SAME date/place/tz
//     but times one minute apart at the second-level produce a different
//     ascendant longitude (proving seconds flow into the chart).
// ===========================================================================
describe('Seconds precision: compute pipeline', () => {
  function buildChartAt(time) {
    const jd = KPApp.astro.localToJD(DATE, time, TZ);
    const weekday = KPApp.astro.weekdayIndex(jd);
    return KPApp.kp.buildChart({
      jd, latitude: LAT, longitude: LON, timezone: TZ, weekday, mode: 'manual'
    });
  }

  it('ascendant longitude differs between 14:30:00 and 14:30:59', () => {
    const chartA = buildChartAt('14:30:00');
    const chartB = buildChartAt('14:30:59');
    expect(chartA.ascendant.longitude).not.toBe(chartB.ascendant.longitude);
  });

  it('Julian Day reflects the seconds difference within a minute', () => {
    const jdA = KPApp.astro.localToJD(DATE, '14:30:00', TZ);
    const jdB = KPApp.astro.localToJD(DATE, '14:30:59', TZ);
    expect(jdA).not.toBe(jdB);
    // 59 seconds in days.
    expect(jdB - jdA).toBeCloseTo(59 / 86400, 9);
  });

  it('ui.runAnalysis honours seconds end-to-end (different ascendant)', () => {
    const base = { date: DATE, lat: LAT, lon: LON, tz: TZ, category: 'health', questionId: '', horary: null, place: 'Mumbai', mode: 'manual' };
    const outA = KPApp.ui.runAnalysis({ ...base, time: '14:30:00' });
    const outB = KPApp.ui.runAnalysis({ ...base, time: '14:30:59' });
    expect(outA.chart.ascendant.longitude).not.toBe(outB.chart.ascendant.longitude);
  });
});

// ===========================================================================
// (c) JSDOM full-render: the rendered time inputs expose seconds (step="1")
//     and prefillNow fills HH:MM:SS on Mooka tab activation.
// ===========================================================================
describe('Seconds precision: rendered UI (JSDOM)', () => {
  let dom, doc, win;
  const FIXED_LAT = 12.9716;
  const FIXED_LON = 77.5946;

  beforeAll(async () => {
    const htmlPath = path.resolve(__dirname, '..', 'kp-prashna.html');
    const html = fs.readFileSync(htmlPath, 'utf-8');
    dom = new JSDOM(html, {
      url: 'http://localhost',
      runScripts: 'dangerously',
      pretendToBeVisual: true
    });
    win = dom.window;
    doc = win.document;
    win.Element.prototype.scrollIntoView = function () {};

    // Stub geolocation so the Mooka tab activation completes deterministically.
    Object.defineProperty(win.navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: function (success) {
          success({ coords: { latitude: FIXED_LAT, longitude: FIXED_LON } });
        }
      }
    });

    await new Promise(resolve => {
      if (doc.readyState === 'complete' || doc.readyState === 'interactive') resolve();
      else win.addEventListener('DOMContentLoaded', resolve);
      setTimeout(resolve, 200);
    });
  });

  it('the manual and mooka time inputs expose a seconds field (step="1")', () => {
    const manualTime = doc.getElementById('manual-time');
    expect(manualTime).toBeTruthy();
    expect(manualTime.getAttribute('type')).toBe('time');
    expect(manualTime.getAttribute('step')).toBe('1');

    const mookaTime = doc.getElementById('mooka-time');
    expect(mookaTime).toBeTruthy();
    expect(mookaTime.getAttribute('type')).toBe('time');
    expect(mookaTime.getAttribute('step')).toBe('1');
  });

  it('Mooka tab activation prefills the time with seconds (HH:MM:SS)', () => {
    doc.getElementById('tab-mooka').dispatchEvent(new win.Event('click'));
    expect(doc.getElementById('mooka-time').value).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});
