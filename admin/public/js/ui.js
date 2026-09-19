// Shared rendering helpers: formatters, a small DOM builder, the slide-over
// drawer, the typed-confirmation modal and toasts.

/* --- DOM ---------------------------------------------------------------- */

/**
 * Build an element. Children may be nodes, strings (escaped as text) or
 * null/false (skipped). Everything user- or S3-supplied goes through here
 * rather than innerHTML, so a filename with a `<` in it cannot become markup.
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const clear = (node) => { while (node.firstChild) node.firstChild.remove(); };

/* --- Formatters --------------------------------------------------------- */

const DASH = '—';

export function bytes(value) {
  if (!Number.isFinite(value) || value < 0) return DASH;
  if (value === 0) return '0 B';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** exponent;
  return `${scaled >= 100 || exponent === 0 ? Math.round(scaled) : scaled.toFixed(1)} ${units[exponent]}`;
}

export function absoluteDate(value) {
  if (!value) return DASH;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? DASH : date.toLocaleString();
}

export function relativeDate(value) {
  if (!value) return DASH;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return DASH;

  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const steps = [
    [60, 'minute'], [24, 'hour'], [7, 'day'], [4.35, 'week'], [12, 'month']
  ];
  let amount = seconds / 60;
  let unit = 'minute';
  for (let i = 1; i < steps.length; i++) {
    if (Math.abs(amount) < steps[i][0]) break;
    amount /= steps[i][0];
    unit = steps[i][1];
  }
  if (Math.abs(amount) >= 12 && unit === 'month') { amount /= 12; unit = 'year'; }
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
    .format(-Math.round(amount), unit);
}

/** A date cell: relative text, with the exact value on hover. */
export function dateCell(value) {
  if (!value) return el('span', { class: 'muted', text: DASH });
  return el('span', { title: absoluteDate(value), text: relativeDate(value) });
}

export function duration(from, to) {
  if (!from || !to) return DASH;
  const ms = new Date(to) - new Date(from);
  if (!Number.isFinite(ms) || ms < 0) return DASH;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function number(value, digits = 3) {
  return Number.isFinite(value) ? value.toFixed(digits) : DASH;
}

/* --- Pills -------------------------------------------------------------- */

const STATUS_PILLS = {
  completed: 'pill-ok',
  failed: 'pill-danger',
  running: 'pill-accent',
  queued: 'pill-warn',
  cancelled: 'pill'
};

export const statusPill = (status) =>
  el('span', { class: `pill ${STATUS_PILLS[status] || ''}`, text: status || 'unknown' });

const USER_STATE_PILLS = {
  active: 'pill-ok',
  invited: 'pill-warn',
  disabled: 'pill-danger',
  'reset-required': 'pill-warn',
  'unknown-account': 'pill-danger',
  'no-user': 'pill-warn'
};

const USER_STATE_LABELS = {
  active: 'Active',
  invited: 'Invited',
  disabled: 'Disabled',
  'reset-required': 'Reset required',
  'unknown-account': 'No account',
  'no-user': 'No user recorded'
};

export const userStatePill = (state) =>
  el('span', {
    class: `pill ${USER_STATE_PILLS[state] || ''}`,
    text: USER_STATE_LABELS[state] || state
  });

/* --- Copyable key ------------------------------------------------------- */

export function copyable(value, { mono = true } = {}) {
  if (!value) return el('span', { class: 'muted', text: DASH });
  return el('span', {}, [
    el('span', { class: mono ? 'mono' : '', text: value }),
    el('button', {
      class: 'copy',
      type: 'button',
      title: 'Copy to clipboard',
      onClick: async (event) => {
        event.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          toast('Copied', 'ok');
        } catch {
          toast('Could not copy to clipboard', 'error');
        }
      }
    }, 'copy')
  ]);
}

/* --- Toasts ------------------------------------------------------------- */

export function toast(message, kind = '') {
  const container = document.getElementById('toasts');
  const node = el('div', { class: `toast ${kind ? `toast-${kind}` : ''}`, text: message });
  container.append(node);
  setTimeout(() => node.remove(), kind === 'error' ? 8000 : 4000);
}

/* --- Drawer ------------------------------------------------------------- */

let drawerNode = null;

export function closeDrawer() {
  if (drawerNode) {
    drawerNode.remove();
    drawerNode = null;
  }
  document.querySelectorAll('tr.selected').forEach((row) => row.classList.remove('selected'));
}

/**
 * A right-hand slide-over rather than a modal: the table stays visible and
 * scannable while you read a record, which is most of what this app is for.
 */
export function openDrawer({ title, subtitle, body, actions = [] }) {
  closeDrawer();

  drawerNode = el('div', { class: 'drawer', role: 'dialog', 'aria-label': title }, [
    el('div', { class: 'drawer-head' }, [
      el('div', {}, [
        el('h3', { text: title }),
        subtitle && el('div', { class: 'muted', text: subtitle })
      ]),
      el('button', { class: 'btn-sm', type: 'button', onClick: closeDrawer }, 'Close')
    ]),
    el('div', { class: 'drawer-body' }, body),
    actions.length > 0 ? el('div', { class: 'drawer-foot' }, actions) : null
  ]);

  document.body.append(drawerNode);
}

