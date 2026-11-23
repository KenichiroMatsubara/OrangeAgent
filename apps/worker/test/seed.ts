import type { TestD1Database } from './d1';

const CREATED_AT = '2026-07-25T00:00:00.000Z';

export const seedAccountRoute = (
  control: TestD1Database,
  input: {
    id: string;
    bindingName: string;
    databaseId?: string;
    name?: string;
    status?: 'provisioning' | 'active' | 'suspended' | 'failed';
  },
): void => {
  control.execute(
    `INSERT INTO organizations
      (id, name, status, database_id, binding_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    input.id,
    input.name ?? input.id,
    input.status ?? 'active',
    input.databaseId ?? `local:${input.bindingName}`,
    input.bindingName,
    CREATED_AT,
    CREATED_AT,
  );
};

export const seedScheduledEvent = (
  account: TestD1Database,
  input: {
    id: string;
    accountId?: string;
    title?: string;
    startsAt?: string;
    endsAt?: string;
    attendanceDeadline?: string | null;
    status?: 'draft' | 'scheduled' | 'cancelled' | 'exception';
  },
): void => {
  const accountId = input.accountId ?? 'organization-1';
  account.execute(
    `INSERT INTO events
      (id, organization_id, title, starts_at, ends_at, status, attendance_deadline, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.id,
    accountId,
    input.title ?? input.id,
    input.startsAt ?? '2099-01-01T10:00:00.000Z',
    input.endsAt ?? '2099-01-01T11:00:00.000Z',
    input.status ?? 'scheduled',
    input.attendanceDeadline ?? null,
    CREATED_AT,
    CREATED_AT,
  );
};

export const seedContact = (
  account: TestD1Database,
  input: { id: string; name?: string; email?: string; googleSubject?: string; lineDestinationId?: string },
): void => {
  account.execute(
    `INSERT OR IGNORE INTO members (id, organization_id, name, email, state, tags, google_subject, created_at, updated_at)
     VALUES (?, 'organization-1', ?, ?, 'active', '[]', ?, ?, ?)`,
    input.id,
    input.name ?? input.id,
    input.email ?? '',
    input.googleSubject ?? null,
    CREATED_AT,
    CREATED_AT,
  );
  if (!input.lineDestinationId) return;
  account.execute(
    `INSERT OR IGNORE INTO connections (id, kind, label, credential, status, created_at, updated_at)
     VALUES ('line-connection', 'line', 'LINE', '{}', 'active', ?, ?)`,
    CREATED_AT,
    CREATED_AT,
  );
  account.execute(
    `INSERT OR IGNORE INTO line_destinations (id, connection_id, destination_id, display_name, kind, status, source, discovered_at, updated_at)
     VALUES (?, 'line-connection', ?, ?, 'user', 'discovered', 'webhook', ?, ?)`,
    `line-${input.id}`,
    input.lineDestinationId,
    input.name ?? input.id,
    CREATED_AT,
    CREATED_AT,
  );
  account.execute(
    'INSERT OR IGNORE INTO member_line_destinations (member_id, line_destination_id, created_at) VALUES (?, ?, ?)',
    input.id,
    `line-${input.id}`,
    CREATED_AT,
  );
};

export const seedAttendanceRegistration = (
  account: TestD1Database,
  input: {
    eventId: string;
    contactId: string;
    destination: string;
    name?: string;
    googleSubject?: string;
    status?: 'unanswered' | 'attending' | 'not_attending';
  },
): void => {
  seedContact(account, {
    id: input.contactId,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.googleSubject === undefined ? {} : { googleSubject: input.googleSubject }),
    lineDestinationId: input.destination,
  });
  account.execute(
    `INSERT INTO attendance (event_id, member_id, status, comment, updated_at)
     VALUES (?, ?, ?, '', ?)`,
    input.eventId,
    input.contactId,
    input.status ?? 'unanswered',
    CREATED_AT,
  );
};

