/**
 * @jest-environment node
 */

process.env.S3_BUCKET_NAME = 'mock-bucket';
process.env.COGNITO_USER_POOL_ID = 'us-east-1_mockpool';
process.env.COGNITO_CLIENT_ID = 'mockclient';
process.env.NODE_ENV = 'test';

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  PutObjectCommand: jest.fn(),
  GetObjectCommand: jest.fn(),
  DeleteObjectCommand: jest.fn(),
  HeadObjectCommand: jest.fn(),
  ListObjectsV2Command: jest.fn()
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

const { buildJobSummaryMarkdown, buildCoefficientHistoryCsv } = require('./backend/app/app');

// Modelled on a real completed job.
const completedJob = (overrides = {}, metricOverrides = {}) => ({
  jobId: 'job-1788642294567-62e9ae44',
  originalName: 'car.stl',
  status: 'completed',
  startedAt: '2026-09-05T21:04:54.567Z',
  completedAt: '2026-09-05T21:07:05.930Z',
  frontalArea: 0.6571292656817072,
  raceSpeedMph: 30,
  wheelbase: 1.8,
  momentCentreX: 1.17,
  fastCheck: false,
  metricsError: null,
  metrics: {
    cd: 0.28227, cl: -0.091302, cm: -0.14279,
    cdStd: 0.112994, clStd: 0.120136, cmStd: 0.032365,
    converged: true, sampleCount: 200, iterations: 500,
    aref: 0.657129, cda: 0.185488, cla: -0.059997,
    dragForce: 20.4, liftForce: -6.6, aeroPower: 274,
    ...metricOverrides
  },
  ...overrides
});

describe('buildJobSummaryMarkdown', () => {
  describe('provenance', () => {
    it('records the job identity and timings', () => {
      const md = buildJobSummaryMarkdown(completedJob());

      expect(md).toContain('# CFD Summary — car.stl');
      expect(md).toContain('job-1788642294567-62e9ae44');
      expect(md).toContain('2026-09-05T21:07:05.930Z');
    });

    // Without these the coefficients cannot be checked or reproduced later.
    it('records every value the coefficients were normalised by', () => {
      const md = buildJobSummaryMarkdown(completedJob());

      expect(md).toContain('30.0 mph (13.41 m/s)');
      expect(md).toContain('0.6571 m²');      // Aref
      expect(md).toContain('1.800 m');        // lRef
      expect(md).toContain('(1.170 0 0)');    // CofR
    });

    it('says which fidelity the run used', () => {
      expect(buildJobSummaryMarkdown(completedJob())).toContain('Full (refined, 500 iterations)');
      expect(buildJobSummaryMarkdown(completedJob({ fastCheck: true })))
        .toContain('Fast check (coarse, 50 iterations)');
    });
  });

  describe('coefficients', () => {
    it('reports each coefficient with its spread', () => {
      const md = buildJobSummaryMarkdown(completedJob());

      expect(md).toContain('0.282 ± 0.113');
      expect(md).toContain('-0.091 ± 0.120');
      expect(md).toContain('-0.143 ± 0.032');
    });

    it('reports a bare coefficient when no spread was recorded', () => {
      const md = buildJobSummaryMarkdown(
        completedJob({}, { cdStd: undefined, clStd: undefined, cmStd: undefined })
      );

      expect(md).toContain('| Drag, `Cd` | 0.282 |');
    });

    it('reports the forces at the speed the run was solved at', () => {
      const md = buildJobSummaryMarkdown(completedJob());

      expect(md).toContain('## Forces at 30.0 mph');
      expect(md).toContain('20.4 N');
      expect(md).toContain('274 W');
    });
  });

  describe('caveats', () => {
    // The warning has to precede the numbers, or someone skims the table and
    // takes an untrustworthy figure at face value.
    it('puts the fast-check warning above the results', () => {
      const md = buildJobSummaryMarkdown(completedJob({ fastCheck: true }));

      expect(md).toContain('Fast check run — these results are not accurate');
      expect(md.indexOf('Fast check run')).toBeLessThan(md.indexOf('## Aerodynamic coefficients'));
    });

    it('warns above the results when the solve had not converged', () => {
      const md = buildJobSummaryMarkdown(completedJob({}, { converged: false }));

      expect(md).toContain('Not converged');
      expect(md.indexOf('Not converged')).toBeLessThan(md.indexOf('## Aerodynamic coefficients'));
    });

    it('confirms convergence and the window it was measured over', () => {
      const md = buildJobSummaryMarkdown(completedJob());

      expect(md).toContain('Converged. Values are the mean of the final 200 of 500 iterations.');
    });

    it('explains that the spread is oscillation, not error', () => {
      expect(buildJobSummaryMarkdown(completedJob())).toContain('not an error bar');
    });
  });

  describe('incomplete jobs', () => {
    it('says so when no coefficients were produced, and why', () => {
      const md = buildJobSummaryMarkdown(completedJob({
        metrics: null,
        metricsError: 'The solver produced no usable force history.'
      }));

      expect(md).toContain('No aerodynamic results are available');
      expect(md).toContain('no usable force history');
      // The inputs are still worth recording for a failed run.
      expect(md).toContain('## Simulation inputs');
    });

    it('still renders when nothing but the job id is known', () => {
      const md = buildJobSummaryMarkdown({ jobId: 'job-bare' });

      expect(md).toContain('job-bare');
      expect(md).toContain('not recorded');
      expect(() => buildJobSummaryMarkdown({ jobId: 'x' })).not.toThrow();
    });

    it('falls back to the default race speed when none was recorded', () => {
      const md = buildJobSummaryMarkdown(completedJob({ raceSpeedMph: undefined }));

      expect(md).toMatch(/Race speed \| \d+\.\d mph/);
    });
  });
});

