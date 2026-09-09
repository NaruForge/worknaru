# 0016. AI Agent 관리 기반으로 Paseo 채택

- 날짜: 2026-09-09
- Status: Accepted
- 관련 Work Item: [#34 Paseo 통합 분석과 채택](https://github.com/NaruForge/worknaru/issues/34), [#35 Migration 계획](https://github.com/NaruForge/worknaru/issues/35)
- 대체하는 ADR: [0001. ACP 직접 연결](0001-use-acp-for-agent-connections.md), [0002. Daemon 중심 코어](0002-use-daemon-core-with-web-and-desktop-clients.md)
- 유지하는 관련 결정: [0006. Module의 업무 책임](0006-define-modules-as-business-services.md), [0007. 업무 데이터와 AI Session 분리](0007-separate-business-data-from-ai-sessions.md), [0009. Module 공통 계약](0009-use-a-common-module-platform-contract.md)
- 근거: [제품 방향](../../README.md), [Paseo 채택 재검토](../research/2026-09-09-issue34-runtime-and-product-direction.md), [기록 규약](../project-records.md)

## Context

WorkNaru는 독립적인 업무 Module을 추가하는 AI Workspace다. 초기에는 ACP를 직접 연결하고 Paseo의 Agent 관리 구조를 참고했다. 구현이 진행되면서 Provider 연결·설정, 세션 재개, 프로세스 수명, 스트리밍·승인·오류 처리에 개발 부담이 집중됐다. 참고 구현의 기능과 수정 사항을 WorkNaru 방식으로 다시 만드는 비용도 계속 발생한다.

사용자는 Paseo를 실제 Agent 관리에 사용하고 있으며, 현재 WorkNaru 동작의 100% 재현보다 이 기반을 재사용해 업무 Module 개발에 집중하는 방향을 선택했다. 내부 Client API도 사용할 수 있는 통합 경로로 평가했다.

분석은 `@getpaseo/server`와 `@getpaseo/client`의 `0.8.0-beta.1` 배포물 및 고정 소스를 확인했다. Client의 `internal/daemon-client` 경로는 JavaScript·타입 선언과 함께 export되며 Paseo 자체 CLI도 사용한다. 취소·모델·추론 설정·승인·기록 제어에 접근할 수 있다. 다만 외부에 지원되는 안정 SDK라는 약속은 없으며, 이번 분석은 WorkNaru에 통합한 Windows 실행 검증을 대신하지 않는다.

| 대안 | 판단 |
| --- | --- |
| ACP 기반 Agent 관리를 계속 직접 구현 | 현재 코드와 연결되지만 Provider·실행·복구 관리 및 참고 구현의 변경 이식 비용을 계속 소유한다. |
| Paseo Server/Client를 재사용 | 사용 경험과 구현 근거가 있는 실행 기반을 활용하고 WorkNaru의 직접 책임을 줄일 수 있다. 패키지·내부 API 변경에 대한 통합 검증 비용을 수용한다. |
| 공개 Client root만 사용 | 지원 SDK 경계는 좁힐 수 있으나 분석 버전에서 필요한 제어 기능이 빠져 있다. 이 제한을 채택 조건으로 두지 않는다. |
| Paseo 앱·Plugin host를 제품 기반으로 사용 | 제품의 화면·확장 모델과 배포 소유권까지 달라진다. 독립적인 WorkNaru 업무 제품을 유지하려는 이번 선택의 범위가 아니다. |

## Decision

**WorkNaru의 AI Agent 관리 기반으로 Paseo Server/Client를 채택한다. WorkNaru는 업무 제품과 공통 Daemon을 유지하고 Agent의 내부 실행 관리를 Paseo에 위임한다.**

### 책임과 연결 경계

- **Paseo:** Provider 연결, Agent 생성·실행·취소·재개, native 세션·timeline·실행 상태와 Provider 권한 요청을 담당한다. WorkNaru가 이 기능의 별도 원본이나 동등한 Agent manager를 다시 만들지 않는다.
- **WorkNaru Daemon:** Workspace 접근과 제품 API, Module의 업무 처리, 업무 객체와 Agent의 연결, 필요한 업무 접수·검토 증거와 결과 보존을 담당한다. Paseo가 제공하는 요청 장부와 native 기록을 그대로 재사용할 수 있는 영역은 중복 구현하지 않는다.
- **WorkNaru 연결 코드:** 필요한 호출·이벤트·오류만 연결한다. `@getpaseo/client/internal/daemon-client` 사용을 허용하고 그 의존성을 이 코드 안에 모은다. 한 연결에서 필요한 경우 공개 `createPaseoApi`도 조합할 수 있다. Module과 UI에 내부 driver를 직접 전달하지 않는다.
- **Module:** 업무 화면·데이터·규칙, AI 제안의 반영 및 사람의 검토·확정을 소유한다. AI가 완료되거나 Session이 없어져도 보존해야 할 업무 결과는 Module의 책임으로 남는다.

검증한 server/client 버전을 exact version과 lockfile로 함께 관리한다. 분석에 사용한 beta 버전을 영구 지원 버전으로 확정하지는 않는다. 업데이트 때 WorkNaru가 사용하는 호출과 사용자 흐름을 검증하며 Paseo 소스 fork, 배포되지 않은 임의 내부 파일 접근, 범용 Client 재구현을 기본 해법으로 삼지 않는다.

### Daemon과 실행 수명

WorkNaru UI·업무 호출 클라이언트는 WorkNaru Daemon에 접속한다. WorkNaru Daemon은 UI 없이도 업무 기능을 제공하며, 자신이 관리하는 전용 Paseo 인스턴스와 연결한다. 전용 home·주소·자격증명과 실행 소유권을 구분하고 개인 Paseo나 다른 제품 인스턴스를 변경·종료하지 않는다. 별도 프로세스와 home은 운영 분리이며 보안 sandbox를 뜻하지 않는다.

기본 통합 후보는 전용 프로세스에서 Server의 배포된 진입점을 사용하는 방식이다. 설치·기동상 필요한 경우 Paseo의 공식 CLI·supervisor 재사용을 비교한다. WorkNaru 실행기는 자신이 시작한 runtime의 기동·연결·종료를 조립하며 Agent별 감독 로직을 가져오지 않는다.

ADR-0002의 공통 Daemon 접속과 수명 원칙은 다음과 같이 유지한다.

| 실행 방식 | 수명 소유자와 종료 동작 |
| --- | --- |
| 앱·개발 실행기가 시작한 전용 WorkNaru Daemon | 해당 실행기가 명시적 제품 종료 시 자신이 소유한 Daemon·Paseo·관리 Agent를 정리한다. 정리 결과가 불명확하면 성공으로 표시하지 않는다. |
| 사용자가 독립적으로 시작한 WorkNaru Daemon | 접속 클라이언트 종료 후에도 실행을 유지하고 별도 운영 명령으로 종료한다. 접속만 한 클라이언트는 수명을 소유하지 않는다. |

브라우저 탭 닫기·새로고침·접속 끊김은 실행 취소나 Daemon 종료가 아니다. 실행 종료는 저장 기록 삭제나 이미 수행한 파일·외부 작업의 원복을 뜻하지 않는다. Web·데스크톱 공통 접속 원칙은 유지하되 데스크톱 앱 구현 완료를 의미하지 않는다.

### 호환성과 권한

현재 WorkNaru의 기능·코드·API·화면·운영 명령을 이식 목록으로 고정하지 않는다. 사용자는 필요하면 바닥부터 다시 만드는 것도 허용했다. 작은 Paseo 기반 실행 흐름을 먼저 만들고, 기존 구현의 재사용과 필요한 부분의 전면 재구축 중 직접 관리할 책임이 적은 방식을 선택한다. 기존 기능이나 시험이 있다는 이유만으로 새 제품에 그 동작을 다시 넣지 않는다.

실제 필요한 사용자 흐름을 Paseo의 상태·설정·승인 의미에 맞게 구성한다. 선택한 기능의 계약이 바뀌면 사용처, 관련 동작 시험과 개발 안내를 함께 바꾼다. 제외한 기능의 시험은 새 구현의 필수 통과 조건으로 남기지 않는다. 세부 기능과 파일 배치의 선택은 Migration 계획 및 구현 근거로 관리하며 기존 구조를 보존하기 위한 범용 호환 계층을 만들지 않는다.

일반 Agent 도구 권한은 Paseo의 승인 흐름을 우선 재사용한다. Module의 업무 검토·확정은 별도로 유지한다. 기존 8KiB 파일 수정 도구의 전체 동등성을 전환 관문으로 삼지 않으며, 유지·재설계·제공 시점 변경을 Migration 계획에서 구분한다. 기능을 변경한다는 이유로 사용자 승인 없는 자동 허용이나 미확인 결과의 성공 처리를 도입하지 않는다.

ADR-0009의 같은 Session에서 한 번에 한 실행을 허용하고 추가 입력을 명시적으로 거절하는 초기 정책은 유지한다. Paseo의 기본 추가 입력 동작이 다르면 연결 경계에서 명시적으로 처리한다. 자동 interrupt·대기열 도입은 이 결정에 포함하지 않는다. WorkNaru의 업무 접수, Paseo의 실행 완료와 Module의 업무 확정은 서로 다른 사실이다.

사용자는 기존 대화 내역을 보존할 필요 없이 새롭게 시작해도 된다고 명시했다. 새 전용 데이터 영역에서 Paseo 기반으로 시작하며 기존 ACP 대화·파일 승인 내역의 이식·조회 호환성, native 맥락 이식과 legacy reader 유지는 범위에 넣지 않는다. 실제 Workspace 파일과 향후 Module 업무 데이터의 소유·보존 원칙은 대화 내역 폐기와 별개다. 이행은 실행 환경의 복귀 절차를 갖추고 사용하지 않는 독자 Agent 관리 코드와 의존성을 제거하는 데까지 이어진다. 두 완전한 runtime을 영구 유지하지 않는다.

### 승인 근거와 적용 범위

2026-09-09 사용자가 재검토 결과에 이어 다음과 같이 요청했다.

> Paseo를 관리 기반으로 채택하고, Migration을 위한 이슈를 생성합니다.
> 생성한 이슈에 Migration을 위한 계획서를 꼼꼼하게 작성합니다.

같은 요청에서 분석의 커밋·푸시·병합과 Issue 기록도 지시했다. 이 ADR은 사용자의 채택 결정을 기록하므로 `Accepted`다. 이번 작업은 분석·결정 기록과 Migration 계획 작성까지이며 패키지 설치, runtime 교체나 실제 데이터 변환을 수행했다는 뜻이 아니다.

계획 작성 중 사용자가 “기존 대화 내역 보존할 필요 없습니다. 새롭게 시작해도 됩니다.”라고 범위를 조정했다. 이를 반영해 과거 대화 보존과 데이터 호환 이식을 제외한다.

이어 “현재 기능을 모두 이식할 필요도 없습니다. 필요하다면 바닥부터 다시 만드는것도 허용합니다.”라고 명시했다. 기존 구현의 유지·부분 이식에 제한하지 않고 필요한 범위의 재구축을 허용하는 결정으로 반영한다. WorkNaru의 독립 업무 제품 및 Module 책임은 계속 설계 기준으로 사용한다.

ADR-0001의 ACP 직접 연결 및 Paseo 참고 한정 결정을 대체한다. ADR-0002는 공통 Daemon·수명 원칙을 위와 같이 이어받으면서 Daemon이 Agent 내부 실행을 직접 관리하던 책임 배치를 대체한다. 두 원문은 역사적 근거로 보존하고 이 ADR로 연결한다. Windows·Node·WebSocket·SQLite·React/Vite와 Module 책임에 관한 나머지 결정은 변경하지 않는다.

## Consequences

- Provider와 Agent 관리의 수정 사항을 별도로 다시 구현하는 부담을 줄이고 업무 Module에 개발을 집중할 수 있다. 줄어드는 유지보수량은 실제 이행 결과로 확인하며 비율을 약속하지 않는다.
- internal API의 변경 위험과 전용 runtime의 설치·연결·수명 검증은 WorkNaru가 소유한다. 버전 고정은 업데이트 시점을 통제하지만 변경 대응 비용을 없애지는 않는다.
- 새 기능 범위에 따라 Chat·설정·승인 화면, API·CLI·개발 실행기와 시험을 재사용·변경·제외하거나 다시 만들 수 있다. 현재 개발 안내의 ACP 동작은 Migration 구현 전까지 유효한 현재 동작이다.
- Paseo의 실행 기록과 WorkNaru 업무 저장 사이의 연결, 응답 유실·결과 불명과 새 데이터의 저장 실패를 다뤄야 한다. 과거 대화 reader·schema migration 부담은 제외한다. 전체 timeline과 Provider 실행 상태를 이중 원본으로 저장하는 설계를 피한다.
- 첫 연결은 실제 필요한 Provider와 Chat으로 작게 검증한다. 모든 Provider, 전체 Paseo 기능이나 첫 업무 Module 완성을 이행의 선행조건으로 만들지 않는다. 구체적인 단계·완료 조건·검증·복구 절차는 Migration Issue가 소유한다.
