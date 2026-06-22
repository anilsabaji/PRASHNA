import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'fs';
import { JSDOM } from 'jsdom';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Full-document JSDOM harness (mirrors the Mooka UI integration tests): loads
// the complete HTML, lets ui.init() run, then drives a real analysis so that
// #results is populated by the live render path (ui.renderResults).
// ---------------------------------------------------------------------------
describe('Print / Save as PDF action bar', () => {
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

  it('renders a #print-report button inside #results with a .no-print ancestor', () => {
    runMookaAnalysis();

    const results = doc.getElementById('results');
    const btn = doc.getElementById('print-report');
    expect(btn).toBeTruthy();
    // The button lives inside the results container.
    expect(results.contains(btn)).toBe(true);

    // It has a .no-print ancestor (the action bar) so it is hidden when printing.
    expect(btn.closest('.no-print')).toBeTruthy();
    expect(btn.closest('.results-actions')).toBeTruthy();

    // The report content (attribution) is still present and unchanged.
    expect((results.textContent || '')).toContain('Developed by Dr. Anil Sabaji');
  });

  it('calls window.print() exactly once when the print button is clicked', () => {
    runMookaAnalysis();

    const btn = doc.getElementById('print-report');
    expect(btn).toBeTruthy();

    const spy = vi.fn();
    const original = win.print;
    win.print = spy;
    try {
      btn.dispatchEvent(new win.Event('click'));
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      win.print = original;
    }
  });

  it('sets document.title to "KP-Prashna-Report" during print and restores it afterward', () => {
    runMookaAnalysis();

    const btn = doc.getElementById('print-report');
    expect(btn).toBeTruthy();

    const originalTitle = doc.title;
    let titleDuringPrint = null;
    const original = win.print;
    // Capture the document title at the exact moment window.print() is invoked.
    win.print = vi.fn(function () {
      titleDuringPrint = doc.title;
    });
    try {
      btn.dispatchEvent(new win.Event('click'));
      // During the print call the title must be the PDF filename override.
      expect(titleDuringPrint).toBe('KP-Prashna-Report');
      // After the call returns it must be restored to the original value.
      expect(doc.title).toBe(originalTitle);
    } finally {
      win.print = original;
    }
  });
});

// ---------------------------------------------------------------------------
// Pure DOM-free check: every report builder prepends the print action bar as
// the very first element, and the footer attribution text is unchanged.
// ---------------------------------------------------------------------------
describe('printBarHtml is prepended to every report builder', () => {
  let KPApp;

  beforeAll(async () => {
    const htmlPath = path.resolve(__dirname, '..', 'kp-prashna.html');
    const html = fs.readFileSync(htmlPath, 'utf-8');
    const dom = new JSDOM(html, {
      url: 'http://localhost',
      runScripts: 'dangerously',
      pretendToBeVisual: true
    });
    const win = dom.window;
    win.Element.prototype.scrollIntoView = function () {};
    await new Promise(resolve => {
      const d = win.document;
      if (d.readyState === 'complete' || d.readyState === 'interactive') resolve();
      else win.addEventListener('DOMContentLoaded', resolve);
      setTimeout(resolve, 200);
    });
    KPApp = win.KPApp;
  });

  it('printBarHtml returns a no-print bar containing the print button', () => {
    const bar = KPApp.ui.printBarHtml();
    expect(bar).toContain('results-actions');
    expect(bar).toContain('no-print');
    expect(bar).toContain('id="print-report"');
  });

  it('Mooka, manual and answer builders start with the print bar', () => {
    const input = {
      date: '2024-03-21', time: '14:30', lat: 19.076, lon: 72.8777, tz: 5.5,
      category: 'marriage', questionId: '', horary: null, place: 'Mumbai', mode: 'manual'
    };
    const barPrefix = '<div class="results-actions no-print">';
    const out = KPApp.ui.runAnalysis(input);
    const resultsHtml = KPApp.ui.buildResultsHtml(input, out.chart, out.result);
    expect(resultsHtml.startsWith(barPrefix)).toBe(true);

    const mookaInput = { ...input, category: '', mode: 'mooka' };
    const mookaOut = KPApp.ui.runAnalysis(mookaInput);
    const mookaHtml = KPApp.ui.buildMookaResultsHtml(mookaInput, mookaOut.chart, mookaOut.mooka);
    expect(mookaHtml.startsWith(barPrefix)).toBe(true);

    // Footer / attribution text remains exactly as specified.
    expect(KPApp.ATTRIBUTION).toBe('Developed by Dr. Anil Sabaji, Email: anilsabaji@gmail.com');
  });
});
