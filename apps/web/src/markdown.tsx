import { Check, Copy } from 'lucide-react';
import { Fragment, useState, type ReactNode } from 'react';

import styles from './markdown.module.css';

/**
 * The Markdown a model writes, rendered as React elements and never as HTML,
 * so nothing in an answer can run in the page. It covers what answers use:
 * paragraphs, headings, lists and checklists, quotes, code blocks with their
 * language and a copy button, tables, emphasis, strikethrough, and links. Text
 * that is still arriving renders as far as it has got.
 */

const SAFE_LINK = /^(https?:|mailto:)/iu;
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,、。])|(\*[^*\s][^*\n]*?\*)|(~~[^~\n]+?~~)/u;

const inline = (text: string): ReactNode[] => {
  const nodes: ReactNode[] = [];
  let rest = text;
  let key = 0;
  while (rest) {
    const match = INLINE.exec(rest);
    if (!match) {
      nodes.push(rest);
      break;
    }
    if (match.index > 0) nodes.push(rest.slice(0, match.index));
    const [token, code, bold, link, url, italic, struck] = match;
    if (struck) nodes.push(<del key={key}>{inline(struck.slice(2, -2))}</del>);
    else if (code) nodes.push(<code key={key} className={styles.code}>{code.slice(1, -1)}</code>);
    else if (bold) nodes.push(<strong key={key}>{inline(bold.slice(2, -2))}</strong>);
    else if (italic) nodes.push(<em key={key}>{inline(italic.slice(1, -1))}</em>);
    else if (link) {
      const label = link.slice(1, link.indexOf(']('));
      const href = link.slice(link.indexOf('](') + 2, -1);
      nodes.push(SAFE_LINK.test(href) ? <a key={key} href={href} target="_blank" rel="noreferrer">{inline(label)}</a> : label);
    } else if (url) nodes.push(<a key={key} href={url} target="_blank" rel="noreferrer">{url}</a>);
    key += 1;
    rest = rest.slice(match.index + token.length);
  }
  return nodes;
};

/** Lines of one paragraph keep their breaks, as an answer's addresses and lists of times do. */
const lines = (text: string): ReactNode[] => text.split('\n').map((line, index) =>
  <Fragment key={index}>{index > 0 && <br />}{inline(line)}</Fragment>);

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/u;
const HEADING = /^(#{1,6})\s+(.*)$/u;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/u;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/u;

const cells = (row: string): string[] => row.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((cell) => cell.trim());

interface ListEntry { ordered: boolean; text: string }

const CHECK_ITEM = /^\[([ xX])\]\s+(.*)$/su;

/** A list item, or a checklist item (`- [x] 済んだこと`) with a box that is only shown, never changed. */
const item = (entry: ListEntry, index: number): ReactNode => {
  const checked = CHECK_ITEM.exec(entry.text);
  if (!checked) return <li key={index}>{lines(entry.text)}</li>;
  const done = checked[1] !== ' ';
  return <li key={index} className={styles.check} data-done={done || undefined}>
    <span className={styles.box} role="img" aria-label={done ? '済み' : '未完了'}>{done && <Check size={12} aria-hidden="true" />}</span>
    <span>{lines(checked[2] ?? '')}</span>
  </li>;
};

const list = (entries: ListEntry[], key: number): ReactNode => {
  const items = entries.map(item);
  return entries[0]?.ordered ? <ol key={key} className={styles.list}>{items}</ol> : <ul key={key} className={styles.list}>{items}</ul>;
};

/** What a fence names its code as (```ts), or nothing. */
const fenceLanguage = (fence: string): string => /^`{3,}\s*([\w#+.-]+)/u.exec(fence.trim())?.[1] ?? '';

/** A code block under a header naming its language, with a button that copies the code alone. */
export const CodeBlock = ({ code, language }: { code: string; language: string }) => {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return <figure className={styles.block}>
    <figcaption className={styles.blockHead}>
      <span className={styles.language}>{language || 'コード'}</span>
      <button type="button" className={styles.blockCopy} onClick={() => void copy()} aria-label={copied ? 'コピーしました' : 'コードをコピー'}>
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{copied ? 'コピーしました' : 'コピー'}
      </button>
    </figcaption>
    <pre className={styles.pre}><code>{code}</code></pre>
  </figure>;
};

export const Markdown = ({ text }: { text: string }) => {
  const source = text.replace(/\r\n?/gu, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length) blocks.push(<p key={blocks.length} className={styles.paragraph}>{lines(paragraph.join('\n'))}</p>);
    paragraph = [];
  };
  while (index < source.length) {
    const line = source[index] ?? '';
    if (line.trimStart().startsWith('```')) {
      flush();
      const language = fenceLanguage(line);
      const body: string[] = [];
      index += 1;
      while (index < source.length && !(source[index] ?? '').trimStart().startsWith('```')) {
        body.push(source[index] ?? '');
        index += 1;
      }
      index += 1;
      blocks.push(<CodeBlock key={blocks.length} code={body.join('\n')} language={language} />);
      continue;
    }
    if (!line.trim()) {
      flush();
      index += 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const Heading = (heading[1]?.length ?? 1) <= 2 ? 'h3' : 'h4';
      blocks.push(<Heading key={blocks.length} className={styles.heading}>{inline(heading[2] ?? '')}</Heading>);
      index += 1;
      continue;
    }
    if (RULE.test(line)) {
      flush();
      blocks.push(<hr key={blocks.length} className={styles.rule} />);
      index += 1;
      continue;
    }
    if (line.includes('|') && TABLE_DIVIDER.test(source[index + 1] ?? '')) {
      flush();
      const head = cells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < source.length && (source[index] ?? '').includes('|') && (source[index] ?? '').trim()) {
        rows.push(cells(source[index] ?? ''));
        index += 1;
      }
      blocks.push(<div key={blocks.length} className={styles.tableWrap}><table className={styles.table}>
        <thead><tr>{head.map((cell, column) => <th key={column}>{inline(cell)}</th>)}</tr></thead>
        <tbody>{rows.map((row, at) => <tr key={at}>{head.map((_, column) => <td key={column}>{inline(row[column] ?? '')}</td>)}</tr>)}</tbody>
      </table></div>);
      continue;
    }
    if (line.startsWith('>')) {
      flush();
      const quoted: string[] = [];
      while (index < source.length && (source[index] ?? '').startsWith('>')) {
        quoted.push((source[index] ?? '').replace(/^>\s?/u, ''));
        index += 1;
      }
      blocks.push(<blockquote key={blocks.length} className={styles.quote}><Markdown text={quoted.join('\n')} /></blockquote>);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      flush();
      const entries: ListEntry[] = [];
      while (index < source.length) {
        const current = source[index] ?? '';
        const item = LIST_ITEM.exec(current);
        if (item) {
          entries.push({ ordered: /\d/u.test(item[2] ?? ''), text: item[3] ?? '' });
        } else if (current.trim() && /^\s{2,}/u.test(current) && entries.length) {
          const last = entries[entries.length - 1];
          if (last) last.text += `\n${current.trim()}`;
        } else break;
        index += 1;
      }
      blocks.push(list(entries, blocks.length));
      continue;
    }
    paragraph.push(line);
    index += 1;
  }
  flush();
  return <div className={styles.markdown}>{blocks}</div>;
};
