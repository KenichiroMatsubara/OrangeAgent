import type { BrowserLogin, BrowserSettings, BrowserSignIn } from '@mail/domain';
import { CircleAlert, ExternalLink, Globe } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useLoaderData, useRevalidator } from 'react-router-dom';

import { api } from '../api';
import { accountIdOf, useAccount } from '../dashboard';
import { pendingKey, usePendingOperations } from '../pending';
import { browserZone, dateTimeLabel, momentLabel, zoneLabel, zones } from '../time';
import { Button, ButtonAnchor } from '../ui/button';
import { Deferred, later } from '../ui/deferred';
import { Field, Switch } from '../ui/field';
import { List, Row } from '../ui/list';
import { Banner } from '../ui/notice';
import { Card, FormCard, Note, Page, Section } from '../ui/page';
import { SkeletonBlock } from '../ui/skeleton';

export interface BrowserData {
  browser: Promise<BrowserSettings>;
}

/** Returns at once; the screen fills in as the settings are read. */
export const loader = async (): Promise<BrowserData> => {
  const accountId = await accountIdOf();
  return { browser: later(api.browserSettings(accountId)) };
};

/** Whether the Account's runs operate a browser: the one place it is turned on or off. */
const Operation = ({ browser }: { browser: BrowserSettings }) => {
  const { account } = useAccount();
  const operations = usePendingOperations();
  const revalidator = useRevalidator();
  const set = (enabled: boolean): void => void operations.run(pendingKey.browserEnabled, async () => {
    await api.setBrowserEnabled(account.accountId, enabled);
    await revalidator.revalidate();
  });
  return <Section title="ブラウザ操作">
    {!browser.available && <Banner tone="warn" icon={<CircleAlert size={18} aria-hidden="true" />}>この環境には Cloudflare Browser Run が結び付けられていないため、オンにしても、どの実行もブラウザを使えません。</Banner>}
    <Card>
      <Switch
        label="AI にブラウザを操作させる"
        sub={browser.enabled
          ? <>AI に聞く画面でも自動化でも、AI は同じブラウザでページを開き、読み、クリックや入力をします。自動化では、<Link to="../automations">自動化</Link>の「使える道具」でブラウザの操作を許可し、無人で動かすものだけが使います。</>
          : 'オフなので、AI に聞く画面にも、どの自動化にもブラウザを渡しません。オンにすると、どちらでも同じブラウザを使えるようになります。'}
        checked={browser.enabled}
        disabled={operations.pending(pendingKey.browserEnabled)}
        onChange={set}
      />
    </Card>
    <Note>ブラウザでの操作はその場でサイトに届き、取り消せません。申し込みや購入をさせるときは、スキルに何をしてよいかを書いておきます。</Note>
  </Section>;
};

/**
 * The zone the Browser's clock reads in: any zone a person chooses, and until
 * one is set, the zone of the browser this screen is open in.
 */
const TimeZone = ({ browser }: { browser: BrowserSettings }) => {
  const { account } = useAccount();
  const operations = usePendingOperations();
  const revalidator = useRevalidator();
  const here = browserZone();
  const shown = browser.timeZone ?? here ?? 'Asia/Tokyo';
  const set = (timeZone: string): void => void operations.run(pendingKey.browserTimeZone, async () => {
    await api.setBrowserTimeZone(account.accountId, timeZone);
    await revalidator.revalidate();
  });
  const hint = browser.timeZone
    ? 'サイトに表示される時刻や日付は、このタイムゾーンで出ます。'
    : 'まだ決めていないので、いまは日本時間で動きます。ブラウザ操作をオンにするかログインを始めると、上に出ているこのブラウザのタイムゾーンになります。ほかを選べば、すぐにそれを使います。';
  return <Section title="ブラウザの時刻">
    <Card>
      <Field label="タイムゾーン" hint={hint}>{(control) => <select {...control} value={shown} disabled={operations.pending(pendingKey.browserTimeZone)} onChange={(change) => set(change.target.value)}>
        {zones([shown]).map((zone) => <option key={zone} value={zone}>{zoneLabel(zone)}</option>)}
      </select>}</Field>
    </Card>
  </Section>;
};

const loginSub = (login: BrowserLogin): string => {
  if (login.signingIn && !login.savedAt) return 'ログインの途中です。まだ保存していません。';
  const saved = login.savedAt ? `${momentLabel(login.savedAt)}に保存` : '';
  const used = login.usedAt ? `最後に使ったのは${momentLabel(login.usedAt)}` : 'まだ使っていません';
  return [login.signingIn ? 'ログインし直している途中です' : '', saved, used].filter(Boolean).join(' ・ ');
};

