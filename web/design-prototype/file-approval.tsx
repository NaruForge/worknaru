import type { ReactNode } from 'react';
import { Icon } from '../icons.js';
// Historical design sample only. The current product uses runtime tool permissions.
type FileApproval = { toolId: string; path: string; before: string; after: string; errorCode: string | null;
  state: 'pending' | 'approved' | 'rejected' | 'applying' | 'completed' | 'failed' | 'cancelled' | 'unknown' };

export const fileStateLabel = (tool: FileApproval) => ({ pending: '승인 대기', approved: '승인 접수', rejected: '거절됨 · 수정하지 않음', applying: '파일 적용 중', completed: '파일 수정 완료', failed: '적용하지 못함', cancelled: '취소됨 · 수정하지 않음', unknown: '파일 적용 결과 확인 필요' })[tool.state];

export function FilePreview({ tool }: { tool: FileApproval }) {
  return <div className="file-preview">
    <p className="file-path">{tool.path}</p>
    <div className="file-versions"><section><h3>수정 전</h3><pre>{tool.before || '(빈 파일)'}</pre></section><section><h3>수정 후</h3><pre>{tool.after || '(빈 파일)'}</pre></section></div>
  </div>;
}

export function FileToolHistory({ tools }: { tools: FileApproval[] }) {
  return <>{tools.map((tool) => <details className="file-history" key={tool.toolId}><summary>{fileStateLabel(tool)} · {tool.path}</summary><FilePreview tool={tool} />
    {tool.errorCode === 'FILE_CONFLICT' && <p>승인 대기 중 원본이 변경되어 덮어쓰지 않았습니다.</p>}
    {tool.state === 'unknown' && <p>파일의 실제 내용을 확인하세요. 이 요청은 자동 재실행하지 않습니다.</p>}
  </details>)}</>;
}

export function FileApprovalPanel({ tool, context, children, onToggle, open }: { tool: FileApproval; context?: string; children: ReactNode; onToggle?: (open: boolean) => void; open?: boolean }) {
  return <details className="file-approval" aria-label="파일 수정 승인" open={open} onToggle={event => onToggle?.(event.currentTarget.open)}><summary><Icon name="folder" /><span aria-live="polite">{tool.state === 'pending' ? '파일 수정 승인 대기' : fileStateLabel(tool)}{context && <span className="muted"> · {context}</span>}</span><span className="file-approval-hint">내용 확인</span></summary><div className="file-approval-body"><FilePreview tool={tool} />{children}</div></details>;
}
