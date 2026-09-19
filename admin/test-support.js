// Shared mock harness for the admin test suites.
//
// Extends the approach in the repo-root app.test.js (an in-memory object store
// behind a fake S3Client that dispatches on command.constructor.name) with the
// things the admin app does and the CFD backend does not: paginated listings,
// bulk deletes, and Cognito.
//
// Each factory is required from inside a jest.mock() callback, which is why
// this lives in its own module — jest.mock factories cannot close over
// ordinary outer-scope variables.

const state = {
  objects: new Map(),        // key -> string body
  users: [],                 // raw Cognito ListUsers shapes
  adminUsernames: [],
  deleteObjectsErrors: [],   // keys that DeleteObjects should report as failed
  cognitoError: null,        // when set, Cognito calls reject with it
  counts: { list: 0, get: 0, deleteObjects: 0, deleteObject: 0, put: 0 }
};

function reset() {
  state.objects.clear();
  state.users = [];
  state.adminUsernames = [];
  state.deleteObjectsErrors = [];
  state.cognitoError = null;
  state.counts = { list: 0, get: 0, deleteObjects: 0, deleteObject: 0, put: 0 };
}

const putObject = (key, body) =>
  state.objects.set(key, typeof body === 'string' ? body : JSON.stringify(body));

const keys = () => [...state.objects.keys()].sort();
const has = (key) => state.objects.has(key);
const read = (key) => state.objects.get(key);

/** A complete job: job.json plus the artifacts a real run leaves behind. */
function putJob(job, { artifacts = ['results.zip', 'simulation.log', 'flow_slice.png'] } = {}) {
  putObject(`results/${job.jobId}/job.json`, JSON.stringify(job, null, 2));
  for (const name of artifacts) {
    putObject(`results/${job.jobId}/${name}`, `contents of ${name}`);
  }
}

function makeJob(overrides = {}) {
  const jobId = overrides.jobId || `job-${Date.now()}-abcdef12`;
  return {
    jobId,
    fileKey: 'uploads/1700000000000_car.stl',
    originalName: 'car.stl',
    status: 'completed',
    stage: 'done',
    error: null,
    startedAt: '2026-01-01T10:00:00.000Z',
    updatedAt: '2026-01-01T10:30:00.000Z',
    completedAt: '2026-01-01T10:30:00.000Z',
    dropletId: 12345,
    // The secret the droplet authenticates its callbacks with. Nothing the
    // admin API returns may ever contain it.
    jobToken: 'SUPER-SECRET-CALLBACK-TOKEN',
    metrics: { cd: 0.42, cl: -0.1 },
    runName: 'Test run',
    userSub: 'user-sub-1',
    userEmail: 'one@example.com',
    ...overrides
  };
}

function makeCognitoUser(overrides = {}) {
  const { email = 'one@example.com', sub = 'user-sub-1', ...rest } = overrides;
  return {
    Username: rest.Username || `uuid-${sub}`,
    Enabled: true,
    UserStatus: 'CONFIRMED',
    UserCreateDate: new Date('2025-06-01T00:00:00Z'),
    UserLastModifiedDate: new Date('2025-06-02T00:00:00Z'),
    Attributes: [
      { Name: 'sub', Value: sub },
      { Name: 'email', Value: email },
      { Name: 'email_verified', Value: 'true' }
    ],
    ...rest
  };
}

/* --- @aws-sdk/client-s3 -------------------------------------------------- */

function s3Mock() {
  // Named classes so the dispatcher can switch on constructor.name, exactly as
  // the root app.test.js does.
  class PutObjectCommand { constructor(input) { this.input = input; } }
  class GetObjectCommand { constructor(input) { this.input = input; } }
  class DeleteObjectCommand { constructor(input) { this.input = input; } }
  class DeleteObjectsCommand { constructor(input) { this.input = input; } }
  class ListObjectsV2Command { constructor(input) { this.input = input; } }
  class HeadObjectCommand { constructor(input) { this.input = input; } }

  // S3 returns at most 1000 keys per listing. Reproducing that is the point of
  // this mock: it is what makes "does the admin app actually paginate?"
  // testable, and the CFD backend's missing continuation loop a real bug.
  const MAX_KEYS = 1000;

  const send = async (command) => {
    const input = command.input || {};

    switch (command.constructor.name) {
      case 'PutObjectCommand': {
        state.counts.put++;
        state.objects.set(input.Key, input.Body);
        return {};
      }

      case 'GetObjectCommand': {
        state.counts.get++;
        if (!state.objects.has(input.Key)) {
          const err = new Error('NoSuchKey');
          err.name = 'NoSuchKey';
          err.code = 'NoSuchKey';
          throw err;
        }
        const body = state.objects.get(input.Key);
        return { Body: { transformToString: async () => String(body) } };
      }

      case 'HeadObjectCommand': {
        if (!state.objects.has(input.Key)) {
          const err = new Error('NotFound');
          err.name = 'NotFound';
          throw err;
        }
        return {};
      }

      case 'DeleteObjectCommand': {
        state.counts.deleteObject++;
        state.objects.delete(input.Key);
        return {};
      }

      case 'DeleteObjectsCommand': {
        state.counts.deleteObjects++;
        const requested = (input.Delete?.Objects || []).map((o) => o.Key);
        const failed = new Set(state.deleteObjectsErrors);
        const Deleted = [];
        const Errors = [];
        for (const key of requested) {
          if (failed.has(key)) {
            Errors.push({ Key: key, Code: 'AccessDenied', Message: 'Access Denied' });
          } else {
            state.objects.delete(key);
            Deleted.push({ Key: key });
          }
        }
        return { Deleted, Errors };
      }

      case 'ListObjectsV2Command': {
        state.counts.list++;
        const matching = keys().filter((key) => key.startsWith(input.Prefix || ''));
        const start = input.ContinuationToken ? Number(input.ContinuationToken) : 0;
        const page = matching.slice(start, start + MAX_KEYS);
        const end = start + page.length;
        const truncated = end < matching.length;
        return {
          Contents: page.map((key) => ({
            Key: key,
            Size: String(state.objects.get(key) ?? '').length,
            LastModified: new Date('2026-01-01T12:00:00Z')
          })),
          IsTruncated: truncated,
          NextContinuationToken: truncated ? String(end) : undefined
        };
      }

      default:
        throw new Error(`Unmocked S3 command: ${command.constructor.name}`);
    }
  };

  return {
    S3Client: jest.fn().mockImplementation(() => ({ send })),
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
    DeleteObjectsCommand,
    ListObjectsV2Command,
    HeadObjectCommand
  };
}

