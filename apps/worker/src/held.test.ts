import { describe, expect, it } from 'vitest';

import type { ChatGeneratedFile } from '@mail/domain';

import { handFile, handedName, heldFiles } from './held';
import { FileAnswer, type GeneratedFile, type TurnFile } from './turns';

const file = (filename: string, text = filename, mediaType = 'image/jpeg'): TurnFile => ({ filename, mediaType, bytes: new TextEncoder().encode(text) });

const keeper = () => {
  const kept: GeneratedFile[] = [];
  const keep = async (handed: GeneratedFile): Promise<ChatGeneratedFile[]> => {
    kept.push(handed);
    return [{ id: `kept-${kept.length}`, filename: handed.filename, mediaType: handed.mediaType, size: handed.bytes.byteLength, drive: null }];
  };
  return { kept, keep };
};

describe('the files an answer holds', () => {
  it('notes every file a tool hands the answer, whoever called it, and leaves its answer as it was', async () => {
    const held = heldFiles([file('見積書.pdf', 'pdf', 'application/pdf')]);
    const answer = new FileAnswer({ title: 'ウィキペディア' }, [file('screenshot-1.jpg', 'first')]);
    const handlers = held.watch({ 'browser.read': async () => answer, 'query_contacts': async () => [] });

    expect(await handlers['browser.read']?.({ screenshot: true })).toBe(answer);
    await handlers.query_contacts?.({});

    expect(held.names()).toEqual(['screenshot-1.jpg', '見積書.pdf']);
    expect(held.find('screenshot-1.jpg')?.bytes).toEqual(new TextEncoder().encode('first'));
  });

  it('shows the member a picture the run took the moment it is taken, and no file a tool only read', async () => {
    const shown: string[] = [];
    const held = heldFiles([], async (taken) => { shown.push(taken.filename); });
    const picture = { ...file('screenshot-1.jpg'), shown: true };
    const handlers = held.watch({
      'browser.read': async () => new FileAnswer({}, [picture]),
      'mail.read': async () => new FileAnswer({}, [file('logo.png', 'png', 'image/png')]),
    });

    await handlers['browser.read']?.({ screenshot: true });
    await handlers['mail.read']?.({ messageId: 'm-1' });

    expect(shown).toEqual(['screenshot-1.jpg']);
    expect(held.names()).toEqual(['logo.png', 'screenshot-1.jpg']);
  });

  it('still answers with a picture it could not show', async () => {
    const held = heldFiles([], async () => { throw new Error('R2 is down'); });
    const answer = new FileAnswer({}, [{ ...file('screenshot-1.jpg'), shown: true }]);

    await expect(held.watch({ 'browser.read': async () => answer })['browser.read']?.({})).resolves.toBe(answer);
    expect(held.find('screenshot-1.jpg')).not.toBeNull();
  });

  it('holds the latest file handed under one name', async () => {
    const held = heldFiles([file('photo.jpg', 'sent')]);
    await held.watch({ 'mail.read': async () => new FileAnswer({}, [file('photo.jpg', 'attached')]) })['mail.read']?.({});

    expect(held.find('photo.jpg')?.bytes).toEqual(new TextEncoder().encode('attached'));
    expect(held.names()).toEqual(['photo.jpg']);
  });
});

describe('handing the member a file', () => {
  it('keeps a held file as a file of the answer, under the name asked for', async () => {
    const held = heldFiles([file('screenshot-1.jpg', 'jpeg')]);
    const { kept, keep } = keeper();

    const answer = await handFile({ held, filename: 'screenshot-1.jpg', name: 'ウィキペディア', keep });

    expect(kept).toEqual([{ filename: 'ウィキペディア.jpg', mediaType: 'image/jpeg', bytes: new TextEncoder().encode('jpeg') }]);
    expect(answer).toMatchObject({ handed: { filename: 'ウィキペディア.jpg', mediaType: 'image/jpeg', size: 4 } });
  });

  it('refuses a file the answer does not hold, naming those it does', async () => {
    const held = heldFiles([file('screenshot-1.jpg')]);
    const { kept, keep } = keeper();

    const answer = await handFile({ held, filename: 'screenshot.png', keep });

    expect(kept).toEqual([]);
    expect(answer).toMatchObject({ isError: true });
    expect((answer as { message: string }).message).toContain('screenshot-1.jpg');
  });

  it('says there is nothing to hand when the answer holds no file', async () => {
    const { keep } = keeper();
    const answer = await handFile({ held: heldFiles([]), filename: 'screenshot-1.jpg', keep });

    expect((answer as { message: string }).message).toContain('mail.read');
  });

  it('keeps a file’s own extension unless the name asked for gives it one', () => {
    expect(handedName('screenshot-1.jpg')).toBe('screenshot-1.jpg');
    expect(handedName('screenshot-1.jpg', 'top')).toBe('top.jpg');
    expect(handedName('screenshot-1.jpg', 'top.JPG')).toBe('top.JPG');
    expect(handedName('folder/report.pdf', 'out/月次報告')).toBe('月次報告.pdf');
    expect(handedName('README', 'notes')).toBe('notes');
  });
});