/** The sites the browser is signed in to, and signing in to one through Browser Run's Live View. */
const Logins = ({ browser }: { browser: BrowserSettings }) => {
  const { account } = useAccount();
  const operations = usePendingOperations();
  const revalidator = useRevalidator();
  const [url, setUrl] = useState('');
  const [signIn, setSignIn] = useState<BrowserSignIn | null>(null);
  const begin = (target: string): void => void operations.run(pendingKey.browserSignIn, async () => {
    const begun = await api.beginBrowserSignIn(account.accountId, target);
    setSignIn(begun);
    setUrl('');
    await revalidator.revalidate();
  });
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    begin(url);
  };
  const save = (loginId: string): void => void operations.run(pendingKey.browserLogin(loginId), async () => {
    await api.saveBrowserSignIn(account.accountId, loginId);
    setSignIn(null);
    await revalidator.revalidate();
  });
  const cancel = (loginId: string): void => void operations.run(pendingKey.browserLogin(loginId), async () => {
    await api.cancelBrowserSignIn(account.accountId, loginId);
    setSignIn(null);
    await revalidator.revalidate();
  });
  const removeLogin = (loginId: string): void => void operations.run(pendingKey.browserLogin(loginId), async () => {
    await api.removeBrowserLogin(account.accountId, loginId);
    await revalidator.revalidate();
  });
  const beginning = operations.pending(pendingKey.browserSignIn);
  return <Section title="ログインしておくサイト" lead="ここでログインしたサイトは、どの実行のブラウザでもログインした状態で開きます。パスワードは AI にも FlareChat にも渡りません。保存するのはログイン後にブラウザに残る Cookie などだけで、暗号化して保管します。">
    {operations.error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{operations.error}</Banner>}
    {signIn && <Card>
      <Note>{signIn.login.site} のログイン用の画面を用意しました。下のボタンで開き、ふだんどおりにログインしてください（二段階認証もそのまま通せます）。終わったらこの画面に戻り、「ログインを保存」を押します。{dateTimeLabel(signIn.expiresAt)}までに保存しないと、ブラウザは閉じます。</Note>
      <ButtonAnchor href={signIn.liveViewUrl} variant="secondary" icon={<ExternalLink size={18} aria-hidden="true" />}>ログイン用の画面を開く</ButtonAnchor>
      <Button busy={operations.pending(pendingKey.browserLogin(signIn.login.id))} onClick={() => save(signIn.login.id)}>ログインを保存</Button>
      <Button variant="quiet" onClick={() => cancel(signIn.login.id)}>やめる</Button>
    </Card>}
    {browser.logins.length
      ? <List label="ログインしておくサイト">{browser.logins.map((login) => <Row
        key={login.id}
        leading={<Globe size={20} aria-hidden="true" />}
        title={login.site}
        sub={loginSub(login)}
        wrap
        aside={login.signingIn
          ? <>
            <Button variant="secondary" small busy={operations.pending(pendingKey.browserLogin(login.id))} aria-label={`${login.site} のログインを保存する`} onClick={() => save(login.id)}>保存</Button>
            <Button variant="quiet" small aria-label={`${login.site} のログインをやめる`} onClick={() => cancel(login.id)}>やめる</Button>
          </>
          : <>
            <Button variant="quiet" small busy={beginning} aria-label={`${login.site} にログインし直す`} onClick={() => begin(login.url)}>ログインし直す</Button>
            <Button variant="quiet" small busy={operations.pending(pendingKey.browserLogin(login.id))} aria-label={`${login.site} のログインを削除する`} onClick={() => removeLogin(login.id)}>削除</Button>
          </>}
      />)}</List>
      : <Note>まだどのサイトにもログインしていません。ログインが要らないページは、このままでも開けます。</Note>}
    <FormCard onSubmit={submit}>
      <Field label="ログインするページの URL" hint="サイトのログイン画面か、ログイン後に見たいページの URL を入れます。">{(control) => <input {...control} value={url} onChange={(change) => setUrl(change.target.value)} placeholder="https://example.com/login" inputMode="url" autoCapitalize="none" spellCheck={false} />}</Field>
      <Button type="submit" variant="secondary" busy={beginning} disabled={!url.trim() || !browser.available}>{beginning ? 'ブラウザを起動しています…' : 'ログインを始める'}</Button>
    </FormCard>
  </Section>;
};

/** The browser the Account's runs operate, and the sites it is signed in to. */
const BrowserScreen = () => {
  const data = useLoaderData<BrowserData>();
  return <Page title="ブラウザ" back={{ to: '../more', label: 'その他' }} narrow>
    <Deferred value={data.browser} fallback={<SkeletonBlock height={320} />}>{(browser) => <>
      <Operation browser={browser} />
      <TimeZone browser={browser} />
      <Logins browser={browser} />
    </>}</Deferred>
  </Page>;
};

export default BrowserScreen;
