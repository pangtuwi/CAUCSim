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

const stopSimSource = sliceBetween(
  MAIN_JS,
  '// --- Stop simulation ---',
  '// --- End stop simulation ---',
  'stop simulation'
);

const el = (id) => document.getElementById(id);

function loadStopSimModule(overrides = {}) {
  document.documentElement.innerHTML = INDEX_HTML;

  const factory = new Function('deps', `
    let activeJobId = deps.activeJobId;
    const idToken = deps.idToken;
    const fetch = deps.fetch;
    const alert = deps.alert;
    const handleLogout = deps.handleLogout;
    const stopCfdPolling = deps.stopCfdPolling;
    const updateCfdMonitorState = deps.updateCfdMonitorState;
    const displayFailedCfdState = deps.displayFailedCfdState;
    const switchStage = deps.switchStage;

    ${stopSimSource}

    return {
      isStopCfdModalOpen,
      openStopCfdModal,
      closeStopCfdModal,
      setStopCfdButtonVisible,
      confirmStopCfdSimulation,
      setActiveJobId: (id) => { activeJobId = id; }
    };
  `);

  const deps = {
    activeJobId: 'job-123',
    idToken: 'mock-id-token',
    fetch: jest.fn(),
    alert: jest.fn(),
    handleLogout: jest.fn(),
    stopCfdPolling: jest.fn(),
    updateCfdMonitorState: jest.fn(),
    displayFailedCfdState: jest.fn(),
    switchStage: jest.fn(),
    ...overrides
  };
  const api = factory(deps);
  return { ...api, deps };
}

describe('Stop simulation markup', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = INDEX_HTML;
  });

  test('the stop button exists in the Stage 3 card and starts hidden', () => {
    const btn = el('btn-stop-cfd');
    expect(btn).not.toBeNull();
    expect(btn.style.display).toBe('none');
    expect(btn.textContent).toContain('Stop Simulation');
  });

  test('the confirmation modal shell is present, hidden, and has both actions', () => {
    const modal = el('stop-cfd-modal');
    expect(modal).not.toBeNull();
    expect(modal.style.display).toBe('none');
    expect(modal.classList.contains('auth-overlay')).toBe(true);
    expect(el('btn-close-stop-cfd')).not.toBeNull();
    expect(el('btn-cancel-stop-cfd').textContent).toContain('Keep Running');
    expect(el('btn-confirm-stop-cfd').textContent).toContain('Stop Simulation');
  });
});

describe('Stop confirmation modal open/close', () => {
  test('opening does nothing without an active job', () => {
    const sim = loadStopSimModule({ activeJobId: null });
    sim.openStopCfdModal();
    expect(sim.isStopCfdModalOpen()).toBe(false);
  });

  test('opens and closes the modal', () => {
    const sim = loadStopSimModule();
    sim.openStopCfdModal();
    expect(sim.isStopCfdModalOpen()).toBe(true);
    sim.closeStopCfdModal();
    expect(sim.isStopCfdModalOpen()).toBe(false);
  });

  test('closing when already closed does not throw', () => {
    const sim = loadStopSimModule();
    expect(() => sim.closeStopCfdModal()).not.toThrow();
  });
});

describe('setStopCfdButtonVisible', () => {
  test('toggles the button display style', () => {
    const sim = loadStopSimModule();
    sim.setStopCfdButtonVisible(true);
    expect(el('btn-stop-cfd').style.display).toBe('flex');
    sim.setStopCfdButtonVisible(false);
    expect(el('btn-stop-cfd').style.display).toBe('none');
  });
});

describe('confirmStopCfdSimulation', () => {
  test('does nothing (but closes the modal) without an active job', async () => {
    const sim = loadStopSimModule({ activeJobId: null });
    sim.openStopCfdModal(); // no-op, stays closed
    await sim.confirmStopCfdSimulation();
    expect(sim.deps.fetch).not.toHaveBeenCalled();
    expect(sim.isStopCfdModalOpen()).toBe(false);
  });

  test('POSTs to the stop endpoint with the bearer token', async () => {
    const cancelledJob = { jobId: 'job-123', status: 'cancelled', error: 'Stopped by user.' };
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => cancelledJob
    });
    const sim = loadStopSimModule({ fetch: fetchMock });

    await sim.confirmStopCfdSimulation();

    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/job-123/stop', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer mock-id-token' }
    });
  });

  test('on success: closes the modal, stops polling, and hands the cancelled job to the UI', async () => {
    const cancelledJob = { jobId: 'job-123', status: 'cancelled', error: 'Stopped by user.' };
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => cancelledJob
    });
    const sim = loadStopSimModule({ fetch: fetchMock });
    sim.openStopCfdModal();

    await sim.confirmStopCfdSimulation();

    expect(sim.isStopCfdModalOpen()).toBe(false);
    expect(sim.deps.stopCfdPolling).toHaveBeenCalledTimes(1);
    expect(sim.deps.updateCfdMonitorState).toHaveBeenCalledWith(cancelledJob);
    expect(sim.deps.displayFailedCfdState).toHaveBeenCalledWith(cancelledJob);
    expect(sim.deps.switchStage).toHaveBeenCalledWith(3);
  });

  test('on 401: logs the user out and closes the modal without touching polling', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    const sim = loadStopSimModule({ fetch: fetchMock });
    sim.openStopCfdModal();

    await sim.confirmStopCfdSimulation();

    expect(sim.deps.handleLogout).toHaveBeenCalledTimes(1);
    expect(sim.isStopCfdModalOpen()).toBe(false);
    expect(sim.deps.stopCfdPolling).not.toHaveBeenCalled();
  });

  test('on a server error: alerts the user, leaves the modal state recoverable, re-enables the button', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Job is already completed and cannot be stopped.' })
    });
    const sim = loadStopSimModule({ fetch: fetchMock });
    sim.openStopCfdModal();

    await sim.confirmStopCfdSimulation();

    expect(sim.deps.alert).toHaveBeenCalledWith('Job is already completed and cannot be stopped.');
    expect(sim.deps.stopCfdPolling).not.toHaveBeenCalled();
    expect(sim.deps.displayFailedCfdState).not.toHaveBeenCalled();
    const btnConfirm = el('btn-confirm-stop-cfd');
    expect(btnConfirm.disabled).toBe(false);
    expect(btnConfirm.textContent).toBe('Stop Simulation');
  });

  test('disables and relabels the confirm button while the request is in flight', async () => {
    let resolveFetch;
    const fetchMock = jest.fn().mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; }));
    const sim = loadStopSimModule({ fetch: fetchMock });

    const pending = sim.confirmStopCfdSimulation();
    const btnConfirm = el('btn-confirm-stop-cfd');
    expect(btnConfirm.disabled).toBe(true);
    expect(btnConfirm.textContent).toContain('Stopping');

    resolveFetch({ ok: true, status: 200, json: async () => ({ jobId: 'job-123', status: 'cancelled' }) });
    await pending;
    expect(btnConfirm.disabled).toBe(false);
  });
});
