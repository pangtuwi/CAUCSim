// Every simulation in the bucket, from every account.
import { api, ApiError } from '../api.js';
import {
  el, clear, table, pageHead, stats, loading, errorNotice, toast,
  dateCell, absoluteDate, duration, bytes, number, statusPill,
  openDrawer, closeDrawer, section, kv, copyable, confirmByTyping
} from '../ui.js';

// The droplet self-destructs after 3600s. A run still calling itself "running"
// well past that has lost its droplet, or its droplet has lost the network —
// either way it is not coming back and is worth flagging.
const STALE_RUN_MS = 70 * 60 * 1000;

const state = {
  search: '',
  status: '',
  user: '',
  sort: 'started',
  order: 'desc',
  data: null
};

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
      state.data = await api(`/jobs${refresh ? '?refresh=1' : ''}`);
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

function visibleJobs() {
  const { jobs } = state.data;
  const needle = state.search.trim().toLowerCase();

  const filtered = jobs.filter((job) => {
    if (state.status && job.status !== state.status) return false;
    if (state.user && (job.userEmail || '(no user)') !== state.user) return false;
    if (!needle) return true;
    return [job.runName, job.originalName, job.jobId, job.userEmail, job.purpose]
      .filter(Boolean).join(' ').toLowerCase().includes(needle);
  });

  const direction = state.order === 'asc' ? 1 : -1;
  const sorters = {
    started: (a, b) => new Date(a.startedAt || 0) - new Date(b.startedAt || 0),
    user: (a, b) => String(a.userEmail || '').localeCompare(String(b.userEmail || '')),
    status: (a, b) => String(a.status || '').localeCompare(String(b.status || '')),
    size: (a, b) => (a.totalBytes || 0) - (b.totalBytes || 0),
    name: (a, b) => String(a.runName || '').localeCompare(String(b.runName || ''))
  };
  return [...filtered].sort((a, b) => (sorters[state.sort] || sorters.started)(a, b) * direction);
}

function draw() {
  const { jobs, malformed, scannedAt } = state.data;
  const rows = visibleJobs();
  const users = [...new Set(jobs.map((job) => job.userEmail || '(no user)'))].sort();

  clear(container);
  container.append(...pageHead(
    'Simulations',
    'Every run in the bucket, across all accounts. The CFD app only ever shows a user their own runs.',
    { scannedAt, onRefresh: () => render({ refresh: true }) }
  ));

  container.append(stats([
    ['Runs', jobs.length],
    ['Completed', jobs.filter((j) => j.status === 'completed').length],
    ['Failed', jobs.filter((j) => j.status === 'failed').length],
    ['In flight', jobs.filter((j) => j.status === 'running' || j.status === 'queued').length],
    ['Users', users.length],
    ['Stored', bytes(jobs.reduce((total, j) => total + (j.totalBytes || 0), 0))]
  ]));

  if (malformed.length > 0) {
    container.append(el('div', { class: 'notice notice-warn' }, [
      el('h4', { text: `${malformed.length} unreadable job record${malformed.length === 1 ? '' : 's'}` }),
      el('p', { text: 'These keys exist but could not be parsed, so they are missing from the list below.' }),
      el('ul', {}, malformed.map((m) => el('li', { text: `${m.key} — ${m.error}` })))
    ]));
  }

  container.append(el('div', { class: 'toolbar' }, [
    el('input', {
      type: 'search',
      placeholder: 'Search run, model, user or job id',
      value: state.search,
      onInput: (event) => { state.search = event.target.value; draw(); }
    }),
    select(['', 'queued', 'running', 'completed', 'failed', 'cancelled'], state.status, 'All statuses',
      (value) => { state.status = value; draw(); }),
    select(['', ...users], state.user, 'All users',
      (value) => { state.user = value; draw(); }),
    el('span', { class: 'spacer' }),
    el('span', { class: 'muted', text: `${rows.length} of ${jobs.length}` })
  ]));

  container.append(table(columns(), rows, {
    sort: { key: state.sort, order: state.order },
    onSort: (key) => {
      if (state.sort === key) state.order = state.order === 'asc' ? 'desc' : 'asc';
      else { state.sort = key; state.order = 'desc'; }
      draw();
    },
    onRowClick: openJob,
    emptyMessage: jobs.length === 0
      ? 'No simulations have been run yet.'
      : 'No runs match these filters.'
  }));
}

