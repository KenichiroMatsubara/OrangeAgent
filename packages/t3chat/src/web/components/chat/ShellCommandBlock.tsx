import { withVisibleControlCharacters } from "@t3tools/client-runtime/work-log/commandLabel.ts";

const WORD_CLASS_NAME = "[overflow-wrap:anywhere]";

function PlainWords({ code }: { code: string }) {
  return code.split(/(\s+)/u).map((part, index) =>
    index % 2 === 1 || part === "" ? (
      part
    ) : (
      // oxlint-disable-next-line react/no-array-index-key -- positions are stable for one string
      <span key={index} className={WORD_CLASS_NAME}>
        {part}
      </span>
    ),
  );
}

export function ShellCommandBlock({ command }: { command: string }) {
  // OrangeAgent: shell highlighting is cut; the command is shown as plain words.
  const code = withVisibleControlCharacters(command.trim());
  if (!code) return null;
  return (
    <div className="text-foreground/85">
      <PlainWords code={code} />
    </div>
  );
}