/* --- @aws-sdk/s3-request-presigner --------------------------------------- */

// Echo the key and the disposition so tests can assert that downloads were
// asked for as attachments with the right filename.
function presignerMock() {
  return {
    getSignedUrl: jest.fn(async (client, command) => {
      const disposition = command.input.ResponseContentDisposition || '';
      return `https://signed.example/${command.input.Key}?disposition=${encodeURIComponent(disposition)}`;
    })
  };
}

/* --- aws-jwt-verify ------------------------------------------------------ */

const TOKENS = {
  'admin-token': { sub: 'admin-sub', email: 'admin@example.com', 'cognito:groups': ['admins'] },
  // Cognito normally sends an array; tolerate the string shape too.
  'admin-token-string-groups': { sub: 'admin-sub', email: 'admin@example.com', 'cognito:groups': 'admins' },
  // Authenticates perfectly well, simply is not an admin. Must be 403, not 401.
  'user-token': { sub: 'user-sub-1', email: 'one@example.com' },
  'other-group-token': { sub: 'x', email: 'x@example.com', 'cognito:groups': ['engineers'] }
};

function jwtVerifyMock() {
  return {
    CognitoJwtVerifier: {
      create: jest.fn(() => ({
        verify: jest.fn(async (token) => {
          if (!TOKENS[token]) {
            const err = new Error('Invalid token signature');
            err.name = 'JwtInvalidSignatureError';
            throw err;
          }
          return TOKENS[token];
        })
      }))
    }
  };
}

/* --- @aws-sdk/client-cognito-identity-provider ---------------------------- */

function cognitoMock() {
  class ListUsersCommand { constructor(input) { this.input = input; } }
  class ListUsersInGroupCommand { constructor(input) { this.input = input; } }

  // Deliberately smaller than Cognito's real 60 so a two-page listing is easy
  // to set up, and any code that ignores PaginationToken visibly loses users.
  const PAGE = 2;

  const send = async (command) => {
    if (state.cognitoError) throw state.cognitoError;
    const input = command.input || {};

    switch (command.constructor.name) {
      case 'ListUsersCommand': {
        const start = input.PaginationToken ? Number(input.PaginationToken) : 0;
        const page = state.users.slice(start, start + PAGE);
        const end = start + page.length;
        return {
          Users: page,
          PaginationToken: end < state.users.length ? String(end) : undefined
        };
      }
      case 'ListUsersInGroupCommand':
        return { Users: state.adminUsernames.map((Username) => ({ Username })) };
      default:
        throw new Error(`Unmocked Cognito command: ${command.constructor.name}`);
    }
  };

  return {
    CognitoIdentityProviderClient: jest.fn().mockImplementation(() => ({ send })),
    ListUsersCommand,
    ListUsersInGroupCommand
  };
}

/* --- Environment --------------------------------------------------------- */

// Must run before the app is required: lib/config.js validates at import time.
function setEnv() {
  process.env.NODE_ENV = 'test';
  process.env.S3_BUCKET_NAME = 'mock-bucket';
  process.env.AWS_REGION = 'eu-west-2';
  process.env.COGNITO_USER_POOL_ID = 'eu-west-2_mockpool';
  process.env.COGNITO_CLIENT_ID = 'mockclient';
  process.env.ADMIN_GROUP = 'admins';
  // Caching would make one test's scan leak into the next.
  process.env.ADMIN_JOB_CACHE_TTL_MS = '1';
  process.env.ADMIN_AUDIT_S3 = 'false';
}

module.exports = {
  state,
  reset,
  putObject,
  putJob,
  makeJob,
  makeCognitoUser,
  keys,
  has,
  read,
  s3Mock,
  presignerMock,
  jwtVerifyMock,
  cognitoMock,
  setEnv
};
