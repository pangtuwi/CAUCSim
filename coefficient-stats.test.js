/**
 * @jest-environment node
 */

// app.js throws on import without these, and constructs an S3 client.
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

const { computeCoefficientStatistics } = require('./backend/app/app');

const HEADER = [
  '# Force coefficients',
  '# Aref         : 0.657129',
  '# lRef         : 1.42',
  '# Time         Cm            Cd            Cl'
].join('\n');

// Build a forceCoeffs.dat body. `shape(i)` returns { cm, cd, cl } for iteration i.
function buildTrace(count, shape, { header = true } = {}) {
  const rows = [];
  for (let i = 1; i <= count; i++) {
    const { cm, cd, cl } = shape(i);
    rows.push(`${i}\t${cm.toExponential(6)}\t${cd.toExponential(6)}\t${cl.toExponential(6)}`);
  }
  return (header ? HEADER + '\n' : '') + rows.join('\n') + '\n';
}

// A settled bluff-body solve: a steady mean with the genuine vortex-shedding
// oscillation the reference runs measured at roughly ±0.003–0.008.
const converged = (base) => (i) => ({
  cm: base.cm + 0.004 * Math.sin(i / 3),
  cd: base.cd + 0.004 * Math.sin(i / 4),
  cl: base.cl + 0.005 * Math.cos(i / 5)
});

