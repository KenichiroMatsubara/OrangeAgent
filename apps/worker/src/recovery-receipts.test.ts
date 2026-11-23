import { afterEach, describe, expect, it } from 'vitest';

import { archiveExpiredDeliveryRecords } from './delivery-archive';
import { encrypt, masterKey } from './cryptography';
import { readRecoveryReceipt, restoreDeliveryRecordFromReceipt, writeRecoveryReceipt } from './recovery-receipts';
import { createMigratedTestD1, type TestD1Database } from '../test/d1';
import { createMemoryR2, seedScheduledEvent } from '../test/seed';

const openDatabases: TestD1Database[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

describe('Recovery Receipts', () => {
  it('stores a successful external effect and retrieves it by idempotency key', async () => {
    const r2 = createMemoryR2();
    const key = await masterKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    const receipt = {
      accountId: 'organization-1',
      idempotencyKey: 'calendar:event-1:recipient-1',
      effectType: 'calendar' as const,
      externalId: 'google-event-1',
      destinationFingerprint: 'sha256:abc',
      succeededAt: '2026-07-25T00:00:00.000Z',
    };

    const path = await writeRecoveryReceipt({ bucket: r2.bucket, receipt });

    expect(JSON.parse(r2.object(path) ?? '{}')).toEqual(receipt);
    await expect(readRecoveryReceipt({
      bucket: r2.bucket,
      accountKey: key,
      accountId: 'organization-1',
      idempotencyKey: 'calendar:event-1:recipient-1',
    })).resolves.toEqual(receipt);
  });

  it('still reads a receipt kept encrypted before receipts were kept as they are', async () => {
    const r2 = createMemoryR2();
    const key = await masterKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    const receipt = {
      accountId: 'organization-1',
      idempotencyKey: 'calendar:event-1:recipient-1',
      effectType: 'calendar' as const,
      externalId: 'google-event-1',
      destinationFingerprint: 'sha256:abc',
      succeededAt: '2026-07-25T00:00:00.000Z',
    };
    const envelope = await encrypt(JSON.stringify(receipt), key, 'recovery-receipt:organization-1:calendar:event-1:recipient-1');
    await r2.bucket.put('recovery-receipts/organization-1/calendar%3Aevent-1%3Arecipient-1.json', JSON.stringify(envelope));

    await expect(readRecoveryReceipt({
      bucket: r2.bucket,
      accountKey: key,
      accountId: 'organization-1',
      idempotencyKey: 'calendar:event-1:recipient-1',
    })).resolves.toEqual(receipt);
  });

  it('restores a durable successful Delivery Record that participates in normal retention', async () => {
    const database = createMigratedTestD1('organization');
    openDatabases.push(database);
    seedScheduledEvent(database, { id: 'event-1' });

    await restoreDeliveryRecordFromReceipt(database.binding, {
      accountId: 'organization-1',
      idempotencyKey: 'calendar:event-1:recipient-1',
      effectType: 'calendar',
      externalId: 'google-event-1',
      destinationFingerprint: 'sha256:abc',
      succeededAt: '2026-07-25T00:00:00.000Z',
    });

    await expect(archiveExpiredDeliveryRecords({
      database: database.binding,
      bucket: createMemoryR2().bucket,
      accountId: 'organization-1',
      before: '2099-01-01T00:00:00.000Z',
    })).resolves.toBe(1);
  });
});
