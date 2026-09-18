/**
 * @jest-environment jsdom
 */

const fs = require('fs');
const path = require('path');

const MAIN_JS = fs.readFileSync(path.resolve(__dirname, 'frontend/cfd/js/main.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.resolve(__dirname, 'frontend/cfd/index.html'), 'utf8');

function sliceBetween(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + 1);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Could not extract ${label} from main.js — have the markers moved?`);
  }
  return source.slice(start, end);
}

// The chart builder and the in-panel renderer, up to the resize handler.
const chartSource = sliceBetween(
  MAIN_JS,
  '// --- SVG Performance Charts Rendering ---',
  '// Window resize handler for performance charts',
  'chart rendering'
).replace('window.renderPerformanceCharts = renderPerformanceCharts;', '');

const chartModalSource = sliceBetween(
  MAIN_JS,
  '// --- Chart zoom modal ---',
  '// --- End chart zoom modal ---',
  'chart zoom modal'
);

const el = (id) => document.getElementById(id);

// jsdom does no layout, so clientWidth/Height are 0 and the code falls back
// to its defaults (500x200 in-panel, 900x500 in the modal).
function loadChartModule() {
  document.documentElement.innerHTML = INDEX_HTML;
  const factory = new Function('deps', `
    const { raceSpeedMs, raceSpeedMph } = deps;
    ${chartSource}
    ${chartModalSource}
    return {
      buildPerformanceChartSvgs,
      renderPerformanceCharts,
      openChartModal,
      closeChartModal,
      renderChartModal,
      isChartModalOpen,
      chartZoomAvailable
    };
  `);
  return factory({ raceSpeedMs: (mph) => mph * 0.44704, raceSpeedMph: 30 });
}

describe('Chart zoom markup', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = INDEX_HTML;
  });

  test('the three Results-panel boxes are zoomable and keyboard-reachable', () => {
    const boxes = document.querySelectorAll('.chart-box[data-zoom]');
    expect([...boxes].map((b) => b.dataset.zoom)).toEqual(['forces', 'power', 'flow']);
    for (const box of boxes) {
      expect(box.classList.contains('chart-box--zoomable')).toBe(true);
      expect(box.getAttribute('tabindex')).toBe('0');
      expect(box.getAttribute('role')).toBe('button');
      expect(box.querySelector('.chart-expand-hint')).not.toBeNull();
    }
  });

  test('the chart modal shell is present and hidden', () => {
    const modal = el('chart-modal');
    expect(modal).not.toBeNull();
    expect(modal.style.display).toBe('none');
    expect(modal.classList.contains('auth-overlay')).toBe(true);
    expect(el('btn-close-chart').classList.contains('btn-modal-close')).toBe(true);
    for (const id of ['chart-modal-title', 'chart-modal-subtitle', 'chart-modal-body', 'chart-modal-svg', 'chart-modal-img']) {
      expect(el(id)).not.toBeNull();
    }
  });
});

describe('Chart builder', () => {
  test('draws both charts at the requested size', () => {
    const charts = loadChartModule();
    const svgs = charts.buildPerformanceChartSvgs(640, 320, 0.08, -0.12);
    expect(svgs.forces).toContain('viewBox="0 0 640 320"');
    expect(svgs.power).toContain('viewBox="0 0 640 320"');
    expect(svgs.forces).toContain('Drag Force (N)');
    expect(svgs.power).toContain('Aero Power Required (W)');
  });

  test('scale enlarges the race-speed markers and legend', () => {
    const charts = loadChartModule();
    const small = charts.buildPerformanceChartSvgs(500, 200, 0.08, -0.12, 1);
    const big = charts.buildPerformanceChartSvgs(1000, 500, 0.08, -0.12, 2);
    expect(small.forces).toContain('r="4.5"');
    expect(big.forces).toContain('r="9"');
    expect(big.forces).toContain('width="16" height="16"');
  });

  test('renderPerformanceCharts fills the in-panel wrappers', () => {
    const charts = loadChartModule();
    charts.renderPerformanceCharts();
    expect(el('forces-chart-svg').querySelector('svg')).not.toBeNull();
    expect(el('power-chart-svg').querySelector('svg')).not.toBeNull();
  });
});

describe('Chart zoom modal', () => {
  test('opening a chart redraws it into the modal with the box title and caption', () => {
    const charts = loadChartModule();
    charts.openChartModal('forces');

    expect(charts.isChartModalOpen()).toBe(true);
    expect(el('chart-modal-title').textContent).toBe('Aerodynamic Forces vs. Speed');
    expect(el('chart-modal-subtitle').textContent).toContain('Drag (cyan) and lift (purple)');
    const svg = el('chart-modal-svg').querySelector('svg');
    expect(svg).not.toBeNull();
    // Fallback modal size when jsdom reports no layout.
    expect(svg.getAttribute('viewBox')).toBe('0 0 900 500');
    expect(el('chart-modal-img').style.display).toBe('none');
  });

  test('opening the power chart shows the power SVG', () => {
    const charts = loadChartModule();
    charts.openChartModal('power');
    expect(el('chart-modal-title').textContent).toBe('Aerodynamic Power Demand');
    expect(el('chart-modal-svg').innerHTML).toContain('Aero Power Required (W)');
  });

  test('the flow image is only zoomable once a run has produced one', () => {
    const charts = loadChartModule();
    expect(charts.chartZoomAvailable('flow')).toBe(false);
    charts.openChartModal('flow');
    expect(charts.isChartModalOpen()).toBe(false);

    const img = el('flow-visualisation-img');
    img.src = 'blob:http://localhost/flow';
    img.style.display = 'block';
    expect(charts.chartZoomAvailable('flow')).toBe(true);

    charts.openChartModal('flow');
    expect(charts.isChartModalOpen()).toBe(true);
    expect(el('chart-modal-title').textContent).toBe('Centreline Flow Visualisation');
    expect(el('chart-modal-img').style.display).toBe('block');
    expect(el('chart-modal-img').src).toBe('blob:http://localhost/flow');
    expect(el('chart-modal-svg').style.display).toBe('none');
  });

  test('unknown kinds are ignored', () => {
    const charts = loadChartModule();
    charts.openChartModal('nonsense');
    expect(charts.isChartModalOpen()).toBe(false);
  });

  test('closing hides the modal, clears its content and is idempotent', () => {
    const charts = loadChartModule();
    charts.openChartModal('forces');
    charts.closeChartModal();
    expect(charts.isChartModalOpen()).toBe(false);
    expect(el('chart-modal-svg').innerHTML).toBe('');
    expect(el('chart-modal-img').hasAttribute('src')).toBe(false);
    expect(() => charts.closeChartModal()).not.toThrow();
  });

  test('renderChartModal is a no-op when nothing is open', () => {
    const charts = loadChartModule();
    expect(() => charts.renderChartModal()).not.toThrow();
    expect(el('chart-modal-svg').innerHTML).toBe('');
  });
});
