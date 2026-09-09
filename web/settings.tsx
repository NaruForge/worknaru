import type { ChatModel } from '../src/chat-model.js';
import { AppearanceSettings } from './appearance-settings.js';
import type { ColorPreference } from './appearance.js';
import { Button, Field, Select } from './ui.js';
import type { SettingsSection } from './settings-navigation.js';

export function Settings({ section, state, model, appearance, back }: { section: SettingsSection;
  state: ReturnType<ChatModel['getSnapshot']>; model: ChatModel; appearance: ColorPreference; back: () => void }) {
  const selection = state.settings?.defaults;
  const chosen = state.models.find(entry => entry.id === selection?.model);
  const disabled = !state.connected || !state.info?.connected || !state.info.storageAvailable || !state.settings || state.settingsBusy || state.modelsLoading || state.checking || !!state.refreshError;
  const supported = !!chosen?.efforts.some(effort => effort.id === selection?.effort);
  return <div className="main-panel" aria-label="플랫폼 설정">
    <header className="main-panel-heading"><h1 tabIndex={-1}>설정</h1><Button onClick={back}>Chat으로 돌아가기</Button></header>
    <div className="settings-content">
      {section === 'appearance' && <AppearanceSettings preference={appearance} />}
      {section === 'connection' && <section>
        <div className="settings-section-heading"><h2>연결 상태</h2><Button density="compact" disabled={state.modelsLoading} onClick={() => { void model.retry(); }}>연결 상태 확인</Button></div>
        <dl className="connection-facts"><dt>WorkNaru</dt><dd>{state.connected ? '연결됨' : '연결 끊김'}</dd>
          <dt>AI 실행 환경</dt><dd>{state.connected ? state.info?.connected ? '연결됨' : '연결 확인 필요' : '확인 불가'}</dd>
          <dt>Workspace</dt><dd>{state.info?.workspace ?? '확인 중'}</dd>
          <dt>기록 저장</dt><dd>{state.connected ? state.info?.storageAvailable ? '사용 가능' : '확인 필요' : '확인 불가'}</dd>
          <dt>Provider</dt><dd>Codex</dd>
          <dt>모델 조회</dt><dd>{!state.connected || !state.info?.connected ? '연결 확인 필요' : state.modelsLoading ? '확인 중' : state.catalogError ? '조회 실패' : `${state.models.length}개 모델 확인`}</dd>
          <dt>인증 상태</dt><dd>확인 불가</dd></dl>
        <p className="muted small">현재 연결은 인증 상태를 별도로 제공하지 않습니다. 연결되거나 모델 목록을 조회했다고 AI 실행이 가능한 것으로 판단하지 않습니다.</p>
        <p className="muted small">인증 오류가 발생하면 실행 환경의 Codex 로그인을 확인한 뒤 다시 조회하세요.</p>
      </section>}
      {section === 'ai' && <section>
        <div className="settings-section-heading"><h2>새 대화 기본값</h2><Button density="compact" disabled={state.modelsLoading || state.settingsBusy} onClick={() => { void model.retry(); }}>기본값 확인</Button></div>
        <p className="muted small">선택하면 바로 저장하며 이 데이터 영역의 새 대화에 적용합니다. 기존 대화의 모델과 추론 강도는 유지됩니다.</p>
        <div className="ai-controls">
          <Field label="기본 Model">{props => <Select {...props} value={selection?.model ?? ''} disabled={disabled} onChange={event => {
            const next = state.models.find(model => model.id === event.target.value);
            const effort = next?.efforts.find(effort => effort.id === selection?.effort)?.id ?? next?.efforts.find(effort => effort.id === 'low')?.id ?? next?.efforts[0]?.id;
            if (next && effort) void model.updateDefaults({ model: next.id, effort });
          }}>{!chosen && <option value={selection?.model ?? ''}>{selection?.model ?? '확인 중'}</option>}
            {state.models.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </Select>}</Field>
          <Field label="기본 Reasoning Effort">{props => <Select {...props} value={selection?.effort ?? ''} disabled={disabled || !chosen} onChange={event => {
            if (selection) void model.updateDefaults({ ...selection, effort: event.target.value });
          }}>{!supported && <option value={selection?.effort ?? ''}>{selection?.effort ?? '확인 중'}</option>}
            {chosen?.efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.label}</option>)}
          </Select>}</Field>
        </div>
        {!supported && !state.modelsLoading && state.settings && <p className="error-text small">저장된 기본값의 지원 여부를 확인하지 못했습니다. 목록을 다시 조회하거나 지원하는 값을 선택하세요.</p>}
        {state.settingsBusy && <p role="status">기본값을 저장하고 있습니다.</p>}
        {state.settingsError && <p role="alert" className="error-text small">{state.settingsError} 현재 저장값은 ‘기본값 확인’으로 조회할 수 있습니다.</p>}
        {state.settingsNotice && <p role="status" className="small">{state.settingsNotice}</p>}
      </section>}
      {(state.catalogError || state.refreshError) && section !== 'appearance' && <p role="alert" className="error-text small">{state.catalogError ?? state.refreshError}</p>}
    </div>
  </div>;
}
