/**
 * What an opened tool call shows besides t3code's arguments and answer (OrangeAgent's own file):
 * why a call failed, as an error rather than as an answer, and the tool's own name, which the row
 * itself shows in words (domain `toolLabel`).
 */
import type { ReactElement } from 'react';

/** Why a call failed, in the words the Worker kept, styled as an error. */
export function ToolFailure({ output, cancelled }: { readonly output: string | null; readonly cancelled: boolean }): ReactElement {
  const message = output?.trim() || (cancelled ? '実行しませんでした。' : '理由は記録されていません。');
  return (
    <div
      role="alert"
      data-tool-failure="true"
      className={cancelled
        ? 'rounded-md border border-border/70 bg-muted/30 px-2 py-1.5 font-sans text-xs leading-5 text-muted-foreground'
        : 'rounded-md border border-destructive/30 bg-destructive/8 px-2 py-1.5 font-sans text-xs leading-5 text-destructive'}
    >
      <p className="font-medium">{cancelled ? '実行しませんでした' : 'エラー'}</p>
      <p className="whitespace-pre-wrap wrap-anywhere select-text">{message}</p>
    </div>
  );
}

/** The tool's own name, shown only here. */
export function ToolName({ name }: { readonly name: string }): ReactElement {
  return (
    <p className="text-muted-foreground" data-tool-name="true">
      <span>ツール名 </span>
      <span className="select-text">{name}</span>
    </p>
  );
}
