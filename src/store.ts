import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { AppError, MAX_PAGE_BYTES, MAX_TEXT_BYTES } from './protocol.js';
import type { Mutation, Request } from './protocol.js';
import { validateDataFiles, workspacePath } from './paths.js';
import { INITIAL_AI_SELECTION } from './ai-settings.js';
import type { AiSelection } from './ai-settings.js';
import type { Run } from './public-contract.js';
export type { Run } from './public-contract.js';
import type { FileApproval } from './file-approval.js';

const APPLICATION_ID = 0x574e4152;
const PRINCIPAL = 'local-owner';
const MODULE = 'chat';

type Workspace = { workspaceId: string; path: string };
type Session = { sessionId: string; workspaceId: string; title: string; seq: number; createdAt: string; aiUnavailable: number; latestRunId: string | null; latestRunState: Run['state'] | null; storageAvailable: boolean; model: string | null; reasoningEffort: string | null };

const RUN_SELECT = `SELECT r.id AS runId, r.session_id AS sessionId, r.state, r.delivery, r.revision, m.text, r.error_code AS errorCode, r.stop_reason AS stopReason, r.created_at AS createdAt, r.ai_model AS model, r.ai_effort AS reasoningEffort, r.model_confirmed AS modelConfirmed FROM runs r JOIN messages m ON m.run_id = r.id AND m.role = 'assistant'`;
const SESSION_SELECT = `SELECT s.id AS sessionId, s.workspace_id AS workspaceId, s.title, s.seq, s.created_at AS createdAt,
  s.agent_unavailable AS aiUnavailable, r.id AS latestRunId, r.state AS latestRunState, s.ai_model AS model, s.ai_effort AS reasoningEffort
  FROM sessions s LEFT JOIN runs r ON r.id = (SELECT run_id FROM messages WHERE session_id = s.id AND role = 'assistant' ORDER BY seq DESC LIMIT 1)`;
export const isFinal = (run: Run) => ['completed', 'cancelled', 'failed'].includes(run.state);

type Message = { messageId: string; sessionId: string; seq: number; text: string; createdAt: string };

export class RecordStore {
  private owner?: DatabaseSync;
  private db!: DatabaseSync;
  private failed = false;
  private closed = false;
  readonly epoch: string;
  readonly workspace: Workspace;

