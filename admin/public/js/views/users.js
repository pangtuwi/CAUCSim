// Cognito accounts, with the activity that can be derived from job records.
import { api, ApiError } from '../api.js';
import {
  el, clear, table, pageHead, stats, loading, errorNotice,
  dateCell, absoluteDate, userStatePill, openDrawer, section, kv, copyable
} from '../ui.js';

const state = { search: '', showAll: false, sort: 'email', order: 'asc', data: null };

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
      state.data = await api(`/users${refresh ? '?refresh=1' : ''}`);
      onCountChange(state.data.activeCount);
    } catch (err) {
      clear(container);
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return;
      container.append(errorNotice(
        err.message,
        err instanceof ApiError && err.code === 'cognito-permissions'
          ? 'Everything else in this app still works — only this view needs Cognito read access.'
          : null
      ));
      return;
    }
  }
  draw();
}

function visibleUsers() {
  const needle = state.search.trim().toLowerCase();
  const filtered = state.data.users.filter((user) => {
    if (!state.showAll && user.state !== 'active') return false;
    if (!needle) return true;
    return [user.email, user.sub, user.username].filter(Boolean).join(' ').toLowerCase().includes(needle);
  });

  const direction = state.order === 'asc' ? 1 : -1;
  const sorters = {
    email: (a, b) => String(a.email).localeCompare(String(b.email)),
    state: (a, b) => String(a.state).localeCompare(String(b.state)),
    runs: (a, b) => a.simulationCount - b.simulationCount,
    lastRun: (a, b) => new Date(a.lastRunAt || 0) - new Date(b.lastRunAt || 0),
    created: (a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
  };
  return [...filtered].sort((a, b) => (sorters[state.sort] || sorters.email)(a, b) * direction);
}

function draw() {
  const { users, adminGroup, scannedAt } = state.data;
  const rows = visibleUsers();

  clear(container);
  container.append(...pageHead(
    'Users',
    'Every account in the Cognito pool. Cognito does not record sign-ins, so "last run" — '
    + 'taken from simulation records — is the only real activity signal there is.',
    { scannedAt, onRefresh: () => render({ refresh: true }) }
  ));

  container.append(stats([
    ['Accounts', users.filter((u) => !u.synthetic).length],
    ['Active', users.filter((u) => u.state === 'active').length],
    ['Invited', users.filter((u) => u.state === 'invited').length],
    ['Disabled', users.filter((u) => u.state === 'disabled').length],
    ['Admins', users.filter((u) => u.isAdmin).length]
  ]));

  const deleted = users.find((u) => u.state === 'unknown-account');
  if (deleted) {
    container.append(el('div', { class: 'notice notice-warn' }, [
      el('h4', { text: `${deleted.simulationCount} simulation${deleted.simulationCount === 1 ? '' : 's'} belong to a deleted account` }),
      el('p', { text: 'Their owner has been removed from the pool. The data is still in the bucket.' })
    ]));
  }

  const noUser = users.find((u) => u.state === 'no-user');
  if (noUser) {
    container.append(el('div', { class: 'notice' }, [
      el('h4', { text: `${noUser.simulationCount} simulation${noUser.simulationCount === 1 ? '' : 's'} record no user at all` }),
      el('p', {
        text: 'These predate the CFD app writing userSub and userEmail into job.json, so the owner '
          + 'was never captured. The CFD app shows these runs to every signed-in user.'
      })
    ]));
  }

  container.append(el('div', { class: 'toolbar' }, [
    el('input', {
      type: 'search',
      placeholder: 'Search email or sub',
      value: state.search,
      onInput: (event) => { state.search = event.target.value; draw(); }
    }),
    el('label', { class: 'muted' }, [
      el('input', {
        type: 'checkbox',
        checked: state.showAll,
        style: 'width:auto;margin-right:6px;vertical-align:middle',
        onChange: (event) => { state.showAll = event.target.checked; draw(); }
      }),
      'Show invited and disabled'
    ]),
    el('span', { class: 'spacer' }),
    el('span', { class: 'muted', text: `${rows.length} shown · admin group "${adminGroup}"` })
  ]));

  container.append(table(columns(), rows, {
    sort: { key: state.sort, order: state.order },
    onSort: (key) => {
      if (state.sort === key) state.order = state.order === 'asc' ? 'desc' : 'asc';
      else { state.sort = key; state.order = 'asc'; }
      draw();
    },
    onRowClick: openUser,
    emptyMessage: state.showAll
      ? 'No accounts match this search.'
      : 'No active accounts. Tick "Show invited and disabled" to see the rest.'
  }));
}

function columns() {
  return [
    {
      key: 'email',
      label: 'Email',
      sortable: true,
      render: (user) => el('div', {}, [
        el('span', { text: user.email }),
        user.isAdmin && el('span', { class: 'pill pill-accent', style: 'margin-left:8px', text: 'admin' }),
        !user.emailVerified && !user.synthetic
          && el('span', { class: 'secondary-line', text: 'email not verified' })
      ].filter(Boolean))
    },
    {
      key: 'state',
      label: 'State',
      sortable: true,
      // "Active" means enabled and confirmed — a policy choice this app makes,
      // not something Cognito reports, hence the tooltip.
      render: (user) => userStatePill(user.state)
    },
    { key: 'runs', label: 'Runs', sortable: true, class: 'num', render: (user) => user.simulationCount },
    {
      key: 'lastRun',
      label: 'Last run',
      sortable: true,
      class: 'nowrap',
      render: (user) => dateCell(user.lastRunAt)
    },
    { key: 'created', label: 'Created', sortable: true, class: 'nowrap', render: (user) => dateCell(user.createdAt) }
  ];
}

function openUser(user) {
  openDrawer({
    title: user.email,
    subtitle: user.synthetic ? 'Not a Cognito account — a bucket of unclaimed runs' : user.state,
    body: [
      section('Account', kv([
        ['State', userStatePill(user.state)],
        ['Cognito status', user.status],
        ['Enabled', user.synthetic ? null : (user.enabled ? 'yes' : 'no')],
        ['Email verified', user.synthetic ? null : (user.emailVerified ? 'yes' : 'no')],
        ['Admin', user.isAdmin ? 'yes' : 'no'],
        ['Sub', user.sub ? copyable(user.sub) : null],
        ['Username', user.username ? copyable(user.username) : null],
        ['Created', user.createdAt ? absoluteDate(user.createdAt) : null],
        // Explicitly not a sign-in time. Cognito has no such field, and
        // labelling this one as one would be a lie people would act on.
        ['Attributes changed', user.modifiedAt ? absoluteDate(user.modifiedAt) : null]
      ])),

      section('Activity', kv([
        ['Simulations', user.simulationCount],
        ['Completed', user.completedCount],
        ['Failed', user.failedCount],
        ['In flight', user.runningCount],
        ['Last run', user.lastRunAt ? absoluteDate(user.lastRunAt) : 'never']
      ])),

      !user.synthetic && el('div', { class: 'notice' }, [
        el('h4', { text: 'Managing this account' }),
        el('p', {
          text: 'This app is read-only for users. Inviting, disabling, resetting and deleting '
            + 'are done with the AWS CLI — see Documentation/USER_MANAGEMENT.md.'
        })
      ])
    ].filter(Boolean)
  });
}
