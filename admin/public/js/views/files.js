// The uploads/ prefix: CAD geometry uploaded by every account.
import { api, ApiError } from '../api.js';
import {
  el, clear, table, pageHead, stats, loading, errorNotice, toast,
  dateCell, absoluteDate, bytes, openDrawer, closeDrawer, section, kv,
  copyable, confirmByTyping
} from '../ui.js';

const state = { search: '', unusedOnly: false, sort: 'uploaded', order: 'desc', data: null };

let container = null;
let onCountChange = () => {};

export function init({ mount, onCount }) {
  container = mount;
  onCountChange = onCount;
}

export async function render({ refresh = false } = {}) {
  if (!state.data || refresh) {
    clear(container);
    container.append(loading());
    try {
      state.data = await api(`/uploads${refresh ? '?refresh=1' : ''}`);
      onCountChange(state.data.total);
    } catch (err) {
      clear(container);
      if (!(err instanceof ApiError) || (err.status !== 401 && err.status !== 403)) {
        container.append(errorNotice(err.message));
      }
      return;
    }
  }
  draw();
}

function visibleFiles() {
  const needle = state.search.trim().toLowerCase();
  const filtered = state.data.files.filter((file) => {
    if (state.unusedOnly && file.runCount > 0) return false;
    if (!needle) return true;
    const owners = [...(file.usedBy || []).map((u) => u.email), file.uploader?.email].filter(Boolean);
    return [file.originalName, file.fileKey, ...owners].join(' ').toLowerCase().includes(needle);
  });

  const direction = state.order === 'asc' ? 1 : -1;
  const sorters = {
    uploaded: (a, b) => new Date(a.lastModified || 0) - new Date(b.lastModified || 0),
    name: (a, b) => a.originalName.localeCompare(b.originalName),
    size: (a, b) => a.size - b.size,
    runs: (a, b) => a.runCount - b.runCount
  };
  return [...filtered].sort((a, b) => (sorters[state.sort] || sorters.uploaded)(a, b) * direction);
}

function draw() {
  const { files, missing, stale, unusedCount, unusedBytes, totalBytes, scannedAt } = state.data;
  const rows = visibleFiles();

  clear(container);
  container.append(...pageHead(
    'CAD files',
    'Every .stl in the bucket. Uploads carry no identity of their own, so ownership is '
    + 'either taken from an upload record or inferred from the runs that used the file — '
    + 'the two are labelled differently below because they are different claims.',
    { scannedAt, onRefresh: () => render({ refresh: true }) }
  ));

  container.append(stats([
    ['Files', files.length],
    ['Stored', bytes(totalBytes)],
    ['Never simulated', unusedCount],
    ['Reclaimable', bytes(unusedBytes)]
  ]));

  if (missing.length > 0) {
    container.append(el('div', { class: 'notice notice-warn' }, [
      el('h4', { text: `${missing.length} run${missing.length === 1 ? '' : 's'} reference geometry that is no longer here` }),
      el('p', { text: 'Their results are intact, but the geometry cannot be viewed or re-run.' }),
      el('ul', {}, missing.map((entry) =>
        el('li', { text: `${entry.fileKey} — ${entry.runCount} run${entry.runCount === 1 ? '' : 's'}` })))
    ]));
  }

  if (stale.length > 0) {
    container.append(el('div', { class: 'notice' }, [
      el('h4', { text: `${stale.length} upload record${stale.length === 1 ? '' : 's'} with no file` }),
      el('p', {
        text: 'The CFD app signed an upload URL but nothing was ever uploaded — usually someone '
          + 'opening the file picker and cancelling. Harmless, and safe to ignore.'
      })
    ]));
  }

  container.append(el('div', { class: 'toolbar' }, [
    el('input', {
      type: 'search',
      placeholder: 'Search file name, key or user',
      value: state.search,
      onInput: (event) => { state.search = event.target.value; draw(); }
    }),
    el('label', { class: 'muted' }, [
      el('input', {
        type: 'checkbox',
        checked: state.unusedOnly,
        style: 'width:auto;margin-right:6px;vertical-align:middle',
        onChange: (event) => { state.unusedOnly = event.target.checked; draw(); }
      }),
      'Never simulated only'
    ]),
    el('span', { class: 'spacer' }),
    el('span', { class: 'muted', text: `${rows.length} of ${files.length}` })
  ]));

  container.append(table(columns(), rows, {
    sort: { key: state.sort, order: state.order },
    onSort: (key) => {
      if (state.sort === key) state.order = state.order === 'asc' ? 'desc' : 'asc';
      else { state.sort = key; state.order = 'desc'; }
      draw();
    },
    onRowClick: openFile,
    emptyMessage: files.length === 0 ? 'No CAD files have been uploaded.' : 'No files match these filters.'
  }));
}

