/**
 * @jest-environment jsdom
 */

const fs = require('fs');
const path = require('path');

const MAIN_JS = fs.readFileSync(path.resolve(__dirname, 'frontend/cfd/js/main.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.resolve(__dirname, 'frontend/cfd/index.html'), 'utf8');

// Sliced out of main.js rather than restated, so these tests fail if the shipped
// implementation drifts. main.js is an ES module that imports Three.js and boots
// the app, so it cannot be required into jsdom.
function sliceBetween(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + 1);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Could not extract ${label} from main.js — have the markers moved?`);
  }
  return source.slice(start, end);
}

const resultHelpersSource = sliceBetween(
  MAIN_JS,
  '// Render a coefficient as',
  'function displayCfdResults(job) {',
  'CFD result helpers'
);

function loadResultHelpers() {
  document.documentElement.innerHTML = INDEX_HTML;
  return new Function(`
    ${resultHelpersSource}
    return { formatCoefficient, renderResultBanner };
  `)();
}

const banner = () => document.getElementById('cfd-result-banner');

describe('formatCoefficient', () => {
  let helpers;

  beforeEach(() => {
    helpers = loadResultHelpers();
  });

  it('shows the spread when the run reported one', () => {
    expect(helpers.formatCoefficient(0.2671, 0.0032)).toBe('0.267 ± 0.003');
  });

  it('shows a negative coefficient with its spread', () => {
    expect(helpers.formatCoefficient(-0.1974, 0.0051)).toBe('-0.197 ± 0.005');
  });

  it('shows a zero spread rather than hiding it', () => {
    expect(helpers.formatCoefficient(0.315, 0)).toBe('0.315 ± 0.000');
  });

  // Jobs that completed before spreads were recorded must still render.
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', '0.003'],
    ['NaN', Number.NaN]
  ])('falls back to a bare value when the spread is %s', (_label, std) => {
    expect(helpers.formatCoefficient(0.315, std)).toBe('0.315');
  });
});

describe('renderResultBanner', () => {
  let helpers;

  beforeEach(() => {
    helpers = loadResultHelpers();
  });

  it('stays hidden for a job with no convergence information', () => {
    helpers.renderResultBanner({ cd: 0.315, cl: -0.197 });

    expect(banner().style.display).toBe('none');
  });

  it('confirms a converged run and says what was averaged', () => {
    helpers.renderResultBanner({ converged: true, sampleCount: 200 });

    expect(banner().style.display).toBe('block');
    expect(banner().textContent).toMatch(/converged/i);
    expect(banner().textContent).toMatch(/final 200 iterations/);
  });

  it('warns plainly when the solution had not settled', () => {
    helpers.renderResultBanner({ converged: false, sampleCount: 200 });

    expect(banner().style.display).toBe('block');
    expect(banner().textContent).toMatch(/not converged/i);
    expect(banner().textContent).toMatch(/provisional/i);
  });

  it('warns that a fast check is not an accurate result', () => {
    helpers.renderResultBanner({ fastCheck: true, converged: false });

    expect(banner().style.display).toBe('block');
    expect(banner().textContent).toMatch(/fast check/i);
    expect(banner().textContent).toMatch(/not accurate/i);
  });

  // A fast check is the more specific and more important thing to say, and a
  // 50-iteration run can never certify convergence anyway.
  it('reports a fast check as such even if convergence were somehow claimed', () => {
    helpers.renderResultBanner({ fastCheck: true, converged: true, sampleCount: 50 });

    expect(banner().textContent).toMatch(/fast check/i);
    expect(banner().textContent).not.toMatch(/^Converged/);
  });

  it('uses the warning colour for both untrustworthy cases', () => {
    helpers.renderResultBanner({ converged: false });
    const unconverged = banner().style.color;

    helpers.renderResultBanner({ fastCheck: true });
    expect(banner().style.color).toBe(unconverged);
    expect(unconverged).toContain('danger');
  });

  it('does not colour a converged run as a warning', () => {
    helpers.renderResultBanner({ converged: true, sampleCount: 200 });

    expect(banner().style.color).not.toContain('danger');
    expect(banner().style.color).toContain('cyan');
  });

  // The banner is reused across runs in the same session.
  it('clears a previous warning when a later run converges', () => {
    helpers.renderResultBanner({ fastCheck: true });
    expect(banner().textContent).toMatch(/fast check/i);

    helpers.renderResultBanner({ converged: true, sampleCount: 200 });
    expect(banner().textContent).toMatch(/converged/i);
    expect(banner().textContent).not.toMatch(/fast check/i);
  });

  // A completed run whose coefficients could not be derived must say so; a
  // silent empty panel is what sent us looking for this bug in the first place.
  it('explains a derivation failure instead of staying blank', () => {
    helpers.renderResultBanner({ metricsError: 'The solver produced no usable force history. Check the run log.' });

    expect(banner().style.display).toBe('block');
    expect(banner().textContent).toMatch(/no results available/i);
    expect(banner().textContent).toMatch(/no usable force history/i);
    expect(banner().style.color).toContain('danger');
  });

  it('reports a derivation failure ahead of any other verdict', () => {
    helpers.renderResultBanner({ metricsError: 'boom', fastCheck: true, converged: false });

    expect(banner().textContent).toMatch(/no results available/i);
  });

  it('hides itself again for a job carrying no verdict', () => {
    helpers.renderResultBanner({ converged: false });
    expect(banner().style.display).toBe('block');

    helpers.renderResultBanner({ cd: 0.3 });
    expect(banner().style.display).toBe('none');
  });
});
