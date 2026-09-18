/**
 * @jest-environment jsdom
 */

const fs = require('fs');
const path = require('path');

const MAIN_JS = fs.readFileSync(path.resolve(__dirname, 'frontend/cfd/js/main.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.resolve(__dirname, 'frontend/cfd/index.html'), 'utf8');
const STYLE_CSS = fs.readFileSync(path.resolve(__dirname, 'frontend/cfd/style.css'), 'utf8');
const HELP_CONTENT_JS = fs.readFileSync(path.resolve(__dirname, 'frontend/cfd/js/help-content.js'), 'utf8');

// main.js is an ES module that imports Three.js and boots the whole app, so the
// help modal helpers are sliced out by their comment markers and evaluated in
// isolation (same approach as auth-modal.test.js).
function sliceBetween(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + 1);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Could not extract ${label} from main.js — have the markers moved?`);
  }
  return source.slice(start, end);
}

// help-content.js has a single `export const HELP_PAGES`; strip the keyword so
// it can be evaluated as a plain script.
const HELP_PAGES = new Function(
  `${HELP_CONTENT_JS.replace(/^\s*export\s+/gm, '')}; return HELP_PAGES;`
)();

const helpModalSource = sliceBetween(
  MAIN_JS,
  '// --- Help modal ---',
  '// --- End help modal ---',
  'help modal helpers'
);

const keyboardSource = sliceBetween(
  MAIN_JS,
  '// --- Overlay keyboard shortcuts ---',
  '// --- End overlay keyboard shortcuts ---',
  'overlay keyboard shortcuts'
);

function loadHelpModule(pages = HELP_PAGES) {
  document.documentElement.innerHTML = INDEX_HTML;

  const factory = new Function('deps', `
    const { HELP_PAGES, closeLogModal, closeChartModal, historyModal } = deps;

    ${helpModalSource}
    ${keyboardSource}

    return {
      openHelpModal,
      closeHelpModal,
      renderHelpPage,
      helpNext,
      helpPrev,
      isHelpModalOpen,
      getIndex: () => helpPageIndex
    };
  `);

  const closeLogModal = jest.fn();
  const closeChartModal = jest.fn();
  const historyModal = document.getElementById('history-modal');
  const api = factory({ HELP_PAGES: pages, closeLogModal, closeChartModal, historyModal });
  return { ...api, closeLogModal, historyModal };
}

const el = (id) => document.getElementById(id);
const pressKey = (key) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

describe('Help tutorial content', () => {
  test('has six pages with complete fields', () => {
    expect(HELP_PAGES).toHaveLength(6);
    for (const page of HELP_PAGES) {
      expect(typeof page.id).toBe('string');
      expect(page.title.trim()).not.toBe('');
      expect(page.image.trim()).not.toBe('');
      expect(page.alt.trim()).not.toBe('');
      expect(page.body.trim()).not.toBe('');
    }
  });

  test('page ids and images are unique', () => {
    expect(new Set(HELP_PAGES.map((p) => p.id)).size).toBe(HELP_PAGES.length);
    expect(new Set(HELP_PAGES.map((p) => p.image)).size).toBe(HELP_PAGES.length);
  });

  test('image paths are relative and the files exist on disk', () => {
    for (const page of HELP_PAGES) {
      expect(page.image).not.toMatch(/^(\/|https?:)/);
      const onDisk = path.resolve(__dirname, 'frontend/cfd', page.image);
      expect(fs.existsSync(onDisk)).toBe(true);
    }
  });
});

describe('Help modal markup', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = INDEX_HTML;
  });

  test('header Help button exists, is hidden until login, and sits before Run History', () => {
    const btnHelp = el('btn-help');
    const btnHistory = el('btn-history');
    expect(btnHelp).not.toBeNull();
    expect(btnHelp.style.display).toBe('none');
    expect(btnHelp.compareDocumentPosition(btnHistory) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('modal shell is present, hidden, and carries every element the JS renders into', () => {
    const modal = el('help-modal');
    expect(modal).not.toBeNull();
    expect(modal.classList.contains('auth-overlay')).toBe(true);
    expect(modal.style.display).toBe('none');
    expect(modal.getAttribute('role')).toBe('dialog');
    for (const id of [
      'help-modal-title', 'help-modal-subtitle', 'btn-close-help',
      'help-image', 'help-text', 'btn-help-prev', 'btn-help-next', 'help-dots'
    ]) {
      expect(el(id)).not.toBeNull();
    }
  });

  test('all overlay close buttons share the .btn-modal-close rule', () => {
    for (const id of ['btn-close-log', 'btn-close-history', 'btn-close-help']) {
      expect(el(id).classList.contains('btn-modal-close')).toBe(true);
    }
    expect(STYLE_CSS).toMatch(/\.btn-modal-close\s*\{/);
    expect(STYLE_CSS).not.toMatch(/#btn-close-log\s*\{/);
  });

  test('help card is sized to 80% of the viewport', () => {
    const rule = STYLE_CSS.match(/\.help-modal-content\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule[1]).toMatch(/width:\s*80vw/);
    expect(rule[1]).toMatch(/height:\s*80vh/);
  });
});

describe('Help modal behaviour', () => {
  test('opening renders page 1 with the first image, Prev disabled and one active dot', () => {
    const help = loadHelpModule();
    help.openHelpModal();

    expect(el('help-modal').style.display).toBe('flex');
    expect(help.getIndex()).toBe(0);
    expect(el('help-modal-title').textContent).toBe(HELP_PAGES[0].title);
    expect(el('help-modal-subtitle').textContent).toBe('Page 1 of 6');
    expect(el('help-image').getAttribute('src')).toBe(HELP_PAGES[0].image);
    expect(el('help-image').alt).toBe(HELP_PAGES[0].alt);
    // innerHTML re-serialises entities (&mdash; → —), so compare the rendered text.
    expect(el('help-text').querySelector('h3').textContent).toBe('What is this?');
    expect(el('help-text').textContent).toContain('computer wind tunnel');
    expect(el('btn-help-prev').disabled).toBe(true);
    expect(el('btn-help-next').textContent).toBe('Next');

    const dots = document.querySelectorAll('.help-dot');
    expect(dots).toHaveLength(6);
    expect(document.querySelectorAll('.help-dot.active')).toHaveLength(1);
    expect(dots[0].classList.contains('active')).toBe(true);
  });

  test('Prev is a no-op on the first page', () => {
    const help = loadHelpModule();
    help.openHelpModal();
    help.helpPrev();
    expect(help.getIndex()).toBe(0);
    expect(help.isHelpModalOpen()).toBe(true);
  });

  test('Next walks to the last page, relabels itself Finish, and then closes', () => {
    const help = loadHelpModule();
    help.openHelpModal();
    for (let i = 0; i < 5; i++) help.helpNext();

    expect(help.getIndex()).toBe(5);
    expect(el('help-modal-subtitle').textContent).toBe('Page 6 of 6');
    expect(el('btn-help-next').textContent).toBe('Finish');
    expect(el('btn-help-prev').disabled).toBe(false);
    expect(document.querySelectorAll('.help-dot')[5].classList.contains('active')).toBe(true);

    help.helpNext();
    expect(help.isHelpModalOpen()).toBe(false);
  });

  test('renderHelpPage clamps out-of-range indices', () => {
    const help = loadHelpModule();
    help.openHelpModal();
    help.renderHelpPage(99);
    expect(help.getIndex()).toBe(5);
    help.renderHelpPage(-3);
    expect(help.getIndex()).toBe(0);
  });

  test('reopening always restarts at page 1', () => {
    const help = loadHelpModule();
    help.openHelpModal();
    help.helpNext();
    help.helpNext();
    help.closeHelpModal();
    help.openHelpModal();
    expect(help.getIndex()).toBe(0);
    expect(el('help-modal-subtitle').textContent).toBe('Page 1 of 6');
  });

  test('closeHelpModal is safe to call when the modal is already closed', () => {
    const help = loadHelpModule();
    expect(() => help.closeHelpModal()).not.toThrow();
    expect(el('help-modal').style.display).toBe('none');
  });
});

describe('Help modal keyboard shortcuts', () => {
  test('Escape closes the help modal along with the other overlays', () => {
    const help = loadHelpModule();
    help.openHelpModal();
    help.historyModal.style.display = 'flex';

    pressKey('Escape');

    expect(help.isHelpModalOpen()).toBe(false);
    expect(help.historyModal.style.display).toBe('none');
    expect(help.closeLogModal).toHaveBeenCalled();
  });

  test('arrow keys page through while open and never close on the last page', () => {
    const help = loadHelpModule();
    help.openHelpModal();

    pressKey('ArrowRight');
    pressKey('ArrowRight');
    expect(help.getIndex()).toBe(2);

    pressKey('ArrowLeft');
    expect(help.getIndex()).toBe(1);

    help.renderHelpPage(5);
    pressKey('ArrowRight');
    expect(help.getIndex()).toBe(5);
    expect(help.isHelpModalOpen()).toBe(true);
  });

  test('arrow keys are ignored when the modal is closed', () => {
    const help = loadHelpModule();
    help.openHelpModal();
    help.closeHelpModal();

    pressKey('ArrowRight');
    expect(help.getIndex()).toBe(0);
    expect(help.isHelpModalOpen()).toBe(false);
  });
});

describe('Help button session gating', () => {
  const validateSessionSource = sliceBetween(
    MAIN_JS,
    'function validateSession() {',
    'function handleLogout() {',
    'validateSession'
  );

  function runValidateSession(idToken) {
    document.documentElement.innerHTML = INDEX_HTML;
    const factory = new Function('deps', `
      const { authModal, btnLogout, btnHistory, btnHelp, fetchLibrary, handleLogout } = deps;
      const authMode = 'cognito';
      let idToken = deps.idToken;
      ${validateSessionSource}
      validateSession();
    `);
    factory({
      authModal: el('auth-modal'),
      btnLogout: el('btn-logout'),
      btnHistory: el('btn-history'),
      btnHelp: el('btn-help'),
      fetchLibrary: jest.fn(),
      handleLogout: jest.fn(),
      idToken
    });
  }

  test('Help is shown alongside Run History once signed in', () => {
    runValidateSession('header.payload.signature');
    expect(el('btn-help').style.display).toBe('block');
    expect(el('btn-history').style.display).toBe('block');
  });

  test('Help is hidden alongside Run History when signed out', () => {
    runValidateSession(null);
    expect(el('btn-help').style.display).toBe('none');
    expect(el('btn-history').style.display).toBe('none');
  });
});
