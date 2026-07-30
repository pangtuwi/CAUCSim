/**
 * @jest-environment node
 */

const fs = require('fs');
const path = require('path');
const THREE = require('three');

// Load main.js
const mainJsSource = fs.readFileSync(path.resolve(__dirname, 'frontend/cfd/js/main.js'), 'utf8');

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

// Extract calculateVolume function.
const calculateVolumeSourceMatch = mainJsSource.match(/function calculateVolume\(geometry\) \{[\s\S]*?return Math\.abs\(volume\);\n\}/);
if (!calculateVolumeSourceMatch) {
  console.error("Could not find calculateVolume function in main.js");
  process.exit(1);
}
const calculateVolumeSource = calculateVolumeSourceMatch[0];
let calculateVolume;
eval(`
  calculateVolume = ${calculateVolumeSource}
`);

const calculateFrontalAreaSourceMatch = mainJsSource.match(/function calculateFrontalArea\(geometry, size\) \{[\s\S]*?return frontalAreaMm2 \/ 1000000; \/\/ mm² -> m²\n\}/);
if (!calculateFrontalAreaSourceMatch) {
  console.error("Could not find calculateFrontalArea function in main.js");
  process.exit(1);
}
let calculateFrontalArea;
eval(`
  calculateFrontalArea = ${calculateFrontalAreaSourceMatch[0]}
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

describe('Geometry Math Functions - calculateVolume', () => {
  it('calculates the volume of a 1x1x1 box correctly (indexed)', () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const volume = calculateVolume(geometry);
    expect(volume).toBeCloseTo(1, 5);
  });

  it('calculates the volume of a 2x3x4 box correctly (indexed)', () => {
    const geometry = new THREE.BoxGeometry(2, 3, 4);
    const volume = calculateVolume(geometry);
    // Volume = 2 * 3 * 4 = 24
    expect(volume).toBeCloseTo(24, 5);
  });

  it('calculates the volume of a non-indexed box correctly', () => {
    const geometry = new THREE.BoxGeometry(2, 3, 4).toNonIndexed();
    const volume = calculateVolume(geometry);
    expect(volume).toBeCloseTo(24, 5);
  });

  it('calculates the volume of a flat plane correctly as 0', () => {
    const geometry = new THREE.PlaneGeometry(10, 10);
    const volume = calculateVolume(geometry);
    // Plane has no volume
    expect(volume).toBeCloseTo(0, 5);
  });

  it('calculates volume as 0 for a geometry with 0,0,0 dimensions', () => {
    const geometry = new THREE.BoxGeometry(0, 0, 0);
    const volume = calculateVolume(geometry);
    expect(volume).toBe(0);
  });

  it('throws an error if geometry has no position attribute', () => {
    const geometry = new THREE.BufferGeometry();
    expect(() => calculateVolume(geometry)).toThrow();
  });
});

describe('Geometry Math Functions - calculateFrontalArea', () => {
  it('calculates the frontal area of a 10x100x100 box correctly', () => {
    // A box with width(Y)=100, height(Z)=100 has a frontal area on YZ plane of 10000 mm^2 = 0.01 m^2
    const geometry = new THREE.BoxGeometry(10, 100, 100);
    geometry.computeBoundingBox();
    const size = new THREE.Vector3();
    geometry.boundingBox.getSize(size);
    const area = calculateFrontalArea(geometry, size);
    expect(area).toBeCloseTo(0.01, 3);
  });

  it('calculates the frontal area of a non-indexed box correctly', () => {
    const geometry = new THREE.BoxGeometry(10, 100, 100).toNonIndexed();
    geometry.computeBoundingBox();
    const size = new THREE.Vector3();
    geometry.boundingBox.getSize(size);
    const area = calculateFrontalArea(geometry, size);
    expect(area).toBeCloseTo(0.01, 3);
  });

  it('calculates the frontal area of a flat plane correctly', () => {
    const geometry = new THREE.PlaneGeometry(100, 100);
    geometry.rotateX(Math.PI / 2); // Now in XZ plane
    geometry.rotateZ(Math.PI / 2); // Now in YZ plane
    geometry.computeBoundingBox();
    const size = new THREE.Vector3();
    geometry.boundingBox.getSize(size);
    const area = calculateFrontalArea(geometry, size);
    expect(area).toBeCloseTo(0.01, 3);
  });

  it('returns 0 for geometry with width or height <= 0', () => {
    const geometry = new THREE.BoxGeometry(10, 10, 10);
    expect(calculateFrontalArea(geometry, new THREE.Vector3(10, 0, 10))).toBe(0);
    expect(calculateFrontalArea(geometry, new THREE.Vector3(10, 10, 0))).toBe(0);
  });

  it('handles low vs high face count geometries (dynamic grid resolution)', () => {
    const size = new THREE.Vector3(100, 100, 100);

    // Low face count
    const geomLow = new THREE.BoxGeometry(100, 100, 100);
    geomLow.computeBoundingBox();
    const areaLow = calculateFrontalArea(geomLow, size);
    expect(areaLow).toBeGreaterThan(0.009); // should be close to 0.01

    // High face count > 150000
    // SphereGeometry(radius, widthSegments, heightSegments)
    // 400 * 400 * 2 = 320,000 faces
    const geomHigh = new THREE.SphereGeometry(50, 400, 400);
    geomHigh.computeBoundingBox();
    geomHigh.boundingBox.getSize(size);
    const areaHigh = calculateFrontalArea(geomHigh, size);
    // Area of sphere projected is a circle of radius 50 = pi * 50^2 = 7853.98 mm^2 = 0.00785 m^2
    expect(areaHigh).toBeCloseTo(0.00785, 2);
  });
});
