import { afterEach, describe, expect, it, vi } from 'vitest';

import { masterKey } from './cryptography';
import { accountBrowser, beginSignIn, browserEnabled, browserSettings, browserTimeZone, cancelSignIn, removeLogin, saveSignIn, savedLogins, setBrowserEnabled, setBrowserTimeZone } from './logins';
import { accountDatabase } from './storage/database';
import { fakeBrowser, pageAnswers } from '../test/browser';
import { createMigratedTestD1, type TestD1Database } from '../test/d1';

let database: TestD1Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

const key = () => masterKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');

const cookies = [{ name: 'sid', value: 'signed-in', domain: '.example.com', path: '/', httpOnly: true, secure: true, expires: 1_900_000_000 }];

describe("the Account's browser", () => {
  it('gives no run a browser until a person turns it on, and none again once it is turned off', async () => {
    database = createMigratedTestD1('organization');
    const db = accountDatabase(database.binding);
    const browser = fakeBrowser();

    expect(await browserEnabled(db)).toBe(false);
    expect(await accountBrowser({ binding: browser.binding, database: database.binding, key: await key(), accountId: 'organization-1', run: { id: 'run-1', entrance: 'chat' } })).toBeNull();

    await setBrowserEnabled(db, true, new Date());

    expect(await browserEnabled(db)).toBe(true);
    expect(await accountBrowser({ binding: browser.binding, database: database.binding, key: await key(), accountId: 'organization-1', run: { id: 'run-1', entrance: 'chat' } })).not.toBeNull();

    await setBrowserEnabled(db, false, new Date());

    expect(await browserSettings(db, browser.binding)).toEqual({ enabled: false, available: true, timeZone: null, logins: [] });
    expect(await accountBrowser({ binding: browser.binding, database: database.binding, key: await key(), accountId: 'organization-1', run: { id: 'run-1', entrance: 'chat' } })).toBeNull();
    expect(await accountBrowser({ binding: undefined, database: database.binding, key: await key(), accountId: 'organization-1', run: { id: 'run-1', entrance: 'chat' } })).toBeNull();
  });

  it('signs in through a Live View a person opens, and keeps what the browser then holds, encrypted, for every run', async () => {
    database = createMigratedTestD1('organization');
    const db = accountDatabase(database.binding);
    const browser = fakeBrowser(pageAnswers({ url: 'https://www.example.com/mypage', storage: { token: 't-1' }, cookies }));

    const begun = await beginSignIn({ db, binding: browser.binding, accountId: 'organization-1', url: 'www.example.com/login', at: new Date() });

    expect(begun).toMatchObject({ liveViewUrl: 'https://live.browser.run/view/target-1', login: { site: 'www.example.com', url: 'https://www.example.com/login', signingIn: true, savedAt: null } });
    expect(browser.acquired).toEqual(['session-1?keep_alive=1200000']);
    expect(browser.sent.find((command) => command.method === 'Cloudflare.getLiveView')?.params).toEqual({ targetId: 'target-1', mode: 'tab', expiresInMs: 1_200_000 });

    const saved = await saveSignIn({ db, binding: browser.binding, key: await key(), accountId: 'organization-1', loginId: begun.login.id, at: new Date() });

    expect(saved).toMatchObject({ site: 'www.example.com', signingIn: false, savedAt: expect.any(String) });
    expect(browser.connected.at(-1)).toBe('session-1');
    expect(browser.methods().at(-1)).toBe('Browser.close');
    const stored = database.row<{ state_envelope: string }>('SELECT state_envelope FROM browser_logins');
    expect(stored?.state_envelope).not.toContain('signed-in');
    expect(await savedLogins(db, await key(), 'organization-1')).toEqual([{
      id: begun.login.id,
      site: 'www.example.com',
      state: { cookies, storage: { 'https://www.example.com': { token: 't-1' } } },
    }]);
  });

  it('refuses to save a sign-in whose browser holds no cookie, so a person saves only once signed in', async () => {
    database = createMigratedTestD1('organization');
    const db = accountDatabase(database.binding);
    const browser = fakeBrowser(pageAnswers({ url: 'https://www.example.com/login' }));
    const begun = await beginSignIn({ db, binding: browser.binding, accountId: 'organization-1', url: 'https://www.example.com/login', at: new Date() });

    await expect(saveSignIn({ db, binding: browser.binding, key: await key(), accountId: 'organization-1', loginId: begun.login.id, at: new Date() }))
      .rejects.toMatchObject({ code: 'invalid' });
  });

  it('keeps a saved sign-in when signing in again is stopped, and removes one never saved', async () => {
    database = createMigratedTestD1('organization');
    const db = accountDatabase(database.binding);
    const browser = fakeBrowser(pageAnswers({ url: 'https://www.example.com/', cookies }));
    const first = await beginSignIn({ db, binding: browser.binding, accountId: 'organization-1', url: 'https://www.example.com/', at: new Date() });
    await saveSignIn({ db, binding: browser.binding, key: await key(), accountId: 'organization-1', loginId: first.login.id, at: new Date() });

    const again = await beginSignIn({ db, binding: browser.binding, accountId: 'organization-1', url: 'https://www.example.com/', at: new Date() });
    expect(again.login.id).toBe(first.login.id);
    await cancelSignIn({ db, binding: browser.binding, loginId: again.login.id, at: new Date() });

    expect((await browserSettings(db, browser.binding)).logins).toMatchObject([{ id: first.login.id, signingIn: false, savedAt: expect.any(String) }]);

    const other = await beginSignIn({ db, binding: browser.binding, accountId: 'organization-1', url: 'https://other.test/', at: new Date() });
    await cancelSignIn({ db, binding: browser.binding, loginId: other.login.id, at: new Date() });
    await removeLogin({ db, binding: browser.binding, loginId: first.login.id });

    expect((await browserSettings(db, browser.binding)).logins).toEqual([]);
  });

  it("reads the Browser's clock in the zone of the browser it was first set up from, until a person chooses any other", async () => {
    database = createMigratedTestD1('organization');
    const db = accountDatabase(database.binding);
    const browser = fakeBrowser(pageAnswers({ url: 'https://www.example.com/', cookies }));
    const zones = () => browser.sent.filter((command) => command.method === 'Emulation.setTimezoneOverride').map((command) => command.params.timezoneId);

    expect(await browserTimeZone(db)).toBe('Asia/Tokyo');
    await beginSignIn({ db, binding: browser.binding, accountId: 'organization-1', url: 'https://www.example.com/', timeZone: 'Not/AZone', at: new Date() });
    await beginSignIn({ db, binding: browser.binding, accountId: 'organization-1', url: 'https://other.test/', timeZone: 'America/New_York', at: new Date() });
    await beginSignIn({ db, binding: browser.binding, accountId: 'organization-1', url: 'https://third.test/', timeZone: 'Europe/London', at: new Date() });

    expect(zones()).toEqual(['Asia/Tokyo', 'America/New_York', 'America/New_York']);
    expect((await browserSettings(db, browser.binding)).timeZone).toBe('America/New_York');

    await setBrowserTimeZone(db, 'Pacific/Auckland', new Date());
    await expect(setBrowserTimeZone(db, 'Not/AZone', new Date())).rejects.toMatchObject({ code: 'invalid' });
    await setBrowserEnabled(db, true, new Date());
    const run = await accountBrowser({ binding: browser.binding, database: database.binding, key: await key(), accountId: 'organization-1', run: { id: 'run-1', entrance: 'chat' } });
    await run?.handlers['browser.open']({ url: 'https://www.example.com/' });
    await run?.close();

    expect(zones().at(-1)).toBe('Pacific/Auckland');
  });

  it('adds to its run how long the run held the browser, each time an answer of the run closes it, and nothing when it never started one', async () => {
    database = createMigratedTestD1('organization');
    const db = accountDatabase(database.binding);
    const browser = fakeBrowser(pageAnswers({ url: 'https://www.example.com/' }));
    await setBrowserEnabled(db, true, new Date());
    database.execute("INSERT INTO runs (id, trigger, execution_mode, status, started_at, updated_at) VALUES ('run-1', 'chat', 'unattended', 'planning', '2026-11-22T00:00:00.000Z', '2026-11-22T00:00:00.000Z')");
    const held = () => database?.rows<{ browser_ms: number }>("SELECT browser_ms FROM runs WHERE id = 'run-1'")[0]?.browser_ms;
    const open = async () => accountBrowser({ binding: browser.binding, database: database!.binding, key: await key(), accountId: 'organization-1', run: { id: 'run-1', entrance: 'chat' } });

    await (await open())?.close();
    expect(held()).toBe(0);

    // The browser's clock moves a second at each reading, so each session is held for some time.
    let now = Date.parse('2026-11-22T00:00:00.000Z');
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => (now += 1000));
    const first = await open();
    await first?.handlers['browser.open']({ url: 'https://www.example.com/' });
    const firstMs = await first?.close();
    expect(firstMs).toBeGreaterThan(0);
    expect(held()).toBe(firstMs);

    const second = await open();
    await second?.handlers['browser.read']({});
    const secondMs = await second?.close();
    clock.mockRestore();
    expect(held()).toBe(Number(firstMs) + Number(secondMs));
  });

  it('refuses a page that is not on the web', async () => {
    database = createMigratedTestD1('organization');
    const db = accountDatabase(database.binding);

    await expect(beginSignIn({ db, binding: fakeBrowser().binding, accountId: 'organization-1', url: 'javascript:alert(1)', at: new Date() })).rejects.toMatchObject({ code: 'invalid' });
    await expect(beginSignIn({ db, binding: undefined, accountId: 'organization-1', url: 'https://example.com/', at: new Date() })).rejects.toMatchObject({ code: 'upstream' });
  });
});
