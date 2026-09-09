# 0001. 외부 AI 에이전트 연결에 ACP 채택

- 날짜: 2026-09-08
- Status: Superseded
- 대체 결정: [0016. AI Agent 관리 기반으로 Paseo 채택](0016-use-paseo-for-agent-management.md) — 2026-09-09 사용자 결정으로 대체. 아래 내용은 당시 결정의 근거로 보존한다.
- 관련 Work Item: [#3 WorkNaru 플랫폼 초기 아키텍처 설계](https://github.com/NaruForge/worknaru/issues/3)
- 관련 문서: [제품 방향](../../README.md), [기존 플랫폼 조사](../research/2026-09-08-ai-workspace-platforms.md), [프로젝트 기록 규약](../project-records.md)

## Context

WorkNaru는 독립적인 업무 Module을 추가하고 조합하는 AI Workspace다. 여러 외부 AI 에이전트를 연결하면서 각 Module이 프로바이더별 통신 방식에 종속되지 않도록 공통 연결 기반이 필요하다.

사용자는 AI 연결 방식으로 ACP(Agent Client Protocol)를 선호하며, 초기 지원 우선순위를 Codex, GitHub Copilot, Grok 순으로 제시했다. 이 우선순위는 초기 계획의 지침이며, 모든 프로바이더를 첫 구현에서 동시에 지원해야 한다는 요구는 아니다. 세션 유지, 연결과 재연결, 에이전트 생성(spawn)을 주요 사용 경험으로 삼고 Paseo의 연결·실행 관리 구조를 참고한다.

결정 전 공식 문서 검토에서 확인한 사항은 다음과 같다. 실제 설치·실행 및 복구 동작의 검증 결과는 아니다.

- Paseo는 Codex에 공식 CLI의 App Server 인터페이스로 연결하며, 여러 다른 에이전트에는 공통 ACP 어댑터를 사용한다. Paseo 전체의 동작을 ACP만의 기능으로 간주할 수는 없다. [Paseo Codex](https://paseo.sh/docs/codex.md), [Providers](https://paseo.sh/docs/providers.md)
- `codex-acp`는 Codex App Server를 실행하고 ACP 요청과 Codex 이벤트 사이를 변환한다. 따라서 ACP 채택은 Codex 내부의 App Server 사용을 배제하는 결정이 아니다. [codex-acp](https://github.com/agentclientprotocol/codex-acp)
- GitHub Copilot CLI와 Grok Build CLI에는 ACP 연결 경로가 있다. 검토 당시 Copilot의 ACP 지원은 공개 프리뷰로 명시되어 있다. [Copilot ACP](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server), [Grok ACP](https://docs.x.ai/build/cli/headless-scripting)
- ACP는 프로토콜 버전과 지원 기능을 협상한다. 세션 불러오기 등 선택 기능의 지원 여부는 에이전트마다 확인해야 한다. [ACP 초기화](https://agentclientprotocol.com/protocol/v1/initialization), [세션 구성](https://agentclientprotocol.com/protocol/v1/session-setup)

검토한 주요 대안은 다음과 같다.

| 대안 | 장점 | 비용과 판단 |
| --- | --- | --- |
| ACP를 공통 연결 규약으로 사용 | 여러 에이전트의 기본 통신 흐름을 공유하고 프로바이더 확장에 활용할 수 있다. | 에이전트·어댑터별 기능 차이와 버전 호환성을 관리해야 한다. 현재 제품 방향에 가장 적합하다고 판단했다. |
| Codex는 App Server에 직접 연결하고 나머지는 ACP 사용 | Codex 고유 API와 이벤트에 직접 접근하고 ACP 변환 계층을 줄일 수 있다. | Codex 전용 연결 구현과 변경 대응을 별도로 유지해야 한다. 현재 요구에서 이 비용을 정당화할 필수 기능의 누락이나 측정된 안정성·성능 우위는 확인되지 않았다. |

App Server의 세밀한 제어 API는 직접 연결의 잠재적 장점이다. 다만 동일한 사용 경험이 ACP 어댑터를 통해 제공될 수 있으므로 API의 존재만으로 직접 연결이 필요하다고 판단하지 않는다. [OpenAI App Server](https://learn.chatgpt.com/docs/app-server)

## Decision

**WorkNaru의 외부 AI 에이전트 연결 규약으로 ACP를 채택한다.** 플랫폼은 ACP를 통해 에이전트와 통신하고, Module은 플랫폼이 제공하는 AI 실행 기능을 사용하도록 설계한다.

세션 생명주기, 에이전트 실행·종료, 연결 상태와 재연결·복구 정책, 플랫폼을 통한 다른 에이전트 생성과 관계 관리는 WorkNaru 플랫폼의 책임으로 둔다. 프로바이더가 소유하는 대화 저장·복구 기능과 에이전트 내부의 서브에이전트 실행은 해당 프로바이더의 기능에 맞춰 연결한다.

Paseo는 이 책임 분리와 사용자 경험의 참고 대상으로 삼는다. Paseo 자체나 그 기술 스택을 기반으로 채택하는 결정은 아니다.

Codex App Server 직접 연결은 초기 연결 방식에 포함하지 않는다. 향후 필수 기능이 ACP 경로에서 충족되지 않는다는 구체적인 근거가 생기면 별도의 변경안을 검토한다.

### 승인 근거

2026-09-08 설계 대화에서 사용자가 다음과 같이 명시적으로 결정했다.

> 좋습니다. 1차 결정은 ACP로 합니다. 동의하나요?

이후 사용자가 “ADR에 기록하세요.”라고 요청했다. 이 ADR은 이미 내려진 사용자 결정을 기록하므로 `Accepted`로 작성한다.

### 이번 결정에서 확정하지 않는 사항

- 사용할 ACP SDK·어댑터 패키지와 버전, 전송 방식 및 프로세스 배치
- 플랫폼 서버·데몬의 구체적인 구조, 데이터 저장 방식과 복구 알고리즘
- 각 프로바이더의 전체 기능 지원, 인증·권한 정책과 서브에이전트 확장 채택
- 별도의 모델 API 직접 연결 기능을 향후 제공할지 여부

## Consequences

### 장점

- 프로바이더마다 다른 기본 통신 방식을 플랫폼이 각각 구현하는 부담을 줄인다.
- Chat을 포함한 Module이 ACP 및 프로바이더별 메시지 형식을 직접 처리하지 않도록 책임을 나눌 수 있다.
- Codex를 먼저 검증하고 Copilot, Grok으로 확장할 때 공통 연결 기반을 재사용할 수 있다.

### 비용과 위험

- ACP 규약의 일관성이 에이전트 구현의 안정성이나 기능 동등성을 보장하지는 않는다. 지원 기능을 확인하고 차이를 사용자 경험에 반영해야 한다.
- Codex 연결에는 ACP 어댑터가 추가되므로 어댑터와 Codex의 호환성, 이벤트 변환 및 오류 전달을 검증해야 한다.
- 화면의 연결 복원, 에이전트 프로세스 재시작 후 저장된 대화 복구, 중단된 작업의 재실행은 서로 다른 동작이다. ACP 채택만으로 모두 자동 해결되지는 않는다.
- 여러 프로바이더에 걸친 spawn과 에이전트 자체의 내부 서브에이전트는 생명주기 소유자가 다르므로 구분해야 한다. [Paseo 오케스트레이션](https://paseo.sh/docs/orchestration.md)

### 후속 설계와 검증에 미치는 영향

플랫폼 설계에서는 연결 계층과 실행·세션 관리 계층의 책임을 구체화한다. 구현 검증에는 다음 시나리오를 포함한다.

- 세션 생성, 메시지 전송과 응답 스트리밍, 승인 요청과 취소
- 화면 연결이 끊긴 동안의 실행 유지와 재연결 후 상태·기록 복원
- 에이전트 프로세스 종료 후 세션 복구 가능 범위와 실패 처리
- 플랫폼을 통한 에이전트 생성, 부모·자식 관계 및 후속 입력 관리
- 프로바이더별 선택 기능과 어댑터 버전 차이 처리

이 목록은 설계·검증 요구이며 구현 완료를 의미하지 않는다. 작업의 범위와 진행은 관련 GitHub Issue와 전용 Project에서 관리한다.
