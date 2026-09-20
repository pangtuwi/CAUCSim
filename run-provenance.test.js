/**
 * @jest-environment jsdom
 */

// The Aerodynamic Summary used to show coefficients with nothing tying them to
// the run that produced them -- no run name, no model file, none of the inputs
// they were normalised by. These cover the rows that now carry that.

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

const provenanceSource = sliceBetween(
  MAIN_JS,
  'const MODEL_SCALE_NAMES',
  'function displayCfdResults(',
  'run provenance helpers'
).trim();

const factory = new Function('deps', `
  const { MPH_TO_MS, DEFAULT_RACE_SPEED_MPH } = deps;
  ${provenanceSource}
  return { runProvenanceRows, formatRunTimestamp, renderRunProvenance };
`);

const { runProvenanceRows, formatRunTimestamp, renderRunProvenance } = factory({
  MPH_TO_MS: 0.44704,
  DEFAULT_RACE_SPEED_MPH: 30
});

// The container renderRunProvenance writes into, mirroring index.html.
const mountProvenanceMarkup = () => {
  document.body.innerHTML = `
    <div id="run-provenance">
      <div id="run-provenance-name"></div>
      <div id="run-provenance-file"></div>
      <p id="run-provenance-purpose"></p>
      <details><summary>Simulation inputs</summary>
        <dl id="run-provenance-inputs"></dl>
      </details>
    </div>`;
};

// Modelled on a real completed job, matching job-summary.test.js.
const completedJob = (overrides = {}) => ({
  jobId: 'job-1788642294567-62e9ae44',
  originalName: 'car.stl',
  runName: 'Baseline - no changes yet',
  purpose: 'First run to see what the standard shell does.',
  status: 'completed',
  completedAt: '2026-09-05T21:07:05.930Z',
  frontalArea: 0.6571292656817072,
  raceSpeedMph: 30,
  wheelbase: 1.8,
  momentCentreX: 1.17,
  modelScaleToMetres: 1,
  fastCheck: false,
  metrics: { aref: 0.657129, cd: 0.28227 },
  ...overrides
});

// The rows are [label, value] pairs; look them up by label.
const rowValue = (job, label) => {
  const row = runProvenanceRows(job).find(([l]) => l === label);
  if (!row) throw new Error(`No "${label}" row — labels: ${runProvenanceRows(job).map(([l]) => l).join(', ')}`);
  return row[1];
};

describe('runProvenanceRows', () => {
  it('names the model the run was solved on', () => {
    expect(rowValue(completedJob(), 'Model file')).toBe('car.stl');
  });

  // Every value the coefficients were normalised by, so a result can be
  // checked or reproduced later.
  it('records the inputs the coefficients depend on', () => {
    const job = completedJob();

    expect(rowValue(job, 'Race speed')).toBe('30.0 mph (13.41 m/s)');
    expect(rowValue(job, 'Frontal area (Aref)')).toBe('0.6571 m²');
    expect(rowValue(job, 'Wheelbase (lRef)')).toBe('1.800 m');
    expect(rowValue(job, 'Moment centre (CofR)')).toBe('1.170 m');
    expect(rowValue(job, 'Run ID')).toBe('job-1788642294567-62e9ae44');
  });

  // Aref as the solver reported it is authoritative; the client's measurement
  // is only a fallback for runs that never reported one.
  it('prefers the solver-reported frontal area over the client measurement', () => {
    const job = completedJob({ frontalArea: 0.5, metrics: { aref: 0.9 } });
    expect(rowValue(job, 'Frontal area (Aref)')).toBe('0.9000 m²');

    const noMetrics = completedJob({ frontalArea: 0.5, metrics: null });
    expect(rowValue(noMetrics, 'Frontal area (Aref)')).toBe('0.5000 m²');
  });

  it.each([
    [1, 'metres'],
    [0.01, 'centimetres'],
    [0.001, 'millimetres'],
    [0.0254, 'inches']
  ])('reports a scale of %p as %s', (modelScaleToMetres, expected) => {
    expect(rowValue(completedJob({ modelScaleToMetres }), 'Model units')).toBe(expected);
  });

  it('distinguishes a fast check from a full run', () => {
    expect(rowValue(completedJob(), 'Mesh')).toMatch(/^Full/);
    expect(rowValue(completedJob({ fastCheck: true }), 'Mesh')).toMatch(/^Fast check/);
  });

  describe('fields a run may not carry', () => {
    // Claiming a default for a run that predates a field would assert
    // something we do not know about how it was actually solved.
    it.each([
      ['originalName', 'Model file'],
      ['wheelbase', 'Wheelbase (lRef)'],
      ['momentCentreX', 'Moment centre (CofR)'],
      ['modelScaleToMetres', 'Model units'],
      ['completedAt', 'Finished'],
      ['jobId', 'Run ID']
    ])('says "not recorded" rather than guessing when %s is absent', (field, label) => {
      const job = completedJob();
      delete job[field];
      expect(rowValue(job, label)).toBe('not recorded');
    });

    it('says "not recorded" when no frontal area was captured at all', () => {
      expect(rowValue(completedJob({ frontalArea: null, metrics: null }), 'Frontal area (Aref)'))
        .toBe('not recorded');
    });

    // Zero is a legitimate moment centre -- a car whose CofR sits on the
    // origin -- and must not be mistaken for a missing value.
    it('keeps a moment centre of zero', () => {
      expect(rowValue(completedJob({ momentCentreX: 0 }), 'Moment centre (CofR)')).toBe('0.000 m');
    });

    // The run still has to be identifiable even with nothing else recorded.
    it('produces a full set of rows for a bare legacy job', () => {
      const rows = runProvenanceRows({ jobId: 'job-legacy' });

      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every(([, value]) => typeof value === 'string' && value.length > 0)).toBe(true);
      expect(rowValue({ jobId: 'job-legacy' }, 'Run ID')).toBe('job-legacy');
    });
  });
});