describe('computeCoefficientStatistics', () => {
  describe('unusable input', () => {
    it.each([
      ['an empty string', ''],
      ['only comments', '# Force coefficients\n# Aref : 0.65\n'],
      ['only whitespace', '   \n\n\t\n'],
      ['rows with too few columns', '# h\n1 0.1\n2 0.2\n'],
      ['non-numeric rows', '# h\nalpha beta gamma delta\n'],
      ['a non-string', undefined],
      ['a null', null]
    ])('returns null for %s', (_label, input) => {
      expect(computeCoefficientStatistics(input)).toBeNull();
    });

    it('skips malformed rows but keeps the usable ones', () => {
      const contents = [
        '# Time Cm Cd Cl',
        '1\t-0.05\t0.310\t-0.190',
        'this row is broken',
        '2\t-0.05\t0.310\t-0.190',
        '3\tNaN\tNaN\tNaN',
        '4\t-0.05\t0.310\t-0.190'
      ].join('\n');

      const stats = computeCoefficientStatistics(contents);
      expect(stats.iterations).toBe(3);
      expect(stats.cd).toBeCloseTo(0.31, 6);
    });
  });

  describe('reported values', () => {
    it('reports the mean of the trailing window, not the final iteration', () => {
      // Alternates about 0.300; the last row alone would read 0.310.
      const contents = buildTrace(400, (i) => ({
        cm: -0.05,
        cd: i % 2 === 0 ? 0.29 : 0.31,
        cl: -0.2
      }));

      const stats = computeCoefficientStatistics(contents);
      expect(stats.cd).toBeCloseTo(0.3, 6);
      expect(stats.sampleCount).toBe(200);
      expect(stats.iterations).toBe(400);
    });

    it('reports a spread that reflects the oscillation', () => {
      const stats = computeCoefficientStatistics(
        buildTrace(500, converged({ cm: -0.05, cd: 0.267, cl: -0.197 }))
      );

      expect(stats.cdStd).toBeGreaterThan(0);
      expect(stats.cdStd).toBeLessThan(0.01);
      expect(stats.clStd).toBeGreaterThan(0);
    });

    it('reports a zero spread for a perfectly flat trace', () => {
      const stats = computeCoefficientStatistics(
        buildTrace(300, () => ({ cm: -0.05, cd: 0.267, cl: -0.197 }))
      );

      expect(stats.cdStd).toBeCloseTo(0, 10);
      expect(stats.cd).toBeCloseTo(0.267, 6);
      expect(stats.cl).toBeCloseTo(-0.197, 6);
      expect(stats.cm).toBeCloseTo(-0.05, 6);
    });

    it('reads Aref from the header so CdA is built from what the solve used', () => {
      const stats = computeCoefficientStatistics(
        buildTrace(300, () => ({ cm: -0.05, cd: 0.267, cl: -0.197 }))
      );

      expect(stats.aref).toBeCloseTo(0.657129, 6);
    });

    it('reports a null Aref when the header carries none', () => {
      const stats = computeCoefficientStatistics(
        buildTrace(300, () => ({ cm: -0.05, cd: 0.267, cl: -0.197 }), { header: false })
      );

      expect(stats.aref).toBeNull();
    });
  });

  describe('convergence', () => {
    it('accepts a settled solve that is still oscillating', () => {
      const stats = computeCoefficientStatistics(
        buildTrace(500, converged({ cm: -0.05, cd: 0.267, cl: -0.197 }))
      );

      expect(stats.converged).toBe(true);
    });

    // The regression case from the controlled comparison: at iteration 50 Cl was
    // still falling by ~0.0024 per step and Cd still climbing by ~0.0006. That
    // run must never be reported as a settled answer.
    it('rejects the still-drifting trace from the reference comparison', () => {
      const stats = computeCoefficientStatistics(
        buildTrace(500, (i) => ({
          cm: -0.05,
          cd: 0.2 + 0.0006 * i,
          cl: 0.063 - 0.0024 * i
        }))
      );

      expect(stats.converged).toBe(false);
    });

    it('rejects a run that drifts only in Cl', () => {
      const stats = computeCoefficientStatistics(
        buildTrace(500, (i) => ({ cm: -0.05, cd: 0.267, cl: -0.1 - 0.0005 * i }))
      );

      expect(stats.converged).toBe(false);
    });

    it('rejects a run that drifts only in Cd', () => {
      const stats = computeCoefficientStatistics(
        buildTrace(500, (i) => ({ cm: -0.05, cd: 0.2 + 0.0005 * i, cl: -0.197 }))
      );

      expect(stats.converged).toBe(false);
    });

    // A 50-iteration fast check collapses every comparison window onto the same
    // rows, so there is nothing to compare — which is the honest answer.
    it('cannot certify a 50-iteration fast check', () => {
      const stats = computeCoefficientStatistics(
        buildTrace(50, converged({ cm: -0.05, cd: 0.267, cl: -0.197 }))
      );

      expect(stats.converged).toBe(false);
      expect(stats.sampleCount).toBe(50);
      expect(stats.iterations).toBe(50);
      // It still reports a usable mean, just an untrustworthy one.
      expect(stats.cd).toBeGreaterThan(0.26);
      expect(stats.cd).toBeLessThan(0.275);
    });

    it('cannot certify a single-iteration run', () => {
      const stats = computeCoefficientStatistics('# h\n1\t-0.05\t0.310\t-0.190\n');

      expect(stats.converged).toBe(false);
      expect(stats.sampleCount).toBe(1);
      expect(stats.cdStd).toBe(0);
    });

    // Above 100 rows the windows separate, so a settled run can be certified
    // without waiting for the full 200.
    it('can certify a settled run between the window sizes', () => {
      const stats = computeCoefficientStatistics(
        buildTrace(175, converged({ cm: -0.05, cd: 0.267, cl: -0.197 }))
      );

      expect(stats.converged).toBe(true);
      expect(stats.sampleCount).toBe(175);
    });

    // The tolerance scales with magnitude, so a large coefficient is not held to
    // an unreachable absolute drift.
    it('tolerates proportionally small drift on a large coefficient', () => {
      const stats = computeCoefficientStatistics(
        buildTrace(500, (i) => ({ cm: -0.05, cd: 2.0 + 0.00001 * i, cl: -0.197 }))
      );

      expect(stats.converged).toBe(true);
    });
  });
});
