import { describe, expect, it } from 'vitest';

import { bodied } from './isolate';

describe('the run\'s code in a Dynamic Worker', () => {
  it('keeps its imports at the top and moves every other statement into the body the harness calls, each on its line', () => {
    const code = "import { Tasks } from './skills/task-management/scripts/tasks.mjs';\nconst t = new Tasks(tools);\nconsole.log(await t.search());";
    const wrapped = bodied(code);
    expect(wrapped.split('\n')).toEqual([
      "import { Tasks } from './skills/task-management/scripts/tasks.mjs'; export async function __orangeagentRun() {",
      ' '.repeat(67),
      'const t = new Tasks(tools);',
      'console.log(await t.search());',
      '}',
      '',
    ]);
  });

  it('runs code that exports, or does not parse, as it was written', () => {
    expect(bodied('export const a = 1;')).toBe('export const a = 1;');
    expect(bodied('const = ;')).toBe('const = ;');
  });
});
