import { describe, expect, it, vi } from 'vitest';

import type { LoginState } from './browser';
import { renewedLogin, loginCovers } from './browser';
import { runBrowser, type LoginStore, type RunLogin } from './browsing';
import { cdpOver, type CdpSocket } from './cdp';
import { FileAnswer } from './turns';
import { fakeBrowser, pageAnswers } from '../test/browser';

const signedIn: LoginState = {
  cookies: [{ name: 'sid', value: 'old', domain: '.example.com', path: '/', secure: true }],
  storage: { 'https://www.example.com': { token: 'old-token' } },
};

const store = (logins: RunLogin[]) => {
  const renewed: Array<{ id: string; state: LoginState; used: boolean }> = [];
  const port: LoginStore = {
    saved: async () => logins,
    renew: async (login, state, used) => {
      renewed.push({ id: login.id, state, used });
    },
  };
  return { port, renewed };
};

describe('the browser a run operates', () => {
  it('starts no browser until the run first calls a browser tool, and closes nothing it never started', async () => {
    const browser = fakeBrowser();
    const run = runBrowser({ binding: browser.binding, timeZone: 'Asia/Tokyo', logins: store([]).port });

    await run.close();

    expect(browser.acquired).toEqual([]);
  });

  it('opens a page signed in to every site the Account saved, before the page is loaded', async () => {
    const browser = fakeBrowser(pageAnswers({ url: 'https://www.example.com/orders', title: '注文', text: '注文履歴\n[1] button "次へ"' }));
    const run = runBrowser({ binding: browser.binding, timeZone: 'Asia/Tokyo', logins: store([{ id: 'login-1', site: 'www.example.com', state: signedIn }]).port });

    const reading = await run.handlers['browser.open']({ url: 'https://www.example.com/orders' });

    expect(reading).toEqual({ url: 'https://www.example.com/orders', title: '注文', text: '注文履歴\n[1] button "次へ"', nextOffset: null });
    const methods = browser.methods();
    expect(methods.indexOf('Storage.setCookies')).toBeLessThan(methods.indexOf('Page.navigate'));
    expect(browser.sent.find((command) => command.method === 'Storage.setCookies')?.params).toEqual({ cookies: signedIn.cookies });
    expect(String(browser.sent.find((command) => command.method === 'Page.addScriptToEvaluateOnNewDocument')?.params.source)).toContain('old-token');
    expect(browser.sent.find((command) => command.method === 'Page.navigate')).toMatchObject({ params: { url: 'https://www.example.com/orders' }, sessionId: 'page-1' });
    await run.close();
  });

  it('writes back what the site renewed of each sign-in when the run ends, and closes the browser', async () => {
    const browser = fakeBrowser(pageAnswers({
      url: 'https://www.example.com/',
      storage: { token: 'new-token' },
      cookies: [
        { name: 'sid', value: 'new', domain: '.example.com', path: '/', secure: true },
        { name: 'other', value: 'x', domain: 'tracker.test', path: '/' },
      ],
    }));
    const logins = store([{ id: 'login-1', site: 'www.example.com', state: signedIn }]);
    const run = runBrowser({ binding: browser.binding, timeZone: 'Asia/Tokyo', logins: logins.port });

    await run.handlers['browser.open']({ url: 'https://www.example.com/' });
    await run.close();

    expect(logins.renewed).toEqual([{
      id: 'login-1',
      used: true,
      state: { cookies: [{ name: 'sid', value: 'new', domain: '.example.com', path: '/', secure: true }], storage: { 'https://www.example.com': { token: 'new-token' } } },
    }]);
    expect(browser.methods().at(-1)).toBe('Browser.close');
    await expect(run.handlers['browser.read']({})).resolves.toMatchObject({ isError: true });
  });

  it('clicks a numbered control where the page shows it, as a mouse would', async () => {
    const browser = fakeBrowser(pageAnswers({ url: 'https://shop.test/' }));
    const run = runBrowser({ binding: browser.binding, timeZone: 'Asia/Tokyo', logins: store([]).port });

    await run.handlers['browser.click']({ ref: 4 });

    const mouse = browser.sent.filter((command) => command.method === 'Input.dispatchMouseEvent').map((command) => command.params.type);
    expect(mouse).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    expect(browser.sent.find((command) => command.method === 'Input.dispatchMouseEvent')?.params).toMatchObject({ x: 10, y: 20 });
    await run.close();
  });

  it('answers a control the page no longer has, and a call it cannot read, as refusals the run can correct', async () => {
    const browser = fakeBrowser((command) => {
      if (command.method === 'Runtime.evaluate' && String(command.params.expression).includes('getBoundingClientRect')) return { result: { value: null } };
      return pageAnswers({ url: 'https://shop.test/' })(command);
    });
    const run = runBrowser({ binding: browser.binding, timeZone: 'Asia/Tokyo', logins: store([]).port });

    await expect(run.handlers['browser.click']({ ref: 9 })).resolves.toMatchObject({ isError: true, message: expect.stringContaining('[9]') });
    await expect(run.handlers['browser.click']({})).resolves.toMatchObject({ isError: true, message: expect.stringContaining('ref') });
    await expect(run.handlers['browser.open']({ url: 'file:///etc/passwd' })).resolves.toMatchObject({ isError: true });
    await expect(run.handlers['browser.press']({ key: 'F13' })).resolves.toMatchObject({ isError: true });
    await run.close();
  });

  it('types in place of what a field held, and presses Enter to send it when asked', async () => {
    const browser = fakeBrowser(pageAnswers({ url: 'https://shop.test/' }));
    const run = runBrowser({ binding: browser.binding, timeZone: 'Asia/Tokyo', logins: store([]).port });

    await run.handlers['browser.type']({ ref: 2, text: '傘', submit: true });

    expect(browser.sent.find((command) => command.method === 'Input.insertText')?.params).toEqual({ text: '傘' });
    expect(browser.sent.filter((command) => command.method === 'Input.dispatchKeyEvent').map((command) => command.params.key)).toEqual(['Enter', 'Enter']);
    await run.close();
  });

  it('hands over a picture of the page when the run asks for one', async () => {
    const browser = fakeBrowser((command) => command.method === 'Page.captureScreenshot' ? { data: btoa('jpeg') } : pageAnswers({ url: 'https://shop.test/' })(command));
    const run = runBrowser({ binding: browser.binding, timeZone: 'Asia/Tokyo', logins: store([]).port });

    const reading = await run.handlers['browser.read']({ screenshot: true });

    expect(reading).toBeInstanceOf(FileAnswer);
    expect((reading as FileAnswer).files).toEqual([{ filename: 'screenshot-1.jpg', mediaType: 'image/jpeg', bytes: new TextEncoder().encode('jpeg'), shown: true }]);
    // Each picture has a name of its own, so any one of them can be handed to the member.
    const next = await run.handlers['browser.read']({ screenshot: true });
    expect((next as FileAnswer).files.map((file) => file.filename)).toEqual(['screenshot-2.jpg']);
    await run.close();
  });
});

