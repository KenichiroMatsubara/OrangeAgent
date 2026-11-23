import { ShieldCheck } from 'lucide-react';
import type { ProvisioningPhase } from '@mail/domain';

import { SetupBrand } from './brand';

export const setupPhaseLabel = (phase: ProvisioningPhase | null): string => {
  if (!phase) return '準備を始めています';
  return {
    allocating_database: 'データベースを用意しています',
    applying_schema: 'データベースを整えています',
    storing_credentials: 'Google との接続を保存しています',
    verifying_binding: 'データベースにつながるか確かめています',
    activating_organization: 'アカウントを使えるようにしています',
  }[phase];
};

/** The one way in: signing in with Google, which asks for nothing but who the person is. */
export const SignedOutEntry = ({
  busy,
  error,
  onSignIn,
}: {
  busy: boolean;
  error: string;
  onSignIn: () => void;
}) => <main className="setup-shell"><section className="setup-card login-card">
  <SetupBrand caption="SCHEDULES AND CONTACTS" />
  <p className="eyebrow">GOOGLE</p><h1>OrangeAgentを開く</h1>
  <p className="setup-copy">Google アカウントでログインします。求めるのは名前とメールアドレスだけです。初めてのときは、このあとすぐに使い始められます。</p>
  {error && <p className="setup-error">{error}</p>}
  <button className="primary google-login entry-login" onClick={onSignIn} disabled={busy}><ShieldCheck size={18} />{busy ? 'Googleへ接続中…' : 'Google でログイン'}</button>
</section></main>;
