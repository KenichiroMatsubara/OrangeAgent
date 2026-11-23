import type { PushSettings } from '@mail/domain';
import { BellOff, BellRing, CircleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';

import { api } from './api';
import { useAccount } from './dashboard';
import { pendingKey, usePendingOperations } from './pending';
import type { Device, Subscribed } from './push';
import { Button } from './ui/button';
import { Banner, Chip, type Tone } from './ui/notice';
import { Card, Note, Section } from './ui/page';

import styles from './notifications.module.css';

/** Where this browser stands: being read, or what the person can do about notifications here. */
export type Standing =
  | { kind: 'reading' }
  | { kind: 'unavailable' }
  | { kind: 'install' }
  | { kind: 'unsupported' }
  | { kind: 'blocked' }
  | { kind: 'off' }
  | { kind: 'on' };

/** Where a browser stands, from what the Worker and the browser say. */
export const standingOf = async (settings: PushSettings, device: Device): Promise<{ standing: Standing; subscribed: Subscribed | null }> => {
  if (!settings.publicKey) return { standing: { kind: 'unavailable' }, subscribed: null };
  const support = device.support();
  if (support !== 'supported') return { standing: { kind: support }, subscribed: null };
  const subscribed = device.permission() === 'granted' ? await device.subscription(settings.publicKey) : null;
  if (subscribed) return { standing: { kind: 'on' }, subscribed };
  return { standing: { kind: device.permission() === 'denied' ? 'blocked' : 'off' }, subscribed: null };
};

const CHIPS: Readonly<Record<Exclude<Standing['kind'], 'reading'>, { tone: Tone; text: string }>> = {
  unavailable: { tone: 'muted', text: '使えません' },
  install: { tone: 'warn', text: 'ホーム画面に追加すると使えます' },
  unsupported: { tone: 'muted', text: 'このブラウザでは使えません' },
  blocked: { tone: 'danger', text: 'ブロックされています' },
  off: { tone: 'neutral', text: 'オフ' },
  on: { tone: 'brand', text: 'オン' },
};

/** What follows from where the browser stands, in a sentence or two. */
const Explanation = ({ standing, label }: { standing: Standing; label: string }) => {
  if (standing.kind === 'unavailable') return <Note>この FlareChat には、通知を送るための鍵がまだ設定されていません。設定されるまでは通知は届かないので、承認待ちや答えは会話を開いて確かめてください。</Note>;
  if (standing.kind === 'install') return <>
    <Note>iPhone や iPad で通知を受け取るには、まず FlareChat をホーム画面に追加して、ホーム画面のアイコンから開き直してください。そこでこの画面を開くと、通知をオンにできます。</Note>
    <ol className={styles.steps}>
      <li>Safari の下（iPad では上）にある共有ボタン（四角から矢印が出ているボタン）を押す</li>
      <li>「ホーム画面に追加」を選ぶ</li>
      <li>ホーム画面の FlareChat を開き、AI に聞く の「通知」で「この端末で受け取る」を押す</li>
    </ol>
  </>;
  if (standing.kind === 'unsupported') return <Note>このブラウザは通知を受け取れません。Chrome、Edge、Firefox、Mac の Safari、またはホーム画面に追加した iPhone・iPad で開くとオンにできます。それまでは、承認待ちや答えは会話を開いて確かめてください。</Note>;
  if (standing.kind === 'blocked') return <Note>この端末では FlareChat の通知がブロックされています。ブラウザ（iPhone・iPad では「設定」アプリの「通知」）で FlareChat の通知を許可してから、この画面を開き直してください。</Note>;
  if (standing.kind === 'on') return <Note>この端末（{label}）に届きます。オフにすると、この端末には届かなくなります。</Note>;
  if (standing.kind === 'off') return <Note>この端末（{label}）には届きません。オンにするとブラウザが通知の許可を求めるので、「許可」を選んでください。</Note>;
  return <Note>この端末の状態を確かめています…</Note>;
};

/**
 * The one place a member turns Operator Chat's notifications on and off
 * for the browser they are using: whether this FlareChat and this browser can
 * notify at all and what to do when they cannot, whether this browser is
 * notified, and the button that changes it.
 */
export const NotificationSettings = ({ settings, device }: { settings: PushSettings; device: Device }) => {
  const { account } = useAccount();
  const operations = usePendingOperations();
  const [standing, setStanding] = useState<Standing>({ kind: 'reading' });
  const publicKey = settings.publicKey;
  const changing = operations.pending(pendingKey.pushDevice);

  useEffect(() => {
    let current = true;
    void standingOf(settings, device).then(async ({ standing: read, subscribed }) => {
      if (!current) return;
      setStanding(read);
      // A browser that still holds its subscription is handed over again, so the Worker notifies it even if it had forgotten it.
      if (subscribed) await api.savePushDevice(account.accountId, { ...subscribed, label: device.label() }).catch(() => undefined);
    }, () => {
      if (current) setStanding({ kind: 'off' });
    });
    return () => {
      current = false;
    };
  }, [account.accountId, device, settings]);

  const turnOn = (): void => void operations.run(pendingKey.pushDevice, async () => {
    if (!publicKey) return;
    const subscribed = await device.subscribe(publicKey);
    if (!subscribed) {
      setStanding({ kind: device.permission() === 'denied' ? 'blocked' : 'off' });
      if (device.permission() !== 'denied') throw new Error('通知が許可されなかったので、オンにしませんでした。もう一度押して「許可」を選んでください。');
      return;
    }
    try {
      await api.savePushDevice(account.accountId, { ...subscribed, label: device.label() });
    } catch (error) {
      // A browser the Worker did not take is not left subscribed for nothing.
      await device.unsubscribe().catch(() => null);
      throw error;
    }
    setStanding({ kind: 'on' });
  });

  const turnOff = (): void => void operations.run(pendingKey.pushDevice, async () => {
    const subscribed = publicKey ? await device.subscription(publicKey) : null;
    if (subscribed) await api.removePushDevice(account.accountId, subscribed.endpoint);
    await device.unsubscribe();
    setStanding({ kind: device.permission() === 'denied' ? 'blocked' : 'off' });
  });

  const chip = standing.kind === 'reading' ? null : CHIPS[standing.kind];
  return <Section title="通知" lead="AI の答えが承認を待っているとき、答え終えたとき、途中で止まったときに、この端末へ知らせます。知らせるのは、あなたが始めた会話と、あなたがメッセージを送ったり承認したりした答えです。その会話を開いて見ているあいだは知らせません。">
    {operations.error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{operations.error}</Banner>}
    <Card>
      <div className={styles.status}>
        {standing.kind === 'on' ? <BellRing size={20} aria-hidden="true" /> : <BellOff size={20} aria-hidden="true" />}
        <span className={styles.label}>この端末</span>
        {chip && <Chip tone={chip.tone}>{chip.text}</Chip>}
      </div>
      <Explanation standing={standing} label={device.label()} />
      {standing.kind === 'off' && <Button busy={changing} onClick={turnOn}>{changing ? 'オンにしています…' : 'この端末で受け取る'}</Button>}
      {standing.kind === 'on' && <Button variant="secondary" busy={changing} onClick={turnOff}>{changing ? 'オフにしています…' : 'この端末では受け取らない'}</Button>}
      {(standing.kind === 'off' || standing.kind === 'on') && <Note>ほかの端末（スマートフォンとパソコンなど）は、それぞれの端末でこの欄からオンにします。</Note>}
    </Card>
  </Section>;
};
