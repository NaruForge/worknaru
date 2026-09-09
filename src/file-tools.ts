import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readSync, realpathSync, writeSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, publicError } from './protocol.js';
import { fileEditSchema, fileReadSchema, MAX_FILE_BYTES } from './file-approval.js';
import type { FileApproval } from './file-approval.js';
import { RecordStore } from './store.js';
import type { Run } from './store.js';

const inside = (root: string, path: string) => { const part = relative(root, path); return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
const identity = (stat: BigIntStats) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
const result = (value: unknown, isError = false) => ({ isError, content: [{ type: 'text', text: JSON.stringify(value) }] });

// Deliberately limited to existing small UTF-8 files. No arbitrary shell or filesystem API.
export class FileTools {
  private server = createServer();
  private listening?: Promise<void>;
  private tokens = new Map<string, { sessionId: string; currentRun: () => string | undefined; calls: number }>();
  private pending = new Map<string, { runId: string; finish: (value: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  private sockets = new Set<Socket>();
  private stopping = false;
  constructor(private store: RecordStore, private dataDirectory: string, private changed: (run: Run) => void) {
    this.server.on('connection', (socket) => { this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)); });
    this.server.on('request', (req, res) => {
      const address = this.server.address() as AddressInfo;
      const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
      const binding = this.tokens.get(token);
      if (this.stopping || !binding || req.method !== 'POST' || req.url !== '/file-tool' || req.headers.origin !== undefined || req.headers.host !== `127.0.0.1:${address.port}`) { res.writeHead(403).end(); return; }
      if (binding.calls >= 4) { res.writeHead(429).end(); return; }
      binding.calls++;
      const runId = binding.currentRun();
      let bytes = 0;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 64 * 1024) req.destroy(); else chunks.push(chunk); });
      const bodyTimer = setTimeout(() => req.destroy(), 5_000);
      req.on('close', () => clearTimeout(bodyTimer));
      req.on('error', () => {});
      res.on('close', () => { binding.calls--; });
      req.on('end', () => {
        clearTimeout(bodyTimer);
        void (async () => {
          try {
            const call = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { name?: unknown; arguments?: unknown };
            if (this.tokens.get(token) !== binding || !runId || binding.currentRun() !== runId || this.store.run(runId).sessionId !== binding.sessionId || this.store.run(runId).state !== 'running') throw new AppError('RUN_INACTIVE', '현재 실행의 파일 도구만 사용할 수 있습니다.');
            const value = call.name === 'read_text_file' ? this.read(call.arguments)
              : call.name === 'edit_text_file' ? await this.edit(runId, call.arguments)
              : (() => { throw new AppError('TOOL_UNSUPPORTED', '지원하지 않는 파일 도구입니다.'); })();
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
          } catch (error) { if (!res.destroyed) res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result(publicError(error), true))); }
        })();
      });
    });
  }

  async bind(sessionId: string, currentRun: () => string | undefined) {
    if (this.stopping) throw new AppError('DAEMON_STOPPING', '데몬을 종료하고 있습니다.');
    this.listening ??= (async () => { this.server.listen(0, '127.0.0.1'); await once(this.server, 'listening'); })();
    await this.listening;
    const token = randomBytes(32).toString('base64url');
    this.tokens.set(token, { sessionId, currentRun, calls: 0 });
    return { name: 'worknaru_files', command: process.execPath, args: [fileURLToPath(new URL('./file-tool-bridge.js', import.meta.url))],
      env: [{ name: 'WORKNARU_FILE_ENDPOINT', value: `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/file-tool` }, { name: 'WORKNARU_FILE_TOKEN', value: token }] };
  }

  unbind(sessionId: string) { for (const [token, binding] of this.tokens) if (binding.sessionId === sessionId) this.tokens.delete(token); }
  waiting(runId: string) { return [...this.pending.values()].some((item) => item.runId === runId); }

  private path(value: string) {
    if (isAbsolute(value) || /^[a-z]:/i.test(value) || value.includes(':') || value.includes('\0')) throw new AppError('FILE_PATH_INVALID', 'Workspace 안의 상대 파일 경로를 사용하세요.');
    const parts = value.replaceAll('\\', '/').split('/');
    if (parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /[<>"|?*\x00-\x1f]/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || ['.git', '.codex', '.agents', 'node_modules'].includes(part.toLowerCase())))
      throw new AppError('FILE_PATH_INVALID', '링크·예약 경로·설정 영역은 파일 도구로 접근할 수 없습니다.');
    const root = this.store.workspace.path;
    const target = resolve(root, ...parts);
    if (!inside(root, target) || inside(this.dataDirectory, target)) throw new AppError('FILE_PATH_INVALID', 'Workspace의 작업 파일만 사용할 수 있습니다.');
    let cursor = root;
    for (const [index, part] of parts.entries()) {
      cursor = join(cursor, part);
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) throw new AppError('FILE_PATH_INVALID', '기존 일반 파일만 사용할 수 있으며 링크는 허용하지 않습니다.');
    }
    if (realpathSync(target).toLowerCase() !== target.toLowerCase()) throw new AppError('FILE_PATH_INVALID', '파일의 실제 경로를 확인할 수 없습니다.');
    return { target, path: parts.join('/') };
  }

  private open(value: string, writable = false) {
    let fd: number | undefined;
    try {
      const checked = this.path(value);
      fd = openSync(checked.target, writable ? 'r+' : 'r');
      const stat = fstatSync(fd, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(MAX_FILE_BYTES) || identity(lstatSync(checked.target, { bigint: true })) !== identity(stat)) throw new AppError('FILE_UNSUPPORTED', '8KiB 이하의 기존 일반 텍스트 파일만 사용할 수 있습니다.');
      const buffer = Buffer.alloc(Number(stat.size));
      let offset = 0;
      while (offset < buffer.length) { const count = readSync(fd, buffer, offset, buffer.length - offset, offset); if (!count) break; offset += count; }
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, offset));
      if (offset !== buffer.length || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text) || identity(fstatSync(fd, { bigint: true })) !== identity(stat)) throw new AppError('FILE_UNSUPPORTED', '변경 중인 파일이나 비텍스트 파일은 사용할 수 없습니다.');
      return { ...checked, fd, text, identity: identity(stat) };
    } catch (error) { if (fd !== undefined) closeSync(fd); if (error instanceof AppError) throw error; throw new AppError('FILE_UNAVAILABLE', '파일을 읽을 수 없습니다. 기존 UTF-8 텍스트 파일과 경로를 확인하세요.'); }
  }

  private read(args: unknown) {
    const input = fileReadSchema.safeParse(args);
    if (!input.success) throw new AppError('TOOL_INPUT_INVALID', '파일 읽기 입력을 확인하세요.');
    const file = this.open(input.data.path);
    try { return result({ path: file.path, text: file.text }); } finally { closeSync(file.fd); }
  }

  private async edit(runId: string, args: unknown) {
    const input = fileEditSchema.safeParse(args);
    if (!input.success) throw new AppError('TOOL_INPUT_INVALID', '파일 수정 입력은 UTF-8 8KiB 이내여야 합니다.');
    const file = this.open(input.data.path);
    let tool: FileApproval;
    try {
      if (file.text !== input.data.before) throw new AppError('FILE_CONFLICT', '파일 내용이 입력과 다릅니다. 다시 읽고 새 수정안을 만드세요.');
      if (file.text === input.data.after) throw new AppError('FILE_UNCHANGED', '수정 전후 내용이 같습니다.');
      tool = this.store.proposeFile(runId, file.path, file.text, input.data.after, file.identity);
    } finally { closeSync(file.fd); }
    const response = new Promise<unknown>((finish) => {
      const timer = setTimeout(() => {
        try { this.changed(this.store.finishFile(runId, tool.toolId, 'cancelled', 'PERMISSION_EXPIRED')); }
        catch { /* A storage fault must not grant permission or crash the daemon. */ }
        finally { this.settle(tool.toolId, result({ state: 'cancelled', code: 'PERMISSION_EXPIRED' }, true)); }
      }, 300_000);
      this.pending.set(tool.toolId, { runId, finish, timer });
    });
    this.changed(this.store.run(runId));
    return response;
  }

  respond(runId: string, toolId: string) {
    const pending = this.pending.get(toolId);
    if (!pending || pending.runId !== runId) return;
    const tool = this.store.run(runId).tools.find((item) => item.toolId === toolId)!;
    if (tool.state === 'rejected') { this.changed(this.store.run(runId)); this.settle(toolId, result({ state: 'rejected', message: '사용자가 거절했습니다. 수정하지 않았습니다. 이 수정을 재요청하거나 다른 도구로 실행하지 마세요.' }, true)); return; }
    const claim = this.store.claimFile(runId, toolId);
    if (!claim) return;
    let wrote = false;
    let fd: number | undefined;
    try {
      const file = this.open(claim.tool.path, true);
      fd = file.fd;
      if (file.text !== claim.tool.before || file.identity !== claim.identity) throw new AppError('FILE_CONFLICT', '승인 대기 중 파일이 변경되어 적용하지 않았습니다.');
      this.path(claim.tool.path);
      const bytes = Buffer.from(claim.tool.after, 'utf8');
      wrote = true;
      let offset = 0;
      while (offset < bytes.length) { const count = writeSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) throw new Error('Incomplete write'); offset += count; }
      ftruncateSync(fd, bytes.length);
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      this.changed(this.store.finishFile(runId, toolId, 'completed'));
      this.settle(toolId, result({ state: 'completed', path: tool.path, message: '승인한 내용을 파일에 적용했습니다.' }));
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      const code = wrote ? 'FILE_OUTCOME_UNKNOWN' : publicError(error).code;
      try { this.changed(this.store.finishFile(runId, toolId, wrote ? 'unknown' : 'failed', code)); }
      finally { this.settle(toolId, result({ state: wrote ? 'unknown' : 'failed', code, message: wrote ? '파일 적용 결과를 확인하지 못했습니다. 자동 재실행하지 마세요.' : publicError(error).message }, true)); }
    }
  }

  private settle(toolId: string, value: unknown) { const pending = this.pending.get(toolId); if (pending) { clearTimeout(pending.timer); this.pending.delete(toolId); pending.finish(value); } }
  cancel(runId: string) {
    for (const [id, pending] of this.pending) if (pending.runId === runId) {
      try { this.changed(this.store.finishFile(runId, id, 'cancelled', 'PERMISSION_CANCELLED')); }
      catch { /* Resolve the blocked tool even when recording cancellation failed. */ }
      finally { this.settle(id, result({ state: 'cancelled' }, true)); }
    }
  }
  async close() {
    this.stopping = true;
    this.tokens.clear();
    for (const item of [...this.pending.values()]) this.cancel(item.runId);
    if (this.listening) { await this.listening.catch(() => {}); const closed = new Promise<void>((done) => this.server.close(() => done())); for (const socket of this.sockets) socket.destroy(); await closed; }
  }
}
