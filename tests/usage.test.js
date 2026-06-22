import { describe, it, expect, beforeAll } from 'vitest';
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
// existing tests/*.test.js bootstrap pattern). This exercises the pure,
// DOM-free usage layer (KPApp.usage).
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
    Math, Date, JSON, parseInt, parseFloat, console,
    Number, String, Array, Object, Error, TypeError, RangeError,
    isFinite, isNaN, Infinity, NaN, undefined, RegExp, Boolean, Map, Set
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

// ===========================================================================
// Pure layer: KPApp.usage
// ===========================================================================
describe('KPApp.usage.emptyStats', () => {
  it('returns the canonical empty shape', () => {
    const s = KPApp.usage.emptyStats();
    expect(s).toEqual({
      total: 0,
      byMode: { manual: 0, instant: 0, mooka: 0 },
      byCategory: {},
      byQuestion: {},
      firstUsedAt: null,
      lastUsedAt: null
    });
  });

  it('returns a brand-new object each call (no shared references)', () => {
    const a = KPApp.usage.emptyStats();
    const b = KPApp.usage.emptyStats();
    expect(a).not.toBe(b);
    expect(a.byMode).not.toBe(b.byMode);
    a.byMode.manual = 99;
    expect(b.byMode.manual).toBe(0);
  });
});

describe('KPApp.usage.record', () => {
  it('increments total and the relevant byMode bucket', () => {
    let s = KPApp.usage.emptyStats();
    s = KPApp.usage.record(s, { mode: 'manual', at: '2024-01-01T00:00:00.000Z' });
    s = KPApp.usage.record(s, { mode: 'instant', at: '2024-01-02T00:00:00.000Z' });
    s = KPApp.usage.record(s, { mode: 'mooka', at: '2024-01-03T00:00:00.000Z' });
    expect(s.total).toBe(3);
    expect(s.byMode).toEqual({ manual: 1, instant: 1, mooka: 1 });
  });

  it('defaults an unknown/missing mode to manual', () => {
    let s = KPApp.usage.record(KPApp.usage.emptyStats(), { at: 't1' });
    s = KPApp.usage.record(s, { mode: 'bogus', at: 't2' });
    expect(s.byMode.manual).toBe(2);
    expect(s.total).toBe(2);
  });

  it('increments byCategory only for non-empty string categories', () => {
    let s = KPApp.usage.emptyStats();
    s = KPApp.usage.record(s, { mode: 'manual', category: 'marriage', at: 't1' });
    s = KPApp.usage.record(s, { mode: 'manual', category: 'marriage', at: 't2' });
    s = KPApp.usage.record(s, { mode: 'manual', category: '', at: 't3' });
    s = KPApp.usage.record(s, { mode: 'manual', at: 't4' });
    expect(s.byCategory).toEqual({ marriage: 2 });
  });

  it('increments byQuestion and stores { count, text }, preserving prior text', () => {
    let s = KPApp.usage.emptyStats();
    s = KPApp.usage.record(s, { mode: 'manual', questionId: 'q1', questionText: 'Will it rain?', at: 't1' });
    s = KPApp.usage.record(s, { mode: 'manual', questionId: 'q1', at: 't2' }); // no text supplied
    expect(s.byQuestion.q1).toEqual({ count: 2, text: 'Will it rain?' });
  });

  it('sets firstUsedAt once and lastUsedAt every time', () => {
    let s = KPApp.usage.emptyStats();
    s = KPApp.usage.record(s, { mode: 'manual', at: 'first' });
    s = KPApp.usage.record(s, { mode: 'manual', at: 'second' });
    s = KPApp.usage.record(s, { mode: 'manual', at: 'third' });
    expect(s.firstUsedAt).toBe('first');
    expect(s.lastUsedAt).toBe('third');
  });

  it('does NOT mutate the input stats object (immutability)', () => {
    const before = KPApp.usage.emptyStats();
    const snapshot = JSON.stringify(before);
    const after = KPApp.usage.record(before, { mode: 'mooka', category: 'health', questionId: 'q9', questionText: 'x', at: 'now' });
    expect(JSON.stringify(before)).toBe(snapshot); // unchanged
    expect(after).not.toBe(before);
    expect(after.byMode).not.toBe(before.byMode);
    expect(after.total).toBe(1);
  });

  it('tolerates an undefined / non-object stats argument', () => {
    const a = KPApp.usage.record(undefined, { mode: 'manual', at: 't' });
    expect(a.total).toBe(1);
    const b = KPApp.usage.record(null, { mode: 'instant', at: 't' });
    expect(b.total).toBe(1);
    const c = KPApp.usage.record(42, { mode: 'mooka', at: 't' });
    expect(c.total).toBe(1);
    expect(c.byMode.mooka).toBe(1);
  });

  it('tolerates a missing event and missing optional fields', () => {
    const a = KPApp.usage.record(KPApp.usage.emptyStats());
    expect(a.total).toBe(1);
    expect(a.byMode.manual).toBe(1);
    expect(a.firstUsedAt).toBeNull();
    expect(a.lastUsedAt).toBeNull();
  });

  // Property: total always equals the sum of all byMode buckets after a
  // sequence of records starting from empty.
  it('PROPERTY: total equals the sum of byMode counts', () => {
    const eventArb = fc.record({
      mode: fc.constantFrom('manual', 'instant', 'mooka', 'other', undefined),
      category: fc.option(fc.string(), { nil: undefined }),
      questionId: fc.option(fc.string(), { nil: undefined }),
      at: fc.integer({ min: 0, max: 1000 }).map(String)
    });
    fc.assert(fc.property(fc.array(eventArb), (events) => {
      let s = KPApp.usage.emptyStats();
      events.forEach(e => { s = KPApp.usage.record(s, e); });
      const modeSum = s.byMode.manual + s.byMode.instant + s.byMode.mooka;
      expect(modeSum).toBe(s.total);
      expect(s.total).toBe(events.length);
    }), { numRuns: 100 });
  });
});

