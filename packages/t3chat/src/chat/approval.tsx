/**
 * A call waiting for approval, as the Worker describes it (apps/worker/src/approval.ts
 * `describeCall`): what its tool does on the first line, then what it will do — the mail's
 * recipient, subject, and body, the event's name, time, and place, a change as before → after —
 * or, for a tool without such a preview, each argument on a line. OrangeAgent's own file: t3code
 * shows a command to approve as code, which reads badly for a mail.
 */
import type { ReactElement } from 'react';

/** A preview's `項目：値` line, whose name is short; a line of a mail's body is not one. */
const FIELD = /^([^：\n]{1,8})：(.*)$/u;

export function ApprovalDetail({ detail, label }: { readonly detail: string; readonly label: string }): ReactElement {
  const [title = '', ...rest] = detail.split('\n');
  let inBody = false;
  return (
    <div
      aria-label={label}
      data-approval-detail="complete"
      tabIndex={0}
      className="block max-h-72 min-w-0 overflow-auto text-sm leading-6 text-foreground select-text! wrap-anywhere [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
    >
      <p className="font-medium">{title}</p>
      {rest.length > 0 ? (
        <div className="mt-0.5 whitespace-pre-wrap">
          {rest.map((line, index) => {
            const field = inBody ? null : FIELD.exec(line);
            // A mail's body follows its 本文： line, and runs to the end.
            if (field?.[1] === '本文') inBody = true;
            return field ? (
              <div key={index}>
                <span className="text-muted-foreground">{field[1]}：</span>
                {field[2]}
              </div>
            ) : (
              <div key={index} className={line === '' ? 'h-2' : inBody ? 'ps-3 text-foreground/85' : undefined}>{line}</div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
