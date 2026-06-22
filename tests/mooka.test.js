import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import fc from 'fast-check';
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
// existing tests/catalog.test.js bootstrap pattern).
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

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------
function buildMookaChart(date, time, lat, lon, tz) {
  const jd = KPApp.astro.localToJD(date, time, tz);
  const weekday = KPApp.astro.weekdayIndex(jd);
  return KPApp.kp.buildChart({
    jd, latitude: lat, longitude: lon, timezone: tz, weekday, mode: 'mooka'
  });
}

function rawMomentArb() {
  const dateArb = fc.date({
    min: new Date('1950-01-01'), max: new Date('2050-12-31')
  }).map(d => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  });
  const timeArb = fc.tuple(
    fc.integer({ min: 0, max: 23 }),
    fc.integer({ min: 0, max: 59 })
  ).map(([h, m]) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  const latArb = fc.double({ min: -60, max: 60, noNaN: true, noDefaultInfinity: true });
  const lonArb = fc.double({ min: -170, max: 170, noNaN: true, noDefaultInfinity: true });
  const tzArb = fc.integer({ min: -12, max: 14 });
  return fc.record({ date: dateArb, time: timeArb, lat: latArb, lon: lonArb, tz: tzArb });
}

function makeMookaChartArb() {
  return rawMomentArb().map(m => {
    try { return buildMookaChart(m.date, m.time, m.lat, m.lon, m.tz); }
    catch (e) { return null; }
  }).filter(c => c !== null);
}