describe('buildCoefficientHistoryCsv', () => {
  // Shaped like a real OpenFOAM 13 forceCoeffs.dat.
  const HISTORY = [
    '# Force coefficients',
    '# magUInf     : 1.341120e+01',
    '# lRef        : 2.340000e+00',
    '# Aref        : 6.571290e-01',
    '# Time        \tCm            \tCd            \tCl            \tCl(f)         \tCl(r)         ',
    '0             \t2.428109e-03\t1.875034e-02\t9.187129e-05\t2.474044e-03\t-2.382173e-03',
    '1             \t-7.291676e-02\t6.120765e-01\t-4.958101e-01\t-3.208218e-01\t-1.749883e-01',
    '2             \t-1.313830e-01\t3.154900e-01\t-1.967192e-01\t-2.297426e-01\t3.302338e-02'
  ].join('\n') + '\n';

  it('takes its column names from the file header', () => {
    const csv = buildCoefficientHistoryCsv(HISTORY);

    expect(csv.split('\n')[0]).toBe('Time,Cm,Cd,Cl,Cl(f),Cl(r)');
  });

  it('emits one row per iteration', () => {
    const rows = buildCoefficientHistoryCsv(HISTORY).trim().split('\n');

    expect(rows).toHaveLength(4); // header + 3 iterations
    expect(rows[1]).toBe('0,2.428109e-03,1.875034e-02,9.187129e-05,2.474044e-03,-2.382173e-03');
    expect(rows[3].startsWith('2,')).toBe(true);
  });

  // The provenance belongs in the Markdown summary; a leading "#" block would
  // show up as junk rows in Excel.
  it('carries no comment lines through into the CSV', () => {
    const csv = buildCoefficientHistoryCsv(HISTORY);

    expect(csv).not.toContain('#');
    expect(csv).not.toContain('magUInf');
  });

  it('keeps every column, not just the three that are reported', () => {
    const csv = buildCoefficientHistoryCsv(HISTORY);

    expect(csv).toContain('Cl(f)');
    expect(csv.trim().split('\n').every((line) => line.split(',').length === 6)).toBe(true);
  });

  it('falls back to generic names when the header is missing', () => {
    const csv = buildCoefficientHistoryCsv('1\t0.1\t0.2\t0.3\n2\t0.1\t0.2\t0.3\n');

    expect(csv.split('\n')[0]).toBe('Time,Column1,Column2,Column3');
  });

  // A header that disagrees with the data would silently mislabel columns.
  it('ignores a header whose width does not match the data', () => {
    const csv = buildCoefficientHistoryCsv('# Time\tCm\n1\t0.1\t0.2\t0.3\n');

    expect(csv.split('\n')[0]).toBe('Time,Column1,Column2,Column3');
  });

  it.each([
    ['an empty string', ''],
    ['only comments', '# Force coefficients\n# Aref : 0.65\n'],
    ['only whitespace', '  \n\t\n'],
    ['a non-string', undefined]
  ])('returns null for %s', (_label, input) => {
    expect(buildCoefficientHistoryCsv(input)).toBeNull();
  });

  it('skips non-numeric rows', () => {
    const csv = buildCoefficientHistoryCsv('# Time\tCd\n1\t0.3\nbroken row here\n2\t0.4\n');

    expect(csv.trim().split('\n')).toHaveLength(3); // header + 2 good rows
  });
});
