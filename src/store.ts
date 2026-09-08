import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { AppError, MAX_PAGE_BYTES, MAX_TEXT_BYTES } from './protocol.js';
import type { Mutation, Request } from './protocol.js';
import { validateDataFiles, workspacePath } from './paths.js';

const APPLICATION_ID = 0x574e4152;
const PRINCIPAL = 'local-owner';
const MODULE = 'chat';

type Workspace = { workspaceId: string; path: string };
type Session = { sessionId: string; workspaceId: string; title: string; seq: number; createdAt: string };
export type Run = { runId: string; sessionId: string; state: 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed'; delivery: 'not_attempted' | 'attempting'; revision: number; text: string; errorCode: string | null; stopReason: string | null; createdAt: string; storageAvailable: boolean };

const RUN_SELECT = `SELECT r.id AS runId, r.session_id AS sessionId, r.state, r.delivery, r.revision, m.text, r.error_code AS errorCode, r.stop_reason AS stopReason, r.created_at AS createdAt FROM runs r JOIN messages m ON m.run_id = r.id AND m.role = 'assistant'`;
export const isFinal = (run: Run) => ['completed', 'cancelled', 'failed'].includes(run.state);

type Message = { messageId: string; sessionId: string; seq: number; text: string; createdAt: string };

export class RecordStore {
  private owner?: DatabaseSync;
  private db!: DatabaseSync;
  private failed = false;
  private closed = false;
  readonly epoch: string;
  readonly workspace: Workspace;

  constructor(private readonly directory: string, workspaceDirectory: string) {
    const workspace = workspacePath(workspaceDirectory);
    validateDataFiles(directory);
    try {
      // This connection holds an OS-backed SQLite lock for the daemon's lifetime.
      // Never delete/replace this file: doing so could create a second lock identity.
      this.owner = new DatabaseSync(join(directory, 'owner.sqlite'), { timeout: 0 });
      try {
        this.owner.exec('BEGIN EXCLUSIVE');
      } catch (error) {
        if ([5, 6].includes((error as { errcode?: number }).errcode ?? -1)) {
          throw new AppError('DATA_IN_USE', '같은 데이터 영역을 사용하는 데몬이 이미 있습니다.');
        }
        throw error;
      }
      this.db = new DatabaseSync(join(directory, 'records.sqlite'), { timeout: 0 });
      this.initialize();
      const meta = this.db.prepare('SELECT store_epoch FROM metadata WHERE id = 1').get();
      const epoch = z.uuid().safeParse(meta?.store_epoch);
      if (!epoch.success) throw new Error('Invalid metadata');
      this.epoch = epoch.data;
      this.workspace = this.transaction(() => {
        const found = this.db.prepare('SELECT id AS workspaceId, path FROM workspaces WHERE path_key = ?').get(workspace.key) as Workspace | undefined;
        if (found) return found;
        const created = { workspaceId: randomUUID(), path: workspace.path };
        this.db.prepare('INSERT INTO workspaces (id, path_key, path) VALUES (?, ?, ?)').run(created.workspaceId, workspace.key, created.path);
        return created;
      });
    } catch (error) {
      this.close();
      if (error instanceof AppError) throw error;
      throw new AppError('STORE_UNAVAILABLE', '저장소를 열 수 없습니다. 원본 데이터를 보존하고 원인을 확인하세요.');
    }
  }

  private initialize() {
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
    const appId = Number(this.db.prepare('PRAGMA application_id').get()!.application_id);
    const objects = Number(this.db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get()!.count);
    if ((version === 0 && (objects !== 0 || appId !== 0)) || (version !== 0 && (![1, 2].includes(version) || appId !== APPLICATION_ID))) {
      throw new AppError('UNSUPPORTED_STORE', '지원하지 않는 저장소 형식입니다. 원본을 변경하지 않습니다.');
    }
    if (this.db.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok') throw new Error('Integrity check failed');
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    if (version === 0) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK (id = 1), store_epoch TEXT NOT NULL) STRICT;
          CREATE TABLE workspaces (id TEXT PRIMARY KEY, path_key TEXT NOT NULL UNIQUE, path TEXT NOT NULL) STRICT;
          CREATE TABLE sessions (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id), principal TEXT NOT NULL,
            module TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL
          ) STRICT;
          CREATE INDEX sessions_scope ON sessions(workspace_id, principal, module, seq);
          CREATE TABLE messages (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
            session_id TEXT NOT NULL REFERENCES sessions(id), text TEXT NOT NULL,
            created_at TEXT NOT NULL
          ) STRICT;
          CREATE INDEX messages_session ON messages(session_id, seq);
          CREATE TABLE receipts (
            principal TEXT NOT NULL, module TEXT NOT NULL,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id), request_id TEXT NOT NULL,
            fingerprint TEXT NOT NULL, result_json TEXT NOT NULL,
            PRIMARY KEY (principal, module, workspace_id, request_id)
          ) STRICT;
          PRAGMA application_id = ${APPLICATION_ID};
          PRAGMA user_version = 1;
        `);
        this.db.prepare('INSERT INTO metadata VALUES (1, ?)').run(randomUUID());
      });
    }
    if (version < 2) {
      // VACUUM INTO creates a consistent, exclusive new backup, including WAL data.
      if (version === 1) this.db.prepare('VACUUM INTO ?').run(join(this.directory, `records-v1-${randomUUID()}.sqlite`));
      this.transaction(() => this.db.exec(`
        ALTER TABLE sessions ADD COLUMN provider_session_id TEXT;
        ALTER TABLE sessions ADD COLUMN agent_job TEXT;
        ALTER TABLE sessions ADD COLUMN agent_unavailable INTEGER NOT NULL DEFAULT 0 CHECK(agent_unavailable IN (0, 1));
        CREATE TABLE runs (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
          state TEXT NOT NULL CHECK(state IN ('running','cancelling','completed','cancelled','failed')),
          delivery TEXT NOT NULL DEFAULT 'not_attempted' CHECK(delivery IN ('not_attempted','attempting')),
          revision INTEGER NOT NULL DEFAULT 0, error_code TEXT, stop_reason TEXT, created_at TEXT NOT NULL
        ) STRICT;
        CREATE UNIQUE INDEX runs_active_session ON runs(session_id) WHERE state IN ('running','cancelling');
        CREATE INDEX runs_session ON runs(session_id);
        ALTER TABLE messages ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','assistant'));
        ALTER TABLE messages ADD COLUMN run_id TEXT REFERENCES runs(id);
        CREATE UNIQUE INDEX messages_run_role ON messages(run_id, role) WHERE run_id IS NOT NULL;
        PRAGMA user_version = 2;
      `));
    }
    if (this.db.prepare('PRAGMA foreign_key_check').all().length !== 0) throw new Error('Broken references');
  }

  private transaction<T>(action: () => T): T {
    if (this.closed || this.failed) throw new AppError('STORE_UNAVAILABLE', '저장 장애로 새 변경을 받을 수 없습니다.');
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      if (error instanceof AppError) throw error;
      this.failed = true;
      throw new AppError('STORE_UNAVAILABLE', '저장에 실패했습니다. 접수 여부를 다시 확인하세요.');
    }
  }

  private checkWorkspace(workspaceId: string) {
    if (workspaceId !== this.workspace.workspaceId) throw new AppError('NOT_FOUND', '접근 가능한 대상을 찾을 수 없습니다.');
  }

  private checkEpoch(epoch: string) {
    if (epoch !== this.epoch) throw new AppError('STORE_EPOCH_MISMATCH', '같은 접수 저장소인지 확인할 수 없습니다.');
  }

  private session(sessionId: string): Session {
    const session = this.db.prepare(`
      SELECT id AS sessionId, workspace_id AS workspaceId, title, seq, created_at AS createdAt, agent_unavailable AS aiUnavailable
      FROM sessions WHERE id = ? AND workspace_id = ? AND principal = ? AND module = ?
    `).get(sessionId, this.workspace.workspaceId, PRINCIPAL, MODULE) as Session | undefined;
    if (!session) throw new AppError('NOT_FOUND', '접근 가능한 대상을 찾을 수 없습니다.');
    return session;
  }

  private receipt(requestId: string) {
    return this.db.prepare(`SELECT fingerprint, result_json FROM receipts
      WHERE principal = ? AND module = ? AND workspace_id = ? AND request_id = ?
    `).get(PRINCIPAL, MODULE, this.workspace.workspaceId, requestId) as { fingerprint: string; result_json: string } | undefined;
  }

  private mutate(request: Mutation, action: () => unknown) {
    this.checkEpoch(request.storeEpoch);
    const fingerprint = JSON.stringify({ method: request.method, params: request.params });
    return this.transaction(() => {
      const previous = this.receipt(request.requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new AppError('REQUEST_ID_CONFLICT', '같은 요청 ID에 다른 내용을 사용할 수 없습니다.');
        return JSON.parse(previous.result_json) as unknown;
      }
      const result = action();
      this.db.prepare('INSERT INTO receipts VALUES (?, ?, ?, ?, ?, ?)').run(
        PRINCIPAL, MODULE, this.workspace.workspaceId, request.requestId, fingerprint, JSON.stringify(result),
      );
      return result;
    });
  }

  handle(request: Request): unknown {
    if (this.closed) throw new AppError('STORE_UNAVAILABLE', '저장소가 닫혔습니다.');
    try {
      switch (request.method) {
        case 'runs.get':
        case 'runs.watch':
        case 'runs.unwatch': return this.run(request.params.runId);
        case 'runs.start': {
          this.session(request.params.sessionId);
          return this.mutate(request, () => {
            const sessionId = request.params.sessionId;
            if (this.binding(sessionId).unavailable) throw new AppError('SESSION_UNAVAILABLE', '이 대화의 AI 연결을 이어갈 수 없습니다. 기록을 확인하고 새 대화를 시작하세요.');
            if (this.db.prepare("SELECT id FROM runs WHERE session_id = ? AND state IN ('running','cancelling')").get(sessionId))
              throw new AppError('SESSION_BUSY', '이 대화에 끝나지 않은 실행이 있습니다.');
            const runId = randomUUID();
            const now = new Date().toISOString();
            this.db.prepare('INSERT INTO runs (id, session_id, state, created_at) VALUES (?, ?, ?, ?)').run(runId, sessionId, 'running', now);
            const insert = this.db.prepare('INSERT INTO messages (id, session_id, text, created_at, role, run_id) VALUES (?, ?, ?, ?, ?, ?)');
            insert.run(randomUUID(), sessionId, request.params.text, now, 'user', runId);
            insert.run(randomUUID(), sessionId, '', now, 'assistant', runId);
            return { accepted: true, requestId: request.requestId, run: this.run(runId), aiExecution: true };
          });
        }
        case 'runs.cancel': {
          this.run(request.params.runId);
          return this.mutate(request, () => {
            this.db.prepare("UPDATE runs SET state = 'cancelling', revision = revision + 1 WHERE id = ? AND state = 'running'").run(request.params.runId);
            return { accepted: true, requestId: request.requestId, run: this.run(request.params.runId) };
          });
        }
        case 'workspaces.get': return this.workspace;
        case 'sessions.create': {
          this.checkWorkspace(request.params.workspaceId);
          return this.mutate(request, () => {
            const sessionId = randomUUID();
            this.db.prepare(`INSERT INTO sessions (id, workspace_id, principal, module, title, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
              .run(sessionId, this.workspace.workspaceId, PRINCIPAL, MODULE, request.params.title, new Date().toISOString());
            return { accepted: true, requestId: request.requestId, session: this.session(sessionId) };
          });
        }
        case 'sessions.get': return this.session(request.params.sessionId);
        case 'sessions.list': {
          this.checkWorkspace(request.params.workspaceId);
          const { after, limit } = request.params;
          const sessions = this.db.prepare(`SELECT id AS sessionId, workspace_id AS workspaceId, title, seq, created_at AS createdAt
            FROM sessions WHERE workspace_id = ? AND principal = ? AND module = ? AND seq > ? ORDER BY seq LIMIT ?`)
            .all(this.workspace.workspaceId, PRINCIPAL, MODULE, after, limit + 1) as Session[];
          return { sessions: sessions.slice(0, limit), nextAfter: sessions.length > limit ? sessions[limit - 1]!.seq : null };
        }
        case 'messages.append': {
          this.session(request.params.sessionId);
          return this.mutate(request, () => {
            const messageId = randomUUID();
            this.db.prepare('INSERT INTO messages (id, session_id, text, created_at) VALUES (?, ?, ?, ?)')
              .run(messageId, request.params.sessionId, request.params.text, new Date().toISOString());
            const message = this.db.prepare('SELECT id AS messageId, session_id AS sessionId, seq, text, role, run_id AS runId, created_at AS createdAt FROM messages WHERE id = ?')
              .get(messageId) as Message;
            return { accepted: true, requestId: request.requestId, message, aiExecution: false };
          });
        }
        case 'messages.list': {
          this.session(request.params.sessionId);
          const { sessionId, after, limit } = request.params;
          const upTo = request.params.upTo ?? Number(this.db.prepare('SELECT coalesce(max(seq), 0) AS seq FROM messages WHERE session_id = ?').get(sessionId)!.seq);
          const rows = this.db.prepare(`SELECT id AS messageId, session_id AS sessionId, seq, text, role, run_id AS runId, created_at AS createdAt
            FROM messages WHERE session_id = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?`)
            .all(sessionId, after, upTo, limit + 1) as Message[];
          const messages: Message[] = [];
          let bytes = 0;
          for (const row of rows.slice(0, limit)) {
            const size = Buffer.byteLength(JSON.stringify(row));
            if (bytes + size > MAX_PAGE_BYTES) break;
            bytes += size;
            messages.push(row);
          }
          return { messages, upTo, nextAfter: rows.length > messages.length ? messages.at(-1)!.seq : null };
        }
        case 'requests.get': {
          this.checkWorkspace(request.params.workspaceId);
          this.checkEpoch(request.params.storeEpoch);
          if (this.failed) throw new AppError('STORE_UNAVAILABLE', '저장 장애 중에는 접수 장부의 연속성을 확인할 수 없습니다.');
          const receipt = this.receipt(request.params.requestId);
          return receipt
            ? { storeEpoch: this.epoch, found: true, result: JSON.parse(receipt.result_json) as unknown }
            : { storeEpoch: this.epoch, found: false };
        }
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      this.failed = true;
      throw new AppError('STORE_UNAVAILABLE', '저장소를 읽을 수 없습니다. 접수 여부를 추정하지 마세요.');
    }
  }

  run(runId: string): Run {
    const run = this.db.prepare(RUN_SELECT + ' WHERE r.id = ?').get(runId) as Run | undefined;
    if (!run) throw new AppError('NOT_FOUND', '접근 가능한 실행을 찾을 수 없습니다.');
    this.session(run.sessionId);
    return { ...run, storageAvailable: !this.failed && !this.closed };
  }

  binding(sessionId: string) {
    this.session(sessionId);
    return this.db.prepare('SELECT provider_session_id AS providerSessionId, agent_job AS jobName, agent_unavailable AS unavailable FROM sessions WHERE id = ?')
      .get(sessionId) as { providerSessionId: string | null; jobName: string | null; unavailable: number };
  }

  setAgent(sessionId: string, jobName: string, providerSessionId: string | null = null) {
    this.session(sessionId);
    this.transaction(() => this.db.prepare('UPDATE sessions SET agent_job = ?, provider_session_id = ? WHERE id = ?').run(jobName, providerSessionId, sessionId));
  }

  disconnectAgent(sessionId: string) {
    this.session(sessionId);
    this.transaction(() => this.db.prepare('UPDATE sessions SET agent_unavailable = 1 WHERE id = ?').run(sessionId));
  }

  claimRun(runId: string): string | null {
    this.run(runId);
    return this.transaction(() => {
      const changed = this.db.prepare("UPDATE runs SET delivery = 'attempting', revision = revision + 1 WHERE id = ? AND delivery = 'not_attempted' AND state = 'running'").run(runId).changes;
      return changed ? String(this.db.prepare("SELECT text FROM messages WHERE run_id = ? AND role = 'user'").get(runId)!.text) : null;
    });
  }

  appendOutput(runId: string, text: string): Run {
    return this.transaction(() => {
      const run = this.run(runId);
      if (isFinal(run)) return run;
      if (!text.isWellFormed() || Buffer.byteLength(run.text + text) > MAX_TEXT_BYTES)
        throw new AppError('OUTPUT_LIMIT', '이번 실행의 텍스트 출력 한도를 초과했습니다. 저장된 부분은 보존됩니다.');
      this.db.prepare("UPDATE messages SET text = text || ? WHERE run_id = ? AND role = 'assistant'").run(text, runId);
      this.db.prepare('UPDATE runs SET revision = revision + 1 WHERE id = ?').run(runId);
      return this.run(runId);
    });
  }

  finishRun(runId: string, state: 'completed' | 'failed' | 'cancelled', errorCode: string | null = null, stopReason: string | null = null): Run {
    return this.transaction(() => {
      this.run(runId);
      this.db.prepare("UPDATE runs SET state = ?, error_code = ?, stop_reason = ?, revision = revision + 1 WHERE id = ? AND state IN ('running','cancelling')")
        .run(state, errorCode, stopReason, runId);
      return this.run(runId);
    });
  }

  recoverySessions() {
    // Inspect all workspaces: the same data directory can be reopened for a different one.
    return this.db.prepare('SELECT id AS sessionId, agent_job AS jobName FROM sessions WHERE agent_job IS NOT NULL').all() as { sessionId: string; jobName: string }[];
  }

  recoverSession(sessionId: string, confirmed: boolean) {
    this.transaction(() => {
      this.db.prepare('UPDATE sessions SET agent_unavailable = 1 WHERE id = ?').run(sessionId);
      if (confirmed) this.db.prepare("UPDATE runs SET state = 'failed', error_code = CASE WHEN delivery = 'not_attempted' THEN 'INTERRUPTED_BEFORE_DELIVERY' ELSE 'EXECUTION_OUTCOME_UNKNOWN' END, revision = revision + 1 WHERE session_id = ? AND state IN ('running','cancelling')").run(sessionId);
      else this.db.prepare("UPDATE runs SET error_code = 'PROCESS_CLEANUP_UNKNOWN', revision = revision + 1 WHERE session_id = ? AND state IN ('running','cancelling')").run(sessionId);
    });
  }

  blockRun(runId: string) {
    return this.transaction(() => {
      this.run(runId);
      this.db.prepare("UPDATE runs SET error_code = 'PROCESS_CLEANUP_UNKNOWN', revision = revision + 1 WHERE id = ? AND state IN ('running','cancelling')").run(runId);
      return this.run(runId);
    });
  }

  recoverUndelivered() {
    this.transaction(() => this.db.exec("UPDATE runs SET state = 'failed', error_code = 'INTERRUPTED_BEFORE_DELIVERY', revision = revision + 1 WHERE state IN ('running','cancelling') AND session_id IN (SELECT id FROM sessions WHERE agent_job IS NULL)"));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.db?.close(); }
    finally { this.owner?.close(); }
  }
}