describe('the time a run holds its browser', () => {
  const ticking = (step: number) => {
    let now = 0;
    return () => {
      now += step;
      return now;
    };
  };
  const logged = (spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> => spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);

  it('writes each browser call to the log with how long it took, and the one that started the browser with how long starting took', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const browser = fakeBrowser(pageAnswers({ url: 'https://shop.test/' }));
      const run = runBrowser({ binding: browser.binding, timeZone: 'Asia/Tokyo', logins: store([]).port, trace: { accountId: 'acct-1', runId: 'run-1', entrance: 'chat' }, clock: ticking(100) });

      await run.handlers['browser.open']({ url: 'https://shop.test/' });
      await run.handlers['browser.click']({});
      await run.close();

      const calls = logged(spy).filter((line) => line.event === 'browser_call');
      expect(calls).toEqual([
        { event: 'browser_call', accountId: 'acct-1', runId: 'run-1', entrance: 'chat', tool: 'browser.open', ok: true, ms: expect.any(Number), startMs: expect.any(Number) },
        { event: 'browser_call', accountId: 'acct-1', runId: 'run-1', entrance: 'chat', tool: 'browser.click', ok: false, ms: expect.any(Number) },
      ]);
      expect(Number(calls[0]?.ms)).toBeGreaterThan(Number(calls[0]?.startMs));
    } finally {
      spy.mockRestore();
    }
  });

  it('answers on closing how long the browser was held, from acquiring it to closing it, and writes the session to the log', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const browser = fakeBrowser(pageAnswers({ url: 'https://shop.test/' }));
      const run = runBrowser({ binding: browser.binding, timeZone: 'Asia/Tokyo', logins: store([]).port, trace: { accountId: 'acct-1', runId: 'run-1' }, clock: ticking(100) });

      await run.handlers['browser.open']({ url: 'https://shop.test/' });
      await run.handlers['browser.read']({});
      const held = await run.close();

      expect(held).toBeGreaterThan(0);
      expect(logged(spy).filter((line) => line.event === 'browser_session')).toEqual([
        { event: 'browser_session', accountId: 'acct-1', runId: 'run-1', ms: held, calls: 2 },
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it('answers no time and writes nothing when the run never started its browser', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const run = runBrowser({ binding: fakeBrowser().binding, timeZone: 'Asia/Tokyo', logins: store([]).port });

      await expect(run.close()).resolves.toBe(0);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('a saved sign-in', () => {
  it('covers the hosts its cookies are sent to', () => {
    expect(loginCovers(signedIn, 'www.example.com')).toBe(true);
    expect(loginCovers(signedIn, 'example.com')).toBe(true);
    expect(loginCovers(signedIn, 'example.org')).toBe(false);
  });

  it('keeps no cookie of a domain it never held, and stays signed out when the site signed it out', () => {
    expect(renewedLogin(signedIn, [{ name: 'ad', value: '1', domain: 'ads.test', path: '/' }], {})).toEqual({ cookies: [], storage: signedIn.storage });
  });
});

describe('speaking CDP', () => {
  const socket = () => {
    const listeners: { message: Array<(event: { data: unknown }) => void>; close: Array<() => void> } = { message: [], close: [] };
    const sent: string[] = [];
    const value: CdpSocket = {
      send: (message) => sent.push(message),
      close: () => undefined,
      addEventListener: (type: 'message' | 'close', listener: never) => {
        (listeners[type] as unknown[]).push(listener);
      },
    };
    return { value, sent, reply: (data: unknown) => listeners.message.forEach((listener) => listener({ data: JSON.stringify(data) })), drop: () => listeners.close.forEach((listener) => listener()) };
  };

  it('answers each command with the message carrying its id, and a refusal as an error', async () => {
    const channel = socket();
    const cdp = cdpOver(channel.value);

    const first = cdp.send('Page.navigate', { url: 'https://a.test/' }, 'page-1');
    const second = cdp.send('Target.createTarget');
    channel.reply({ id: 2, result: { targetId: 't' } });
    channel.reply({ id: 1, error: { message: 'Cannot navigate' } });

    await expect(second).resolves.toEqual({ targetId: 't' });
    await expect(first).rejects.toThrow('Cannot navigate');
    expect(JSON.parse(channel.sent[0] ?? '{}')).toEqual({ id: 1, method: 'Page.navigate', params: { url: 'https://a.test/' }, sessionId: 'page-1' });
  });

  it('fails every waiting command when the browser closes', async () => {
    const channel = socket();
    const cdp = cdpOver(channel.value);
    const waiting = cdp.send('Runtime.evaluate');

    channel.drop();

    await expect(waiting).rejects.toThrow('closed');
    await expect(cdp.send('Page.enable')).rejects.toThrow('closed');
  });
});