// ===========================================================================
describe('Mooka Prashna engine property tests (P1-P10)', () => {

  // Feature: mooka-prashna, Property 1: Same chart -> identical analysis output (determinism)
  it('P1: analyzeMookaPrashna is deterministic for a given chart', () => {
    fc.assert(fc.property(makeMookaChartArb(), (chart) => {
      const a = KPApp.interpret.analyzeMookaPrashna(chart);
      const b = KPApp.interpret.analyzeMookaPrashna(chart);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }), { numRuns: 60 });
  });

  // Feature: mooka-prashna, Property 2: Every candidate's houses subset of {1..12} and category in CATEGORY_HOUSES
  it('P2: candidate houses are a valid 1..12 subset mapping to real categories', () => {
    const keys = Object.keys(KPApp.interpret.CATEGORY_HOUSES);
    fc.assert(fc.property(makeMookaChartArb(), (chart) => {
      const r = KPApp.interpret.analyzeMookaPrashna(chart);
      r.candidates.forEach(k => {
        expect(keys).toContain(k.category);
        k.houses.forEach(h => {
          expect(Number.isInteger(h)).toBe(true);
          expect(h).toBeGreaterThanOrEqual(1);
          expect(h).toBeLessThanOrEqual(12);
        });
        expect(k.houses).toEqual(KPApp.interpret.CATEGORY_HOUSES[k.category]);
      });
    }), { numRuns: 60 });
  });

  // Feature: mooka-prashna, Property 3: Non-empty headline, >=1 candidate, non-empty KP/Hora, exact ATTRIBUTION
  it('P3: output is complete (headline, candidates, rationales, attribution)', () => {
    fc.assert(fc.property(makeMookaChartArb(), (chart) => {
      const r = KPApp.interpret.analyzeMookaPrashna(chart);
      expect(typeof r.headline).toBe('string');
      expect(r.headline.length).toBeGreaterThan(0);
      expect(r.candidates.length).toBeGreaterThanOrEqual(1);
      r.candidates.forEach(k => {
        expect(typeof k.kp).toBe('string');
        expect(k.kp.length).toBeGreaterThan(0);
        expect(typeof k.hora).toBe('string');
        expect(k.hora.length).toBeGreaterThan(0);
        expect(typeof k.label).toBe('string');
        expect(k.label.length).toBeGreaterThan(0);
      });
      expect(r.attribution).toBe(KPApp.ATTRIBUTION);
      expect(r.headline).toContain(r.candidates[0].label);
    }), { numRuns: 60 });
  });

  // Feature: mooka-prashna, Property 4: Confidences non-increasing, each in (0,1], sum <= 1+epsilon
  it('P4: confidences are sorted descending, in (0,1], and sum to <= 1', () => {
    fc.assert(fc.property(makeMookaChartArb(), (chart) => {
      const r = KPApp.interpret.analyzeMookaPrashna(chart);
      let sum = 0;
      for (let i = 0; i < r.candidates.length; i++) {
        const c = r.candidates[i].confidence;
        expect(c).toBeGreaterThan(0);
        expect(c).toBeLessThanOrEqual(1);
        if (i > 0) {
          expect(r.candidates[i - 1].confidence).toBeGreaterThanOrEqual(c);
        }
        sum += c;
      }
      expect(sum).toBeLessThanOrEqual(1 + 1e-9);
    }), { numRuns: 60 });
  });

  // Feature: mooka-prashna, Property 5: Every houseScore[1..12] is finite and >= 0
  it('P5: house scores are finite and non-negative for all 12 houses', () => {
    fc.assert(fc.property(makeMookaChartArb(), (chart) => {
      const r = KPApp.interpret.analyzeMookaPrashna(chart);
      for (let h = 1; h <= 12; h++) {
        expect(Number.isFinite(r.houseScores[h])).toBe(true);
        expect(r.houseScores[h]).toBeGreaterThanOrEqual(0);
      }
    }), { numRuns: 60 });
  });

  // Feature: mooka-prashna, Property 6: Analysis succeeds and is stable with I/O & nondeterminism stubbed to throw
  it('P6: no network / storage / time / randomness used during analysis', () => {
    fc.assert(fc.property(makeMookaChartArb(), (chart) => {
      const origFetch = globalThis.fetch;
      const origXHR = globalThis.XMLHttpRequest;
      const origRandom = Math.random;
      const origNow = Date.now;
      globalThis.fetch = () => { throw new Error('network forbidden'); };
      globalThis.XMLHttpRequest = function () { throw new Error('network forbidden'); };
      Math.random = () => { throw new Error('randomness forbidden'); };
      Date.now = () => { throw new Error('time forbidden'); };
      try {
        const a = KPApp.interpret.analyzeMookaPrashna(chart);
        const b = KPApp.interpret.analyzeMookaPrashna(chart);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      } finally {
        globalThis.fetch = origFetch;
        globalThis.XMLHttpRequest = origXHR;
        Math.random = origRandom;
        Date.now = origNow;
      }
    }), { numRuns: 40 });
  });

  // Feature: mooka-prashna, Property (purity): the chart is not mutated by analysis
  it('Purity: analyzeMookaPrashna does not mutate the chart', () => {
    fc.assert(fc.property(makeMookaChartArb(), (chart) => {
      const before = JSON.stringify(chart);
      KPApp.interpret.analyzeMookaPrashna(chart);
      expect(JSON.stringify(chart)).toBe(before);
    }), { numRuns: 40 });
  });

  // Feature: mooka-prashna, Property 9: ascSubLord / moon.house and all indicator houses are valid
  it('P9: indicator integrity (asc sub-lord, moon house, indicator houses)', () => {
    fc.assert(fc.property(makeMookaChartArb(), (chart) => {
      const r = KPApp.interpret.analyzeMookaPrashna(chart);
      const ind = r.indicators;
      expect(ind.ascSubLord).toBe(chart.ascendant.subLord);
      expect(Number.isInteger(ind.moon.house)).toBe(true);
      expect(ind.moon.house).toBeGreaterThanOrEqual(1);
      expect(ind.moon.house).toBeLessThanOrEqual(12);
      const allHouseLists = [
        ind.ascSubLordHouses, ind.moon.starLordHouses,
        ind.moon.subLordHouses, ind.rulingSignifiedHouses
      ];
      allHouseLists.forEach(list => {
        list.forEach(h => {
          expect(Number.isInteger(h)).toBe(true);
          expect(h).toBeGreaterThanOrEqual(1);
          expect(h).toBeLessThanOrEqual(12);
        });
      });
    }), { numRuns: 60 });
  });

  // Feature: mooka-prashna, Property 10: candidate planets are real bodies that signify a candidate house
  it('P10: candidate planets are real bodies signifying at least one candidate house', () => {
    fc.assert(fc.property(makeMookaChartArb(), (chart) => {
      const r = KPApp.interpret.analyzeMookaPrashna(chart);
      r.candidates.forEach(k => {
        k.planets.forEach(p => {
          expect(KPApp.kp.BODIES).toContain(p);
          const signifiesSome = k.houses.some(h => (chart.significators[h] || []).indexOf(p) >= 0);
          expect(signifiesSome).toBe(true);
        });
      });
    }), { numRuns: 60 });
  });

  // Feature: mooka-prashna, error handling: a malformed chart throws a descriptive error
  it('throws a descriptive error when the chart lacks significators/ruling planets', () => {
    expect(() => KPApp.interpret.analyzeMookaPrashna({})).toThrow(/built chart/i);
    expect(() => KPApp.interpret.analyzeMookaPrashna(null)).toThrow(/built chart/i);
  });
});

