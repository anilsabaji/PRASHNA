import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import { JSDOM } from 'jsdom';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Shared JSDOM harness: loads the full document, lets ui.init() run, then
// exposes KPApp for both DOM-free unit checks and live render assertions.
// ---------------------------------------------------------------------------
let dom, win, doc, KPApp;

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
  await new Promise(resolve => {
    if (doc.readyState === 'complete' || doc.readyState === 'interactive') resolve();
    else win.addEventListener('DOMContentLoaded', resolve);
    setTimeout(resolve, 200);
  });
  KPApp = win.KPApp;
});

function buildSampleChart() {
  // Deterministic moment (Mumbai) -> full chart.
  const jd = KPApp.astro.localToJD('2024-03-21', '14:30:00', 5.5);
  return KPApp.kp.buildChart({
    jd: jd, latitude: 19.076, longitude: 72.8777, timezone: 5.5, mode: 'manual'
  });
}

const BODIES = ['Sun', 'Moon', 'Mars', 'Mercury', 'Jupiter', 'Venus', 'Saturn', 'Rahu', 'Ketu'];

describe('interpret.computeAspects — classical graha drishti', () => {
  it('every planet aspects the 7th house from itself (6 places ahead)', () => {
    const chart = buildSampleChart();
    const asp = KPApp.interpret.computeAspects(chart);
    BODIES.forEach(name => {
      const a = asp.byPlanet[name];
      const seventh = ((a.house - 1 + 6) % 12) + 1;
      expect(a.aspectsHouses).toContain(seventh);
    });
  });

  it('Mars aspects its 4th and 8th; Jupiter 5th and 9th; Saturn 3rd and 10th', () => {
    const chart = buildSampleChart();
    const asp = KPApp.interpret.computeAspects(chart);

    const m = asp.byPlanet.Mars;
    expect(m.aspectsHouses).toContain(((m.house - 1 + 3) % 12) + 1); // 4th
    expect(m.aspectsHouses).toContain(((m.house - 1 + 7) % 12) + 1); // 8th

    const j = asp.byPlanet.Jupiter;
    expect(j.aspectsHouses).toContain(((j.house - 1 + 4) % 12) + 1); // 5th
    expect(j.aspectsHouses).toContain(((j.house - 1 + 8) % 12) + 1); // 9th

    const s = asp.byPlanet.Saturn;
    expect(s.aspectsHouses).toContain(((s.house - 1 + 2) % 12) + 1); // 3rd
    expect(s.aspectsHouses).toContain(((s.house - 1 + 9) % 12) + 1); // 10th
  });

  it('Rahu and Ketu additionally aspect their 5th and 9th', () => {
    const chart = buildSampleChart();
    const asp = KPApp.interpret.computeAspects(chart);
    ['Rahu', 'Ketu'].forEach(name => {
      const a = asp.byPlanet[name];
      expect(a.aspectsHouses).toContain(((a.house - 1 + 4) % 12) + 1); // 5th
      expect(a.aspectsHouses).toContain(((a.house - 1 + 8) % 12) + 1); // 9th
    });
  });

  it('benefics (Sun, Moon, Mercury, Venus) aspect the 7th only', () => {
    const chart = buildSampleChart();
    const asp = KPApp.interpret.computeAspects(chart);
    ['Sun', 'Moon', 'Mercury', 'Venus'].forEach(name => {
      const a = asp.byPlanet[name];
      expect(a.aspectsHouses.length).toBe(1);
      expect(a.aspectsHouses[0]).toBe(((a.house - 1 + 6) % 12) + 1);
    });
  });

  it('all aspectsHouses are integers in 1..12, sorted and deduplicated', () => {
    const chart = buildSampleChart();
    const asp = KPApp.interpret.computeAspects(chart);
    BODIES.forEach(name => {
      const arr = asp.byPlanet[name].aspectsHouses;
      const seen = {};
      let prev = 0;
      arr.forEach(h => {
        expect(Number.isInteger(h)).toBe(true);
        expect(h).toBeGreaterThanOrEqual(1);
        expect(h).toBeLessThanOrEqual(12);
        expect(seen[h]).toBeUndefined();   // deduped
        expect(h).toBeGreaterThan(prev);   // sorted ascending
        seen[h] = true;
        prev = h;
      });
    });
  });

  it('is deterministic (two calls deep-equal) and does not mutate the chart', () => {
    const chart = buildSampleChart();
    const snapshot = JSON.stringify(chart);
    const a1 = KPApp.interpret.computeAspects(chart);
    const a2 = KPApp.interpret.computeAspects(chart);
    expect(a1).toEqual(a2);
    expect(JSON.stringify(chart)).toBe(snapshot); // chart untouched
  });

  it('onHouse[h] contains exactly the planets whose byPlanet aspects h', () => {
    const chart = buildSampleChart();
    const asp = KPApp.interpret.computeAspects(chart);
    for (let h = 1; h <= 12; h++) {
      const expected = BODIES.filter(name => asp.byPlanet[name].aspectsHouses.indexOf(h) >= 0);
      // Same membership (order may differ).
      expect(asp.onHouse[h].slice().sort()).toEqual(expected.slice().sort());
      // Cross-check: every planet listed actually aspects h.
      asp.onHouse[h].forEach(name => {
        expect(asp.byPlanet[name].aspectsHouses).toContain(h);
      });
    }
  });
});

