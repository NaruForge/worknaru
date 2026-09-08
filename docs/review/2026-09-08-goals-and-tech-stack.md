# WorkNaru 목표 및 기술 스택 검토

- 검토일: 2026-09-08
- 검토 기준 커밋: [`c4c9daf9eeae0fbeba01dd460c8322c53d10306a`][baseline]
- 작성 근거: 사용자와 ChatGPT의 프로젝트 목표·기술 스택 검토 대화 및 저장소 문서 재확인
- 성격: 자문 검토 기록. 새로운 아키텍처 결정이나 구현 승인 문서가 아니다.
- 검토 범위: 제품 정의, ADR, Module 연결 계약, 통신 및 저장·복구 설계의 정합성
- 검증 한계: 제품 실행, 성능 측정, 장애 주입, Windows 프로세스 정리 및 프로바이더 통합시험은 수행하지 않았다.

사용자는 이 검토를 `docs/review/`에 보존·게시하는 것을 승인했다. 이는 아래 권고 각각의 채택, 후속 Issue 생성, 기존 ADR 변경 또는 제품 구현·배포를 승인한 것으로 해석하지 않는다. 결정과 작업의 원본은 [프로젝트 기록 규약][records]을 따른다.

## 1. 결론

**현재 WorkNaru의 목표와 핵심 기술 선택은 서로 잘 맞는다. ACP, TypeScript/Node.js, WebSocket, SQLite를 교체해야 할 근거는 이번 검토에서 확인되지 않았다.** 새로운 기술 비교를 확대하기보다, 이미 선택한 구조로 작은 실행 경로를 구현하고 장애·복구 및 비대화형 업무 사례를 검증하는 편을 권고한다.

목표 대비 가장 중요한 미검증 영역은 **공통 AI 연결을 넘어 실제 업무 Module의 실행·저장·편집 규칙을 수용할 수 있는가**이다. Chat의 성공만으로 보고서 작성이나 문서 검토 같은 업무 서비스의 확장성이 입증되는 것은 아니다.

검토 기준 커밋에는 제품·운영·설계 문서가 있으며, 애플리케이션 코드, 제품 의존성 명세와 실행 테스트는 없다. 따라서 이 문서의 평가는 설계 적합성에 관한 판단이지, 구현 품질이나 성능·안정성에 대한 검증 결과가 아니다. [기준 저장소][baseline-tree]

