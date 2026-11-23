import type { Tool } from '@mail/domain';

import { TOOL_AREAS, tool, toolArea, word } from './labels';
import { Check, CheckGroup } from './ui/field';

/** What a call of the tool does, as the line under its name says it. */
export const toolEffect = (entry: Tool): string =>
  entry.acts ? 'サイトをその場で操作します' : entry.reachesContacts ? '相手に届きます' : entry.writes ? '中身を変えます' : '読むだけです';

/**
 * The tools a grant may hold, under what each works on (メール, 予定と出欠, …),
 * each with what a call of it does. A tool added to the list appears here as
 * it is, under its area or under その他.
 */
export const ToolChecks = ({ tools, value, onChange, effect = toolEffect, disabled = false }: {
  tools: readonly Tool[];
  value: readonly string[];
  onChange: (tools: string[]) => void;
  effect?: (entry: Tool) => string;
  disabled?: boolean;
}) => {
  const set = (name: string, checked: boolean): void => onChange(checked
    ? tools.map((entry) => entry.name).filter((entry) => entry === name || value.includes(entry))
    : value.filter((entry) => entry !== name));
  return <>{TOOL_AREAS.map((area) => {
    const listed = tools.filter((entry) => toolArea(entry.name) === area);
    if (!listed.length) return null;
    return <CheckGroup key={area} legend={area} showLegend>
      {listed.map((entry) => <Check
        key={entry.name}
        label={word(tool, entry.name)}
        sub={effect(entry)}
        checked={value.includes(entry.name)}
        disabled={disabled}
        onChange={(checked) => set(entry.name, checked)}
      />)}
    </CheckGroup>;
  })}</>;
};