function select(options, value, placeholder, onChange) {
  return el('select', { onChange: (event) => onChange(event.target.value) },
    options.map((option) => el('option', {
      value: option,
      selected: option === value
    }, option === '' ? placeholder : option)));
}

function columns() {
  return [
    { key: 'status', label: 'Status', sortable: true, render: (job) => statusPill(job.status) },
    {
      key: 'name',
      label: 'Run',
      sortable: true,
      render: (job) => el('div', {}, [
        el('span', { text: job.runName || job.jobId }),
        el('span', { class: 'secondary-line', text: job.originalName || '' })
      ])
    },
    { key: 'user', label: 'User', sortable: true, render: (job) => job.userEmail || el('span', { class: 'muted', text: 'unknown' }) },
    { key: 'started', label: 'Started', sortable: true, class: 'nowrap', render: (job) => dateCell(job.startedAt) },
    { label: 'Duration', class: 'num', render: (job) => duration(job.startedAt, job.completedAt) },
    { label: 'Cd', class: 'num', render: (job) => number(job.metrics?.cd) },
    { label: 'Cl', class: 'num', render: (job) => number(job.metrics?.cl) },
    { key: 'size', label: 'Size', sortable: true, class: 'num', render: (job) => bytes(job.totalBytes) }
  ];
}

/* --- Detail ------------------------------------------------------------- */

async function openJob(job) {
  let detail;
  try {
    detail = await api(`/jobs/${job.jobId}`);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }

  const { job: full, artifacts } = detail;
  const stale = (full.status === 'running' || full.status === 'queued')
    && full.updatedAt && Date.now() - new Date(full.updatedAt).getTime() > STALE_RUN_MS;

  const body = [
    stale && el('div', { class: 'notice notice-warn' }, [
      el('h4', { text: 'This run looks abandoned' }),
      el('p', {
        text: `Still ${full.status}, but nothing has written to it since ${absoluteDate(full.updatedAt)}. `
          + 'The droplet destroys itself after an hour, so it has probably gone — check DigitalOcean '
          + `for droplet ${full.dropletId || 'unknown'}.`
      })
    ]),

    full.error && el('div', { class: 'notice notice-danger' }, [
      el('h4', { text: 'Error' }),
      el('p', { text: full.error })
    ]),

    section('Identity', kv([
      ['Job id', copyable(full.jobId)],
      ['User', full.userEmail || 'unknown'],
      ['User sub', copyable(full.userSub), { mono: true }],
      ['Geometry', copyable(full.fileKey)],
      ['Droplet', full.dropletId ? copyable(String(full.dropletId)) : null]
    ])),

    section('Timeline', kv([
      ['Status', statusPill(full.status)],
      ['Stage', full.stage],
      ['Started', absoluteDate(full.startedAt)],
      ['Updated', absoluteDate(full.updatedAt)],
      ['Completed', full.completedAt ? absoluteDate(full.completedAt) : null],
      ['Duration', duration(full.startedAt, full.completedAt)]
    ])),

    section('Parameters', kv([
      ['Race speed', full.raceSpeedMph ? `${full.raceSpeedMph} mph` : null],
      ['Frontal area', full.frontalArea ? `${full.frontalArea} m²` : null],
      ['Wheelbase', full.wheelbase ? `${full.wheelbase} m` : null],
      ['Moment centre X', full.momentCentreX],
      ['Fast check', full.fastCheck ? 'yes (coarse mesh)' : 'no'],
      ['Purpose', full.purpose]
    ])),

    full.metrics && section('Results', kv([
      ['Cd', `${number(full.metrics.cd)} ± ${number(full.metrics.cdStd)}`],
      ['Cl', `${number(full.metrics.cl)} ± ${number(full.metrics.clStd)}`],
      ['Cm', `${number(full.metrics.cm)} ± ${number(full.metrics.cmStd)}`],
      ['CdA', full.metrics.cda ? `${number(full.metrics.cda)} m²` : null],
      ['Drag force', full.metrics.dragForce ? `${full.metrics.dragForce} N` : null],
      ['Aero power', full.metrics.aeroPower ? `${full.metrics.aeroPower} W` : null],
      ['Converged', full.metrics.converged === undefined ? null : (full.metrics.converged ? 'yes' : 'no')],
      ['Iterations', full.metrics.iterations]
    ])),

    section(`Files (${artifacts.length})`, artifacts.length === 0
      ? el('p', { class: 'muted', text: 'This job has no objects in S3.' })
      : el('table', {}, [
        el('tbody', {}, artifacts.map((artifact) => el('tr', {}, [
          el('td', { class: 'mono wrap', text: artifact.name }),
          el('td', { class: 'num', text: bytes(artifact.size) }),
          el('td', { class: 'actions' }, [
            el('button', {
              class: 'btn-sm',
              type: 'button',
              onClick: () => downloadArtifact(full.jobId, artifact.name)
            }, 'Download')
          ])
        ])))
      ])),

    section('Raw record', el('details', {}, [
      el('summary', { text: 'Show job.json' }),
      el('pre', { class: 'block', text: JSON.stringify(full, null, 2) })
    ]))
  ];

  openDrawer({
    title: full.runName || full.jobId,
    subtitle: `${full.userEmail || 'unknown user'} · ${bytes(full.totalBytes)}`,
    body: body.filter(Boolean),
    actions: [
      artifacts.some((a) => a.name === 'results.zip')
        && el('button', { class: 'btn-primary', type: 'button', onClick: () => downloadArtifact(full.jobId, 'results.zip') }, 'Download results.zip'),
      artifacts.some((a) => a.name === 'simulation.log')
        && el('button', { type: 'button', onClick: () => window.open(`/api/admin/jobs/${full.jobId}/log`, '_blank') }, 'View log'),
      el('button', { type: 'button', onClick: () => downloadJobJson(full.jobId) }, 'Download job.json'),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn-danger', type: 'button', onClick: () => deleteJob(full, artifacts) }, 'Delete run')
    ].filter(Boolean)
  });
}

