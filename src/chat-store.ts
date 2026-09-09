import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { assertUnlinkedFile } from './paths.js';
import { ChatError, type Selection } from './chat-contract.js';

export type ChatBinding = { id: string; title: string; createdAt: string; creation: { title: string; selection: Selection };
  agentId: string | null; pendingMessageId: string | null; pendingExecutionId: string | null; cancelRequested: boolean;
  configuring: Selection | null; responding: { id: string; decision: 'allow' | 'deny' } | null };

export class ChatStore {
  private db: DatabaseSync;
  constructor(directory: string) {
    for (const name of ['worknaru.sqlite', 'worknaru.sqlite-wal', 'worknaru.sqlite-shm', 'worknaru.sqlite-journal']) {
      const file = join(directory, name); if (existsSync(file)) assertUnlinkedFile(file);
    }
    this.db = new DatabaseSync(join(directory, 'worknaru.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, creation TEXT NOT NULL,
        agent_id TEXT UNIQUE, pending_message_id TEXT, pending_execution_id TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0, configuring TEXT, responding TEXT
      );`);
  }
  close() { this.db.close(); }
  list(): ChatBinding[] { return this.db.prepare('SELECT * FROM chats ORDER BY created_at DESC, id').all().map(row => this.decode(row)); }
  get(id: string): ChatBinding {
    const row = this.db.prepare('SELECT * FROM chats WHERE id=?').get(id);
    if (!row) throw new ChatError('CHAT_NOT_FOUND', '대화를 찾을 수 없습니다.');
    return this.decode(row);
  }
  byAgent(agentId: string) {
    const row = this.db.prepare('SELECT * FROM chats WHERE agent_id=?').get(agentId);
    return row ? this.decode(row) : null;
  }
  create(id: string, title: string, selection: Selection): ChatBinding {
    const creation = JSON.stringify({ title, selection });
    const previous = this.db.prepare('SELECT * FROM chats WHERE id=?').get(id);
    if (previous) {
      const decoded = this.decode(previous);
      if (decoded.creation.title !== title || decoded.creation.selection.model !== selection.model || decoded.creation.selection.effort !== selection.effort)
        throw new ChatError('CREATION_CONFLICT', '같은 대화 생성 ID에 다른 내용을 사용할 수 없습니다.');
      return decoded;
    }
    this.db.prepare('INSERT INTO chats(id,title,created_at,creation) VALUES(?,?,?,?)').run(id, title, new Date().toISOString(), creation);
    return this.get(id);
  }
  bind(id: string, agentId: string) {
    this.db.prepare('UPDATE chats SET agent_id=? WHERE id=? AND agent_id IS NULL').run(agentId, id);
    if (this.get(id).agentId !== agentId) throw new ChatError('BINDING_CONFLICT', '대화 연결이 변경됐습니다.');
  }
  pending(id: string, messageId: string) {
    const changed = this.db.prepare('UPDATE chats SET pending_message_id=?,pending_execution_id=NULL,cancel_requested=0 WHERE id=? AND pending_message_id IS NULL').run(messageId, id);
    if (changed.changes !== 1) throw new ChatError('CHAT_BUSY', '앞선 입력의 결과를 먼저 확인하세요.');
  }
  link(id: string, messageId: string, executionId: string) {
    this.db.prepare('UPDATE chats SET pending_execution_id=? WHERE id=? AND pending_message_id=?').run(executionId, id, messageId);
  }
  finish(id: string, messageId: string, executionId: string) {
    return this.db.prepare('UPDATE chats SET pending_message_id=NULL,pending_execution_id=NULL,cancel_requested=0,responding=NULL WHERE id=? AND pending_message_id=? AND pending_execution_id=?').run(id, messageId, executionId).changes === 1;
  }
  setCancel(id: string) { this.db.prepare('UPDATE chats SET cancel_requested=1 WHERE id=?').run(id); }
  setConfiguration(id: string, selection: Selection | null) { this.db.prepare('UPDATE chats SET configuring=? WHERE id=?').run(selection ? JSON.stringify(selection) : null, id); }
  setPermission(id: string, value: ChatBinding['responding']) { this.db.prepare('UPDATE chats SET responding=? WHERE id=?').run(value ? JSON.stringify(value) : null, id); }
  private decode(row: Record<string, unknown>): ChatBinding {
    return { id: row.id as string, title: row.title as string, createdAt: row.created_at as string,
      creation: JSON.parse(row.creation as string), agentId: row.agent_id as string | null,
      pendingMessageId: row.pending_message_id as string | null, pendingExecutionId: row.pending_execution_id as string | null,
      cancelRequested: row.cancel_requested === 1, configuring: row.configuring ? JSON.parse(row.configuring as string) : null,
      responding: row.responding ? JSON.parse(row.responding as string) : null };
  }
}
