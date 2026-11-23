import { Check, LogOut, UserPlus } from 'lucide-react';

import type { SignedInPerson } from '@mail/domain';

import { useAccount } from './dashboard';
import { Button } from './ui/button';
import { List, Row } from './ui/list';
import { Section } from './ui/page';
import styles from './ui/shell.module.css';

/** What a person is called in a list of the Google accounts signed in here: their name, and the address that tells two apart. */
const named = (person: SignedInPerson): { title: string; sub: string } => ({
  title: person.displayName.trim() || person.email,
  sub: person.account ? person.email : `${person.email}・アカウント未作成`,
});

/**
 * The Google accounts this browser is signed in to, in the side bar: the one
 * this page is for marked, the others opening the same screen as them, and the
 * ways to add one or sign out.
 */
export const SidebarPeople = () => {
  const { state, person, switchPerson, addPerson, logout, logoutEveryone, leaving } = useAccount();
  return <div className={styles.people}>
    <span className={styles.groupTitle}>Google アカウント</span>
    <ul className={styles.personList} aria-label="ログイン中の Google アカウント">
      {state.people.map((candidate) => {
        const { title, sub } = named(candidate);
        const here = candidate.identityId === person.identityId;
        return <li key={candidate.identityId}>
          <button type="button" className={styles.person} aria-current={here ? 'true' : undefined} disabled={here} onClick={() => switchPerson(candidate.identityId)}>
            <span className={styles.personText}><span className={styles.personName}>{title}</span><span className={styles.personEmail}>{sub}</span></span>
            {here && <><Check size={16} aria-hidden="true" /><span className="sr-only">表示中</span></>}
          </button>
        </li>;
      })}
    </ul>
    <button type="button" className={styles.logout} onClick={addPerson}><UserPlus size={18} aria-hidden="true" />アカウントを追加</button>
    <button type="button" className={styles.logout} onClick={logout} disabled={leaving}><LogOut size={18} aria-hidden="true" />{leaving ? 'ログアウト中…' : 'ログアウト'}</button>
    {state.people.length > 1 && <button type="button" className={styles.logout} onClick={logoutEveryone} disabled={leaving}><LogOut size={18} aria-hidden="true" />すべてログアウト</button>}
  </div>;
};

/** The same, as a section of その他 on a phone. */
export const PeopleSection = () => {
  const { state, person, switchPerson, addPerson, logout, logoutEveryone, leaving } = useAccount();
  return <Section title="Google アカウント">
    <List label="ログイン中の Google アカウント">
      {state.people.map((candidate) => {
        const { title, sub } = named(candidate);
        return candidate.identityId === person.identityId
          ? <Row key={candidate.identityId} title={title} sub={sub} aside="表示中" />
          : <Row key={candidate.identityId} title={title} sub={sub} label={`${title} に切り替える`} onClick={() => switchPerson(candidate.identityId)} />;
      })}
    </List>
    <Button variant="secondary" block onClick={addPerson} icon={<UserPlus size={18} aria-hidden="true" />}>別の Google アカウントを追加</Button>
    <Button variant="secondary" block busy={leaving} onClick={logout} icon={<LogOut size={18} aria-hidden="true" />}>{leaving ? 'ログアウト中…' : `${named(person).title} からログアウト`}</Button>
    {state.people.length > 1 && <Button variant="secondary" block disabled={leaving} onClick={logoutEveryone} icon={<LogOut size={18} aria-hidden="true" />}>すべてログアウト</Button>}
  </Section>;
};
