/**
 * @jest-environment jsdom
 */

// The unit selector used to be viewer-only: the factor that turns the uploaded
// STL's units into the metres the OpenFOAM case is built in was never sent with
// the job, so a millimetre model was meshed 1000x oversized while Aref/lRef
// stayed correct. These cover the helper that factor now comes from.

const fs = require('fs');
const path = require('path');

const MAIN_JS = fs.readFileSync(path.resolve(__dirname, 'frontend/cfd/js/main.js'), 'utf8');

function sliceBetween(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + 1);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Could not extract ${label} from main.js — have the markers moved?`);
  }
  return source.slice(start, end);
}

const unitHelpersSource = sliceBetween(
  MAIN_JS,
  'const UNIT_TO_METRES',
  'const MPH_TO_MS',
  'model unit helpers'
).trim();

const factory = new Function(`
  ${unitHelpersSource}
  return { UNIT_TO_METRES, readModelUnit, modelScaleToMetres };
`);

const { UNIT_TO_METRES, readModelUnit, modelScaleToMetres } = factory();

function setUnitSelector(value) {
  document.body.innerHTML = `
    <select id="unit-select">
      <option value="m">Meters (m)</option>
      <option value="mm">Millimeters (mm)</option>
      <option value="cm">Centimeters (cm)</option>
      <option value="in">Inches (in)</option>
    </select>`;
  if (value !== undefined) {
    document.getElementById('unit-select').value = value;
  }
}

describe('modelScaleToMetres', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it.each([
    ['m', 1],
    ['cm', 0.01],
    ['mm', 0.001],
    ['in', 0.0254]
  ])('converts %s to metres with a factor of %p', (unit, expected) => {
    setUnitSelector(unit);
    expect(modelScaleToMetres()).toBe(expected);
  });

  // The backend accepts only the four factors this map can produce, so a value
  // outside it would have the run rejected rather than silently mis-scaled.
  it('exposes exactly the four factors the backend accepts', () => {
    expect(Object.values(UNIT_TO_METRES).sort()).toEqual([0.001, 0.0254, 0.01, 1].sort());
  });

  it('falls back to metres when the selector holds an unrecognised unit', () => {
    setUnitSelector('m');
    // Bypasses the <option> list the way a stale cached page or tampering could.
    const select = document.getElementById('unit-select');
    Object.defineProperty(select, 'value', { value: 'furlongs', configurable: true });

    expect(readModelUnit()).toBe('m');
    expect(modelScaleToMetres()).toBe(1);
  });

  it('falls back to metres when the selector is absent from the page', () => {
    document.body.innerHTML = '';

    expect(readModelUnit()).toBe('m');
    expect(modelScaleToMetres()).toBe(1);
  });
});

describe('viewer scaling stays unchanged', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  // loadSTL normalises into the app's mm world units as `modelScaleToMetres()
  // * 1000`. That refactor must reproduce the factors that were previously
  // open-coded there, or every model would render at the wrong size.
  it.each([
    ['m', 1000],
    ['cm', 10],
    ['mm', 1],
    ['in', 25.4]
  ])('scales a %s model into viewer mm by %p', (unit, expected) => {
    setUnitSelector(unit);
    expect(modelScaleToMetres() * 1000).toBeCloseTo(expected, 10);
  });
});
