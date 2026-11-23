/**
 * The files an answer wrote or handed on, shown under its words (OrangeAgent's own file). t3code
 * shows files only on a person's message; an answer's files are kept on its message item
 * (`attachments`, apps/worker/src/timeline.ts), each read where the transport says. A picture
 * shows inline and opens full size; any other file is a link by its name, which opens a PDF in the
 * browser and downloads anything else, as the Worker serves it. Each can be saved to Drive, in
 * OrangeAgent's AI に聞く folder or, where Google Picker is configured, a folder the member chooses.
 */
import { CloudUploadIcon, DownloadIcon, ExternalLinkIcon, FileTextIcon, FolderOpenIcon } from 'lucide-react';
import { createContext, type ReactElement, use, useState } from 'react';

import type { ExpandedImagePreview } from '~/components/chat/ExpandedImagePreview';
import { formatBytes } from '~/lib/formatBytes';
import { type ChatAttachment, type ChatFileAttachment, type ChatImageAttachment, isFileAttachment, isImageAttachment } from '~/types';

/** The kind a file's name or type says it is, in words. */
const kindOf = (file: ChatFileAttachment): string => {
  if (file.mimeType === 'application/pdf') return 'PDF';
  const extension = /\.([a-z0-9]{1,8})$/iu.exec(file.name)?.[1];
  return extension ? extension.toUpperCase() : 'ファイル';
};

/** What an answer's files can be done with beyond opening them, which ChatSurface fills from its transport. */
export interface FileCommands {
  /** Saves a file to Drive, in a folder chosen with Google Picker when `choose`; resolves with where, or null when nothing was saved. */
  readonly saveToDrive: ((fileId: string, choose: boolean) => Promise<{ readonly url: string } | null>) | null;
  /** Whether a folder can be chosen; otherwise a file is saved in AI に聞く. */
  readonly chooseFolder: boolean;
}

export const FileContext = createContext<FileCommands>({ saveToDrive: null, chooseFolder: false });

type Saving = { readonly state: 'idle' } | { readonly state: 'saving' } | { readonly state: 'saved'; readonly url: string } | { readonly state: 'failed'; readonly message: string };

/** Saving one file to Drive: 「Drive に保存」, 「保存先を選ぶ」 where a folder can be chosen, and, once saved, a link to it there. */
function DriveSave({ fileId, name }: { readonly fileId: string; readonly name: string }): ReactElement | null {
  const { saveToDrive, chooseFolder } = use(FileContext);
  const [saving, setSaving] = useState<Saving>({ state: 'idle' });
  if (saveToDrive === null) return null;
  if (saving.state === 'saved') {
    return (
      <a href={saving.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
        <ExternalLinkIcon aria-hidden className="size-3.5" />Drive で開く
      </a>
    );
  }
  const save = (choose: boolean): void => {
    setSaving({ state: 'saving' });
    saveToDrive(fileId, choose).then(
      (saved) => setSaving(saved ? { state: 'saved', url: saved.url } : { state: 'idle' }),
      (error: unknown) => setSaving({ state: 'failed', message: error instanceof Error ? error.message : 'Drive に保存できませんでした。' }),
    );
  };
  const busy = saving.state === 'saving';
  const button = 'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-60';
  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-drive-save={fileId}>
      <button type="button" className={button} disabled={busy} onClick={() => save(false)} aria-label={`${name} を Drive に保存`}>
        <CloudUploadIcon aria-hidden className="size-3.5" />{busy ? '保存しています…' : 'Drive に保存'}
      </button>
      {chooseFolder ? (
        <button type="button" className={button} disabled={busy} onClick={() => save(true)} aria-label={`${name} の保存先を選ぶ`}>
          <FolderOpenIcon aria-hidden className="size-3.5" />保存先を選ぶ
        </button>
      ) : null}
      {saving.state === 'failed' ? <span role="alert" className="text-xs text-destructive-foreground">{saving.message}</span> : null}
    </span>
  );
}

/** A PDF opens in the browser; any other file is saved. */
const opensInBrowser = (file: ChatFileAttachment): boolean => file.mimeType === 'application/pdf';

export function AnswerFiles({
  attachments,
  onImageExpand,
}: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
}): ReactElement | null {
  const images = (attachments ?? []).filter(isImageAttachment).filter((image): image is ChatImageAttachment & { readonly previewUrl: string } => typeof image.previewUrl === 'string');
  const files = (attachments ?? []).filter(isFileAttachment);
  if (images.length === 0 && files.length === 0) return null;
  const gallery: ExpandedImagePreview['images'] = images.map((image) => ({ src: image.previewUrl, name: image.name, mimeType: image.mimeType }));
  return (
    <div className="mt-2 flex flex-col gap-2" data-answer-files="true">
      {images.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {images.map((image, index) => (
            <div key={image.id} className="flex max-w-[min(18rem,100%)] flex-col items-start gap-1">
              <button
                type="button"
                aria-label={`${image.name} を大きく表示`}
                onClick={() => onImageExpand({ images: gallery, index })}
                className="max-w-full cursor-zoom-in overflow-hidden rounded-lg border border-border/70 bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
              >
                <img src={image.previewUrl} alt={image.name} loading="lazy" className="block h-auto max-h-48 w-auto max-w-full" />
              </button>
              <DriveSave fileId={image.id} name={image.name} />
            </div>
          ))}
        </div>
      ) : null}
      {files.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {files.map((file) => (
            <li key={file.id} className="flex flex-col items-start gap-1">
              {file.previewUrl ? (
                <a
                  href={file.previewUrl}
                  {...(opensInBrowser(file) ? { target: '_blank', rel: 'noopener noreferrer' } : { download: file.name })}
                  className="group/file flex w-72 max-w-full items-center gap-3 rounded-xl border border-border/70 bg-card px-3 py-2 text-foreground no-underline hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                >
                  <FileTextIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium group-hover/file:underline">{file.name}</span>
                    <span className="block text-xs text-muted-foreground tabular-nums">{kindOf(file)} · {formatBytes(file.sizeBytes)}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{opensInBrowser(file) ? '開く' : <DownloadIcon aria-label="保存" className="size-4" />}</span>
                </a>
              ) : (
                <span className="flex w-72 max-w-full items-center gap-3 rounded-xl border border-border/70 px-3 py-2 text-sm text-muted-foreground">
                  <FileTextIcon aria-hidden className="size-5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{file.name}</span>
                </span>
              )}
              <DriveSave fileId={file.id} name={file.name} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
