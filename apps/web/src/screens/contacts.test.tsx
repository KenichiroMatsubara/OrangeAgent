import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api';
import { fakeApi } from '../fake';
import { ACCOUNT_ID, connections, contact, contactList, lineHandle } from './fixtures';
import { renderScreen } from './render';
import * as contacts from './contacts';

fakeApi();

describe('Contacts screen', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.contacts).mockResolvedValue([
      contact({ lineDestinations: [{ id: 'handle-9', destinationId: 'Uyam…', displayName: '山田', kind: 'user', status: 'discovered', source: 'webhook' }] }),
      contact({ id: 'contact-2', name: '届かない人', email: '', description: '', tags: [] }),
      contact({ id: 'contact-3', name: '前会長', state: 'inactive' }),
    ]);
    vi.mocked(api.lineHandles).mockResolvedValue([lineHandle(), lineHandle({ id: 'handle-2', destinationId: 'Uabc2', displayName: '', source: 'manual' })]);
    vi.mocked(api.connections).mockResolvedValue(connections());
    vi.mocked(api.contactLists).mockResolvedValue([contactList()]);
  });

  it('shows how each Contact is reached, and names the ones nothing can reach', async () => {
    renderScreen('contacts', contacts);

    const yamada = await screen.findByRole('link', { name: /山田 太郎/u });
    expect(yamada.textContent).toContain('LINE');
    expect(yamada.textContent).toContain('メール');
    expect(yamada.getAttribute('href')).toBe(`/contacts/contact-1`);
    expect(screen.getByRole('link', { name: /届かない人/u }).textContent).toContain('届く手段なし');
    expect(screen.getByText(/届かない人にはメールアドレスも LINE もありません/u)).toBeTruthy();
    expect(screen.getByRole('link', { name: /前会長/u }).textContent).toContain('停止中');
    expect(screen.getByText(/LINE から 2件 届いています/u)).toBeTruthy();
  });

  it('finds a Contact by any part of what it holds', async () => {
    const user = userEvent.setup();
    renderScreen('contacts', contacts);

    await user.type(await screen.findByRole('searchbox', { name: '連絡先を検索' }), '会計');

    expect(screen.getByRole('link', { name: /山田 太郎/u })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /届かない人/u })).toBeNull();
  });

  it('registers a Contact with a name alone, without a LINE handle or an email', async () => {
    vi.mocked(api.createContact).mockResolvedValue(contact({ id: 'contact-9', name: '新しい人' }));
    const user = userEvent.setup();
    renderScreen('contacts', contacts);

    await user.click(await screen.findByRole('button', { name: '追加' }));
    const sheet = await screen.findByRole('dialog', { name: '連絡先を追加' });
    await user.type(within(sheet).getByRole('textbox', { name: '名前' }), '新しい人');
    await user.click(within(sheet).getByRole('button', { name: '追加する' }));

    await waitFor(() => expect(api.createContact).toHaveBeenCalledWith(ACCOUNT_ID, { name: '新しい人', description: '', tags: [] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.contacts).toHaveBeenCalledTimes(2);
  });

  it('makes a Contact from a LINE handle that reached the Account, named after it', async () => {
    vi.mocked(api.createContact).mockResolvedValue(contact({ id: 'contact-9', name: '花子' }));
    const user = userEvent.setup();
    renderScreen('contacts', contacts);

    await user.click(await screen.findByRole('button', { name: '結び付ける' }));
    const pool = await screen.findByRole('dialog', { name: 'LINE から届いた相手' });
    await user.click(within(pool).getAllByRole('button', { name: '連絡先にする' })[0] as HTMLElement);
    const sheet = await screen.findByRole('dialog', { name: '連絡先を追加' });
    expect(within(sheet).getByRole('textbox', { name: '名前' })).toHaveProperty('value', '花子');
    await user.click(within(sheet).getByRole('button', { name: '追加する' }));

    await waitFor(() => expect(api.createContact).toHaveBeenCalledWith(ACCOUNT_ID, { name: '花子', description: '', tags: [], lineDestinationId: 'handle-1' }));
  });

  it('shows the Worker\'s reason when a Contact cannot be added, and keeps what was typed', async () => {
    vi.mocked(api.createContact).mockRejectedValue(new Error('A Contact with this email already exists.'));
    const user = userEvent.setup();
    renderScreen('contacts', contacts);

    await user.click(await screen.findByRole('button', { name: '追加' }));
    const sheet = await screen.findByRole('dialog', { name: '連絡先を追加' });
    await user.type(within(sheet).getByRole('textbox', { name: '名前' }), '重複');
    await user.click(within(sheet).getByRole('button', { name: '追加する' }));

    expect(await within(sheet).findByText('A Contact with this email already exists.')).toBeTruthy();
    expect(within(sheet).getByRole('textbox', { name: '名前' })).toHaveProperty('value', '重複');
  });

  it('keeps Contact Lists beside the roster, and edits who is in one', async () => {
    vi.mocked(api.saveContactList).mockResolvedValue({ id: 'list-1' });
    const user = userEvent.setup();
    renderScreen('contacts', contacts);

    await user.click(await screen.findByRole('radio', { name: 'リスト 1' }));
    await user.click(await screen.findByRole('button', { name: /定例連絡/u }));
    const sheet = await screen.findByRole('dialog', { name: 'リストを編集' });
    await user.click(within(sheet).getByRole('checkbox', { name: /届かない人/u }));
    await user.click(within(sheet).getByRole('button', { name: '保存する' }));

    await waitFor(() => expect(api.saveContactList).toHaveBeenCalledWith(ACCOUNT_ID, 'list-1', { name: '定例連絡', contactIds: ['contact-1', 'contact-2'] }));
    // Contact Lists are the only lists left: an Automation's reach is one of them.
    expect(screen.queryByRole('region', { name: 'ルールの許可リスト' })).toBeNull();
  });
});
