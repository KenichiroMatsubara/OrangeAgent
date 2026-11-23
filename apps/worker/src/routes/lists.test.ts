import { afterEach, describe, expect, it } from 'vitest';

import { listRoutes } from './lists';
import { createTestApp, type TestApp } from '../../test/app';
import { seedContact } from '../../test/seed';

let fixture: TestApp | undefined;

afterEach(() => fixture?.close());

describe('Contact List routes', () => {
  it('saves a Contact List with its Contacts and replaces them on the next save', async () => {
    fixture = createTestApp();
    seedContact(fixture.account, { id: 'contact-1' });
    seedContact(fixture.account, { id: 'contact-2' });
    const save = (contactIds: string[]) => listRoutes.fetch(fixture!.jsonRequest(
      '/organizations/organization-1/contact-lists/readers', { name: '読む人', contactIds }, 'PUT',
    ), fixture!.environment);

    await save(['contact-1', 'contact-2']);
    const saved = await save(['contact-2']);
    const listed = await listRoutes.fetch(fixture.request('/organizations/organization-1/contact-lists'), fixture.environment);

    expect(saved.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({ data: [{ id: 'readers', name: '読む人', contactIds: ['contact-2'] }] });
  });

  it('refuses a Contact List with no name', async () => {
    fixture = createTestApp();

    const response = await listRoutes.fetch(fixture.jsonRequest(
      '/organizations/organization-1/contact-lists/readers', { name: '  ' }, 'PUT',
    ), fixture.environment);

    expect(response.status).toBe(400);
  });
});
