import { AudioLines, Globe, Brain, CalendarClock, CalendarDays, Ellipsis, History, House, MessageSquare, Pencil, PlugZap, Settings, UsersRound, type LucideIcon } from 'lucide-react';

/** One destination in the Account's navigation, by its path below the Account. */
export interface Place {
  to: string;
  label: string;
  /** What it is for, in the その他 list. */
  sub: string;
  icon: LucideIcon;
}

/** The screens the Account opens every day, in the order of the bottom tabs; an Account opens on the first. */
export const dailyPlaces: readonly Place[] = [
  { to: 'chat', label: 'AI に聞く', sub: 'チャットで予定や連絡先を調べる', icon: MessageSquare },
  { to: 'home', label: 'ホーム', sub: '今朝の取り込みと要対応', icon: House },
  { to: 'events', label: '予定', sub: '予定と出欠', icon: CalendarDays },
  { to: 'contacts', label: '連絡先', sub: '知らせる相手と、その LINE・メール', icon: UsersRound },
];

export interface PlaceGroup {
  title: string;
  places: readonly Place[];
}

/** Everything else, grouped as the side bar and the その他 screen group it. */
export const morePlaceGroups: readonly PlaceGroup[] = [
  {
    title: 'AI と自動化',
    places: [
      { to: 'transcripts', label: '文字起こし', sub: '会議の録音を話者ごとに文字起こしし、議事録にする', icon: AudioLines },
      { to: 'automations', label: '自動化', sub: 'メール・毎朝・決まった時刻に動く AI', icon: CalendarClock },
      { to: 'skills', label: 'スキル', sub: 'AI の仕事のやり方', icon: Pencil },
      { to: 'memory', label: '記憶', sub: 'AI が覚えていること・意味で探す', icon: Brain },
      { to: 'browser', label: 'ブラウザ', sub: 'AI が操作するブラウザと、ログインしておくサイト', icon: Globe },
    ],
  },
  { title: '記録', places: [{ to: 'operations', label: '履歴', sub: '実行・送信・止まった処理', icon: History }] },
  {
    title: '設定',
    places: [
      { to: 'connections', label: '接続', sub: 'Google・AI（文字起こし）・LINE・Microsoft・Discord・MCP', icon: PlugZap },
      { to: 'settings', label: '設定', sub: 'リマインド・メールの取り込み・アカウント', icon: Settings },
    ],
  },
];

/** The その他 tab itself. */
export const morePlace: Place = { to: 'more', label: 'その他', sub: '', icon: Ellipsis };

/** True when `pathname` is `place` or a screen below it, such as one Automation below the Automations. */
export const isAt = (pathname: string, accountPath: string, place: string): boolean => {
  const path = `${accountPath}/${place}`;
  return pathname === path || pathname.startsWith(`${path}/`);
};
