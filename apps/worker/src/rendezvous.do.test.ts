/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { reachRun, rendezvous, rendezvousName, type RunServing } from './rendezvous';
import { ACCOUNT } from '../test/runtime';

const calls = env.RUN_CALLS!;

/** A run offering one tool, which answers with what it was called with. */
const serving: RunServing = {
  tools: [{ name: 'contacts.search', description: 'Searches the Contacts.', parameters: { type: 'object' } }],
  call: async (name, arguments_) => ({ name, arguments: arguments_ }),
};

const open = () => rendezvous({ namespace: calls, accountId: ACCOUNT, url: 'https://flarechat.example/mcp' }).open(serving);

describe('a Run Token\'s Durable Object in the Workers runtime', () => {
  it('hands a call made with the token to the run, and the run\'s answer back', async () => {
    const access = await open();

    const reached = await reachRun({ namespace: calls, presented: access.token, accountId: ACCOUNT });

    expect(reached?.tools.map((tool) => tool.name)).toEqual(['contacts.search']);
    await expect(reached?.call('contacts.search', { query: '田中' })).resolves.toEqual({ name: 'contacts.search', arguments: { query: '田中' } });
    access.close();
  });

  it('still reaches the run after the object hibernates with the run\'s socket', async () => {
    const access = await open();
    const stub = calls.get(calls.idFromName(await rendezvousName(access.token)));

    await evictDurableObject(stub, { webSockets: 'hibernate' });
    const reached = await reachRun({ namespace: calls, presented: access.token, accountId: ACCOUNT });

    await expect(reached?.call('contacts.search', { query: '佐藤' })).resolves.toEqual({ name: 'contacts.search', arguments: { query: '佐藤' } });
    access.close();
  });

  it('reaches no run for another Account, for a token never issued, or once the run has ended, and then keeps nothing', async () => {
    const access = await open();
    const stub = calls.get(calls.idFromName(await rendezvousName(access.token)));

    await expect(reachRun({ namespace: calls, presented: access.token, accountId: 'organization-2' })).resolves.toBeNull();
    await expect(reachRun({ namespace: calls, presented: 'run_never-issued', accountId: ACCOUNT })).resolves.toBeNull();
    access.close();
    await expect.poll(() => reachRun({ namespace: calls, presented: access.token, accountId: ACCOUNT })).toBeNull();
    expect((await runInDurableObject(stub, (_object, state) => state.storage.list())).size).toBe(0);
  });
});
