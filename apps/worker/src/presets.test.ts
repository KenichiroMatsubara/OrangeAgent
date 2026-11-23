import { describe, expect, it } from 'vitest';

import { app } from './app';
import { availablePresets } from './presets';
import { createTestApp } from '../test/app';
import { skillDocument } from '../test/seed';

describe('Preset catalog', () => {
  it('ships each self-contained JSON Preset', () => {
    expect(availablePresets()).toEqual([
      expect.objectContaining({
        id: 'membership-organization',
        skills: [expect.objectContaining({ key: 'membership-assistant' })],
        automations: [expect.objectContaining({ skillKeys: ['membership-assistant'] })],
      }),
      expect.objectContaining({
        id: 'meeting-minutes',
        skills: [expect.objectContaining({ key: 'meeting-transcription' }), expect.objectContaining({ key: 'meeting-minutes' })],
        automations: [
          expect.objectContaining({ skillKeys: ['meeting-transcription'], schedule: 'daily 07:00' }),
          expect.objectContaining({ skillKeys: ['meeting-minutes'], schedule: 'hourly :30' }),
        ],
      }),
    ]);
  });

  it('exposes the shipped Preset metadata to setup and settings screens', async () => {
    const fixture = createTestApp();
    try {
      const response = await app.fetch(fixture.request('/api/presets'), fixture.environment);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ data: [{
        id: 'membership-organization',
        name: 'Membership organization',
        description: expect.any(String),
      }, {
        id: 'meeting-minutes',
        name: '会議の議事録',
        description: expect.any(String),
      }] });
    } finally {
      fixture.close();
    }
  });
});

describe('Preset application', () => {
  it('copies the complete Preset configuration into an empty Account', async () => {
    const fixture = createTestApp();
    try {
      const applied = await app.fetch(fixture.jsonRequest(
        '/api/organizations/organization-1/presets/membership-organization/apply',
        {},
      ), fixture.environment);
      const [skills, automations] = await Promise.all([
        app.fetch(fixture.request('/api/organizations/organization-1/skills'), fixture.environment),
        app.fetch(fixture.request('/api/organizations/organization-1/automations'), fixture.environment),
      ]);

      expect(applied.status).toBe(201);
      await expect(applied.json()).resolves.toEqual({
        data: { presetId: 'membership-organization', skills: 1, automations: 1 },
      });
      const [skill] = (await skills.json() as { data: Array<{ id: string; name: string }> }).data;
      expect(skill).toMatchObject({ name: 'membership-assistant', title: 'Membership assistant' });
      await expect(automations.json()).resolves.toMatchObject({ data: [{
        name: 'Membership follow-up', enabled: false, executionMode: 'approval', revision: 1,
        skillIds: [skill!.id], schedule: 'daily 05:00',
      }] });
    } finally {
      fixture.close();
    }
  });

  it('does not retain a live link to the repository document after copying', async () => {
    const fixture = createTestApp();
    const document = availablePresets()[0]!;
    const rule = document.automations[0]!;
    const originalName = rule.name;
    try {
      await app.fetch(fixture.jsonRequest(
        '/api/organizations/organization-1/presets/membership-organization/apply',
        {},
      ), fixture.environment);
      rule.name = 'Changed in a later product release';

      const copiedRules = await app.fetch(
        fixture.request('/api/organizations/organization-1/automations'),
        fixture.environment,
      );

      await expect(copiedRules.json()).resolves.toMatchObject({ data: [{ name: originalName }] });
    } finally {
      rule.name = originalName;
      fixture.close();
    }
  });

  it('rejects existing configuration unless the member explicitly chooses to add another copy', async () => {
    const fixture = createTestApp();
    try {
      await app.fetch(fixture.fileRequest('/api/organizations/organization-1/skills', skillDocument({
        name: 'existing-configuration', instructions: 'Act.',
      }), 'POST', 'text/markdown'), fixture.environment);

      const rejected = await app.fetch(fixture.jsonRequest(
        '/api/organizations/organization-1/presets/membership-organization/apply',
        {},
      ), fixture.environment);
      const beforeChoice = await app.fetch(
        fixture.request('/api/organizations/organization-1/skills'),
        fixture.environment,
      );
      const explicitlyAdded = await app.fetch(fixture.jsonRequest(
        '/api/organizations/organization-1/presets/membership-organization/apply',
        { conflictPolicy: 'duplicate' },
      ), fixture.environment);
      const afterChoice = await app.fetch(
        fixture.request('/api/organizations/organization-1/skills'),
        fixture.environment,
      );

      expect(rejected.status).toBe(409);
      await expect(rejected.json()).resolves.toMatchObject({ error: { code: 'conflict' } });
      await expect(beforeChoice.json()).resolves.toMatchObject({ data: [{ name: 'existing-configuration' }] });
      expect(explicitlyAdded.status).toBe(201);
      await expect(afterChoice.json()).resolves.toMatchObject({ data: [
        { name: 'existing-configuration' },
        { name: 'membership-assistant', title: 'Membership assistant' },
      ] });
    } finally {
      fixture.close();
    }
  });

  it('adds a separately named second copy only after an explicit duplicate choice', async () => {
    const fixture = createTestApp();
    try {
      await app.fetch(fixture.jsonRequest(
        '/api/organizations/organization-1/presets/membership-organization/apply',
        {},
      ), fixture.environment);
      const second = await app.fetch(fixture.jsonRequest(
        '/api/organizations/organization-1/presets/membership-organization/apply',
        { conflictPolicy: 'duplicate' },
      ), fixture.environment);
      const prompts = await app.fetch(
        fixture.request('/api/organizations/organization-1/skills'),
        fixture.environment,
      );

      expect(second.status).toBe(201);
      await expect(prompts.json()).resolves.toMatchObject({ data: [
        { name: 'membership-assistant', title: 'Membership assistant' },
        { name: 'membership-assistant-2', title: 'Membership assistant' },
      ] });
    } finally {
      fixture.close();
    }
  });
});