describe('KPApp.usage.topQuestions', () => {
  it('sorts by count DESC then id ASC and caps to n', () => {
    let s = KPApp.usage.emptyStats();
    // Build counts: b->3, a->3, c->1, d->2
    for (let i = 0; i < 3; i++) s = KPApp.usage.record(s, { questionId: 'b', questionText: 'B?', at: 't' });
    for (let i = 0; i < 3; i++) s = KPApp.usage.record(s, { questionId: 'a', questionText: 'A?', at: 't' });
    s = KPApp.usage.record(s, { questionId: 'c', questionText: 'C?', at: 't' });
    for (let i = 0; i < 2; i++) s = KPApp.usage.record(s, { questionId: 'd', questionText: 'D?', at: 't' });

    const top = KPApp.usage.topQuestions(s, 3);
    expect(top.map(q => q.id)).toEqual(['a', 'b', 'd']); // a,b tie on 3 -> id asc; then d(2)
    expect(top.length).toBe(3);
    expect(top[0]).toEqual({ id: 'a', text: 'A?', count: 3 });
  });

  it('defaults n to 5', () => {
    let s = KPApp.usage.emptyStats();
    for (let i = 0; i < 8; i++) s = KPApp.usage.record(s, { questionId: 'q' + i, questionText: 'Q' + i, at: 't' });
    const top = KPApp.usage.topQuestions(s);
    expect(top.length).toBe(5);
  });

  it('returns an empty array when there are no questions', () => {
    expect(KPApp.usage.topQuestions(KPApp.usage.emptyStats())).toEqual([]);
  });
});

describe('KPApp.usage.normalize', () => {
  it('repairs a completely corrupt value into empty stats', () => {
    expect(KPApp.usage.normalize(null)).toEqual(KPApp.usage.emptyStats());
    expect(KPApp.usage.normalize('garbage')).toEqual(KPApp.usage.emptyStats());
    expect(KPApp.usage.normalize(123)).toEqual(KPApp.usage.emptyStats());
    expect(KPApp.usage.normalize(undefined)).toEqual(KPApp.usage.emptyStats());
  });

  it('fills missing fields and drops bad types', () => {
    const raw = {
      total: 'not-a-number',
      byMode: { manual: 4, instant: -2, mooka: 'x', extra: 9 },
      byCategory: { marriage: 3, '': 5, bad: 'nope' },
      byQuestion: { q1: { count: 2, text: 'Hi' }, q2: { count: 'x' }, q3: 'bad', '': { count: 1 } },
      firstUsedAt: 'A',
      lastUsedAt: 99
    };
    const n = KPApp.usage.normalize(raw);
    expect(n.total).toBe(0); // bad total -> 0
    expect(n.byMode).toEqual({ manual: 4, instant: 0, mooka: 0 }); // bad/neg dropped, extra ignored
    expect(n.byCategory).toEqual({ marriage: 3 }); // empty key + bad type dropped
    expect(n.byQuestion).toEqual({ q1: { count: 2, text: 'Hi' } }); // only valid entry kept
    expect(n.firstUsedAt).toBe('A');
    expect(n.lastUsedAt).toBe(99);
  });

  it('coerces float counts to integers and keeps known modes only', () => {
    const n = KPApp.usage.normalize({ total: 5.9, byMode: { manual: 2.7 } });
    expect(n.total).toBe(5);
    expect(n.byMode.manual).toBe(2);
  });

  // Property: normalize is idempotent and always produces a valid shape.
  it('PROPERTY: normalize output is always a valid, idempotent stats shape', () => {
    fc.assert(fc.property(fc.anything(), (raw) => {
      const once = KPApp.usage.normalize(raw);
      const twice = KPApp.usage.normalize(once);
      expect(twice).toEqual(once);
      expect(typeof once.total).toBe('number');
      expect(once.total).toBeGreaterThanOrEqual(0);
      ['manual', 'instant', 'mooka'].forEach(m => {
        expect(typeof once.byMode[m]).toBe('number');
        expect(once.byMode[m]).toBeGreaterThanOrEqual(0);
      });
    }), { numRuns: 100 });
  });
});