describe('reasoning generators mention aspects', () => {
  it('kpReasoning and horaShastraReasoning output contain the word "aspect"', () => {
    const chart = buildSampleChart();
    const kp = KPApp.interpret.kpReasoning('marriage', chart);
    const hora = KPApp.interpret.horaShastraReasoning('marriage', chart);
    expect(kp.toLowerCase()).toContain('aspect');
    expect(hora.toLowerCase()).toContain('aspect');
  });
});

describe('reports render the new kundali + aspects cards', () => {
  function runMookaAnalysis() {
    doc.getElementById('tab-mooka').dispatchEvent(new win.Event('click'));
    doc.getElementById('mooka-date').value = '2024-03-21';
    doc.getElementById('mooka-time').value = '14:30';
    doc.getElementById('mooka-lat').value = '19.0760';
    doc.getElementById('mooka-lon').value = '72.8777';
    doc.getElementById('mooka-tz').value = '5.5';
    doc.getElementById('mooka-city').value = 'Mumbai';
    doc.getElementById('mooka-analyze').dispatchEvent(new win.Event('click'));
  }

  it('#results shows the South Indian kundali as (essentially) the first card with an Asc marker, plus an aspects card', () => {
    runMookaAnalysis();
    const results = doc.getElementById('results');

    // The kundali card is present and carries the ascendant marker.
    const chartTable = results.querySelector('.south-indian-chart');
    expect(chartTable).toBeTruthy();
    expect((results.textContent || '')).toContain('Prashna Kundali (South Indian)');
    expect((chartTable.textContent || '')).toMatch(/Asc|La/);

    // It is the first report card (immediately after the no-print print bar).
    const cards = Array.from(results.querySelectorAll(':scope > .card'));
    const firstReportCard = cards.find(c => !c.classList.contains('results-actions'));
    expect(firstReportCard.querySelector('.south-indian-chart')).toBeTruthy();
    expect(firstReportCard.textContent).toContain('Prashna Kundali (South Indian)');

    // The Planetary Aspects card is present.
    expect((results.textContent || '')).toContain('Planetary Aspects (Graha Drishti)');
  });

  it('DOM-free builders place the kundali first and the aspects card after Ruling Planets', () => {
    const input = {
      date: '2024-03-21', time: '14:30', lat: 19.076, lon: 72.8777, tz: 5.5,
      category: 'marriage', questionId: '', horary: null, place: 'Mumbai', mode: 'manual'
    };
    const out = KPApp.ui.runAnalysis(input);
    const html = KPApp.ui.buildResultsHtml(input, out.chart, out.result);

    const idxBar = html.indexOf('results-actions');
    const idxKundali = html.indexOf('Prashna Kundali (South Indian)');
    const idxDetails = html.indexOf('Prashna Details');
    const idxRuling = html.indexOf('Ruling Planets');
    const idxAspects = html.indexOf('Planetary Aspects (Graha Drishti)');

    expect(idxBar).toBeGreaterThanOrEqual(0);
    expect(idxKundali).toBeGreaterThan(idxBar);
    expect(idxDetails).toBeGreaterThan(idxKundali);
    expect(idxAspects).toBeGreaterThan(idxRuling);
  });
});
