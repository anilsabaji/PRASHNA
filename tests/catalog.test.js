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
let context;

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

  // Stub localStorage
  const storage = new Map();
  const localStorageStub = {
    getItem: (key) => storage.has(key) ? storage.get(key) : null,
    setItem: (key, val) => storage.set(key, String(val)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear()
  };

  const ctx = vm.createContext({
    window: null, // will be set below
    document: win.document,
    navigator: win.navigator,
    localStorage: localStorageStub,
    Math: Math,
    Date: Date,
    JSON: JSON,
    parseInt: parseInt,
    parseFloat: parseFloat,
    console: console,
    Number: Number,
    String: String,
    Array: Array,
    Object: Object,
    Error: Error,
    TypeError: TypeError,
    RangeError: RangeError,
    isFinite: isFinite,
    isNaN: isNaN,
    Infinity: Infinity,
    NaN: NaN,
    undefined: undefined,
    RegExp: RegExp,
    Boolean: Boolean,
    Map: Map,
    Set: Set
  });

  // The script does: (function(global){ ... global.KPApp = KPApp; })(typeof window !== "undefined" ? window : this);
  // So we need `window` in the context to be an object where KPApp gets assigned.
  // We set window to the context itself so that global.KPApp = KPApp writes to ctx.
  ctx.window = ctx;

  // Wrap the script so that const KPApp becomes accessible
  // In vm contexts, block-scoped (const/let) vars aren't on the sandbox.
  // We use a Function wrapper approach to capture the KPApp reference.
  const wrappedScript = `(function() {\n${match[1]}\n; return (typeof KPApp !== 'undefined') ? KPApp : null;\n})()`;
  const script = new vm.Script(wrappedScript);
  const result = script.runInContext(ctx);

  if (!result) throw new Error('KPApp namespace not initialized');
  return result;
}


beforeAll(() => {
  KPApp = loadKPApp();
});

// ========== GENERATORS ==========

function buildChart(date, time, lat, lon, tz, horary) {
  const jd = KPApp.astro.localToJD(date, time, tz);
  const weekday = KPApp.astro.weekdayIndex(jd);
  return KPApp.kp.buildChart({
    jd, latitude: lat, longitude: lon, timezone: tz,
    weekday, mode: 'manual', horaryNumber: horary
  });
}

