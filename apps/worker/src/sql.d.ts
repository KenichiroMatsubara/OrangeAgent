declare module '*.sql' {
  const contents: string;
  export default contents;
}

/** A program a starting Skill carries, imported as its text, as a migration is (wrangler.jsonc's Text rule). */
declare module '*/starter/tasks.mjs' {
  const contents: string;
  export default contents;
}

declare module 'better-sqlite3' {
  interface Statement {
    get(...parameters: unknown[]): unknown;
    all(...parameters: unknown[]): unknown[];
    run(...parameters: unknown[]): { changes: number };
    raw(enabled?: boolean): Statement;
  }

  class Database {
    /** A path or `:memory:`, or the bytes `serialize` returned, opened as a private in-memory copy. */
    constructor(filename: string | Buffer);
    pragma(source: string): unknown;
    prepare(source: string): Statement;
    exec(source: string): this;
    serialize(): Buffer;
    close(): void;
  }

  export default Database;
}

/** Each library a run's code is lent (`lent.ts`), imported as its text by the same rule. */
declare module '*/lent/docx.mjs' {
  const contents: string;
  export default contents;
}
declare module '*/lent/exceljs.mjs' {
  const contents: string;
  export default contents;
}
declare module '*/lent/fflate.mjs' {
  const contents: string;
  export default contents;
}
declare module '*/lent/pdf-lib.mjs' {
  const contents: string;
  export default contents;
}
declare module '*/lent/pptxgenjs.mjs' {
  const contents: string;
  export default contents;
}
declare module '*/lent/xmldom.mjs' {
  const contents: string;
  export default contents;
}
