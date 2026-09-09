import { Field, Select } from '../ui.js';
import { Icon } from '../icons.js';
type AiSelection = { model: string; reasoningEffort: string };
type AiInfo = { models: { id: string; name: string; efforts: string[]; fallbackEffort: string }[] };

export function AiControls({ info, selection, disabled, change, defaults = false, compact = false }: {
  info?: AiInfo; selection?: { model: string | null; reasoningEffort: string | null }; disabled: boolean;
  change: (selection: AiSelection) => void; defaults?: boolean; compact?: boolean;
}) {
  const selected = info?.models.find((model) => model.id === selection?.model);
  const prefix = defaults ? '기본 ' : '';
  return <div className={`ai-controls${compact ? ' ai-controls--compact' : ''}`}>
    <Field labelHidden={compact} label={`${prefix}Model`}>{props => <Select {...props} compact={compact} leadingIcon={compact ? <Icon name="sparkles" /> : undefined} aria-label={`${prefix}Model`} value={selection?.model ?? ''} disabled={disabled || !info?.models.length} onChange={(event) => {
      const model = info!.models.find((entry) => entry.id === event.target.value)!;
      change({ model: model.id, reasoningEffort: selection?.reasoningEffort && model.efforts.includes(selection.reasoningEffort) ? selection.reasoningEffort : model.fallbackEffort });
    }}>
      {!selection?.model && <option value="">모델 선택</option>}
      {selection?.model && !selected && <option value={selection.model} disabled>{selection.model}{info ? ' · 목록에 없음' : ''}</option>}
      {info?.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
    </Select>}</Field>
    <Field labelHidden={compact} label={`${prefix}Reasoning Effort`}>{props => <Select {...props} compact={compact} leadingIcon={compact ? <Icon name="reasoning" /> : undefined} aria-label={`${prefix}Reasoning Effort`} value={selection?.reasoningEffort ?? ''} disabled={disabled || !selected} onChange={(event) => change({ model: selected!.id, reasoningEffort: event.target.value })}>
      {!selection?.reasoningEffort && <option value="">추론 강도 선택</option>}
      {selection?.reasoningEffort && !selected?.efforts.includes(selection.reasoningEffort) && <option value={selection.reasoningEffort} disabled>{selection.reasoningEffort}</option>}
      {selected?.efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
    </Select>}</Field>
  </div>;
}