describe('renderRunProvenance', () => {
  beforeEach(mountProvenanceMarkup);
  afterEach(() => { document.body.innerHTML = ''; });

  it('leads with the run name and shows the model file and purpose', () => {
    renderRunProvenance(completedJob());

    expect(document.getElementById('run-provenance-name').textContent)
      .toBe('Baseline - no changes yet');
    expect(document.getElementById('run-provenance-file').textContent).toBe('car.stl');
    expect(document.getElementById('run-provenance-purpose').textContent)
      .toBe('First run to see what the standard shell does.');
  });

  it('falls back to the model name, then the job id, for an unnamed run', () => {
    renderRunProvenance(completedJob({ runName: '' }));
    expect(document.getElementById('run-provenance-name').textContent).toBe('car.stl');

    renderRunProvenance({ jobId: 'job-bare' });
    expect(document.getElementById('run-provenance-name').textContent).toBe('job-bare');
  });

  // An empty paragraph would otherwise leave a gap above the inputs.
  it('hides the purpose line when the run carries no notes', () => {
    renderRunProvenance(completedJob({ purpose: '' }));
    expect(document.getElementById('run-provenance-purpose').style.display).toBe('none');

    renderRunProvenance(completedJob());
    expect(document.getElementById('run-provenance-purpose').style.display).toBe('block');
  });

  it('writes one dt/dd pair per input row', () => {
    renderRunProvenance(completedJob());
    const inputs = document.getElementById('run-provenance-inputs');
    const expected = runProvenanceRows(completedJob()).length;

    expect(inputs.querySelectorAll('dt')).toHaveLength(expected);
    expect(inputs.querySelectorAll('dd')).toHaveLength(expected);
    expect(inputs.querySelector('dt').textContent).toBe('Model file');
  });

  // Switching between runs in the history must not accumulate rows.
  it('replaces the previous run rather than appending to it', () => {
    renderRunProvenance(completedJob());
    const first = document.getElementById('run-provenance-inputs').querySelectorAll('dt').length;

    renderRunProvenance(completedJob({ runName: 'Second run', originalName: 'other.stl' }));
    const inputs = document.getElementById('run-provenance-inputs');

    expect(inputs.querySelectorAll('dt')).toHaveLength(first);
    expect(document.getElementById('run-provenance-name').textContent).toBe('Second run');
    expect(inputs.textContent).toContain('other.stl');
    expect(inputs.textContent).not.toContain('car.stl');
  });

  // The run name, purpose and file name are all user input. They are written
  // with textContent, so markup in them stays text and is never parsed.
  it('does not let markup in user-supplied fields become elements', () => {
    renderRunProvenance(completedJob({
      runName: '<img src=x onerror="alert(1)">',
      purpose: '<script>alert(2)</script>',
      originalName: '<b>bold</b>.stl'
    }));

    const container = document.getElementById('run-provenance');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(document.getElementById('run-provenance-name').textContent)
      .toBe('<img src=x onerror="alert(1)">');
  });

  // The panel is rendered before the metrics check, so a completed run whose
  // coefficients could not be derived still says which run it was.
  it('renders for a run that produced no metrics', () => {
    renderRunProvenance(completedJob({ metrics: null, frontalArea: null }));

    expect(document.getElementById('run-provenance-name').textContent)
      .toBe('Baseline - no changes yet');
    expect(document.getElementById('run-provenance-inputs').textContent)
      .toContain('not recorded');
  });

  // Called on every results render, including before the markup exists.
  it('does nothing when the panel is not in the document', () => {
    document.body.innerHTML = '';
    expect(() => renderRunProvenance(completedJob())).not.toThrow();
  });
});

describe('formatRunTimestamp', () => {
  it('formats a real timestamp', () => {
    expect(formatRunTimestamp('2026-09-05T21:07:05.930Z')).toMatch(/Sep/);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['an unparseable string', 'not a date']
  ])('does not render an Invalid Date for %s', (_label, value) => {
    expect(formatRunTimestamp(value)).toBe('not recorded');
  });
});