// The attribution cell is the whole point of this view, so it states which kind
// of claim it is making rather than presenting an inference as a fact.
function attributionCell(file) {
  if (file.attribution === 'uploaded-by') {
    return el('div', {}, [
      el('span', { text: file.uploader?.email || 'unknown' }),
      el('span', { class: 'secondary-line', text: 'uploaded by (recorded)' })
    ]);
  }
  if (file.attribution === 'first-simulated-by') {
    const emails = file.usedBy.map((u) => u.email);
    const shown = emails.slice(0, 2).join(', ');
    const extra = emails.length > 2 ? ` +${emails.length - 2} more` : '';
    return el('div', {}, [
      el('span', { text: shown + extra }),
      el('span', { class: 'secondary-line', text: 'first simulated by (inferred)' })
    ]);
  }
  return el('div', {}, [
    el('span', { class: 'muted', text: 'no runs' }),
    el('span', { class: 'secondary-line', text: 'uploader not recorded' })
  ]);
}

function columns() {
  return [
    {
      key: 'name',
      label: 'File',
      sortable: true,
      render: (file) => el('div', {}, [
        el('span', { text: file.originalName }),
        el('span', { class: 'secondary-line mono', text: file.fileKey })
      ])
    },
    { label: 'Attributed to', render: attributionCell },
    { key: 'runs', label: 'Runs', sortable: true, class: 'num', render: (file) => file.runCount },
    { key: 'uploaded', label: 'Uploaded', sortable: true, class: 'nowrap', render: (file) => dateCell(file.uploadedAt || file.lastModified) },
    { key: 'size', label: 'Size', sortable: true, class: 'num', render: (file) => bytes(file.size) }
  ];
}

function openFile(file) {
  const overwritten = file.uploadedAt && file.lastModified
    && Math.abs(new Date(file.uploadedAt) - new Date(file.lastModified)) > 60_000;

  const body = [
    file.attribution === 'orphaned' && el('div', { class: 'notice' }, [
      el('h4', { text: 'No owner can be determined' }),
      el('p', {
        text: 'This file predates upload records and has never been used in a simulation, so '
          + 'there is nothing anywhere that says who uploaded it. That is not recoverable.'
      })
    ]),

    overwritten && el('div', { class: 'notice notice-warn' }, [
      el('h4', { text: 'Modified after upload' }),
      el('p', {
        text: `The key says ${absoluteDate(file.uploadedAt)} but S3 last modified it at `
          + `${absoluteDate(file.lastModified)}, so the object has been overwritten.`
      })
    ]),

    section('File', kv([
      ['Name', file.originalName],
      ['Key', copyable(file.fileKey)],
      ['Size', bytes(file.size)],
      ['Uploaded', file.uploadedAt ? absoluteDate(file.uploadedAt) : null],
      ['Last modified', absoluteDate(file.lastModified)]
    ])),

    section('Attribution', kv([
      ['Uploaded by', file.uploader?.email || null],
      ['Simulated by', file.usedBy.length > 0 ? file.usedBy.map((u) => u.email).join(', ') : null],
      ['Runs', file.runCount],
      ['First used', file.firstUsedAt ? absoluteDate(file.firstUsedAt) : null],
      ['Last used', file.lastUsedAt ? absoluteDate(file.lastUsedAt) : null]
    ])),

    file.jobIds.length > 0 && section('Runs using this file',
      el('pre', { class: 'block', text: file.jobIds.join('\n') }))
  ];

  openDrawer({
    title: file.originalName,
    subtitle: bytes(file.size),
    body: body.filter(Boolean),
    actions: [
      el('button', { class: 'btn-primary', type: 'button', onClick: () => download(file) }, 'Download'),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn-danger', type: 'button', onClick: () => remove(file) }, 'Delete file')
    ]
  });
}

async function download(file) {
  try {
    const { url } = await api(`/uploads/download?key=${encodeURIComponent(file.fileKey)}`);
    window.location.href = url;
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function remove(file) {
  const inUse = file.runCount > 0;
  // A file still referenced by runs is confirmed on its full key: a higher bar
  // for the more consequential delete. The server enforces the same rule.
  const expected = inUse ? file.fileKey : file.originalName;

  const confirmed = await confirmByTyping({
    title: 'Delete this CAD file?',
    body: el('div', {}, [
      el('p', { text: `This permanently removes ${bytes(file.size)} from S3. There is no undo.` }),
      inUse && el('p', {
        text: `${file.runCount} simulation${file.runCount === 1 ? '' : 's'} reference this file. `
          + 'Their results are unaffected, but the geometry can no longer be viewed or re-run.'
      })
    ].filter(Boolean)),
    expected,
    expectedLabel: inUse ? 'Type the full file key to confirm' : 'Type the file name to confirm'
  });
  if (!confirmed) return;

  try {
    await api(`/uploads?key=${encodeURIComponent(file.fileKey)}`, {
      method: 'DELETE',
      body: { confirm: expected }
    });
    toast(`Deleted ${file.originalName}`, 'ok');
    closeDrawer();
    await render({ refresh: true });
  } catch (err) {
    toast(err.message, 'error');
  }
}
