import { describe, expect, it } from 'vitest';

import { OUTPUT_DIR, placedName, ready, runInContainer, WORKDIR, type Workspace } from './container';

interface Call { cmd: string[]; cwd?: string }

/**
 * A container whose files are kept as the Sandbox SDK's `Files` keeps them,
 * refusing a file under a directory no one made, and whose one command, the
 * job's, answers as given.
 */
const fakeContainer = (answer: { exitCode: number; stdout?: string; stderr?: string }, outputs: Record<string, string> = {}) => {
  const calls: Call[] = [];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const directories = new Set<string>(['/']);
  const written = new Map<string, string>(Object.entries(outputs).map(([name, text]) => [`${OUTPUT_DIR}/${name}`, text]));
  const missing = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  const parent = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
  const files: Workspace = {
    mkdir: async (path) => {
      for (let at = path; at !== '/'; at = parent(at)) directories.add(at);
    },
    writeFile: async (path, content) => {
      if (!directories.has(parent(path))) throw missing(path);
      written.set(path, decoder.decode(content as Uint8Array));
    },
    readFile: async (path) => {
      const text = written.get(path);
      if (text === undefined) throw missing(path);
      return new Response(encoder.encode(text));
    },
    readDirectory: async (path) => [...written.keys()].filter((name) => parent(name) === path).map((name) => ({ name: name.slice(path.length + 1), type: 'file' as const })),
    stat: async (path) => {
      const text = written.get(path);
      if (text === undefined) throw missing(path);
      const now = new Date(0);
      return { type: 'file', size: BigInt(encoder.encode(text).byteLength), mode: 0o644, uid: 0, gid: 0, accessedAt: now, modifiedAt: now, changedAt: now };
    },
  };
  const result = (exitCode: number, stdout = '', stderr = '') => ({
    stdin: null, stdout: null, stderr: null, pid: 1, isPty: false, exitCode: Promise.resolve(exitCode),
    output: async () => ({ exitCode, stdout: encoder.encode(stdout).buffer as ArrayBuffer, stderr: encoder.encode(stderr).buffer as ArrayBuffer }),
    kill: () => undefined,
    resize: () => undefined,
  });
  const exec = async (cmd: string[], options?: ContainerExecOptions): Promise<ExecProcess> => {
    calls.push({ cmd, ...(options?.cwd ? { cwd: options.cwd } : {}) });
    return cmd[0] === 'timeout' ? result(answer.exitCode, answer.stdout, answer.stderr) : result(0);
  };
  return { container: { exec }, files, calls, written };
};

describe('a job in a container', () => {
  it('places the files and the code, runs it with a time limit, and reads back what it left in out/', async () => {
    const { container, files, calls, written } = fakeContainer({ exitCode: 0, stdout: 'done' }, { 'report.csv': 'a,b\n1,2\n' });
    const result = await runInContainer(container, files, {
      language: 'python', code: 'print("done")',
      files: [{ filename: 'mail/sales.xlsx', bytes: new TextEncoder().encode('xlsx') }],
    });

    expect(written.get(`${WORKDIR}/sales.xlsx`)).toBe('xlsx');
    expect(written.get(`${WORKDIR}/.main.py`)).toBe('print("done")');
    expect(calls.find((call) => call.cmd[0] === 'timeout')).toEqual({ cmd: ['timeout', '300', 'python3', '.main.py'], cwd: WORKDIR });
    expect(result.stdout).toBe('done');
    expect(result.files.map((file) => [file.filename, new TextDecoder().decode(file.bytes)])).toEqual([['report.csv', 'a,b\n1,2\n']]);
    expect(result.outOfMemory).toBe(false);
  });

  it('tells a kill for want of memory and a time limit apart', async () => {
    const oom = fakeContainer({ exitCode: 137 });
    const killed = await runInContainer(oom.container, oom.files, { language: 'shell', code: 'true', files: [] });
    expect(killed.outOfMemory).toBe(true);
    const slow = fakeContainer({ exitCode: 124 });
    const timed = await runInContainer(slow.container, slow.files, { language: 'shell', code: 'sleep 999', files: [] });
    expect(timed.outOfMemory).toBe(false);
    expect(timed.stderr).toContain('300 seconds');
  });

  it('places a Skill and a lent library at their own paths, making the directories above them', async () => {
    const { container, files, written } = fakeContainer({ exitCode: 0 });
    await runInContainer(container, files, {
      language: 'javascript', code: "import { zipSync } from 'fflate';",
      files: [],
      placed: [{ path: '/skills/office-files/scripts/fill.mjs', bytes: new TextEncoder().encode('export {};') }],
    });

    expect(written.get('/skills/office-files/scripts/fill.mjs')).toBe('export {};');
    expect(written.has('/node_modules/fflate/index.mjs')).toBe(true);
    expect(written.get(`${WORKDIR}/.orangeagent.mjs`)).toContain('globalThis.tools');
  });

  it('hands back the smallest files of out/ first, at most 20', async () => {
    const outputs = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`f${String(index).padStart(2, '0')}.txt`, 'x'.repeat(25 - index)]));
    const { container, files } = fakeContainer({ exitCode: 0 }, outputs);
    const result = await runInContainer(container, files, { language: 'shell', code: 'true', files: [] });

    expect(result.files).toHaveLength(20);
    expect(result.files[0]?.filename).toBe('f24.txt');
    expect(result.files.some((file) => file.filename === 'f00.txt')).toBe(false);
  });

  it('places a file only under a name of its own, never a hidden or parent one', () => {
    expect(placedName('a/b/報告.docx')).toBe('報告.docx');
    expect(placedName('..')).toBeNull();
    expect(placedName('.main.py')).toBeNull();
    expect(placedName('')).toBeNull();
  });

  it('waits for a container just started to take a command', async () => {
    let refused = 2;
    const exec = async (): Promise<ExecProcess> => {
      if (refused > 0) {
        refused -= 1;
        throw new Error('not running');
      }
      return { stdin: null, stdout: null, stderr: null, pid: 1, isPty: false, exitCode: Promise.resolve(0), output: async () => ({ exitCode: 0, stdout: new ArrayBuffer(0), stderr: new ArrayBuffer(0) }), kill: () => undefined, resize: () => undefined };
    };
    await ready({ exec }, 5, async () => undefined);
    expect(refused).toBe(0);
    await expect(ready({ exec: async () => { throw new Error('down'); } }, 2, async () => undefined)).rejects.toThrow('did not start');
  });
});
