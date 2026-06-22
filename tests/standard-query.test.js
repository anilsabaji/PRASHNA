import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import vm from 'vm';
import { JSDOM } from 'jsdom';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let KPApp;

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

function buildChart(date, time, lat, lon, tz, horary) {
  const jd = KPApp.astro.localToJD(date, time, tz);
  const weekday = KPApp.astro.weekdayIndex(jd);
  return KPApp.kp.buildChart({
    jd, latitude: lat, longitude: lon, timezone: tz,
    weekday, mode: 'manual', horaryNumber: horary
  });
}

beforeAll(() => {
  KPApp = loadKPApp();
});

describe('Standard query: "Money stolen. Will I get back?"', () => {
  const TARGET_TEXT = 'Money stolen. Will I get back?';

  it('(a) exists in the standard QUESTION_CATALOG', () => {
    const found = KPApp.catalog.QUESTION_CATALOG.filter(q => q.text === TARGET_TEXT);
    expect(found.length).toBe(1);
    expect(found[0].house).toBe('missing');
    expect(found[0].governingHouses).toEqual([2, 6, 7, 11]);
  });

  it('(b) has handler "missingItem" and resolveHandler returns "missingItem"', () => {
    const question = KPApp.catalog.QUESTION_CATALOG.find(q => q.text === TARGET_TEXT);
    expect(question).toBeDefined();
    expect(question.handler).toBe('missingItem');
    expect(KPApp.catalog.resolveHandler(question)).toBe('missingItem');
  });

  it('(c) answerQuestion runs without throwing and returns a missingItem field', () => {
    const question = KPApp.catalog.QUESTION_CATALOG.find(q => q.text === TARGET_TEXT);
    const chart = buildChart('2024-06-15', '10:30', 19.076, 72.877, 5.5, 100);
    let answer;
    expect(() => { answer = KPApp.interpret.answerQuestion(question, chart); }).not.toThrow();
    expect(answer).toBeDefined();
    expect(typeof answer).toBe('object');
    expect(answer.missingItem).toBeDefined();
    expect(answer.missingItem).not.toBeNull();
    expect(answer.handler).toBe('missingItem');
  });
});