  constructor(private readonly directory: string, workspaceDirectory: string, exclusiveWorkspace = false) {
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
        if (exclusiveWorkspace && this.db.prepare('SELECT 1 FROM workspaces WHERE path_key != ? LIMIT 1').get(workspace.key)) {
          throw new AppError('WORKSPACE_CONFLICT', '이 데이터 영역은 다른 Workspace에 연결되어 있습니다. CLI는 자동으로 바꾸지 않습니다.');
        }
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
    if ((version === 0 && (objects !== 0 || appId !== 0)) || (version !== 0 && (![1, 2, 3, 4].includes(version) || appId !== APPLICATION_ID))) {
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
    if (version < 3) {
      if (version === 2) this.db.prepare('VACUUM INTO ?').run(join(this.directory, `records-v2-${randomUUID()}.sqlite`));
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE ai_settings (id INTEGER PRIMARY KEY CHECK(id = 1), model TEXT NOT NULL, effort TEXT NOT NULL, probe_job TEXT, probe_session_id TEXT, probe_workspace TEXT) STRICT;
          ALTER TABLE sessions ADD COLUMN ai_model TEXT;
          ALTER TABLE sessions ADD COLUMN ai_effort TEXT;
          ALTER TABLE runs ADD COLUMN ai_model TEXT;
          ALTER TABLE runs ADD COLUMN ai_effort TEXT;
          ALTER TABLE runs ADD COLUMN model_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(model_confirmed IN (0,1));
          PRAGMA user_version = 3;
        `);
        this.db.prepare('INSERT INTO ai_settings (id, model, effort) VALUES (1, ?, ?)').run(INITIAL_AI_SELECTION.model, INITIAL_AI_SELECTION.reasoningEffort);
      });
    }
    if (version < 4) {
      if (version === 3) this.db.prepare('VACUUM INTO ?').run(join(this.directory, `records-v3-${randomUUID()}.sqlite`));
      this.transaction(() => this.db.exec(`
        CREATE TABLE file_approvals (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL REFERENCES runs(id),
          path TEXT NOT NULL, before_text TEXT NOT NULL, after_text TEXT NOT NULL, file_identity TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected','applying','completed','failed','cancelled','unknown')),
          error_code TEXT, created_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX file_approvals_run ON file_approvals(run_id, seq);
        PRAGMA user_version = 4;
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
    const session = this.db.prepare(SESSION_SELECT + ' WHERE s.id = ? AND s.workspace_id = ? AND s.principal = ? AND s.module = ?')
      .get(sessionId, this.workspace.workspaceId, PRINCIPAL, MODULE) as Session | undefined;
    if (!session) throw new AppError('NOT_FOUND', '접근 가능한 대상을 찾을 수 없습니다.');
    return { ...session, storageAvailable: !this.failed };
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

  handle(request: Request, validateSelection?: (selection: AiSelection) => void): unknown {
    if (this.closed) throw new AppError('STORE_UNAVAILABLE', '저장소가 닫혔습니다.');
    try {
      switch (request.method) {
        case 'ai.get': throw new AppError('AI_UNAVAILABLE', 'AI 연결을 활성화한 뒤 상태를 확인하세요.');
        case 'settings.get': return this.settings();
        case 'settings.update': return this.mutate(request, () => {
          if (!validateSelection) throw new AppError('AI_UNAVAILABLE', 'AI 모델 목록을 먼저 확인하세요.');
          validateSelection(request.params.selection);
          const { model, reasoningEffort } = request.params.selection;
          this.db.prepare('UPDATE ai_settings SET model = ?, effort = ? WHERE id = 1').run(model, reasoningEffort);
          return { accepted: true, requestId: request.requestId, settings: this.settings() };
        });
        case 'sessions.configure': {
          this.session(request.params.sessionId);
          return this.mutate(request, () => {
            const sessionId = request.params.sessionId;
            if (this.binding(sessionId).unavailable) throw new AppError('SESSION_UNAVAILABLE', '기록 보기 대화의 설정은 변경할 수 없습니다.');
            if (this.db.prepare("SELECT id FROM runs WHERE session_id = ? AND state IN ('running','cancelling')").get(sessionId))
              throw new AppError('SESSION_BUSY', '응답이 끝난 뒤 설정을 변경하세요.');
            if (!validateSelection) throw new AppError('AI_UNAVAILABLE', 'AI 모델 목록을 먼저 확인하세요.');
            validateSelection(request.params.selection);
            this.db.prepare('UPDATE sessions SET ai_model = ?, ai_effort = ? WHERE id = ?')
              .run(request.params.selection.model, request.params.selection.reasoningEffort, sessionId);
            return { accepted: true, requestId: request.requestId, session: this.session(sessionId) };
          });
        }
        case 'permissions.respond': {
          this.run(request.params.runId);
          return this.mutate(request, () => {
            const run = this.run(request.params.runId);
            const tool = run.tools.find((item) => item.toolId === request.params.toolId);
            if (!tool) throw new AppError('NOT_FOUND', '접근 가능한 승인 요청을 찾을 수 없습니다.');
            if (run.state !== 'running' || tool.state !== 'pending') throw new AppError('PERMISSION_RESOLVED', '이미 처리되거나 만료된 승인 요청입니다. 현재 상태를 확인하세요.');
            this.db.prepare('UPDATE file_approvals SET state = ? WHERE id = ?').run(request.params.decision === 'allow' ? 'approved' : 'rejected', tool.toolId);
            this.db.prepare('UPDATE runs SET revision = revision + 1 WHERE id = ?').run(run.runId);
            return { accepted: true, requestId: request.requestId, run: this.run(run.runId) };
          });
        }
        case 'runs.get':
        case 'runs.watch':
        case 'runs.unwatch': return this.run(request.params.runId);
        case 'runs.start': {
          this.session(request.params.sessionId);
          return this.mutate(request, () => {
            const sessionId = request.params.sessionId;
            const selection = this.selection(sessionId);
            if (this.binding(sessionId).unavailable) throw new AppError('SESSION_UNAVAILABLE', '이 대화의 AI 연결을 이어갈 수 없습니다. 기록을 확인하고 새 대화를 시작하세요.');
            if (this.db.prepare("SELECT id FROM runs WHERE session_id = ? AND state IN ('running','cancelling')").get(sessionId))
              throw new AppError('SESSION_BUSY', '이 대화에 끝나지 않은 실행이 있습니다.');
            const runId = randomUUID();
            const now = new Date().toISOString();
            this.db.prepare('INSERT INTO runs (id, session_id, state, created_at, ai_model, ai_effort) VALUES (?, ?, ?, ?, ?, ?)').run(runId, sessionId, 'running', now, selection.model, selection.reasoningEffort);
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
            const selection = this.settings().selection;
            this.db.prepare(`INSERT INTO sessions (id, workspace_id, principal, module, title, created_at, ai_model, ai_effort)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(sessionId, this.workspace.workspaceId, PRINCIPAL, MODULE, request.params.title, new Date().toISOString(), selection.model, selection.reasoningEffort);
            return { accepted: true, requestId: request.requestId, session: this.session(sessionId) };
          });
        }
        case 'sessions.get': return this.session(request.params.sessionId);
        case 'sessions.list': {
          this.checkWorkspace(request.params.workspaceId);
          const { after, limit, order } = request.params;
          const sessions = this.db.prepare(SESSION_SELECT + ` WHERE s.workspace_id = ? AND s.principal = ? AND s.module = ? AND ${order === 'desc' ? (after === 0 ? 's.seq > ?' : 's.seq < ?') : 's.seq > ?'} ORDER BY s.seq ${order === 'desc' ? 'DESC' : 'ASC'} LIMIT ?`)
            .all(this.workspace.workspaceId, PRINCIPAL, MODULE, after, limit + 1) as Omit<Session, 'storageAvailable'>[];
          return { sessions: sessions.slice(0, limit).map((session) => ({ ...session, storageAvailable: !this.failed })), nextAfter: sessions.length > limit ? sessions[limit - 1]!.seq : null };
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
    const tools = this.db.prepare('SELECT id AS toolId, path, before_text AS before, after_text AS after, state, error_code AS errorCode, created_at AS createdAt FROM file_approvals WHERE run_id = ? ORDER BY seq').all(runId) as FileApproval[];
    return { ...run, tools, storageAvailable: !this.failed && !this.closed };
  }

  proposeFile(runId: string, path: string, before: string, after: string, identity: string): FileApproval {
    return this.transaction(() => {
      const run = this.run(runId);
      if (run.state !== 'running') throw new AppError('RUN_INACTIVE', '실행이 종료되어 파일 수정을 요청할 수 없습니다.');
      if (run.tools.some((tool) => ['pending', 'approved', 'applying'].includes(tool.state))) throw new AppError('PERMISSION_PENDING', '먼저 대기 중인 파일 수정 요청을 처리하세요.');
      if (run.tools.length >= 4) throw new AppError('TOOL_LIMIT', '한 실행의 파일 수정 요청은 4회까지입니다.');
      const tool: FileApproval = { toolId: randomUUID(), path, before, after, state: 'pending', errorCode: null, createdAt: new Date().toISOString() };
      this.db.prepare('INSERT INTO file_approvals (id, run_id, path, before_text, after_text, file_identity, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(tool.toolId, runId, path, before, after, identity, tool.state, tool.createdAt);
      this.db.prepare('UPDATE runs SET revision = revision + 1 WHERE id = ?').run(runId);
      return tool;
    });
  }

  claimFile(runId: string, toolId: string): { tool: FileApproval; identity: string } | undefined {
    return this.transaction(() => {
      const run = this.run(runId);
      const tool = run.tools.find((item) => item.toolId === toolId);
      if (run.state !== 'running' || tool?.state !== 'approved') return;
      this.db.prepare("UPDATE file_approvals SET state = 'applying' WHERE id = ?").run(toolId);
      this.db.prepare('UPDATE runs SET revision = revision + 1 WHERE id = ?').run(runId);
      const identity = this.db.prepare('SELECT file_identity FROM file_approvals WHERE id = ?').get(toolId)!.file_identity as string;
      return { tool, identity };
    });
  }

  finishFile(runId: string, toolId: string, state: 'completed' | 'failed' | 'cancelled' | 'unknown', code: string | null = null) {
    return this.transaction(() => {
      this.run(runId);
      this.db.prepare("UPDATE file_approvals SET state = ?, error_code = ? WHERE id = ? AND run_id = ? AND state IN ('pending','approved','applying')").run(state, code, toolId, runId);
      this.db.prepare('UPDATE runs SET revision = revision + 1 WHERE id = ?').run(runId);
      return this.run(runId);
    });
  }

  recoverFiles() {
    this.transaction(() => {
      this.db.exec(`UPDATE runs SET revision = revision + 1 WHERE id IN (SELECT run_id FROM file_approvals WHERE state IN ('pending','approved','applying'));
        UPDATE file_approvals SET error_code = CASE WHEN state = 'applying' THEN 'FILE_OUTCOME_UNKNOWN' ELSE 'PERMISSION_INTERRUPTED' END,
          state = CASE WHEN state = 'applying' THEN 'unknown' ELSE 'cancelled' END WHERE state IN ('pending','approved','applying');`);
    });
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

  settings() {
    const selection = this.db.prepare('SELECT model, effort AS reasoningEffort FROM ai_settings WHERE id = 1').get() as AiSelection;
    return { selection, storageAvailable: !this.failed && !this.closed };
  }

  selection(sessionId: string): AiSelection {
    const session = this.session(sessionId);
    if (!session.model || !session.reasoningEffort) throw new AppError('AI_SETTINGS_REQUIRED', '이전 대화에서 사용할 모델과 추론 강도를 선택하세요.');
    return { model: session.model, reasoningEffort: session.reasoningEffort };
  }

  probeJob() { return this.db.prepare('SELECT probe_job AS job FROM ai_settings WHERE id = 1').get()!.job as string | null; }
  setProbeJob(job: string | null) { this.transaction(() => this.db.prepare('UPDATE ai_settings SET probe_job = ? WHERE id = 1').run(job)); }
  probeSession() {
    return this.db.prepare('SELECT probe_session_id AS sessionId FROM ai_settings WHERE id = 1 AND probe_workspace = ?').get(this.workspace.path)?.sessionId as string | null | undefined;
  }
  setProbeSession(sessionId: string | null) { this.transaction(() => this.db.prepare('UPDATE ai_settings SET probe_session_id = ?, probe_workspace = ? WHERE id = 1').run(sessionId, this.workspace.path)); }

  claimRun(runId: string): string | null {
    this.run(runId);
    return this.transaction(() => {
      const changed = this.db.prepare("UPDATE runs SET delivery = 'attempting', model_confirmed = 1, revision = revision + 1 WHERE id = ? AND delivery = 'not_attempted' AND state = 'running'").run(runId).changes;
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

  activeRunCount() {
    return Number(this.db.prepare("SELECT COUNT(*) AS count FROM runs WHERE state IN ('running','cancelling')").get()!.count);
  }

  pendingApprovalCount() {
    return Number(this.db.prepare("SELECT COUNT(*) AS count FROM file_approvals WHERE state = 'pending'").get()!.count);
  }

  recoverySessions() {
    // Inspect all workspaces: the same data directory can be reopened for a different one.
    return this.db.prepare('SELECT id AS sessionId, agent_job AS jobName FROM sessions WHERE agent_job IS NOT NULL').all() as { sessionId: string; jobName: string }[];
  }

  recoverSession(sessionId: string, confirmed: boolean) {
    this.transaction(() => {
      if (confirmed) this.db.prepare("UPDATE runs SET state = 'failed', error_code = CASE WHEN delivery = 'not_attempted' THEN 'INTERRUPTED_BEFORE_DELIVERY' ELSE 'EXECUTION_OUTCOME_UNKNOWN' END, revision = revision + 1 WHERE session_id = ? AND state IN ('running','cancelling')").run(sessionId);
      else this.db.prepare("UPDATE runs SET error_code = 'PROCESS_CLEANUP_UNKNOWN', revision = revision + 1 WHERE session_id = ? AND state IN ('running','cancelling')").run(sessionId);
      // Only a confirmed, completed conversation is eligible for lazy provider resume.
      // Interrupted/cancelled/failed Runs remain read-only; never replay their input.
      this.db.prepare(`UPDATE sessions SET agent_unavailable = CASE WHEN ? = 1 AND provider_session_id IS NOT NULL
        AND (SELECT r.state FROM runs r JOIN messages m ON m.run_id = r.id AND m.role = 'assistant'
          WHERE r.session_id = sessions.id ORDER BY m.seq DESC LIMIT 1) = 'completed'
        THEN 0 ELSE 1 END WHERE id = ?`).run(Number(confirmed), sessionId);
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
