import { afterEach, describe, expect, it } from 'vitest';

import { inboxRoutes } from './inbox';
import { createTestApp, type TestApp } from '../../test/app';
import { createAutomationTestApp } from '../../test/automation';
import { memoryProviders } from '../../test/providers';

const providers = memoryProviders();
const automationRoutes = inboxRoutes(providers);

let fixture: TestApp | undefined;

afterEach(() => fixture?.close());

describe('Account Automation routes', () => {
  it('reads Automation Inbox behavior for the authenticated Account', async () => {
    fixture = createTestApp();

    const response = await automationRoutes.fetch(
      fixture.request('/organizations/organization-1/automation'),
      fixture.environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { email: 'owner@example.com', displayName: 'Owner', status: 'active' },
    });
  });

  it('reports an Inbox that needs reauthentication so the dashboard can offer recovery', async () => {
    fixture = createTestApp();
    fixture.account.execute(
      "UPDATE google_connections SET status = 'reauthentication_required', last_error = 'Token has been expired or revoked.' WHERE kind = 'automation_inbox'",
    );

    const response = await automationRoutes.fetch(
      fixture.request('/organizations/organization-1/automation'),
      fixture.environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        status: 'reauthentication_required',
        lastError: 'Token has been expired or revoked.',
      },
    });
  });

  it('says whether the Inbox grant lets OrangeAgent save drafts', async () => {
    fixture = createTestApp();
    fixture.account.execute(
      "UPDATE google_connections SET granted_scopes = '[\"openid\",\"https://www.googleapis.com/auth/gmail.send\"]' WHERE kind = 'automation_inbox'",
    );
    const before = await automationRoutes.fetch(fixture.request('/organizations/organization-1/automation'), fixture.environment);
    await expect(before.json()).resolves.toMatchObject({ data: { draftsGranted: false } });

    fixture.account.execute(
      "UPDATE google_connections SET granted_scopes = '[\"https://mail.google.com/\"]' WHERE kind = 'automation_inbox'",
    );
    const after = await automationRoutes.fetch(fixture.request('/organizations/organization-1/automation'), fixture.environment);
    await expect(after.json()).resolves.toMatchObject({ data: { draftsGranted: true } });
  });

  it('says whether the Inbox grant lets OrangeAgent read the Drive', async () => {
    fixture = createTestApp();
    fixture.account.execute(
      "UPDATE google_connections SET granted_scopes = '[\"https://www.googleapis.com/auth/drive.file\"]' WHERE kind = 'automation_inbox'",
    );
    const before = await automationRoutes.fetch(fixture.request('/organizations/organization-1/automation'), fixture.environment);
    await expect(before.json()).resolves.toMatchObject({ data: { driveGranted: false } });

    fixture.account.execute(
      "UPDATE google_connections SET granted_scopes = '[\"https://www.googleapis.com/auth/drive\"]' WHERE kind = 'automation_inbox'",
    );
    const after = await automationRoutes.fetch(fixture.request('/organizations/organization-1/automation'), fixture.environment);
    await expect(after.json()).resolves.toMatchObject({ data: { driveGranted: true } });
  });

  it('adds a Drive folder runs read beneath by its link, read from Drive once, and removes it', async () => {
    fixture = await createAutomationTestApp();
    const app = fixture;
    const folders = '/organizations/organization-1/drive-folders';
    const add = async (link: string) => automationRoutes.fetch(app.jsonRequest(folders, { link }), app.environment);
    providers.google.drive.held.push(
      { id: 'folder-reikai-0001', name: '例会', mimeType: 'application/vnd.google-apps.folder' },
      { id: 'file-agenda-0001', name: '次第.pdf', mimeType: 'application/pdf', bytes: new Uint8Array([1]) },
    );

    const ungranted = await add('https://drive.google.com/drive/folders/folder-reikai-0001');
    expect(ungranted.status).toBe(400);
    await expect(ungranted.json()).resolves.toMatchObject({ error: { message: expect.stringContaining('つなぎ直してください') } });

    app.account.execute("UPDATE google_connections SET granted_scopes = '[\"https://www.googleapis.com/auth/drive\"]' WHERE kind = 'automation_inbox'");
    const added = await add('https://drive.google.com/drive/u/0/folders/folder-reikai-0001?usp=sharing');
    await expect(added.json()).resolves.toEqual({ data: { folders: [{ id: 'folder-reikai-0001', name: '例会', url: 'https://drive.example/folder-reikai-0001' }] } });
    expect((await add('https://drive.google.com/file/d/file-agenda-0001/view')).status).toBe(400);
    expect((await add('file-agenda-0001')).status).toBe(400);
    expect((await add('https://example.com/folders/folder-reikai-0001')).status).toBe(400);

    const removed = await automationRoutes.fetch(app.request(`${folders}/folder-reikai-0001`, { method: 'DELETE' }), app.environment);
    await expect(removed.json()).resolves.toEqual({ data: { folders: [] } });
    await expect((await automationRoutes.fetch(app.request(folders), app.environment)).json()).resolves.toEqual({ data: { folders: [] } });
  });
});