export const seedDeliveryRecord = (
  account: TestD1Database,
  input: {
    id: string;
    eventId?: string | null;
    destination: string;
    outcome?: 'succeeded' | 'failed' | 'pending';
    channel?: 'calendar' | 'line' | 'email' | 'drive';
    externalId?: string | null;
    createdAt: string;
  },
): void => {
  account.execute(
    `INSERT INTO deliveries
      (id, event_id, channel, destination, outcome, external_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    input.id,
    input.eventId ?? null,
    input.channel ?? 'calendar',
    input.destination,
    input.outcome ?? 'succeeded',
    input.externalId ?? null,
    input.createdAt,
  );
};

export const seedAutomationException = (
  account: TestD1Database,
  input: { id: string; code?: string; message?: string },
): void => {
  account.execute(
    `INSERT INTO exceptions (id, code, message, state, created_at)
     VALUES (?, ?, ?, 'open', ?)`,
    input.id,
    input.code ?? 'test_exception',
    input.message ?? 'Test exception',
    CREATED_AT,
  );
};

export const seedAccountContact = (
  control: TestD1Database,
  input: {
    accountId?: string;
    identityId: string;
    email: string;
    state?: 'active' | 'suspended' | 'removed';
    sessionId?: string;
  },
): void => {
  control.execute(
    'INSERT INTO identities (id, google_subject, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    input.identityId,
    `google-${input.identityId}`,
    input.email,
    input.email,
    CREATED_AT,
    CREATED_AT,
  );
  control.execute(
    'INSERT INTO admins (organization_id, identity_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    input.accountId ?? 'organization-1',
    input.identityId,
    input.state ?? 'active',
    CREATED_AT,
    CREATED_AT,
  );
  if (input.sessionId) {
    control.execute(
      'INSERT INTO sessions (id, identity_id, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
      input.sessionId,
      input.identityId,
      '2099-01-01T00:00:00.000Z',
      CREATED_AT,
      CREATED_AT,
    );
  }
};

export interface MemoryR2 {
  bucket: R2Bucket;
  object: (key: string) => string | undefined;
  /** The media type an object was put with, for a file kept as it is. */
  contentType: (key: string) => string | undefined;
  keys: () => string[];
}

interface MemoryObject {
  bytes: Uint8Array;
  contentType: string | undefined;
  customMetadata: Record<string, string>;
}

export const createMemoryR2 = (failure?: Error): MemoryR2 => {
  const objects = new Map<string, MemoryObject>();
  return {
    bucket: {
      put: async (key: string, value: string | ReadableStream | ArrayBuffer | ArrayBufferView | Blob, options?: R2PutOptions) => {
        if (failure) throw failure;
        const bytes = typeof value === 'string' ? new TextEncoder().encode(value)
          : value instanceof ArrayBuffer ? new Uint8Array(value)
            : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()
              : undefined;
        if (!bytes) throw new Error('The test R2 adapter accepts strings and bytes only.');
        const metadata = options?.httpMetadata;
        objects.set(key, {
          bytes,
          contentType: metadata instanceof Headers ? metadata.get('Content-Type') ?? undefined : metadata?.contentType,
          customMetadata: { ...options?.customMetadata },
        });
        return null;
      },
      get: async (key: string) => {
        const value = objects.get(key);
        return value === undefined ? null : {
          size: value.bytes.byteLength,
          get body() { return new Response(value.bytes.slice()).body; },
          text: async () => new TextDecoder().decode(value.bytes),
          arrayBuffer: async () => value.bytes.slice().buffer,
        };
      },
      head: async (key: string) => {
        const value = objects.get(key);
        return value === undefined ? null : { key, size: value.bytes.byteLength, httpMetadata: { contentType: value.contentType }, customMetadata: value.customMetadata };
      },
      // Every match on one page: no test keeps more objects than R2 lists at once.
      list: async (options?: R2ListOptions) => ({
        objects: [...objects.entries()].filter(([key]) => key.startsWith(options?.prefix ?? '')).sort(([left], [right]) => (left < right ? -1 : 1)).map(([key, value]) => ({
          key, size: value.bytes.byteLength, httpMetadata: { contentType: value.contentType }, customMetadata: value.customMetadata,
        })),
        truncated: false,
        delimitedPrefixes: [],
      }),
      delete: async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
      },
    } as unknown as R2Bucket,
    object: (key) => {
      const value = objects.get(key);
      return value === undefined ? undefined : new TextDecoder().decode(value.bytes);
    },
    contentType: (key) => objects.get(key)?.contentType,
    keys: () => [...objects.keys()],
  };
};

/** A SKILL.md naming a Skill, saying when it applies, and giving its instructions. */
/** A SKILL.md as Agent Skills write it: its name, when it applies, and, when it has one, the title a person reads. */
export const skillDocument = (input: { name: string; title?: string; description?: string; instructions: string }): string =>
  `---\nname: ${input.name}\ndescription: ${JSON.stringify(input.description ?? 'When the work calls for it.')}\n${input.title ? `metadata:\n  display-name: ${JSON.stringify(input.title)}\n` : ''}---\n\n${input.instructions}\n`;
