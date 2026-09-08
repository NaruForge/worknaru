# 0011. 클라이언트–Daemon 통신에 WebSocket 채택

- 날짜: 2026-09-08
- Status: Accepted
- 관련 Work Item: [#3 WorkNaru 플랫폼 초기 아키텍처 설계](https://github.com/NaruForge/worknaru/issues/3)
- 관련 ADR: [0002. 공통 Daemon 접속](0002-use-daemon-core-with-web-and-desktop-clients.md), [0005. TypeScript와 Node.js](0005-use-typescript-and-nodejs-for-daemon.md), [0009. Module 공통 계약](0009-use-a-common-module-platform-contract.md)
- 검토한 대안: [0010. HTTP JSON과 SSE 제안](0010-use-http-json-and-sse-for-client-daemon-communication.md)
- 관련 설계: [화면과 Daemon의 통신 설계](../design/client-daemon-protocol.md)
- 관련 문서: [제품 정의](../../README.md), [프로젝트 기록 규약](../project-records.md)

## Context

WorkNaru는 웹·데스크톱이 공통 Daemon에 접속하며, Chat을 포함한 Module이 플랫폼의 Session·실행·승인·취소 기능을 사용한다. 전송 방식으로 HTTP JSON 요청과 SSE 알림을 먼저 제안했으나, 사용자는 비전문가도 이해할 수 있는 설명과 Paseo 기술과의 비교, 두 방식 중 하나의 추천을 요청했다.

Paseo의 공식 문서와 공개 코드에서 주요 명령·알림의 WebSocket 연결, 요청과 응답의 번호 연결, 재접속 및 대화 기록 보충 처리를 확인했다. 이 코드는 참고할 실제 구현이며, WorkNaru에서의 성능·안정성 검증이나 코드 재사용 결정을 뜻하지 않는다.

- [Paseo 웹 접속 문서](https://paseo.sh/docs/web-ui.md): WebSocket과 HTTP의 공존 및 웹 접속 구조.
- [요청·응답 규칙](https://github.com/getpaseo/paseo/blob/229f3cd5a8bfb5caacda457cc918bd910cad8da2/docs/rpc-namespacing.md): 명령과 응답을 요청 번호로 연결하는 규칙.
- [WebSocket 전송 코드](https://github.com/getpaseo/paseo/blob/229f3cd5a8bfb5caacda457cc918bd910cad8da2/packages/client/src/daemon-client-websocket-transport.ts): 공통 전송 기능의 구현 사례.
- [대화 상태 처리 코드](https://github.com/getpaseo/paseo/blob/229f3cd5a8bfb5caacda457cc918bd910cad8da2/packages/app/src/timeline/session-stream-reducers.ts): 순서·기록 구간·누락 보충 처리. WebSocket만으로 상태 복원이 해결되지 않음을 보여준다.

| 대안 | 장점 | 비용과 판단 |
| --- | --- | --- |
| HTTP JSON 요청 + SSE 알림 | 명령별 접수·실패를 HTTP 응답으로 처리하고 서버 알림을 구분하기 좋다. | 별도의 요청·알림 도착을 맞추고, 초안의 fetch 기반 SSE 파싱·재접속도 구현해야 한다. 전체 구현이 더 간단하다는 근거는 충분하지 않아 선택하지 않는다. |
| WebSocket 요청·응답·알림 | 공통 클라이언트의 한 연결에서 여러 Module의 명령과 구독을 처리한다. Paseo의 실제 구현을 비교하며 설계할 수 있다. | 요청·응답 연결, 버전·오류·구독·재접속을 직접 규정해야 한다. 현재 프로젝트의 공통 Daemon 구조와 참고 구현 활용에 적합해 채택한다. |

두 방식 모두 기본 Chat 경험을 구현할 수 있다. 선택 근거는 통신 경로를 모으는 구조와 참고 구현의 활용이며, WebSocket이 언제나 더 빠르거나 더 안정적이라는 판단이 아니다.

## Decision

**클라이언트–Daemon의 공통 조회·명령·응답·실시간 알림은 WebSocket으로 주고받고, Chat에 필요한 최소 기능부터 구현한다.**

1. 웹과 데스크톱은 같은 플랫폼 클라이언트와 전송 계약을 사용한다. 한 클라이언트의 같은 Daemon 연결에서 여러 논리 구독을 구분한다. Module마다 별도 소켓을 만들지 않는다.
2. 요청·응답은 호출 번호로 연결하고, 지속적인 알림은 구독 번호로 구분한다. 명령 접수와 실제 AI 실행 완료는 별도로 확인한다.
3. 중복 실행 방지, Daemon 상태를 기준으로 한 화면 복원, 공통 권한 승인과 취소·완료 구분이라는 기존 설계 원칙을 유지한다. 이 동작을 WebSocket 자체의 보장으로 가정하지 않는다.
4. 첫 구현은 Chat의 Session 생성·조회, 입력·응답, 승인·취소·실패 표시와 재접속에 집중한다. Paseo의 원격 중계·전체 기능·프로토콜 패키지 채택은 포함하지 않는다. Daemon–에이전트의 ACP 연결과 기존 종료 정책도 유지한다.

웹페이지 제공, 초기 접속이나 향후 파일 전송에 HTTP를 사용할 수 있다. 이번 결정은 모든 통신을 WebSocket으로 강제하는 것이 아니라 공통 플랫폼 제어와 상태 전달의 전송 방식을 정한 것이다.

### 승인 근거와 범위

2026-09-08 “둘 중 하나를 선택한다면 무엇을 선택해야하나요?”라는 사용자 질문에 WebSocket을 추천하고, “WebSocket으로 연결하고, Chat에 필요한 최소 명령과 알림부터 구현한다”는 방향과 중복 실행 방지·재접속 복원 원칙의 유지를 설명했다. 사용자는 다음과 같이 승인했다.

> 승인합니다.

이 승인을 근거로 `Accepted`로 기록한다. 승인 대상은 WebSocket 선택과 최소 Chat 범위의 설계 방향이다. 통신 문서의 예시 필드·시간 한도·저장 정책 전체, 특정 라이브러리, 제품 코드 구현·배포까지 포괄 승인한 것으로 취급하지 않는다. HTTP JSON·SSE 제안은 ADR-0010에 검토 결과를 남기며, 이전에 승인된 ADR을 대체하지 않는다.

## Consequences

- 여러 Module이 공통 연결과 요청·구독 처리를 공유할 수 있다. 단일 연결 안에서도 범위·권한·데이터 소유권을 구분해야 한다.
- 연결이 끊기면 그 연결의 여러 구독이 함께 영향을 받는다. 재접속, 재구독과 상태 복원, 느린 소비자에 대한 버퍼 제한이 필요하다.
- WebSocket의 메시지 전달과 별개로 요청 번호·접수 기록·영속 저장을 관리해야 한다. 연결 복원을 명령 자동 재실행으로 처리하지 않는다.
- Paseo의 구현 패턴을 참고할 수 있으나 제품 개념·메시지 형식·부가 기능을 그대로 복제할 필요는 없다. 코드나 패키지를 재사용할 경우 별도의 적합성·라이선스·호환성 검토가 필요하다.
- [통신 설계](../design/client-daemon-protocol.md)의 메시지 예시는 구현 전 상세화 대상이다. 인증 초기 연결, 저장·복구 방식, 전체 런타임 스키마와 큰 출력 처리, 라이브러리·프레임워크는 후속 설계에서 정한다.