function makeChartArb() {
  const dateArb = fc.date({
    min: new Date('1950-01-01'),
    max: new Date('2050-12-31')
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
  const horaryArb = fc.integer({ min: 1, max: 249 });

  return fc.tuple(dateArb, timeArb, latArb, lonArb, tzArb, horaryArb)
    .map(([date, time, lat, lon, tz, horary]) => {
      try {
        return buildChart(date, time, lat, lon, tz, horary);
      } catch (e) {
        return null;
      }
    })
    .filter(chart => chart !== null);
}


function makeCatalogQuestionArb() {
  return fc.constantFrom(...KPApp.catalog.QUESTION_CATALOG);
}

function makeNonMissingCatalogQuestionArb() {
  const nonMissing = KPApp.catalog.QUESTION_CATALOG.filter(
    q => q.handler !== 'missingItem'
  );
  return fc.constantFrom(...nonMissing);
}

function makeQueryArb() {
  const catalog = KPApp.catalog.QUESTION_CATALOG;
  const substrings = catalog.slice(0, 10).map(q => {
    const text = q.text;
    const start = Math.floor(text.length / 4);
    const end = Math.min(start + 8, text.length);
    return text.slice(start, end);
  });

  return fc.oneof(
    fc.constantFrom(...substrings),
    fc.string({ maxLength: 20 }),
    fc.constant(''),
    fc.constant('   ')
  );
}

function makeCustomInputArb() {
  return fc.record({
    text: fc.oneof(
      fc.string({ minLength: 1, maxLength: 50 }),
      fc.constant(''),
      fc.constant('   ')
    ),
    houses: fc.subarray([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], { minLength: 0, maxLength: 6 })
  });
}


// ========== PROPERTY TESTS ==========
describe('Property Tests (P1-P14)', () => {

  // Feature: prashna-question-catalog, Property 1: Structural validity of every question
  it('P1: every catalog question has valid structure', () => {
    fc.assert(
      fc.property(
        makeCatalogQuestionArb(),
        (question) => {
          const validHouses = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 'missing'];
          expect(validHouses).toContain(question.house);
          expect(question.governingHouses.length).toBeGreaterThan(0);
          question.governingHouses.forEach(h => {
            expect(Number.isInteger(h)).toBe(true);
            expect(h).toBeGreaterThanOrEqual(1);
            expect(h).toBeLessThanOrEqual(12);
          });
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: prashna-question-catalog, Property 2: Every question resolves to an existing handler
  it('P2: every question resolves to an existing handler', () => {
    const chartArb = makeChartArb();
    fc.assert(
      fc.property(
        makeCatalogQuestionArb(),
        chartArb,
        (question, chart) => {
          const handler = KPApp.catalog.resolveHandler(question);
          expect(handler).toBeDefined();
          expect(KPApp.interpret.CATEGORY_HOUSES[handler]).toBeDefined();
          // answerQuestion should not throw
          const answer = KPApp.interpret.answerQuestion(question, chart);
          expect(answer).toBeDefined();
        }
      ),
      { numRuns: 100 }
    );
  });


  // Feature: prashna-question-catalog, Property 3: Judgment uses the governing houses' significators
  it('P3: judgment uses the governing houses significators', () => {
    const chartArb = makeChartArb();
    fc.assert(
      fc.property(
        makeNonMissingCatalogQuestionArb(),
        chartArb,
        (question, chart) => {
          const answer = KPApp.interpret.answerQuestion(question, chart);
          // WHY section references governing houses
          expect(answer.why).toBeDefined();
          expect(answer.why.houses).toBeDefined();
          const whyHouses = answer.why.houses.slice().sort((a, b) => a - b);
          const govHouses = question.governingHouses.slice().sort((a, b) => a - b);
          expect(whyHouses).toEqual(govHouses);
          // Significators object should have entries for governing houses
          expect(answer.why.significators).toBeDefined();
          // Handler matches
          expect(answer.handler).toBe(KPApp.catalog.resolveHandler(question));
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: prashna-question-catalog, Property 4: Interrogative selection is exactly the applicable set
  it('P4: interrogative selection is exactly the applicable set', () => {
    const chartArb = makeChartArb();
    fc.assert(
      fc.property(
        makeCatalogQuestionArb(),
        chartArb,
        (question, chart) => {
          const answer = KPApp.interpret.answerQuestion(question, chart);
          // whether and why are always present
          expect(answer.whether).toBeDefined();
          expect(answer.why).toBeDefined();
          // Optional interrogatives
          const optionalSet = ['WHEN', 'WHO', 'WHERE', 'HOW'];
          const questionInterrogs = question.interrogatives || [];
          const expectedOptional = optionalSet.filter(
            i => questionInterrogs.indexOf(i) >= 0
          );
          // Check each optional
          expectedOptional.forEach(interrog => {
            const key = interrog.toLowerCase();
            expect(answer[key]).toBeDefined();
            expect(answer[key].text).toBeDefined();
            expect(answer[key].text.length).toBeGreaterThan(0);
          });
          // Should NOT have optional sections not in the question's interrogatives
          optionalSet.forEach(interrog => {
            const key = interrog.toLowerCase();
            if (questionInterrogs.indexOf(interrog) < 0) {
              expect(answer[key]).toBeUndefined();
            }
          });
        }
      ),
      { numRuns: 100 }
    );
  });


  // Feature: prashna-question-catalog, Property 5: Dual-system output and attribution always present
  it('P5: dual-system output and attribution always present', () => {
    const chartArb = makeChartArb();
    fc.assert(
      fc.property(
        makeCatalogQuestionArb(),
        chartArb,
        (question, chart) => {
          const answer = KPApp.interpret.answerQuestion(question, chart);
          expect(typeof answer.kp).toBe('string');
          expect(answer.kp.length).toBeGreaterThan(0);
          expect(typeof answer.hora).toBe('string');
          expect(answer.hora.length).toBeGreaterThan(0);
          expect(answer.attribution).toBe(KPApp.ATTRIBUTION);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: prashna-question-catalog, Property 6: Search returns exactly the substring matches
  it('P6: searchCatalog returns exact substring matches', () => {
    fc.assert(
      fc.property(
        makeQueryArb(),
        (query) => {
          const catalog = KPApp.catalog.getCatalog();
          const results = KPApp.catalog.searchCatalog(query, catalog);
          const trimmed = (query == null) ? '' : String(query).trim().toLowerCase();

          if (!trimmed) {
            // Empty query returns full catalog
            expect(results.length).toBe(catalog.length);
            return;
          }
          // Every result must contain the query substring
          results.forEach(q => {
            expect(q.text.toLowerCase()).toContain(trimmed);
          });
          // Every catalog item matching must be in results
          const expected = catalog.filter(
            q => q.text.toLowerCase().indexOf(trimmed) >= 0
          );
          expect(results.length).toBe(expected.length);
          expected.forEach(q => {
            expect(results).toContainEqual(q);
          });
        }
      ),
      { numRuns: 100 }
    );
  });


  // Feature: prashna-question-catalog, Property 7: Grouping partitions the catalog by house
  it('P7: groupByHouse partitions the catalog by house', () => {
    fc.assert(
      fc.property(
        fc.subarray(KPApp.catalog.QUESTION_CATALOG, { minLength: 1, maxLength: 20 }),
        (questions) => {
          const groups = KPApp.catalog.groupByHouse(questions);
          // Each question is under its own house
          questions.forEach(q => {
            const key = (q.house === 'missing') ? 'missing' : q.house;
            expect(groups[key]).toContainEqual(q);
          });
          // Union of all groups equals input (no loss, no duplication)
          const allGrouped = [];
          Object.keys(groups).forEach(key => {
            groups[key].forEach(q => allGrouped.push(q));
          });
          expect(allGrouped.length).toBe(questions.length);
          questions.forEach(q => {
            expect(allGrouped).toContainEqual(q);
          });
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: prashna-question-catalog, Property 8: Computation gate requires a selection
  it('P8: computation gate requires a question or category', () => {
    fc.assert(
      fc.property(
        fc.record({
          hasQuestion: fc.boolean(),
          hasCategory: fc.boolean()
        }),
        ({ hasQuestion, hasCategory }) => {
          // Test the validateInput logic for the selection gate
          const raw = {
            date: '2024-01-15',
            time: '10:30',
            lat: '19.076',
            lon: '72.877',
            tz: '5.5',
            horary: '',
            questionId: hasQuestion ? 'h1-recovery' : '',
            category: hasCategory ? 'health' : ''
          };
          const result = KPApp.ui.validateInput(raw);
          if (hasQuestion || hasCategory) {
            expect(result.ok).toBe(true);
          } else {
            expect(result.ok).toBe(false);
            expect(result.message).toBeDefined();
          }
        }
      ),
      { numRuns: 100 }
    );
  });


  // Feature: prashna-question-catalog, Property 9: Custom-question validation rejects invalid input
  it('P9: validateCustom rejects invalid input correctly', () => {
    fc.assert(
      fc.property(
        makeCustomInputArb(),
        ({ text, houses }) => {
          const result = KPApp.catalog.validateCustom(text, houses);
          const hasText = text != null && String(text).trim() !== '';
          const hasHouses = Array.isArray(houses) && houses.length > 0;

          if (hasText && hasHouses) {
            expect(result.ok).toBe(true);
          } else {
            expect(result.ok).toBe(false);
            expect(result.message).toBeDefined();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: prashna-question-catalog, Property 10: Valid custom question lifecycle and persistence round-trip
  it('P10: custom question lifecycle and JSON round-trip', () => {
    const chartArb = makeChartArb();
    const validCustomArb = fc.record({
      text: fc.string({ minLength: 3, maxLength: 50 }).filter(t => t.trim().length > 0),
      houses: fc.subarray([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], { minLength: 1, maxLength: 4 })
    });

    fc.assert(
      fc.property(
        validCustomArb,
        chartArb,
        ({ text, houses }, chart) => {
          // makeCustomQuestion produces a valid question
          const question = KPApp.catalog.makeCustomQuestion(text, houses);
          const sortedHouses = houses.slice().sort((a, b) => a - b);
          expect(question.house).toBe(sortedHouses[0]);
          expect(question.governingHouses).toEqual(sortedHouses);
          expect(question.custom).toBe(true);

          // mergeCustom includes it, searchCatalog finds it
          const merged = KPApp.catalog.mergeCustom(KPApp.catalog.QUESTION_CATALOG, [question]);
          const found = KPApp.catalog.searchCatalog(text.trim(), merged);
          expect(found.length).toBeGreaterThan(0);

          // answerQuestion works
          const answer = KPApp.interpret.answerQuestion(question, chart);
          expect(answer).toBeDefined();
          expect(answer.handler).toBe(question.handler);

          // JSON round-trip preserves equivalence
          const serialized = JSON.stringify(question);
          const deserialized = JSON.parse(serialized);
          expect(deserialized.text).toBe(question.text);
          expect(deserialized.house).toBe(question.house);
          expect(deserialized.governingHouses).toEqual(question.governingHouses);
          expect(deserialized.handler).toBe(question.handler);
        }
      ),
      { numRuns: 100 }
    );
  });


  // Feature: prashna-question-catalog, Property 11: No network access during answering
  it('P11: no network access during answerQuestion', () => {
    const chartArb = makeChartArb();
    fc.assert(
      fc.property(
        makeCatalogQuestionArb(),
        chartArb,
        (question, chart) => {
          let fetchCalls = 0;
          let xhrCalls = 0;
          // Spy by wrapping
          const origFetch = globalThis.fetch;
          const origXHR = globalThis.XMLHttpRequest;
          globalThis.fetch = () => { fetchCalls++; return Promise.resolve(); };
          globalThis.XMLHttpRequest = function () { xhrCalls++; };

          try {
            KPApp.interpret.answerQuestion(question, chart);
          } finally {
            globalThis.fetch = origFetch;
            globalThis.XMLHttpRequest = origXHR;
          }

          expect(fetchCalls).toBe(0);
          expect(xhrCalls).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: prashna-question-catalog, Property 12: Legacy category interpretation is preserved
  it('P12: legacy interpret returns correct shape for all categories', () => {
    const chartArb = makeChartArb();
    const categories = Object.keys(KPApp.interpret.CATEGORY_HOUSES);
    fc.assert(
      fc.property(
        fc.constantFrom(...categories),
        chartArb,
        (category, chart) => {
          const result = KPApp.interpret.interpret(category, chart);
          expect(result.category).toBe(category);
          expect(typeof result.label).toBe('string');
          expect(Array.isArray(result.houses)).toBe(true);
          expect(result.houses.length).toBeGreaterThan(0);
          expect(typeof result.kp).toBe('string');
          expect(result.kp.length).toBeGreaterThan(0);
          expect(typeof result.horaShastra).toBe('string');
          expect(result.horaShastra.length).toBeGreaterThan(0);
          if (category === 'missingItem') {
            expect(result.missingItem).not.toBeNull();
          } else {
            expect(result.missingItem).toBeNull();
          }
        }
      ),
      { numRuns: 100 }
    );
  });


  // Feature: prashna-question-catalog, Property 13: Horary-number range validation is preserved
  it('P13: horary number validation accepts valid and rejects invalid', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: 1, max: 249 }).map(String),
          fc.integer({ min: 250, max: 500 }).map(String),
          fc.integer({ min: -100, max: 0 }).map(String),
          fc.constant(''),
          fc.constant('abc'),
          fc.double({ min: 1.1, max: 248.9, noNaN: true, noDefaultInfinity: true })
            .filter(v => Math.floor(v) !== v)
            .map(String)
        ),
        (horaryStr) => {
          const raw = {
            date: '2024-01-15',
            time: '10:30',
            lat: '19.076',
            lon: '72.877',
            tz: '5.5',
            category: 'health',
            questionId: '',
            horary: horaryStr
          };
          const result = KPApp.ui.validateInput(raw);
          const trimmed = String(horaryStr).trim();

          if (trimmed === '') {
            // Blank horary is accepted
            expect(result.ok).toBe(true);
          } else {
            const n = Number(trimmed);
            if (isFinite(n) && Math.floor(n) === n && n >= 1 && n <= 249) {
              expect(result.ok).toBe(true);
            } else {
              expect(result.ok).toBe(false);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: prashna-question-catalog, Property 14: Missing-item judgment is preserved
  it('P14: judgeMissingItem returns correct structure', () => {
    const chartArb = makeChartArb();
    fc.assert(
      fc.property(
        chartArb,
        (chart) => {
          const mi = KPApp.interpret.judgeMissingItem(chart);
          expect(mi).toBeDefined();
          expect(typeof mi.age).toBe('string');
          expect(['old', 'new']).toContain(mi.age);
          expect(typeof mi.sigPlanet).toBe('string');
          expect(mi.sigPlanet.length).toBeGreaterThan(0);
          expect(typeof mi.material).toBe('string');
          expect(mi.material.length).toBeGreaterThan(0);
          expect(['misplaced', 'lost', 'stolen']).toContain(mi.status);

          // Matching detail block based on status
          if (mi.status === 'misplaced') {
            expect(mi.location).not.toBeNull();
            expect(mi.location).toBeDefined();
          } else if (mi.status === 'lost') {
            expect(mi.lostDetail).not.toBeNull();
            expect(mi.lostDetail).toBeDefined();
          } else {
            expect(mi.thief).not.toBeNull();
            expect(mi.thief).toBeDefined();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

}); // end Property Tests


// ========== UNIT TESTS ==========
describe('Unit Tests', () => {

  it('Config alignment: 4 new handlers exist in all parallel maps', () => {
    const newHandlers = ['wealthRecovery', 'siblings', 'fortune', 'gains'];
    newHandlers.forEach(handler => {
      expect(KPApp.interpret.CATEGORY_HOUSES[handler]).toBeDefined();
      expect(Array.isArray(KPApp.interpret.CATEGORY_HOUSES[handler])).toBe(true);
      expect(KPApp.interpret.CATEGORY_HOUSES[handler].length).toBeGreaterThan(0);

      expect(KPApp.interpret.CATEGORY_LABELS[handler]).toBeDefined();
      expect(typeof KPApp.interpret.CATEGORY_LABELS[handler].name).toBe('string');
    });
  });

  it('House coverage: housesCovered() spans {1..12}', () => {
    const coverage = KPApp.interpret.housesCovered();
    expect(coverage.complete).toBe(true);
    expect(coverage.covered.length).toBe(12);
    for (let h = 1; h <= 12; h++) {
      expect(coverage.covered).toContain(h);
    }
  });

  it('Per-house subjects: each house has >= 3 questions', () => {
    const catalog = KPApp.catalog.QUESTION_CATALOG;
    for (let h = 1; h <= 12; h++) {
      const questions = catalog.filter(q => q.house === h);
      expect(questions.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('Missing set: dedicated missing/lost-article questions exist', () => {
    const catalog = KPApp.catalog.QUESTION_CATALOG;
    const missingQuestions = catalog.filter(q => q.house === 'missing');
    expect(missingQuestions.length).toBeGreaterThanOrEqual(2);
    // All should have missingItem handler
    missingQuestions.forEach(q => {
      expect(q.handler).toBe('missingItem');
    });
  });
});


// ========== SMOKE TEST ==========
describe('Smoke / Integration', () => {

  it('Full load produces valid KPApp', () => {
    expect(KPApp).toBeDefined();
    expect(KPApp.catalog).toBeDefined();
    expect(KPApp.kp).toBeDefined();
    expect(KPApp.interpret).toBeDefined();
    expect(KPApp.ui).toBeDefined();
    expect(Array.isArray(KPApp.catalog.QUESTION_CATALOG)).toBe(true);
    expect(KPApp.catalog.QUESTION_CATALOG.length).toBeGreaterThan(0);
    expect(typeof KPApp.kp.buildChart).toBe('function');
    expect(typeof KPApp.interpret.answerQuestion).toBe('function');
  });

  it('answerQuestion works for a sample question with a sample chart', () => {
    const chart = buildChart('2024-06-15', '10:30', 19.076, 72.877, 5.5, 100);
    const question = KPApp.catalog.QUESTION_CATALOG[0];
    const answer = KPApp.interpret.answerQuestion(question, chart);
    expect(answer).toBeDefined();
    expect(answer.whether).toBeDefined();
    expect(answer.why).toBeDefined();
    expect(typeof answer.kp).toBe('string');
    expect(typeof answer.hora).toBe('string');
    expect(answer.attribution).toBe(KPApp.ATTRIBUTION);
  });

  it('Zero network calls during the whole cycle', () => {
    let fetchCalls = 0;
    let xhrCalls = 0;
    const origFetch = globalThis.fetch;
    const origXHR = globalThis.XMLHttpRequest;
    globalThis.fetch = () => { fetchCalls++; return Promise.resolve(); };
    globalThis.XMLHttpRequest = function () { xhrCalls++; };

    try {
      const chart = buildChart('2024-03-20', '14:00', 28.613, 77.209, 5.5, 50);
      const question = KPApp.catalog.QUESTION_CATALOG[5];
      KPApp.interpret.answerQuestion(question, chart);
      KPApp.interpret.interpret('health', chart);
    } finally {
      globalThis.fetch = origFetch;
      globalThis.XMLHttpRequest = origXHR;
    }

    expect(fetchCalls).toBe(0);
    expect(xhrCalls).toBe(0);
  });
});