/* --- Downloads ---------------------------------------------------------- */

async function downloadArtifact(jobId, file) {
  try {
    const { url } = await api(`/jobs/${jobId}/download?file=${encodeURIComponent(file)}`);
    window.location.href = url;
  } catch (err) {
    toast(err.message, 'error');
  }
}

// job.json is served by the admin API rather than presigned, because a
// presigned URL would hand out the raw S3 object — which still contains the
// droplet's callback token. The API serves the stripped copy.
function downloadJobJson(jobId) {
  window.open(`/api/admin/jobs/${jobId}/job.json`, '_blank');
}

/* --- Delete ------------------------------------------------------------- */

async function deleteJob(job, artifacts) {
  const totalBytes = artifacts.reduce((total, a) => total + a.size, 0);

  const confirmed = await confirmByTyping({
    title: 'Delete this simulation?',
    body: el('div', {}, [
      el('p', {
        text: `This permanently removes ${artifacts.length} object${artifacts.length === 1 ? '' : 's'} `
          + `(${bytes(totalBytes)}) belonging to ${job.userEmail || 'an unknown user'}. There is no undo.`
      }),
      el('p', { class: 'muted', text: `Run: ${job.runName || '(unnamed)'}` })
    ]),
    expected: job.jobId,
    expectedLabel: 'Type the job id to confirm'
  });
  if (!confirmed) return;

  try {
    const result = await api(`/jobs/${job.jobId}`, { method: 'DELETE', body: { confirm: job.jobId } });
    toast(`Deleted ${result.deleted} objects (${bytes(result.bytes)})`, 'ok');
    closeDrawer();
    await render({ refresh: true });
  } catch (err) {
    if (err.code === 'job-in-flight') {
      toast(err.message, 'error');
      return;
    }
    toast(err.message, 'error');
  }
}