export function section(heading, content) {
  return el('div', { class: 'section' }, [el('h4', { text: heading }), content]);
}

/** A definition list. Entries are [label, value]; null values are skipped. */
export function kv(entries) {
  const list = el('dl', { class: 'kv' });
  for (const [label, value, options = {}] of entries) {
    if (value === null || value === undefined || value === '') continue;
    list.append(el('dt', { text: label }));
    list.append(el('dd', { class: options.mono ? 'mono' : '' },
      value instanceof Node ? value : String(value)));
  }
  return list;
}

/* --- Typed confirmation modal ------------------------------------------- */

/**
 * Ask for a destructive action to be confirmed by typing an exact string.
 * Resolves true when confirmed, false when cancelled.
 *
 * The server re-checks the same value: this is the usability half of the gate,
 * not the control.
 */
export function confirmByTyping({ title, body, expected, expectedLabel, confirmLabel = 'Delete' }) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'text', autocomplete: 'off', spellcheck: 'false' });
    const confirmButton = el('button', { class: 'btn-danger', type: 'submit', disabled: true }, confirmLabel);

    const close = (result) => {
      document.removeEventListener('keydown', onKeydown);
      backdrop.remove();
      resolve(result);
    };
    const onKeydown = (event) => { if (event.key === 'Escape') close(false); };

    input.addEventListener('input', () => {
      confirmButton.disabled = input.value.trim() !== expected;
    });

    const form = el('form', {
      onSubmit: (event) => {
        event.preventDefault();
        if (input.value.trim() === expected) close(true);
      }
    }, [
      el('label', { text: expectedLabel || `Type ${expected} to confirm` }),
      input,
      el('div', { class: 'modal-actions' }, [
        el('button', { type: 'button', onClick: () => close(false) }, 'Cancel'),
        confirmButton
      ])
    ]);

    const backdrop = el('div', {
      class: 'modal-backdrop',
      onClick: (event) => { if (event.target === backdrop) close(false); }
    }, [
      el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, [
        el('h3', { text: title }),
        body,
        form
      ])
    ]);

    document.addEventListener('keydown', onKeydown);
    document.body.append(backdrop);
    input.focus();
  });
}

/* --- Table -------------------------------------------------------------- */

/**
 * Render a table.
 * @param {Array<{key?: string, label: string, class?: string, sortable?: boolean,
 *                render: (row) => Node|string}>} columns
 */
export function table(columns, rows, { onRowClick, sort, onSort, emptyMessage } = {}) {
  if (rows.length === 0) {
    return el('div', { class: 'table-wrap' }, [
      el('div', { class: 'empty' }, el('p', { text: emptyMessage || 'Nothing to show.' }))
    ]);
  }

  const head = el('tr', {}, columns.map((column) => {
    const sorted = sort && sort.key === column.key;
    const arrow = sorted ? el('span', { class: 'arrow', text: sort.order === 'asc' ? ' ↑' : ' ↓' }) : null;
    return el('th', {
      class: [column.class, column.sortable && onSort ? 'sortable' : ''].filter(Boolean).join(' '),
      onClick: column.sortable && onSort ? () => onSort(column.key) : undefined
    }, [column.label, arrow]);
  }));

  const body = el('tbody', {}, rows.map((row) => el('tr', {
    class: onRowClick ? 'clickable' : '',
    onClick: onRowClick
      ? (event) => {
        if (event.target.closest('button, a')) return;
        document.querySelectorAll('tr.selected').forEach((r) => r.classList.remove('selected'));
        event.currentTarget.classList.add('selected');
        onRowClick(row);
      }
      : undefined
  }, columns.map((column) => el('td', { class: column.class || '' }, column.render(row))))));

  return el('div', { class: 'table-wrap' }, [
    el('table', {}, [el('thead', {}, head), body])
  ]);
}

/* --- Page scaffolding --------------------------------------------------- */

export function pageHead(title, subtitle, { scannedAt, onRefresh } = {}) {
  return [
    el('div', { class: 'page-head' }, [
      el('h2', { text: title }),
      el('div', { class: 'toolbar' }, [
        scannedAt && el('span', { class: 'scanned-at', text: `as of ${new Date(scannedAt).toLocaleTimeString()}` }),
        onRefresh && el('button', { class: 'btn-sm', type: 'button', onClick: onRefresh }, 'Refresh')
      ])
    ]),
    el('p', { class: 'page-sub', text: subtitle })
  ];
}

export const loading = () => el('div', { class: 'loading', text: 'Loading…' });

export function errorNotice(message, detail) {
  return el('div', { class: 'notice notice-danger' }, [
    el('h4', { text: 'Could not load this view' }),
    el('p', { text: message }),
    detail && el('p', { class: 'muted', text: detail })
  ]);
}

export function stats(entries) {
  return el('div', { class: 'stats' }, entries.map(([label, value]) =>
    el('div', { class: 'stat' }, [
      el('span', { class: 'label', text: label }),
      el('span', { class: 'value', text: String(value) })
    ])));
}