// ===========================================================================
// JSDOM full-render integration test: recording on real analyses + counter.
// ===========================================================================
describe('Usage tracking UI integration', () => {
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

    // Deterministic geolocation stub for the Mooka tab auto-fetch.
    Object.defineProperty(win.navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: function (success) {
          success({ coords: { latitude: FIXED_LAT, longitude: FIXED_LON } });
        }
      }
    });

    // Start from a clean usage slate.
    win.localStorage.removeItem('kp-prashna-usage-v1');

    await new Promise(resolve => {
      if (doc.readyState === 'complete' || doc.readyState === 'interactive') resolve();
      else win.addEventListener('DOMContentLoaded', resolve);
      setTimeout(resolve, 200);
    });
  });

  it('records a Manual analysis: localStorage total >= 1, byMode.manual >= 1, counter updated', () => {
    // The header counter exists and starts at zero.
    const counter = doc.getElementById('usage-counter');
    expect(counter).toBeTruthy();
    expect(counter.textContent).toContain('0');

    // Fill the Manual form with a valid moment + a category.
    doc.getElementById('tab-manual').dispatchEvent(new win.Event('click'));
    doc.getElementById('manual-date').value = '2024-03-21';
    doc.getElementById('manual-time').value = '14:30';
    doc.getElementById('manual-lat').value = '19.0760';
    doc.getElementById('manual-lon').value = '72.8777';
    doc.getElementById('manual-tz').value = '5.5';
    doc.getElementById('manual-city').value = 'Mumbai';
    doc.getElementById('manual-category').value = 'marriage';

    doc.getElementById('manual-analyze').dispatchEvent(new win.Event('click'));

    const raw = win.localStorage.getItem('kp-prashna-usage-v1');
    expect(raw).toBeTruthy();
    const stats = JSON.parse(raw);
    expect(stats.total).toBeGreaterThanOrEqual(1);
    expect(stats.byMode.manual).toBeGreaterThanOrEqual(1);
    expect(stats.byCategory.marriage).toBeGreaterThanOrEqual(1);

    // Header counter reflects the new total.
    expect(counter.textContent).toContain(String(stats.total));
    expect(counter.textContent).toMatch(/this device/i);
  });

  it('records a Mooka analysis: byMode.mooka increments and total grows', () => {
    const before = JSON.parse(win.localStorage.getItem('kp-prashna-usage-v1'));
    const beforeMooka = before.byMode.mooka || 0;
    const beforeTotal = before.total;

    doc.getElementById('tab-mooka').dispatchEvent(new win.Event('click'));
    doc.getElementById('mooka-date').value = '2024-03-21';
    doc.getElementById('mooka-time').value = '14:30';
    doc.getElementById('mooka-lat').value = '19.0760';
    doc.getElementById('mooka-lon').value = '72.8777';
    doc.getElementById('mooka-tz').value = '5.5';
    doc.getElementById('mooka-city').value = 'Mumbai';

    doc.getElementById('mooka-analyze').dispatchEvent(new win.Event('click'));

    const after = JSON.parse(win.localStorage.getItem('kp-prashna-usage-v1'));
    expect(after.byMode.mooka).toBe(beforeMooka + 1);
    expect(after.total).toBe(beforeTotal + 1);

    const counter = doc.getElementById('usage-counter');
    expect(counter.textContent).toContain(String(after.total));
  });

  it('surfaces the usage-statistics card in the Print Report pane', () => {
    doc.getElementById('tab-print').dispatchEvent(new win.Event('click'));
    const statsEl = doc.getElementById('usage-stats');
    expect(statsEl).toBeTruthy();
    const text = statsEl.textContent || '';
    expect(text).toContain('Usage Statistics (this device)');
    expect(text).toMatch(/Total Prashnas cast/i);
    expect(text).toMatch(/Manual:/);
    expect(text).toMatch(/Mooka:/);
  });

  it('keeps the footer attribution text exactly intact', () => {
    const footer = doc.querySelector('footer.app-footer');
    const text = (footer.textContent || '').replace(/\s+/g, ' ').trim();
    expect(text).toContain('Developed by Dr. Anil Sabaji');
    expect(text).toContain('anilsabaji@gmail.com');
  });
});
