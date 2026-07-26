/**
 * @jest-environment node
 */

const fs = require('fs');
const path = require('path');
const THREE = require('three');

// Load main.js
const mainJsSource = fs.readFileSync(path.resolve(__dirname, 'public/js/main.js'), 'utf8');

// We need to extract the calculateSurfaceArea function.
const calculateSurfaceAreaSourceMatch = mainJsSource.match(/function calculateSurfaceArea\(geometry\) \{[\s\S]*?return area;\n\}/);
if (!calculateSurfaceAreaSourceMatch) {
  console.error("Could not find calculateSurfaceArea function in main.js");
  process.exit(1);
}
const calculateSurfaceAreaSource = calculateSurfaceAreaSourceMatch[0];
let calculateSurfaceArea;
eval(`
  calculateSurfaceArea = ${calculateSurfaceAreaSource}
`);

describe('Geometry Math Functions - calculateSurfaceArea', () => {
  it('calculates the surface area of a 1x1x1 box correctly (indexed)', () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const area = calculateSurfaceArea(geometry);
    expect(area).toBeCloseTo(6, 5); // 6 faces, each 1x1
  });

  it('calculates the surface area of a 2x3x4 box correctly (indexed)', () => {
    const geometry = new THREE.BoxGeometry(2, 3, 4);
    const area = calculateSurfaceArea(geometry);
    // Area = 2 * (2*3 + 2*4 + 3*4) = 2 * (6 + 8 + 12) = 2 * 26 = 52
    expect(area).toBeCloseTo(52, 5);
  });

  it('calculates the surface area of a non-indexed box correctly', () => {
    const geometry = new THREE.BoxGeometry(2, 3, 4).toNonIndexed();
    const area = calculateSurfaceArea(geometry);
    expect(area).toBeCloseTo(52, 5);
  });

  it('calculates the surface area of a flat plane correctly', () => {
    const geometry = new THREE.PlaneGeometry(10, 10);
    const area = calculateSurfaceArea(geometry);
    // Plane 10x10 = 100
    expect(area).toBeCloseTo(100, 5);
  });

  it('calculates area as 0 for a geometry with 0,0,0 dimensions', () => {
    const geometry = new THREE.BoxGeometry(0, 0, 0);
    const area = calculateSurfaceArea(geometry);
    expect(area).toBe(0);
  });

  it('throws an error if geometry has no position attribute', () => {
    const geometry = new THREE.BufferGeometry();
    expect(() => calculateSurfaceArea(geometry)).toThrow();
  });
});