// ===========================================================================
describe('Mooka Prashna validation (P7)', () => {
  // Feature: mooka-prashna, Property 7: Mooka mode accepts no-question/no-category but rejects bad moments
  it('P7: mooka mode accepts a valid moment with no question/category', () => {
    fc.assert(fc.property(rawMomentArb(), (m) => {
      const raw = {
        date: m.date, time: m.time,
        lat: String(m.lat), lon: String(m.lon), tz: String(m.tz),
        place: 'Somewhere', mode: 'mooka'
      };
      const v = KPApp.ui.validateInput(raw);
      expect(v.ok).toBe(true);
      expect(v.value.category).toBe('');
      expect(v.value.questionId).toBe('');
      expect(v.value.mode).toBe('mooka');
    }), { numRuns: 60 });
  });

  it('P7: mooka mode rejects an invalid date', () => {
    const v = KPApp.ui.validateInput({ date: 'not-a-date', time: '14:30', lat: '19', lon: '72', tz: '5.5', mode: 'mooka' });
    expect(v.ok).toBe(false);
    expect(typeof v.message).toBe('string');
  });

  it('P7: mooka mode rejects an invalid time', () => {
    const v = KPApp.ui.validateInput({ date: '2024-03-21', time: 'noon', lat: '19', lon: '72', tz: '5.5', mode: 'mooka' });
    expect(v.ok).toBe(false);
  });

  it('P7: mooka mode rejects latitude outside -90..90', () => {
    const v = KPApp.ui.validateInput({ date: '2024-03-21', time: '14:30', lat: '120', lon: '72', tz: '5.5', mode: 'mooka' });
    expect(v.ok).toBe(false);
  });

  it('P7: mooka mode rejects longitude outside -180..180', () => {
    const v = KPApp.ui.validateInput({ date: '2024-03-21', time: '14:30', lat: '19', lon: '999', tz: '5.5', mode: 'mooka' });
    expect(v.ok).toBe(false);
  });

  it('P7: mooka mode rejects a non-numeric timezone', () => {
    const v = KPApp.ui.validateInput({ date: '2024-03-21', time: '14:30', lat: '19', lon: '72', tz: 'abc', mode: 'mooka' });
    expect(v.ok).toBe(false);
  });

  it('P7: non-mooka mode still requires a question or category', () => {
    const v = KPApp.ui.validateInput({ date: '2024-03-21', time: '14:30', lat: '19', lon: '72', tz: '5.5', mode: 'manual' });
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/question|category/i);
  });
});

