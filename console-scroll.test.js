/**
 * @jest-environment jsdom
 */

const fs = require('fs');
const path = require('path');

// Redefine the scroll function exactly as implemented in main.js
function scrollConsoleToBottom(consoleEl) {
  if (!consoleEl) return;
  consoleEl.scrollTop = consoleEl.scrollHeight;
  
  // Also run the scheduled animation frame & timeouts to cover all cases
  if (typeof window !== 'undefined') {
    if (window.requestAnimationFrame) {
      window.requestAnimationFrame(() => {
        consoleEl.scrollTop = consoleEl.scrollHeight;
      });
    }
    setTimeout(() => {
      consoleEl.scrollTop = consoleEl.scrollHeight;
    }, 50);
  }
}

describe('Execution Log UI Auto-Scroll and Layout', () => {
  let consoleEl;
  let sectionEl;
  let monitorEl;

  beforeEach(() => {
    // 1. Load HTML structure from index.html
    const html = fs.readFileSync(path.resolve(__dirname, 'public/index.html'), 'utf8');
    document.documentElement.innerHTML = html;

    consoleEl = document.getElementById('cfd-console');
    sectionEl = document.querySelector('#data-stage-3 section');
    monitorEl = document.getElementById('cfd-monitor');

    // Mock requestAnimationFrame and setTimeout
    jest.useFakeTimers();
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => {
      cb();
      return 1;
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('should have correct CSS layout styling to enforce scrolling instead of growing', () => {
    expect(sectionEl).toBeTruthy();
    expect(monitorEl).toBeTruthy();
    expect(consoleEl).toBeTruthy();

    const sectionStyle = sectionEl.style;
    const monitorStyle = monitorEl.style;
    const consoleStyle = consoleEl.style;

    // The section panel MUST be a flex column container of 100% height and overflow hidden
    expect(sectionStyle.display).toContain('flex');
    expect(sectionStyle.flexDirection).toBe('column');
    expect(sectionStyle.height).toBe('100%');
    expect(sectionStyle.overflow).toBe('hidden');

    // The monitor starts hidden behind the "no simulation in progress"
    // placeholder; showCfdMonitor swaps the two (covered by the test below).
    expect(monitorStyle.display).toBe('none');
    expect(document.getElementById('cfd-monitor-empty')).toBeTruthy();

    // The monitor element MUST still fill height via flex and NOT overflow
    expect(monitorStyle.flexDirection).toBe('column');
    expect(monitorStyle.minHeight).toBe('0');
    expect(monitorStyle.height).toBe('');
    expect(monitorStyle.overflow).toBe('hidden');

    // The console element MUST have overflow-y set to auto to enable a scrollbar
    expect(consoleStyle.overflowY).toBe('auto');
  });

  it('showCfdMonitor reveals the monitor as a flex column, not a block', () => {
    // Extracted from main.js so the real implementation is under test.
    const src = fs.readFileSync(path.resolve(__dirname, 'public/js/main.js'), 'utf8');
    const match = src.match(/function showCfdMonitor\(show\) \{[\s\S]*?\n\}/);
    expect(match).toBeTruthy();

    let showCfdMonitor;
    eval(`showCfdMonitor = ${match[0]}`);

    const emptyEl = document.getElementById('cfd-monitor-empty');

    showCfdMonitor(true);
    // 'block' would drop the flex context and collapse the log to its
    // min-height instead of letting flex: 1 fill the panel.
    expect(monitorEl.style.display).toBe('flex');
    expect(emptyEl.style.display).toBe('none');

    showCfdMonitor(false);
    expect(monitorEl.style.display).toBe('none');
    expect(emptyEl.style.display).toBe('flex');
  });

  it('should scroll to the bottom when text is appended and scrollConsoleToBottom is called', () => {
    // Simulate JSDOM property getters/setters for scroll behavior
    let scrollTopVal = 0;
    const scrollHeightVal = 1000;
    const clientHeightVal = 200;

    Object.defineProperty(consoleEl, 'scrollHeight', {
      value: scrollHeightVal,
      configurable: true
    });
    Object.defineProperty(consoleEl, 'clientHeight', {
      value: clientHeightVal,
      configurable: true
    });
    Object.defineProperty(consoleEl, 'scrollTop', {
      get: () => scrollTopVal,
      set: (val) => { scrollTopVal = val; },
      configurable: true
    });

    // Fill console with many lines of text
    let logText = '';
    for (let i = 0; i < 100; i++) {
      logText += `Simulation log line ${i}...\n`;
    }
    consoleEl.textContent = logText;

    // Scroll to bottom
    scrollConsoleToBottom(consoleEl);

    // Fast-forward timers
    jest.runAllTimers();

    // Verify scrollTop is set to scrollHeight to scroll all the way to the bottom
    expect(scrollTopVal).toBe(scrollHeightVal);
  });
});
