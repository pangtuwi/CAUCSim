/**
 * @jest-environment node
 */
process.env.S3_BUCKET_NAME = 'mock-bucket';
process.env.COGNITO_USER_POOL_ID = 'us-east-1_mockpool';
process.env.COGNITO_CLIENT_ID = 'mockclient';
process.env.NODE_ENV = 'test';

const { meanOf } = require('./app');

describe('meanOf', () => {
  it('calculates the mean of an array of positive numbers', () => {
    expect(meanOf([1, 2, 3, 4, 5])).toBe(3);
    expect(meanOf([10, 20])).toBe(15);
  });

  it('calculates the mean of an array of negative numbers', () => {
    expect(meanOf([-1, -2, -3, -4, -5])).toBe(-3);
  });

  it('calculates the mean of an array with a single element', () => {
    expect(meanOf([42])).toBe(42);
  });

  it('calculates the mean of an array with zeroes', () => {
    expect(meanOf([0, 0, 0])).toBe(0);
    expect(meanOf([0, 10, -10])).toBe(0);
  });

  it('handles floating point numbers', () => {
    expect(meanOf([1.5, 2.5, 3.5])).toBeCloseTo(2.5);
  });

  it('returns NaN for an empty array', () => {
    expect(meanOf([])).toBeNaN();
  });
});