// ===========================================================================
describe('Mooka Prashna additivity / backward compatibility (P8)', () => {
  // Feature: mooka-prashna, Property 8: interpret/answerQuestion unchanged; housesCovered complete
  it('P8: existing interpret/answerQuestion outputs are unchanged by running the engine', () => {
    fc.assert(fc.property(makeMookaChartArb(), (chart) => {
      const question = KPApp.catalog.QUESTION_CATALOG.filter(q => q.handler !== 'missingItem')[0];
      const baselineInterpret = JSON.stringify(KPApp.interpret.interpret('marriage', chart));
      const baselineAnswer = JSON.stringify(KPApp.interpret.answerQuestion(question, chart));

      KPApp.interpret.analyzeMookaPrashna(chart); // run the new engine

      expect(JSON.stringify(KPApp.interpret.interpret('marriage', chart))).toBe(baselineInterpret);
      expect(JSON.stringify(KPApp.interpret.answerQuestion(question, chart))).toBe(baselineAnswer);
      expect(KPApp.interpret.housesCovered().complete).toBe(true);
    }), { numRuns: 40 });
  });

  it('P8: runAnalysis still returns result/answer shapes for non-mooka modes', () => {
    const chartInput = { date: '2024-03-21', time: '14:30', lat: 19.076, lon: 72.8777, tz: 5.5, category: 'marriage', questionId: '', horary: null, place: 'Mumbai', mode: 'manual' };
    const out = KPApp.ui.runAnalysis(chartInput);
    expect(out.chart).toBeDefined();
    expect(out.result).toBeDefined();
    expect(out.mooka).toBeUndefined();
  });

  it('runAnalysis returns a mooka result for mooka mode', () => {
    const out = KPApp.ui.runAnalysis({ date: '2024-03-21', time: '14:30', lat: 19.076, lon: 72.8777, tz: 5.5, category: '', questionId: '', horary: null, place: 'Mumbai', mode: 'mooka' });
    expect(out.chart).toBeDefined();
    expect(out.mooka).toBeDefined();
    expect(out.mooka.candidates.length).toBeGreaterThanOrEqual(1);
    expect(out.mooka.attribution).toBe(KPApp.ATTRIBUTION);
  });
});

// ===========================================================================
// Integration test (JSDOM full render) for the Mooka tab + flow.
// ===========================================================================
describe('Mooka Prashna UI integration', () => {
  let dom, doc, win;

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
    // scrollIntoView is not implemented in JSDOM.
    win.Element.prototype.scrollIntoView = function () {};
    // Wait for DOMContentLoaded -> ui.init() to run.
    await new Promise(resolve => {
      if (doc.readyState === 'complete' || doc.readyState === 'interactive') resolve();
      else win.addEventListener('DOMContentLoaded', resolve);
      setTimeout(resolve, 200);
    });
  });

  it('renders three tabs and toggles panes without disturbing others', () => {
    const tabManual = doc.getElementById('tab-manual');
    const tabInstant = doc.getElementById('tab-instant');
    const tabMooka = doc.getElementById('tab-mooka');
    expect(tabManual).toBeTruthy();
    expect(tabInstant).toBeTruthy();
    expect(tabMooka).toBeTruthy();

    const paneManual = doc.getElementById('manual-pane');
    const paneMooka = doc.getElementById('mooka-pane');
    expect(paneMooka).toBeTruthy();
    // Initially manual is active.
    expect(paneManual.classList.contains('hidden')).toBe(false);
    expect(paneMooka.classList.contains('hidden')).toBe(true);

    tabMooka.dispatchEvent(new win.Event('click'));
    expect(paneMooka.classList.contains('hidden')).toBe(false);
    expect(paneManual.classList.contains('hidden')).toBe(true);
    expect(tabMooka.classList.contains('active')).toBe(true);

    // The Mooka form has no question or category selector.
    expect(doc.getElementById('mooka-question')).toBeNull();
    expect(doc.getElementById('mooka-category')).toBeNull();
    expect(doc.getElementById('mooka-analyze')).toBeTruthy();
  });

  it('runs the silent-query analysis and renders ranked candidates with reasoning', () => {
    const tabMooka = doc.getElementById('tab-mooka');
    tabMooka.dispatchEvent(new win.Event('click'));

    doc.getElementById('mooka-date').value = '2024-03-21';
    doc.getElementById('mooka-time').value = '14:30';
    doc.getElementById('mooka-lat').value = '19.0760';
    doc.getElementById('mooka-lon').value = '72.8777';
    doc.getElementById('mooka-tz').value = '5.5';
    doc.getElementById('mooka-city').value = 'Mumbai';

    doc.getElementById('mooka-analyze').dispatchEvent(new win.Event('click'));

    const results = doc.getElementById('results');
    const text = results.textContent || '';
    expect(text).toContain('The querent is most likely thinking about');
    expect(text).toContain('KP Reasoning');
    expect(text).toContain('Hora Shastra Reasoning');
    expect(text).toContain('Developed by Dr. Anil Sabaji');
  });
});