또한 [초기 아키텍처 설계 #3][issue-3]은 제품 코드 구현을 비목표로 두었고, 2026-09-08 완료 검토에서 미결정 사항의 후속 처리 범위가 합의됐다. 코드가 없거나 합의된 후속 설계가 남아 있다는 이유로 해당 설계 작업을 미완료로 재분류하지 않는다.

## 2. 프로젝트 목표의 해석

### 2.1 중심은 대화가 아니라 업무와 결과물이다

[README][readme]에서 WorkNaru는 다양한 AI 기반 업무 기능을 독립적인 Module로 추가하고 조합하는 Workspace로 정의된다. 플랫폼은 특정 업무나 문서 처리에 종속되지 않고, Module이 함께 사용하는 AI 연결·실행·권한·기록 등의 기반을 제공한다.

이 정의를 다음과 같이 해석한다.

> 서로 다른 업무 서비스를 하나의 작업 환경에서 사용하되, 공통 실행 기반은 공유하고 각 업무의 화면·데이터·규칙은 독립적인 Module이 소유하는 플랫폼.

보고서 Module의 핵심 객체는 대화방이 아니라 보고서이며, 문서 정형화 Module의 핵심 객체는 AI 답변이 아니라 검토 중인 문서와 검토 상태다. 업무 데이터와 AI Session을 별도로 식별하고 필요에 따라 연결하도록 한 경계는 이 목표에 적합하다. [제품 정의][readme], [업무 데이터와 Session 분리 결정][adr-0007]

**평가:** 이 분리는 현재 설계에서 가장 중요한 강점이다. AI 없이 업무 데이터를 편집·저장하거나, 같은 결과물에 대해 다른 Session으로 추가 검토를 수행할 여지를 남긴다. 모든 업무 상태를 대화 기록에 종속시키는 구조를 피할 수 있다.

### 2.2 Chat은 첫 Module이자 공통 기반의 첫 검증 사례다

Chat은 첫 기본 제공 Module이며, 다른 Module은 Chat을 거치지 않고 플랫폼의 AI 기능을 이용한다. Chat으로 먼저 확인할 대상은 대화 화면뿐 아니라 Session·Run 관리, 승인, 취소, 상태 전달과 재접속이다. [제품 정의][readme], [Module 연결 계약][module-contract]

**평가:** 첫 사례로 Chat을 선택한 것은 적절하다. 다만 Chat에는 복잡한 업무 데이터, AI 결과의 선택적 적용, 수동 편집과의 버전 충돌이 충분히 드러나지 않는다. Chat 다음에는 작은 비대화형 Module로 책임 경계를 검증할 필요가 있다.

### 2.3 확장성은 책임 분리로 먼저 확보한다

현재 Module의 독립성은 업무 책임의 독립성을 뜻하며, 별도 서버·프로세스·저장소·설치 패키지를 요구하지 않는다. 첫 검증은 기본 제공 Chat의 명시적 등록에 한정하고, 외부 Plugin 설치와 실행 격리는 보류한다. [제품 정의][readme], [Module 연결 계약][module-contract]

**권고:** 업무 영역의 확장 가능성은 열어두되, 초기 실행 방식과 신뢰 모델은 좁게 유지한다. 처음부터 모든 언어·외부 코드·동적 설치를 지원하는 범용 Plugin 런타임을 만들 필요는 없다.

## 3. 선택된 기술의 적합성

다음은 기준 커밋의 선택을 제품 목표에 비추어 평가한 시점 기록이다. ADR 상태나 향후 진행 상황을 관리하는 별도의 목록이 아니다.

| 영역 | 검토 시점의 선택 | 평가와 핵심 조건 |
| --- | --- | --- |
| 초기 환경 | Windows 우선 | 적절하다. 설치·경로·프로세스 동작을 먼저 집중 검증한다. [근거][adr-0004] |
| 작업 공간 | 폴더 기반 Workspace, Project 계층 보류 | 적절하다. 실제 파일 작업과 연결하면서 초기 개념을 줄인다. 폴더 자체를 보안 경계로 취급하지 않는다. [근거][adr-0003] |
| 실행 구조 | 독립 실행 가능한 Daemon과 공통 Web UI·데스크톱 접속 | 목표에 부합한다. 다중 클라이언트 상태, 실행 소유권과 종료 정책의 구현 비용은 남는다. [근거][adr-0002] |
| Daemon | TypeScript + Node.js | 유지 권고. 현재의 연결·프로세스 입출력·상태 관리 책임에 적합하다. [근거][adr-0005] |
| AI 연결 | ACP | 유지 권고. 공통 연결과 Module의 프로바이더 비종속성에 적합하나 구현별 기능 차이를 검증해야 한다. [근거][adr-0001] |
| UI–Daemon 통신 | WebSocket | 적절하다. 신뢰성·재접속·중복 방지는 별도 플랫폼 계약으로 구현해야 한다. [근거][adr-0011] |
| 플랫폼 기록 | SQLite | 현재 단일 로컬 Daemon과 트랜잭션 기반 기록 요구에 특히 적합하다. [근거][adr-0012] |
| Module 경계 | 공통 플랫폼 계약, 업무 데이터와 AI Session 분리 | 핵심적으로 좋은 선택이다. 업무 코드의 실행·저장 경계는 후속 검증이 필요하다. [근거][module-contract] |

**아직 확정되지 않은 기술을 채택 스택으로 평가해서는 안 된다.** React·Vue, Electron·Tauri, 서버 프레임워크, SQLite 드라이버와 구체적인 런타임 버전은 현재 결정 범위에 포함되지 않는다. HTTP JSON+SSE는 채택안이 아니라 검토 후 기각된 대안이다. 상세 설계의 메시지 필드·저장 배치·운영값도 기술 선택 승인과 구분해야 한다. [Daemon 결정 범위][adr-0005], [통신 결정 범위][adr-0011], [저장 결정 범위][adr-0012]

### 3.1 TypeScript + Node.js

Daemon의 주된 책임은 모델 추론이나 문서 파싱 자체가 아니라 외부 에이전트의 실행·입출력, 클라이언트 통신과 상태 관리다. 계산 성능보다 연결과 실행 흐름의 구현·유지보수 비용을 우선한 판단에 동의한다. [ADR-0005][adr-0005]

다만 **Daemon을 Node.js로 구현한다는 결정과 모든 Module의 무거운 처리를 메인 이벤트 루프에서 수행한다는 결정은 다르다.** 긴 동기 연산이나 큰 JSON 처리가 이벤트 루프를 점유하면 다른 요청과 이벤트 처리가 지연될 수 있다. [Node.js 공식 지침][node-event-loop]

**권고:** Daemon은 실행 조정과 상태 관리에 집중하고, 무거운 문서 변환·내보내기 등은 필요에 따라 worker 또는 별도 프로세스로 분리한다. 구체적인 분리 방식은 실제 처리 특성과 측정 결과에 따라 정한다. 이 경계를 유지하는 한, 현재 요구만으로 Daemon을 Rust나 Python으로 교체할 이유는 약하다.

UI도 TypeScript를 선택하면 타입 공유의 이점이 있을 수 있지만, UI 기술은 아직 미정이다. 또한 정적 타입 공유는 네트워크 입력의 런타임 검증을 대신하지 않는다. [ADR-0005][adr-0005], [통신 설계][protocol]

### 3.2 ACP

외부 에이전트의 기능을 활용하면서 여러 프로바이더를 공통 방식으로 연결하려는 목표에 부합한다. Module에 ACP 메시지를 직접 노출하지 않고 Daemon이 플랫폼 모델로 변환하도록 한 경계도 적절하다. [ADR-0001][adr-0001], [통신 설계][protocol]

ACP의 공통 규약과 실제 기능 동등성은 구분해야 한다. 공식 규약의 초기화 과정은 버전과 지원 기능을 협상하며, Session 불러오기나 추가 입력 형식 등에는 선택 기능이 있다. 따라서 ACP 연결이 된다는 사실만으로 모든 에이전트가 동일한 Session 복구·입력 기능을 제공한다고 볼 수 없다. [ACP 초기화 규약][acp-initialization]

ADR-0001이 기록한 Codex 연결 경로에는 ACP 어댑터가 포함된다. 검증 대상은 단순한 프로토콜 접속 성공이 아니라 어댑터·에이전트·지원 기능의 조합이다. [ADR-0001][adr-0001]

**권고:** 첫 지원 조합의 버전을 고정해 Session 생성, 스트리밍, 승인, 취소, 연결 단절과 복구를 통합시험한다. 필수 기능이 ACP 경로에서 충족되지 않는 구체적인 근거가 나오기 전까지 Codex App Server 직접 연결을 병행하지 않는다. 이는 기존 ADR의 재검토 조건과 일치한다.

### 3.3 WebSocket

여러 Module의 명령·응답·구독을 공통 연결에서 다루는 구조에 적합하다. 선택 근거는 WorkNaru의 접속·상태 공유 요구이며, 다른 제품이 사용한다는 사실만으로 우월성을 주장하지 않는다. [ADR-0011][adr-0011]

현재 설계는 송수신을 연결하는 `callId`와 재전송 후에도 유지하는 `requestId`를 구분하고, 명령 접수와 실행 완료를 분리한다. 재연결 때는 Daemon 상태와 접수 기록을 확인하며, 연결 복원을 명령 자동 재실행으로 처리하지 않는다. [통신 설계][protocol]

**평가:** WebSocket을 신뢰성·중복 방지·업무 완료의 보장으로 오해하지 않고, 그 위의 플랫폼 계약을 따로 정의했다는 점이 좋다.

**권고:** SSE로 되돌아가기보다 Chat에 필요한 최소 명령·알림과 스냅샷 기반 복원을 구현한다. 느린 소비자의 버퍼 제한과 연결 단절 시험은 포함하되, 첫 구현을 임의 업무용 범용 RPC·이벤트 저장 플랫폼으로 확대하지 않는다. 저장소도 네트워크 이벤트 전체의 영속 재생을 첫 범위로 요구하지 않는다. [ADR-0011][adr-0011], [저장·복구 설계][storage]

### 3.4 SQLite

현재 요구는 단일 로컬 Daemon이 관련 기록을 소유하고, 요청 접수·중복 방지·Run 생성·상태 변경을 일관되게 저장하는 것이다. 별도 DB 서버를 추가하지 않고 트랜잭션과 제약을 이용할 수 있다는 선택 근거가 명확하다. [ADR-0012][adr-0012], [저장·복구 설계][storage]

**여러 UI가 같은 Daemon에 접속하는 것과 여러 독립 서버가 같은 DB에 직접 쓰는 것은 다르다.** UI 수가 늘어난다는 이유만으로 PostgreSQL이나 클라우드 저장소가 필요한 것은 아니다. 중앙 공동 데이터, 독립 기기 간 동기화 또는 다른 쓰기·운영 요구가 실제로 생길 때 재검토하는 편이 타당하다. [저장 대안 비교][storage]

상세 구현에서는 다음 경계를 유지해야 한다.

- **내구성과 응답성:** 초안의 `WAL + synchronous=FULL`, 최대 100ms 또는 UTF-8 32KiB 단위 출력 저장은 조정할 제안값이다. FULL은 WAL 커밋마다 추가 동기화를 수행하므로, 실제 Windows 저장장치에서 커밋 지연과 UI·취소 응답성을 측정한다. 내구성을 낮추기 전에 쓰기 묶음과 DB 호출의 실행 위치부터 확인하는 편을 권고한다. [저장 초안][storage], [SQLite 동기화 설정][sqlite-synchronous]
- **기록 복원과 실행 복구:** 저장된 대화를 보여주는 것, 프로바이더의 다음 입력 맥락을 복구하는 것, 중단된 Run을 재개하는 것은 별개다. 결과가 불명확한 외부 작업을 자동 재전송하지 않는 정책을 유지한다. [저장·복구 설계][storage]
- **저장 위치와 사용자 기대:** Workspace 밖의 사용자 데이터 영역에 DB를 두는 배치는 합리적인 제안이지만, 폴더 복사만으로 대화가 이동하지 않는 UX가 된다. 실제 경로, 백업·내보내기·복원 정책은 해당 배치와 함께 구체화해야 한다. SQLite 승인만으로 이 정책들까지 확정된 것은 아니다. [ADR-0012][adr-0012]

또한 DB 트랜잭션과 접수 장부만으로 외부 에이전트의 파일 수정·서비스 호출까지 정확히 한 번 수행됨을 보장할 수는 없다. DB 저장과 외부 실행 사이의 불확실성을 숨기지 않는 것이 중요하다. 이 한계는 기존 저장 설계에 이미 반영돼 있다. [저장·복구 설계][storage]

## 4. 중요한 미검증 영역과 권고

아래 사항은 미구현 코드에서 발견한 결함 목록이 아니다. 문서에 명시된 후속 설계 또는 제품 목표에 비추어 필요한 검증에 대한 자문이다.

### 4.1 Module의 업무 실행·저장 계약

현재 계약은 Module이 AI 실행을 요청하고 상태·결과를 받는 경로를 비교적 구체적으로 설명한다. 반면 업무 코드의 실행 위치, 데이터 저장 인터페이스와 편집 버전 충돌은 후속 설계 대상이다. 보고서·문서 정형화 사례도 문서상 검토이며 기존 TypeScript·Python 코드의 전체 이식 가능성을 입증하지 않는다. [Module 연결 계약][module-contract]

**평가:** 목표 대비 가장 중요한 미검증 경계다. 업무 서비스 플랫폼이 AI 호출 UI의 집합에 머무르지 않으려면 다음 질문에 답할 수 있어야 한다.

| 질문 | 확인할 내용 |
| --- | --- |
| 업무 명령은 어디서 실행하는가? | 보고서 생성·저장·내보내기 등의 명령을 받는 주체와 실행 위치 |
| Module의 데이터 책임은 어떻게 구현하는가? | 업무 데이터의 저장 인터페이스, 형식 변경·마이그레이션과 수명 관리 |
| AI 실행 중 업무 데이터가 바뀌면 어떻게 하는가? | 요청 당시 버전 식별, 현재 버전과의 비교, 수정안의 적용·거절 규칙 |

**권고안:** 신뢰된 기본 제공 Module의 업무 서비스는 우선 Daemon 내부에 명시적으로 등록하고, 무거운 처리만 별도 실행 단위로 분리하는 구성을 검토한다. 이는 기존 확정 결정이 아니라 후속 설계에 대한 제안이다. Module마다 별도 서버를 만들거나 외부 Plugin 런타임부터 구축할 필요는 없다.

핵심 평가 기준은 물리적인 프로세스·DB 분리 여부가 아니라, 새로운 업무 명령과 저장 책임을 추가할 때 플랫폼 내부 구현과 기존 Module을 얼마나 적게 수정하는가이다. 전체 업무 저장 체계를 Chat 전에 완성하라는 뜻은 아니며, 실제 업무 Module을 도입할 때 필요한 최소 계약부터 검증한다.

### 4.2 AI 결과가 업무 규칙을 우회하지 않는가?

제품 정의는 도구 실행 권한 승인과 보고서 수정안 적용·문서 확정 같은 업무 승인을 구분한다. 이 경계는 유지해야 한다. [제품 정의][readme]

**위험 해석:** 에이전트가 Module 관리 원본을 직접 수정할 수 있다면, Module이 관리하는 버전·검토 상태·변경 이력을 우회할 가능성이 있다. 실제로 그런 결함이 있다는 주장이나 모든 파일 직접 수정을 금지하자는 뜻은 아니다.

Module 관리 업무 데이터에는 기본적으로 다음 흐름을 권고한다.

```text
AI 제안 생성
  → Module의 형식·버전 검증
  → 필요한 사용자 업무 승인
  → Module의 저장·이력 반영
```

파일 직접 수정이 필요한 업무라면 해당 변경을 Module의 검토·버전 규칙과 어떻게 연결할지 별도로 정한다. 플랫폼의 도구 권한 승인에서 허용을 선택했다는 이유만으로 업무상 검토까지 완료됐다고 처리해서는 안 된다.

### 4.3 Windows 실행 소유권과 프로세스 정리

앱이 시작한 전용 Daemon은 앱의 명시적 종료 시 정리하고, 독립 실행 Daemon은 클라이언트를 닫아도 유지한다는 정책은 합리적이다. 반면 브라우저 탭 닫기나 일시적인 연결 단절을 실행 종료로 취급하지 않아야 한다. [ADR-0002][adr-0002]

**권고:** 단순 프로세스 생성·종료 호출보다 소유권 확인, 하위 프로세스 정리와 실제 종료 결과 확인을 집중 검증한다. PID만으로 종료 대상을 결정하지 않는 기존 복구 설계도 유지한다. [저장·복구 설계][storage]

Windows Job Object는 연관 프로세스를 묶어 관리하고, `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 설정 시 마지막 Job 핸들의 종료와 프로세스 종료를 연결하는 기능을 제공하므로 검증 후보가 될 수 있다. WorkNaru와 실제 에이전트의 프로세스 구조에서 적용 가능한지는 별도 시험이 필요하며, 이 문서가 해당 기술을 채택하는 것은 아니다. [Microsoft Job Objects][windows-job-objects]

### 4.4 로컬 접속 인증과 접근 검증

로컬 Daemon이라는 사실만으로 모든 접속을 신뢰하거나, Module ID·Workspace ID·Session ID를 아는 것을 권한으로 취급해서는 안 된다. 현재 통신 설계도 인증된 호출자, 서버가 인정한 호출 범위와 대상 접근을 검증하도록 한다. [통신 설계][protocol]

**평가:** 보안이 누락됐다기보다, 인증 요구가 첫 구현에서 실행 가능한 명세와 시험으로 구체화돼야 하는 상태다. 초기 Module은 제품에 포함된 신뢰 코드이며, 같은 프로세스 안에서 기능 객체를 전달하는 것은 외부 코드에 대한 보안 격리가 아니다. [통신 설계][protocol], [Module 연결 계약][module-contract]

접속 인증·접근 검증, 실제 데이터 경로와 DB 단일 소유권은 #3의 완료 검토에서 첫 Daemon 구현 단계로 배분됐다. 이를 해당 단계에서 먼저 다루되, 완료된 #3을 이 검토 때문에 다시 열 필요는 없다. [#3의 합의된 후속 범위][issue-3]

## 5. 후속 검증의 권장 순서

다음은 자문상의 순서와 검증 예시다. 승인된 작업 목록이나 진행 상태 원본이 아니며, 실제 추진 항목은 별도 승인과 기존 기록 규약에 따라 관리한다.

| 순서 | 권장 범위 | 확인하려는 결과 |
| --- | --- | --- |
| 1 | 첫 Daemon의 메시지 저장·재시작 후 조회 | 인증·접근 검증, 실제 데이터 경로, DB 단일 소유권과 SQL·런타임 스키마를 최소 범위로 구체화하고 기록을 일관되게 복원한다. |
| 2 | Codex 한 조합의 실제 AI 연결과 Chat 전체 경로 | ACP 어댑터와 Windows 실행 소유권을 검증하고, Workspace·Session 생성부터 스트리밍·승인·취소·저장까지 연결한다. |
| 3 | 해당 경로의 장애 시나리오 | 응답 유실, 새로고침, 동시 승인, Daemon 강제 종료와 저장 실패에서 중복 실행 및 잘못된 완료 표시를 방지한다. 장애시험을 초기 구현부터 포함하고 이 단계에서 집중 검증한다. |
| 4 | 작은 비대화형 Module | AI 없이 편집·저장하고, AI 제안을 선택 적용하며, Session과 독립적으로 업무 데이터를 유지할 수 있는지 검증한다. |

1·2번은 #3에서 합의한 단계 구분을 존중한 제안이다. 외부 Module 설치, 원격 접속과 Module 간 Session 공유는 기존 보류 범위를 유지한다. [#3][issue-3]

4번에서 완성된 보고서 생성기 전체를 이식할 필요는 없다. 본문을 편집·저장하고 AI 수정안을 적용하는 작은 Module이면 실행·저장·버전 경계의 부족한 부분을 드러낼 수 있다. 요청 당시 버전의 결과가 최신 편집 내용을 자동으로 덮어쓰지 않는지, Session을 닫은 뒤에도 업무 데이터가 유지되는지를 확인한다. [기존 검증 사례][module-contract]

**최종 권고는 현재 핵심 스택 유지다.** 이후 판단의 중심은 기술 이름이 아니라, 새 업무 Module을 추가할 때 코어 변경을 얼마나 줄이는지와 장애 후 실제 작업 상태를 얼마나 근거에 맞게 복원하는지에 둔다.

## 6. 기록의 해석과 후속 연결

이 파일은 기준 커밋에 대한 검토를 보존한다. 이후 설계 변경을 반영해 과거 평가를 최신 상태처럼 덮어쓰지 않고, 필요하면 새로운 검토 문서에서 이전 기록을 연결한다. 오기나 잘못된 사실은 정정할 수 있다.

검토에서 채택할 제안이 생기면 원하는 결과·범위·완료 조건을 Issue에 기록하고 이 문서를 근거로 연결한다. 실제로 중요한 설계 선택을 제안·결정할 때만 ADR을 사용한다. 이 문서에 Issue의 진행 상태나 ADR 상태를 복제하지 않는다. [프로젝트 기록 규약][records]

## 근거 자료

저장소 문서 링크는 검토 기준 커밋에 고정했다. Issue #3은 변경 가능한 링크이므로, 본문의 완료·합의 관련 언급은 2026-09-08 열람 시점을 기준으로 한다. 외부 공식 자료는 같은 날짜에 확인했으며, 기술의 일반적인 동작 근거이지 WorkNaru의 실행 검증 결과가 아니다.

[baseline]: https://github.com/NaruForge/worknaru/commit/c4c9daf9eeae0fbeba01dd460c8322c53d10306a
[baseline-tree]: https://github.com/NaruForge/worknaru/tree/c4c9daf9eeae0fbeba01dd460c8322c53d10306a
[readme]: https://github.com/NaruForge/worknaru/blob/c4c9daf9eeae0fbeba01dd460c8322c53d10306a/README.md
[records]: https://github.com/NaruForge/worknaru/blob/c4c9daf9eeae0fbeba01dd460c8322c53d10306a/docs/project-records.md
[issue-3]: https://github.com/NaruForge/worknaru/issues/3
[adr-0001]: https://github.com/NaruForge/worknaru/blob/c4c9daf9eeae0fbeba01dd460c8322c53d10306a/docs/adr/0001-use-acp-for-agent-connections.md
[adr-0002]: https://github.com/NaruForge/worknaru/blob/c4c9daf9eeae0fbeba01dd460c8322c53d10306a/docs/adr/0002-use-daemon-core-with-web-and-desktop-clients.md
[adr-0003]: https://github.com/NaruForge/worknaru/blob/c4c9daf9eeae0fbeba01dd460c8322c53d10306a/docs/adr/0003-use-folder-based-workspaces.md
[adr-0004]: https://github.com/NaruForge/worknaru/blob/c4c9daf9eeae0fbeba01dd460c8322c53d10306a/docs/adr/0004-target-windows-first.md
[adr-0005]: https://github.com/NaruForge/worknaru/blob/c4c9daf9eeae0fbeba01dd460c8322c53d10306a/docs/adr/0005-use-typescript-and-nodejs-for-daemon.md
[adr-0007]: https://github.com/NaruForge/worknaru/blob/c4c9daf9eeae0fbeba01dd460c8322c53d10306a/docs/adr/0007-separate-business-data-from-ai-sessions.md
[adr-0011]: https://github.com/NaruForge/worknaru/blob/c4c9daf9eeae0fbeba01dd460c8322c53d10306a/docs/adr/0011-use-websocket-for-client-daemon-communication.md
[adr-0012]: https://github.com/NaruForge/worknaru/blob/c4c9daf9eeae0fbeba01dd460c8322c53d10306a/docs/adr/0012-use-sqlite-for-local-platform-records.md
[module-contract]: https://github.com/NaruForge/worknaru/blob/c4c9daf9eeae0fbeba01dd460c8322c53d10306a/docs/design/module-platform-contract.md
[protocol]: https://github.com/NaruForge/worknaru/blob/c4c9daf9eeae0fbeba01dd460c8322c53d10306a/docs/design/client-daemon-protocol.md
[storage]: https://github.com/NaruForge/worknaru/blob/c4c9daf9eeae0fbeba01dd460c8322c53d10306a/docs/design/chat-storage-and-recovery.md
[acp-initialization]: https://agentclientprotocol.com/protocol/v1/initialization
[node-event-loop]: https://nodejs.org/learn/asynchronous-work/dont-block-the-event-loop
[sqlite-synchronous]: https://www.sqlite.org/pragma.html#pragma_synchronous
[windows-job-objects]: https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
