import { describe, expect, it } from "vitest";

import { TOOL_LABELS } from "@mail/domain";
import {
  codeGroupLabel,
  codePlace,
  labelPhrase,
  orangeAgentToolPresentation,
  orangeAgentToolSentence,
} from "./orangeagent.ts";
import {
  resolveWorkEntryToolPresentation,
  summarizeToolGroup,
  toolGroupSummaryKind,
  type WorkLogPresentationEntry,
} from "./presentation.ts";

let next = 0;

/** A tool call as the timeline holds it: its name, arguments, answer, and status. */
const call = (
  toolName: string,
  input: unknown,
  output: unknown,
  status: WorkLogPresentationEntry["toolLifecycleStatus"] = "completed",
): WorkLogPresentationEntry => ({
  id: `entry-${next++}`,
  createdAt: "2026-11-22T00:00:00.000Z",
  label: toolName,
  tone: "tool",
  itemType: "dynamic_tool",
  toolLifecycleStatus: status,
  toolData: { toolName, input, output },
});

describe("orangeAgentToolPresentation", () => {
  it("names a browser call by what it is doing, then by how it ended", () => {
    const name = (status: string, output: unknown = null) =>
      orangeAgentToolPresentation("browser.open", status, { url: "https://example.com" }, output)
        ?.displayName;
    expect(name("inProgress")).toBe("ブラウザでページを開いています");
    expect(name("completed")).toBe("ブラウザでページを開きました");
    expect(name("failed")).toBe("ブラウザでページを開けませんでした");
    expect(name("stopped", "拒否したので実行しませんでした。")).toBe(
      "ブラウザでページを開く操作は拒否されました",
    );
    expect(name("stopped")).toBe("ブラウザでページを開く操作を中止しました");
    expect(orangeAgentToolPresentation("browser.click", "completed", {}, null)).toEqual({
      displayName: "ブラウザでクリックしました",
      icon: "browser",
      action: "browser",
    });
  });

  it("names where code.run ran: the answer's environment, else where its language goes", () => {
    expect(codePlace({ language: "python" }, { environment: "Dynamic Worker (128 MiB)" })).toBe(
      "Dynamic Worker",
    );
    expect(codePlace({ language: "javascript" }, { environment: "コンテナ lite (256 MiB)" })).toBe(
      "Cloudflare Container",
    );
    // An answer too long to keep whole is kept as cut text.
    const cut = `{"environment":"コンテナ basic (1 GiB)","stdout":"${"x".repeat(40)}…（残り 9 文字は画面に表示しません）`;
    expect(codePlace({ language: "python" }, cut)).toBe("Cloudflare Container");
    expect(codePlace({ language: "javascript" }, null)).toBe("Dynamic Worker");
    expect(codePlace({ language: "shell" }, null)).toBe("Cloudflare Container");

    expect(
      orangeAgentToolPresentation("code.run", "inProgress", { language: "javascript" }, null),
    ).toEqual({
      displayName: "Dynamic Worker でコードを実行しています",
      icon: "code",
      action: "code",
    });
    const ran = (output: unknown) =>
      orangeAgentToolPresentation("code.run", "completed", { language: "python" }, output)
        ?.displayName;
    expect(ran({ environment: "コンテナ lite (256 MiB)", exitCode: 0 })).toBe(
      "Cloudflare Container でコードを実行しました",
    );
    expect(ran({ environment: "コンテナ lite (256 MiB)", exitCode: 1 })).toBe(
      "Cloudflare Container でコードを実行できませんでした",
    );
    expect(
      orangeAgentToolPresentation("code_execution", "completed", {}, null)?.displayName,
    ).toBe("Anthropic のサンドボックスでコードを実行しました");
    expect(orangeAgentToolPresentation("mail.search", "completed", {}, null)).toBeNull();
  });
});

describe("a row of OrangeAgent's browser and code calls", () => {
  it("shows each call by its own sentence and icon", () => {
    const entry = call("browser.read", {}, null, "inProgress");
    expect(resolveWorkEntryToolPresentation(entry)).toMatchObject({
      displayName: "ブラウザの画面を読んでいます",
      icon: "browser",
    });
  });

  it("folds consecutive browser calls into one line", () => {
    const entries = [
      call("browser.open", { url: "https://example.com" }, "ok"),
      call("browser.click", {}, "ok"),
      call("browser.read", {}, "ok"),
    ];
    expect(toolGroupSummaryKind(entries)).toBe("browser");
    expect(summarizeToolGroup(entries).summary).toBe("Used browser 3 times");
  });

  it("folds consecutive code calls into one line naming each place", () => {
    const worker = { environment: "Dynamic Worker (128 MiB)", exitCode: 0 };
    const container = { environment: "コンテナ lite (256 MiB)", exitCode: 0 };
    const twice = [
      call("code.run", { language: "javascript" }, worker),
      call("code.run", { language: "javascript" }, worker),
    ];
    expect(toolGroupSummaryKind(twice)).toBe("code");
    expect(summarizeToolGroup(twice).summary).toBe("Dynamic Worker を 2 回使用しました");
    expect(
      summarizeToolGroup([...twice, call("code.run", { language: "python" }, container)]).summary,
    ).toBe("Dynamic Worker を 2 回、Cloudflare Container を 1 回使用しました");
    expect(codeGroupLabel(["Cloudflare Container"])).toBe("Cloudflare Container を 1 回使用しました");
  });
});

describe("the product's other tools", () => {
  it("says every tool's label as what the call is doing, did, or failed to do", () => {
    const unsaid = Object.values(TOOL_LABELS).filter((label) => labelPhrase(label) === null);
    expect(unsaid).toEqual([]);
  });

  it("conjugates the verb the label ends with, whatever its kind", () => {
    expect(orangeAgentToolSentence("スキルを書き換える", "completed", "ok")).toBe("スキルを書き換えました");
    expect(orangeAgentToolSentence("メールを送る", "inProgress", undefined)).toBe("メールを送っています");
    expect(orangeAgentToolSentence("メールを読む", "failed", "401")).toBe("メールを読めませんでした");
    expect(orangeAgentToolSentence("メールを検索する", "completed", "[]")).toBe("メールを検索しました");
    expect(orangeAgentToolSentence("PDF にする", "failed", "x")).toBe("PDF にできませんでした");
    expect(orangeAgentToolSentence("スキルを開く", "completed", "ok")).toBe("スキルを開きました");
    expect(orangeAgentToolSentence("メールを送る", "stopped", "拒否したので実行しませんでした。")).toBe(
      "メールを送る操作は拒否されました",
    );
  });

  it("leaves an MCP Server's tool, whose name ends with no verb, as it is named", () => {
    expect(orangeAgentToolSentence("github の create_issue", "completed", "ok")).toBeNull();
  });
});
