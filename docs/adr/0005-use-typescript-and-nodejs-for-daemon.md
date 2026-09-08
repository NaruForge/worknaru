# 0005. Daemon에 TypeScript와 Node.js 채택

- 날짜: 2026-09-08
- Status: Accepted
- 관련 Work Item: [#3 WorkNaru 플랫폼 초기 아키텍처 설계](https://github.com/NaruForge/worknaru/issues/3)
- 관련 ADR: [0001. ACP 채택](0001-use-acp-for-agent-connections.md), [0002. Daemon과 클라이언트 구조](0002-use-daemon-core-with-web-and-desktop-clients.md), [0004. Windows 우선 지원](0004-target-windows-first.md)
- 관련 문서: [제품 방향](../../README.md), [프로젝트 기록 규약](../project-records.md)

## Context

WorkNaru는 웹·데스크톱 클라이언트가 공통 Daemon에 접속하고, Daemon이 ACP로 외부 AI 에이전트를 관리하는 구조를 채택했다. Windows를 초기 지원 환경으로 두며, 이번에는 Daemon을 구현할 언어와 런타임을 선택한다.

현재 Daemon의 주요 책임은 에이전트 프로세스 실행·종료, 입출력과 이벤트 전달, 승인 요청, 세션 및 상태 관리다. 모델 추론은 외부 에이전트가 담당하므로, 초기 선정에서는 계산 성능보다 연결·실행 흐름을 구현하고 유지보수하는 비용을 우선한다.

검토한 세 가지 후보 모두 ACP 공식 문서에 클라이언트와 에이전트 구현용 라이브러리가 안내되어 있다. ACP 지원 여부만으로 후보를 제외하지 않았다. [TypeScript SDK](https://agentclientprotocol.com/libraries/typescript), [Python SDK](https://agentclientprotocol.com/libraries/python), [Rust 라이브러리](https://agentclientprotocol.com/libraries/rust)

| 후보 | 장점 | 비용과 판단 |
| --- | --- | --- |
| TypeScript + Node.js | 비동기 통신과 외부 프로세스 입출력을 구성할 수 있다. UI도 TypeScript를 사용하면 요청·응답·이벤트 타입과 일부 코드를 공유하기 쉽다. Paseo의 구현을 참고할 수 있다. | 런타임 배포와 의존성 관리가 필요하고, 동기 처리나 무거운 연산이 이벤트 루프를 막지 않도록 설계해야 한다. 현재 Daemon의 역할과 유지보수 비용에 가장 적합하다고 판단했다. |
| Python + asyncio | 빠른 실험과 Python 문서·데이터 처리 라이브러리 활용에 유리하며 비동기 프로세스 관리가 가능하다. | 웹 UI와 언어가 달라 계약 공유 방법을 별도로 마련해야 한다. Windows 배포 시 Python 실행 환경과 의존성을 관리해야 한다. 데이터 처리가 Daemon의 중심 책임은 아니므로 우선 채택하지 않는다. |
| Rust + Tokio | 네이티브 실행 파일로 배포할 수 있고 자원 사용을 세밀하게 제어하기 좋다. 타입·소유권 검사로 일부 오류를 컴파일 단계에서 발견할 수 있다. | 숙련도가 비슷하다는 전제에서 초기 개발·학습과 비동기 공유 상태 구현의 부담이 더 크다고 평가했다. 현재 확인된 요구만으로 이 비용을 우선 감수할 근거는 부족하다. |

Node.js는 비동기 자식 프로세스 API를 제공하며, Paseo의 서버 패키지도 Node.js·TypeScript와 ACP SDK를 사용한다. 이는 구현 참고 근거이며 WorkNaru에서의 안정성·성능 검증을 대신하지 않는다. [Node.js 자식 프로세스](https://nodejs.org/api/child_process.html), [Paseo 서버 패키지](https://github.com/getpaseo/paseo/blob/main/packages/server/package.json)

## Decision

**WorkNaru Daemon은 TypeScript로 작성하고 Node.js에서 실행한다.**

이 선택을 바탕으로 ACP 연결, 프로세스 관리, 세션과 상태 관리, 클라이언트 접속 기능을 설계한다. 기존 ADR의 접속 구조, 실행 방식별 종료 정책과 Windows 우선 지원 범위는 유지한다.

### 승인 근거

2026-09-08 Daemon의 언어·런타임 후보 세 가지와 장단점을 비교한 뒤, 사용자가 다음과 같이 명시적으로 결정했다.

> TypeScript + Node.js로 확정합니다.

이 사용자 결정을 근거로 `Accepted`로 기록한다.

### 이번 결정에서 확정하지 않는 사항

- Node.js·TypeScript의 구체적인 버전, 빌드·실행 설정과 패키지 관리자
- 서버 프레임워크, UI–Daemon 통신 방식, 데이터 검증·저장 라이브러리
- Web UI 및 데스크톱 프레임워크와 해당 코드의 언어
- Module의 구현 언어와 실행 방식, 별도 작업 프로세스의 기술
- Windows에서의 런타임 배포·설치·업데이트 방법

## Consequences

- TypeScript 기반 ACP SDK와 Node.js의 프로세스·통신 API를 활용해 Daemon을 구현할 수 있다.
- 향후 UI도 TypeScript를 선택하면 공통 계약의 타입과 일부 코드를 공유할 수 있다. 이 이점은 UI 기술 선택에 따른 가능성이며, 정적 타입만으로 외부 입력이 검증되지는 않는다.
- Node.js 런타임과 의존성을 설치·업데이트 과정에서 어떻게 제공할지 정해야 한다.
- 메인 이벤트 루프를 오래 점유하는 연산과 동기 처리는 다른 요청과 이벤트를 지연시킬 수 있다. 무거운 작업은 필요에 따라 별도 작업 프로세스 등으로 분리한다. [Node.js 이벤트 루프](https://nodejs.org/learn/asynchronous-work/dont-block-the-event-loop)
- Windows에서 정상 취소, 앱·Daemon 종료, 비정상 종료 후 자식 프로세스 정리와 기록 복구를 검증해야 한다. 언어·런타임의 선택만으로 실행 수명 관리가 해결되지는 않는다.
- 실제 성능, 메모리 사용량과 프로바이더별 호환성은 미검증이다. 구현 시 대표 실행 흐름으로 확인한다.

이번 결정은 언어·런타임의 선택이다. 구현 완료나 전체 기술 스택 확정을 의미하지 않으며, 후속 작업의 범위와 진행은 관련 GitHub Issue와 전용 Project에서 관리한다.
