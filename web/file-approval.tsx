import type { FileApproval } from '../src/file-approval.js';

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
