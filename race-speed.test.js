/**
 * @jest-environment jsdom
 */

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

const raceSpeedMsSource = sliceBetween(
  MAIN_JS,
  'function raceSpeedMs(mph) {',
  '// Authentication State',
  'raceSpeedMs function'
).trim();

// The slice gets everything from the function keyword up to the next section marker.
// Now we wrap it in a new Function to evaluate and return it safely.
// Since raceSpeedMs uses MPH_TO_MS from its enclosing scope, we pass that in.
const factory = new Function('deps', `
  const { MPH_TO_MS } = deps;
  ${raceSpeedMsSource}
  return raceSpeedMs;
`);

const MPH_TO_MS = 0.44704;
const raceSpeedMs = factory({ MPH_TO_MS });

describe('Speed Calculation - raceSpeedMs', () => {
  it('correctly converts the default race speed to ms', () => {
    const expectedMs = 30 * 0.44704;
    expect(raceSpeedMs(30)).toBeCloseTo(expectedMs, 5);
  });

  it('correctly calculates ms when raceSpeedMph is modified', () => {
    const expectedMs = 100 * 0.44704;
    expect(raceSpeedMs(100)).toBeCloseTo(expectedMs, 5);
  });

  it('correctly calculates ms when raceSpeedMph is 0', () => {
    expect(raceSpeedMs(0)).toBe(0);
  });
});
