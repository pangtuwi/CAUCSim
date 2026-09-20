/**
 * @jest-environment jsdom
 */

// Trackpad zoom was close to unusable: OrbitControls scales each zoom step by
// |deltaY| and r160 divides it by devicePixelRatio, so a pinch (deltaY ~1-10)
// moved the camera ~0.05% per event against a mouse wheel notch's 2.5%. These
// cover the per-event speed that compensates for it.

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

const zoomSource = sliceBetween(
  MAIN_JS,
  'const TRACKPAD_ZOOM_BOOST',
  'function initThree()',
  'wheelZoomSpeed'
).trim();

const factory = new Function(`
  ${zoomSource}
  return { wheelZoomSpeed, TRACKPAD_ZOOM_BOOST };
`);

const { wheelZoomSpeed, TRACKPAD_ZOOM_BOOST } = factory();

// A wheel event, with the fields the classifier reads.
const wheel = ({ deltaY = 100, deltaMode = 0, ctrlKey = false } = {}) =>
  ({ deltaY, deltaMode, ctrlKey });

// The step OrbitControls r160 actually applies, for asserting on real effect
// rather than on the multiplier in isolation.
const zoomStep = (event, dpr) => {
  const speed = wheelZoomSpeed(event, dpr);
  return Math.pow(0.95, speed * Math.abs(event.deltaY) / (100 * (dpr | 0)));
};
const percentPerEvent = (event, dpr) => (1 - zoomStep(event, dpr)) * 100;

describe('wheelZoomSpeed', () => {
  describe('trackpad gestures are boosted', () => {
    // Browsers report pinch-zoom as a wheel event with ctrlKey set. That holds
    // however large the delta is, so it must win over the delta test.
    it('treats a ctrlKey wheel event as a pinch at any delta', () => {
      expect(wheelZoomSpeed(wheel({ ctrlKey: true, deltaY: 2 }), 1)).toBe(TRACKPAD_ZOOM_BOOST);
      expect(wheelZoomSpeed(wheel({ ctrlKey: true, deltaY: 400 }), 1)).toBe(TRACKPAD_ZOOM_BOOST);
    });

    // Two-finger scroll carries no ctrlKey but stays well under a wheel notch.
    it('treats small pixel-mode deltas as two-finger scroll', () => {
      expect(wheelZoomSpeed(wheel({ deltaY: 8 }), 1)).toBe(TRACKPAD_ZOOM_BOOST);
      expect(wheelZoomSpeed(wheel({ deltaY: -8 }), 1)).toBe(TRACKPAD_ZOOM_BOOST);
    });
  });

  describe('a real mouse wheel is left alone', () => {
    it.each([100, 120, -100])('does not boost a wheel notch of %p', (deltaY) => {
      expect(wheelZoomSpeed(wheel({ deltaY }), 1)).toBe(1);
    });

    // Line- and page-mode deltas are small numbers by unit, not by gesture --
    // a deltaMode of 1 with deltaY 3 is three whole lines, not a fine scroll.
    it.each([
      ['line mode', 1],
      ['page mode', 2]
    ])('does not treat a small %s delta as a trackpad', (_label, deltaMode) => {
      expect(wheelZoomSpeed(wheel({ deltaY: 3, deltaMode }), 1)).toBe(1);
    });
  });

  describe('display independence', () => {
    // r160 divides the step by devicePixelRatio, so without cancelling it the
    // same gesture zooms half as fast on a Retina screen as on a 1x one.
    it.each([
      ['pinch', wheel({ ctrlKey: true, deltaY: 2 })],
      ['wheel notch', wheel({ deltaY: 100 })]
    ])('applies the same %s step at 1x and 2x', (_label, event) => {
      expect(percentPerEvent(event, 2)).toBeCloseTo(percentPerEvent(event, 1), 10);
    });

    // A browser zoomed below 100% reports a fractional ratio, which truncates
    // to 0. Unclamped that yields a zoomSpeed of 0 and zooming stops dead.
    it('keeps zooming when devicePixelRatio truncates to zero', () => {
      expect(wheelZoomSpeed(wheel({ ctrlKey: true, deltaY: 2 }), 0.8)).toBe(TRACKPAD_ZOOM_BOOST);
      expect(wheelZoomSpeed(wheel({ deltaY: 100 }), 0.8)).toBe(1);
    });
  });

  describe('the resulting zoom is actually usable', () => {
    // The bug: a pinch moved the camera ~0.05% per event, so halving the
    // camera distance took over a thousand events.
    it('brings a Retina pinch within an order of magnitude of a wheel notch', () => {
      const pinch = percentPerEvent(wheel({ ctrlKey: true, deltaY: 2 }), 2);
      const notch = percentPerEvent(wheel({ deltaY: 100 }), 2);

      expect(pinch).toBeGreaterThan(notch / 10);
      // Before the fix this was ~0.05%; anything on this scale is unusable.
      expect(pinch).toBeGreaterThan(0.5);
    });

    // Proportionality has to survive: a fast pinch should still outrun a slow
    // one, which rules out normalising every event to a constant step.
    it('keeps a fast pinch faster than a slow one', () => {
      const slow = percentPerEvent(wheel({ ctrlKey: true, deltaY: 2 }), 2);
      const fast = percentPerEvent(wheel({ ctrlKey: true, deltaY: 12 }), 2);

      expect(fast).toBeGreaterThan(slow);
    });

    // A single gesture must not send the camera through the model.
    it('keeps one event well under a halving of the camera distance', () => {
      for (const deltaY of [2, 8, 20, 40]) {
        expect(zoomStep(wheel({ ctrlKey: true, deltaY }), 2)).toBeGreaterThan(0.5);
      }
    });
  });
});