// ===========================================================================
// Integration test (JSDOM): the Mooka tab auto-fetches the current time and
// the current place (geolocation) on first activation, keeps fields editable,
// and then renders ranked results when "Analyze Silent Query" is pressed.
// ===========================================================================
describe('Mooka Prashna auto-fetch (time + place) on first activation', () => {
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

    // Stub geolocation to return a fixed position synchronously (deterministic).
    Object.defineProperty(win.navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: function (success) {
          success({ coords: { latitude: FIXED_LAT, longitude: FIXED_LON } });
        }
      }
    });

    // Wait for DOMContentLoaded -> ui.init() to run.
    await new Promise(resolve => {
      if (doc.readyState === 'complete' || doc.readyState === 'interactive') resolve();
      else win.addEventListener('DOMContentLoaded', resolve);
      setTimeout(resolve, 200);
    });
  });

  it('populates date/time and fills lat/lon from geolocation when the Mooka tab is first opened', () => {
    // Before activation lat/lon must be empty (proves the values come from the auto-fetch).
    expect(doc.getElementById('mooka-lat').value).toBe('');
    expect(doc.getElementById('mooka-lon').value).toBe('');

    doc.getElementById('tab-mooka').dispatchEvent(new win.Event('click'));

    // Date & time auto-filled with the current device moment.
    expect(doc.getElementById('mooka-date').value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(doc.getElementById('mooka-time').value).toMatch(/^\d{2}:\d{2}$/);

    // Latitude / longitude filled from the stubbed geolocation.
    expect(parseFloat(doc.getElementById('mooka-lat').value)).toBeCloseTo(FIXED_LAT, 3);
    expect(parseFloat(doc.getElementById('mooka-lon').value)).toBeCloseTo(FIXED_LON, 3);

    // The geo status element exists and reports success.
    const geo = doc.getElementById('mooka-geo');
    expect(geo).toBeTruthy();
    expect(geo.textContent.length).toBeGreaterThan(0);

    // Fields remain fully editable.
    expect(doc.getElementById('mooka-date').disabled).toBe(false);
    expect(doc.getElementById('mooka-lat').readOnly).toBe(false);
  });

  it('does not overwrite the user\'s manual edits when the tab is re-opened', () => {
    // User edits the auto-filled values.
    doc.getElementById('mooka-lat').value = '51.5074';
    doc.getElementById('mooka-lon').value = '-0.1278';
    doc.getElementById('mooka-date').value = '2024-03-21';
    doc.getElementById('mooka-time').value = '14:30';

    // Switch away and back to Mooka.
    doc.getElementById('tab-manual').dispatchEvent(new win.Event('click'));
    doc.getElementById('tab-mooka').dispatchEvent(new win.Event('click'));

    // Manual edits are preserved (auto-fetch only runs once).
    expect(doc.getElementById('mooka-lat').value).toBe('51.5074');
    expect(doc.getElementById('mooka-lon').value).toBe('-0.1278');
    expect(doc.getElementById('mooka-date').value).toBe('2024-03-21');
    expect(doc.getElementById('mooka-time').value).toBe('14:30');
  });

  it('renders ranked silent-query results after editing fields and pressing Analyze', () => {
    doc.getElementById('mooka-date').value = '2024-03-21';
    doc.getElementById('mooka-time').value = '14:30';
    doc.getElementById('mooka-lat').value = '19.0760';
    doc.getElementById('mooka-lon').value = '72.8777';
    doc.getElementById('mooka-tz').value = '5.5';
    doc.getElementById('mooka-city').value = 'Mumbai';

    doc.getElementById('mooka-analyze').dispatchEvent(new win.Event('click'));

    const text = doc.getElementById('results').textContent || '';
    expect(text).toContain('The querent is most likely thinking about');
    expect(text).toContain('KP Reasoning');
    expect(text).toContain('Hora Shastra Reasoning');
    expect(text).toContain('Developed by Dr. Anil Sabaji');
  });
});

