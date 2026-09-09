# WorkNaru의 제품 방향과 Paseo 런타임 채택 재검토

이 문서는 채택 결정에 사용한 분석 근거다. 이후 사용자의 채택 요청은 [ADR-0016](../adr/0016-use-paseo-for-agent-management.md)에 기록한다. 아래의 권고·미실행 설명은 분석 당시의 범위를 보존하며, 실제 Migration 계획과 구현 완료를 대신하지 않는다.

후속 계획 작성 중 사용자는 기존 대화 내역을 보존하지 않고 새롭게 시작하도록 범위를 조정했다. 아래의 과거 기록 보존은 분석 당시 고려한 선택지이며 실제 [Migration #35](https://github.com/NaruForge/worknaru/issues/35)의 요구가 아니다. 첫 이행은 새 데이터로 시작하고 과거 ACP 기록·맥락 이식을 제외한다.

사용자는 현재 기능을 모두 이식할 필요가 없고 필요하면 바닥부터 다시 만드는 것도 허용했다. 아래의 기존 코드·기능 재사용 후보는 의무 이식 목록이 아니다. 실제 계획은 제품 방향에 필요한 최소 흐름을 기준으로 재사용·재구축·제외를 선택한다.

**WorkNaru의 AI Agent 관리 기반으로 Paseo server/client를 채택하는 방향을 권고한다. 필요한 제어는 배포 패키지에 노출된 내부 DaemonClient까지 사용하고, 그 의존성을 WorkNaru의 작은 연결 계층에 한정한다. 현재 WorkNaru 동작의 100% 재현은 채택 조건으로 두지 않는다.**

판단의 중심은 이미 만들어 둔 기능의 형태를 보존하는 데 있지 않다. 실제 개발 부담이 집중된 Agent 관리 책임을, 사용 경험과 구현 근거가 있는 Paseo에 넘겨 업무 Module 개발에 집중할 수 있는지가 핵심이다. 제품 데이터와 업무 규칙을 WorkNaru가 소유한다는 기존 방향은 이 선택과 양립한다. [제품 정의][w-readme]

## 1. 결정의 전제

이번 검토는 다음 세 전제를 사용한다.

- 현재 WorkNaru의 모든 기능과 세부 동작을 그대로 재현할 필요는 없다. 필요한 기능을 선별하고 Paseo의 동작에 맞게 단순화하거나 재설계할 수 있다.
- Paseo의 Agent 생명주기 관리는 실제 사용 중인 기반이다. 현재 작업도 Paseo를 통해 관리하고 있다는 실사용 경험을 채택 판단의 근거로 포함한다.
- 내부 Client API 사용을 처음부터 배제하지 않는다. 배포 방식, 실제 사용처와 변경 대응 범위를 확인해 유지보수 선택으로 평가한다.

실사용 경험은 Paseo 자체의 Agent 관리가 유용하다는 강한 근거다. WorkNaru에 포함한 전용 인스턴스의 설치·기동까지 이미 검증했다는 뜻은 아니지만, Agent Runtime 전체를 처음부터 신뢰할 수 있는지 입증해야 하는 출발점과는 다르다.

기존 Issue #34의 내부 API 금지와 동작 보존 항목은 변경 불가능한 제품 정체성이 아니라 제안된 설계 조건이다. 현재 제시된 의도에 맞춰 이 조건을 다시 평가한다. 이 문서는 재검토 권고이며, GitHub Issue의 수정이나 Accepted ADR 변경을 대신하지 않는다. [Issue #34][issue34] [기록 규약][w-records]

## 2. 참고 구현을 계속 재작성하는 비용

WorkNaru는 이미 Paseo의 구조를 참고해 Agent 연결과 생명주기를 설계해 왔다. 현재 코드에는 Provider 설정과 탐색, 프로세스 실행·종료, 세션 재개, stream 저장, 설정 적용, 승인 연결과 오류 처리가 들어 있다. 이들은 하나의 기능을 구현한 뒤 끝나는 영역이 아니라 Provider·운영체제·연결 환경 변화에 따라 유지해야 하는 영역이다. [AcpRuntime][w-acp] [Windows 실행 관리][w-process]

Paseo를 참고 자료로만 사용하면 필요한 기능과 수정 사항을 읽고, WorkNaru 방식으로 다시 구현하고, 별도의 상태 모델과 시험을 유지해야 한다. Paseo가 같은 문제를 고쳐도 WorkNaru가 자동으로 그 개선을 받지는 못한다. 참조 구현과 독자 구현 사이에 계속 번역 비용이 발생한다.

패키지를 사용하면 변화의 단위가 달라진다. 실행 내부를 재구현하는 대신 검증된 패키지 버전을 선택하고, WorkNaru가 사용하는 연결 표면과 제품 흐름이 맞는지 확인하게 된다. 테스트와 유지보수가 없어지는 것은 아니지만 직접 소유할 책임을 줄일 수 있다.

현재의 목표가 Agent 관리 제품 자체를 만드는 것이라면 독자 구현의 가치가 커질 수 있다. 그러나 WorkNaru의 목표는 독립적인 업무 Module을 제공하는 AI Workspace다. 실제 개발 부담도 Agent 관리에 집중돼 있다는 점을 고려하면, Paseo를 구현 기반으로 사용해 그 부담을 줄이는 선택에 더 무게를 두는 것이 타당하다. 이는 개발량 절감 비율을 측정한 결론이 아니라 제품 방향과 관찰된 개발 부담에 따른 판단이다.

## 3. 내부 DaemonClient는 실제 사용 가능한 연결 경로다

정확한 import 경로는 다음과 같다.

```ts
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
```

검토한 `@getpaseo/client@0.8.0-beta.1`은 이 경로를 package.json의 `exports`에 명시한다. 실제 배포물에는 JavaScript와 TypeScript 선언이 함께 있다. 임의로 node_modules 내부 파일을 찾아 접근하거나 소스를 복사해야만 사용할 수 있는 경로가 아니다. [패키지 exports][p-package]

더 중요한 근거는 Paseo 자신의 CLI가 같은 경로에서 DaemonClient를 import하고, 연결·인증 설정을 전달해 실제 Daemon 호출에 사용한다는 점이다. 따라서 WorkNaru는 Paseo 제품이 사용하는 제어 클라이언트를 재사용할 수 있다. [Paseo CLI의 Client 사용][p-cli-client]

다만 package export와 외부 통합에 대한 안정성 약속은 구분한다. Client README는 root를 지원 SDK로, internal 경로를 Paseo 자체 패키지가 사용하는 지원되지 않는 내부 구현으로 설명한다. 이 설명은 변경 대응을 WorkNaru가 더 많이 소유할 수 있다는 의미로 평가해야 한다. 기술적으로 사용할 수 없다거나 모든 상황에서 채택하면 안 된다는 결론으로 확대할 근거는 아니다. [Client README][p-readme]

### 사용할 수 있는 기능

배포 선언과 구현에서 다음 기능을 확인했다. 아래는 메서드의 존재와 요청 경로를 확인한 목록이며, 모든 Provider에서 같은 기능이 된다는 보장은 아니다. [DaemonClient 구현][p-client]

| 기능 | 확인한 연결 표면 | WorkNaru에서 줄일 수 있는 직접 구현 |
| --- | --- | --- |
| 생성·조회 | createAgent, fetchAgent, fetchAgents | Provider별 세션 생성·조회 연결 |
| 입력·실행 | sendAgentMessage, waitForFinish | 요청 전송과 실행 관찰의 저수준 처리 |
| 취소 | cancelAgent | Provider별 취소 RPC와 응답 처리 |
| 모델·추론 설정 | setAgentModel, setAgentThinkingOption | Provider 설정 변경 경로 |
| 여러 설정 적용 | applyAgentConfig | 설정 묶음 전달과 지원 기능 확인 |
| 권한 응답 | respondToPermission | Provider 승인 요청·응답 연결 |
| 기록·구독 | fetchAgentTimeline, setAgentTimelineSubscription | runtime timeline 접근과 구독 제어 |
| 재개·가져오기 | resumeAgent, importAgent | 지원되는 native 세션 연결 경로 |
| 연결 상태 | subscribeConnectionStatus, getLastServerInfoMessage | 연결 상태와 Server capability 관찰 |

내부 경로를 사용하면 고수준 SDK에서 빠져 있던 취소·모델·추론 제어의 접근 문제는 해소된다. createAgent의 idempotencyKey, sendAgentMessage의 messageId와 activeTurnBehavior 같은 선택지도 타입에 드러난다. 이 옵션은 요청 중복과 실행 중 추가 입력의 의미를 연결할 때 유용하다. 세부 동작은 Server와 Provider의 지원 범위에 맞춘다. [Client 요청 옵션][p-client-options]

이 사실을 반영하면 고수준 SDK의 기능 공백을 이유로 채택을 보류하거나, 단지 그 공백 때문에 CLI 명령 실행을 추가해야 할 필요는 크게 줄어든다.

## 4. 권장하는 연결 구조

제품의 외부 경계는 WorkNaru가 유지하고, Agent 제어와 native 상태는 Paseo의 모델을 적극적으로 사용한다.

```text
WorkNaru UI / 업무 호출 클라이언트
              │
        WorkNaru Daemon
        ├─ Module 업무 데이터·규칙·결과
        └─ 작은 Paseo 연결 계층
              │
       Paseo DaemonClient
              │
       전용 Paseo Server
              │
       Provider / Agent
```

WorkNaru의 연결 계층에는 필요한 호출, 업무 객체와 Agent의 연결, 화면에 필요한 오류·상태 변환만 둔다. Paseo의 Agent manager를 WorkNaru 내부에 또 만들지 않는다. Provider별 시작·재개·취소 알고리즘이나 native timeline 저장 형식을 다시 구현하는 것은 책임 위임의 취지와 맞지 않는다.

### 하나의 연결을 사용한다

기본 선택으로는 Agent 작업을 DaemonClient 하나로 처리하는 것이 단순하다. 고수준 API의 편의 기능이 필요하면 같은 객체를 공개 `createPaseoApi`에 전달할 수 있다. 실제 고수준 Client도 내부적으로 이 조합을 사용한다. 공개 API와 내부 API를 쓰겠다는 이유로 서로 다른 연결 두 개를 만들 필요는 없다. [고수준 API의 조립 구현][p-root]

다음은 연결 조합을 설명하는 예시다. 실제 WorkNaru 구현이나 실행 시험 결과는 아니다.

```ts
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { createPaseoApi } from '@getpaseo/client';

const driver = new DaemonClient({
  url: runtimeUrl,
  clientId: 'worknaru',
  clientType: 'cli',
  password: runtimePassword,
});

await driver.connect();
const api = createPaseoApi(driver); // 필요한 고수준 기능만 같은 연결에서 사용
```

이 예시의 clientId는 설명용이다. 실제 여러 인스턴스·연결을 지원할 때의 식별 방식은 설치한 버전과 WorkNaru 배치에 맞춘다. Module과 Web UI에 driver 자체를 전달할 필요도 없다.

### Server는 검증된 실행 기반으로 사용한다

Server root에는 createPaseoDaemon, loadConfig, logger와 start/stop/getListenTarget 수명 API가 있다. WorkNaru가 전용 프로세스에서 Server를 조립하는 경로는 실제 후보다. Agent 내부 실행은 이 Server에 맡긴다. [Server exports][p-exports] [Server bootstrap][p-bootstrap]

WorkNaru 실행기가 맡을 것은 전용 인스턴스를 시작하고 연결 정보를 얻으며 자신이 시작한 인스턴스를 종료하는 일이다. Agent별 실행 관리까지 다시 가져오면 재사용 효과가 줄어든다.

Paseo의 공식 CLI에는 별도의 supervisor 기동 경로도 있다. Server root의 수명 API와 CLI supervisor의 배포·재시작 역할은 동일한 것이 아니므로, WorkNaru의 설치·실행 방식에 필요한 부분만 비교한다. 여기서 실제 문제가 생기면 먼저 Paseo가 제공하는 실행 방식을 재사용할 방법을 찾고, 큰 독자 supervisor를 새로 만드는 것을 기본 해법으로 삼지 않는다. [CLI의 Daemon 기동][p-cli-daemon]

현재 개인 Paseo와 WorkNaru 제품용 인스턴스의 소유권은 구분한다. 제품이 시작한 전용 인스턴스의 home·연결·종료를 WorkNaru가 관리하면 된다. 별도 프로세스·home은 운영 분리이며 보안 sandbox를 뜻하지 않는다.

## 5. 보존할 것과 바꿀 수 있는 것을 구분한다

현재 기능을 모두 보존하지 않는다면, 기존 AcpRuntime의 인터페이스를 고정한 뒤 Paseo를 완전히 같은 모양으로 변환할 이유가 없다. 접착 계층은 실제 필요한 WorkNaru 업무 동작을 제공할 만큼이면 된다.

| 영역 | 권고 | 이유 |
| --- | --- | --- |
| 업무 데이터·Module 규칙·결과물 | WorkNaru가 계속 소유 | 제품의 주된 가치와 책임 |
| 공통 UI·업무 탐색 | 필요한 범위 유지 | 현재 투자 중 제품에 직접 기여하는 부분 |
| Provider 실행·native 세션·Agent 상태 | Paseo에 위임 | 재사용하려는 핵심 기능 |
| Chat 모델·추론 설정과 표시 | Paseo 기능에 맞춰 조정 | 현재 구현 형태의 재현보다 관리 기능 재사용이 목적 |
| 취소 후 대화 재개 정책 | Paseo·Provider가 지원하는 의미를 기준으로 검토 | 현재의 재개 제한을 새 구조에 반드시 복제할 필요가 없음 |
| Run DTO·오류 코드·복구 상태 | 필요한 사용자 의미만 남겨 재설계 가능 | 독자 runtime 상태 기계를 유지하는 비용을 줄임 |
| 일반 Agent 도구 승인 | Paseo 승인 흐름을 우선 사용 | 같은 권한 처리를 다시 구현하지 않음 |
| Module의 검수·업무 확정 | Module에 유지 | Agent 권한 응답과 업무상 판단은 다른 책임 |
| 기존 8KiB 파일 수정 승인 도구 | 유지·재설계·제공 시점 변경을 비교 | 현재 Chat의 구체적인 구현을 전체 플랫폼의 채택 관문으로 고정하지 않음 |
| 기존 기록 | 조회·보존 범위를 정해 처리 | 새 runtime 사용과 과거 데이터 보존은 별도 문제 |

기능 차이를 수용한다는 것은 미확인 결과를 성공으로 표시하거나 사용자가 승인하지 않은 변경을 자동 적용해도 된다는 뜻은 아니다. 사용자에게 무엇을 제공하고 어떤 권한으로 실행하는지는 여전히 명확해야 한다. 다만 그 의미를 충족하는 구현을 현재의 모든 필드·MCP 설정·취소 제한과 동일하게 만들 필요는 없다.

현재 데이터는 우선 보존하고, 새 세션부터 Paseo를 사용하며, 과거 대화는 조회 가능한 기록으로 남기는 방식도 합리적인 후보다. 모든 과거 ACP native 세션을 그대로 이식하는 것을 최초 전환의 필수 조건으로 두지 않아도 된다. 실제 선택할 범위는 기존 데이터의 사용 필요에 맞춰 정한다.

## 6. 파일 승인 문제의 비중도 달라진다

현재 WorkNaru의 파일 도구는 작은 기존 텍스트 파일의 수정 전후를 보존하고 사용자 승인 후 적용하는 구체적인 기능이다. 코드에는 8KiB 범위와 5분 대기 정책이 있다. 이 구현이 현재 Chat에서 유용하다는 것과 모든 미래 업무가 이 도구를 사용해야 한다는 것은 별개다. [현재 파일 도구][w-files]

Paseo의 일반 Agent 도구 승인 흐름을 WorkNaru 화면에서 사용할 수 있다면, 일반 Agent 작업에 대해서는 그 기능을 재사용할 수 있다. 보고서 초안의 수정·확정이나 원문 대조 같은 업무 판단은 해당 Module이 소유한다. Provider 권한과 업무 검토를 분리하는 기존 제품 원칙은 유지된다. [Module·플랫폼 책임][w-readme]

특정 Module에서 원본 파일을 확정 전까지 절대 바꾸지 않아야 한다면, 그 요구를 해당 Module의 기능으로 구현한다. 예를 들어 제안만 저장한 뒤 WorkNaru가 확정된 버전을 적용하거나, 별도 작업 자료에서 처리할 수 있다. 이러한 방식도 실제 요구에 맞춰 선택하며, 지금 일반적인 staging 플랫폼을 선구현할 필요는 없다.

기존 WorkNaru의 Codex 설정 중 일부를 Paseo의 strict providerOptions에 그대로 전달할 수 없다는 사실은 남아 있다. 그러나 현재 설정의 완전 복제가 목표가 아니라면, 그 사실만으로 전체 runtime 채택을 중단할 이유는 없다. 선택한 업무 흐름에서 필요한 권한과 결과 통제가 가능한지 검증하면 된다. 내부 DaemonClient를 사용한다고 Server의 Provider 설정 schema가 사라지는 것도 아니므로 두 문제를 혼동하지 않는다. [Codex 옵션 구현][p-options]

## 7. 내부 API 의존성의 실제 비용

내부 API를 사용할 때 늘어나는 책임은 Paseo 업데이트에 대한 통합 검증이다. 이 비용은 인정하되 현재 직접 구현·유지하는 Agent 관리 비용과 비교해야 한다.

| 지금 직접 관리하는 범위 | Paseo를 사용한 뒤 주로 관리할 범위 |
| --- | --- |
| Provider별 연결·설정·재개·취소 | 사용 중인 Client 호출과 지원 기능 확인 |
| Agent 프로세스·연결 상태의 조정 | 전용 Paseo 인스턴스와 WorkNaru의 연결 |
| 출력·native 세션 변화 대응 | 업무에 필요한 출력·식별자의 연결 |
| 참고 소스의 수정 사항을 별도 이식 | 선택한 버전 업데이트와 제품 흐름 검증 |

이후 비용을 작게 유지하려면 다음 정도의 규칙이면 된다.

1. server/client를 검증한 exact version과 lockfile로 함께 관리한다.
2. 내부 import는 WorkNaru의 Paseo 연결 코드 안에 모은다.
3. 실제 쓰는 메서드와 이벤트만 연결한다. DaemonClient 전체를 또 감싼 범용 SDK를 만들지 않는다.
4. 업데이트할 때 생성·입력·설정·승인·취소·기록·재접속 중 제품이 사용하는 흐름을 검사한다.
5. 기능 변화가 있으면 WorkNaru 연결 코드와 사용자 흐름을 조정한다. Provider 내부 구현을 다시 소유하는 방향으로 되돌아가지 않는다.

pin은 업데이트 시점을 통제하는 수단이다. 미래 변경이나 보안·호환성 대응 비용을 없애지는 않는다. 반대로 internal이라는 이름만으로 비용이 독자 Agent Runtime보다 크다고 단정할 근거도 없다.

Client 코드에는 applyAgentConfig의 capability 전제와 부분 적용 가능성처럼 실제 호출 의미를 이해해야 하는 부분이 있다. 이런 내용은 사용하는 연산의 adapter와 시험에서 다룬다. 같은 문제를 이유로 설정 관리 전체를 다시 구현할 필요는 없다. [설정 묶음 적용][p-config-apply]

## 8. WorkNaru Daemon을 작게 유지하는 방법

Paseo를 채택하면서 WorkNaru가 기존 runtime 상태 기계를 전부 유지하면 두 Agent 플랫폼을 연결하는 비용이 생긴다. 책임 위임의 효과를 얻으려면 WorkNaru가 어떤 사실을 직접 소유하는지도 줄여야 한다.

| 사실 | 권장 원본 |
| --- | --- |
| Agent가 실행 중인지, 어떤 native 세션을 사용하는지 | Paseo·Provider |
| Agent timeline과 Provider별 실행 정보 | Paseo·Provider |
| 어떤 업무 객체가 어떤 Agent·실행과 관련되는지 | WorkNaru |
| 어떤 초안·수정안을 사람이 채택했는지 | 소유 Module |
| 업무 결과의 확정본과 변경 이력 | 소유 Module |
| WorkNaru 제품이 시작한 전용 runtime의 운영 정보 | WorkNaru 실행기 |

Paseo에는 중복 요청과 결과 불명 상태를 다루는 장부도 있다. 이를 사용하면서 WorkNaru에 같은 Provider 전달 장부를 다시 만드는 것은 피한다. WorkNaru의 업무 접수와 결과 관계가 필요하면 그 업무 의미만 저장한다. [Paseo 요청 장부][p-receipts]

Chat의 메시지를 반드시 지금의 저장 구조와 동일한 방식으로 이중 저장해야 하는지도 다시 검토할 수 있다. 업무에 채택한 출력과 승인 증거는 WorkNaru가 보존할 수 있지만, runtime timeline 전체의 두 번째 원본을 운영하는 것은 별개의 비용이다.

다만 Agent 완료가 업무 확정을 뜻하지 않는 구분은 남는다. AI가 초안을 만든 뒤 실행을 끝내도, 사람은 나중에 그 자료를 수정하고 확정할 수 있어야 한다. 이 책임은 Paseo가 부족해서 보완하는 것이 아니라 WorkNaru가 제공하려는 업무 서비스의 본래 역할이다. [업무 데이터와 Session][w-data]

## 9. 권장 진행 순서

### 1단계: 재사용할 실행 경로를 먼저 연결한다

전용 Paseo Server를 시작하고, 하나의 DaemonClient로 Agent 생성·입력·조회·취소를 연결한다. 현재 제공하려는 Provider 하나로 시작한다. 실제 설정·승인·재접속도 필요한 만큼 연결하되, 기존 WorkNaru와 모든 상태 이름·UX를 일치시키는 것을 목표로 두지 않는다.

이 단계의 핵심 질문은 검증된 Paseo 실행을 WorkNaru에서 작게 사용할 수 있는가다. 공개 SDK의 기능 확장을 기다리는 것을 선행조건으로 두지 않는다. 현재 사용 중인 개인 Paseo를 재시작하거나 그 데이터를 실험용으로 사용하지 않고 전용 검증 인스턴스에서 연결을 확인할 수 있다.

### 2단계: 새 세션을 Paseo 중심으로 구성한다

현재 UI에서 실제로 필요한 기능을 고르고 Paseo의 상태·설정·승인 의미에 맞춰 표시한다. 기존 API를 보존하는 편이 작은지, 일부를 바꾸는 편이 작은지는 실제 사용처를 보고 결정한다. 동일 기능을 두 backend에서 영구적으로 개발하지 않는다.

데이터는 보존하되 기존 대화 재개를 모두 이식하는 범위와 과거 기록 조회를 구분한다. 선택한 차이는 사용자에게 보이는 동작으로 설명한다.

### 3단계: 업무 Module에 개발 시간을 사용한다

연결이 사용 가능한 수준이 되면 첫 업무 Module로 넘어간다. 보고서 작성, 문서 검수 등 실제 필요한 사례에서 업무 객체·AI 제안·사람의 검토·결과 활용을 구현한다. Paseo 채택의 목표는 이 단계에 집중할 여력을 확보하는 것이다.

업무 Module 하나를 먼저 완성해야만 Paseo를 채택할 수 있다는 선행조건은 두지 않는다. 현재 Agent 기반 개발 자체가 부담이라면 그 기반을 먼저 재사용하는 판단이 합리적이다. 다만 전환 작업이 끝없이 확장되지 않도록 첫 연결 범위를 작게 둔다.

### 4단계: 중복 구현을 제거하고 업데이트 방식을 정착시킨다

새 흐름에서 더 이상 사용하지 않는 ACP 연결·Provider 관리 코드를 제거한다. 필요한 옛 기록 조회나 운영 코드를 구분하고, 두 완전한 Agent Runtime을 영구 유지하지 않는다. 그 뒤 Paseo 업데이트를 좁은 연결·제품 흐름 검사로 수용하는 방식을 유지한다.

## 10. 필요한 검증의 경계

Paseo를 사용해 얻는 핵심 가치는 이미 발전한 실행 기능을 재사용하는 데 있다. 따라서 Paseo 전체의 생명주기 구현을 WorkNaru 프로젝트에서 다시 증명하거나 모든 내부 시험을 복제할 필요는 없다.

WorkNaru가 추가한 연결 경계는 확인해야 한다.

- 선택한 패키지가 지원 Windows 환경에서 설치되고 전용 Server가 시작되는가.
- Client가 의도한 Server에 연결하고 실제 Agent 작업을 요청할 수 있는가.
- 필요한 취소·설정·승인·재접속이 WorkNaru 화면과 계약에서 올바르게 연결되는가.
- 제품 종료가 자신이 소유한 runtime만 처리하는가.
- 사용자가 보존해야 할 업무 데이터와 기존 기록을 잃지 않는가.

이 시험은 Paseo를 불신해서 추가하는 것이 아니라 WorkNaru가 작성한 접착 코드와 배포 배치를 확인하기 위한 것이다. 일반 Agent 도구 승인이나 재개 동작을 Paseo 방식으로 바꿀 수 있으므로, 기존 구현의 모든 회귀 시험이 새 구조에서도 그대로 요구되는 것은 아니다. 유지한 계약의 시험은 유지하고, 변경한 계약의 시험과 개발 안내는 새 의미에 맞게 갱신한다.

## 11. Issue #34에 권고하는 변경

| 기존 제안의 조건 | 재검토한 방향 |
| --- | --- |
| Client package root만 사용 | DaemonClient의 명시적으로 배포된 internal 경로도 연결 계층에서 사용 |
| 현재 실행·설정·복구 의미를 우선 보존 | 실제 필요한 제품 기능을 고르고 Paseo 중심으로 단순화·재설계 |
| 현재 파일 승인 도구의 동등성이 전체 전환 관문 | 일반 Agent 승인과 Module 업무 승인을 나누고 기존 도구의 제공 범위를 별도로 결정 |
| 공개 SDK 공백이면 다른 기동·제어 수단 검토 | 내부 DaemonClient로 기능을 직접 연결하고 변경 대응 비용을 관리 |
| 업무 Module 검증을 전면 전환 판단의 선행조건으로 강조 | runtime 재사용으로 개발 부담을 먼저 줄이고 업무 Module 개발로 이어감 |
| 기존 코드의 제거보다 호환성에 큰 비중 | 중복 Agent 관리 책임을 실제로 제거하는 것을 중요한 완료 조건으로 둠 |

원본 Issue와 ADR은 실제 결정과 구현 범위에 맞춰 후속 정리할 대상이다. 현재의 재검토 요청만으로 패키지 설치·코드 전환·데이터 변경을 수행한 것은 아니다.

## 12. 결론과 근거의 한계

**현재 WorkNaru에는 Paseo를 참고만 하며 Agent 관리를 계속 직접 만드는 것보다, Paseo를 실행 기반으로 채택하고 업무 Module에 집중하는 선택이 더 적합하다.** 내부 DaemonClient를 사용하는 방식은 이를 위한 실질적인 통합 경로다. 그 경로를 배포 패키지에서 확인했고, Paseo 자신의 CLI가 사용하며, 필요한 제어 메서드도 존재한다.

남는 핵심 작업은 전체 기능 동등성 확보가 아니라 작은 제품 연결과 배포 검증이다. 내부 API 의존성은 버전 고정·사용 범위 제한·업데이트 시험으로 관리한다. 비용이 없어지지는 않지만, 지금의 독자 Agent 관리 개발과 비교하면 감수할 만한 선택이라는 판단이다.

WorkNaru는 업무 데이터, 사용자 검토와 결과물의 의미를 소유한다. Paseo는 Agent 실행과 생명주기의 기반을 제공한다. 이 책임 분리가 실제 구현에서도 유지되면 외부 기반을 사용하는 것이 제품 정체성을 약화시키지 않고, 오히려 제품이 집중할 영역을 명확히 한다.

검토 기준은 WorkNaru main `d3810539d1c73caa65a38e142a2c39ee2e441943`, Paseo `v0.8.0-beta.1` / commit `4eab53e24e1b57c74b00945aa48a89d68ed755e3`이다. npm 배포물과 소스·선언·공식 CLI 사용을 확인했다. 실제 WorkNaru 통합, 새 설치·기동과 Provider 호출을 이번 재검토에서 실행한 것은 아니다. 실사용 기반의 유용성, API의 존재와 제품별 통합 검증을 구분한 권고다.

## 근거 자료

| 자료 | 사용한 근거 |
| --- | --- |
| [WorkNaru README][w-readme] | 제품 방향과 플랫폼·Module의 책임 |
| [ADR-0007][w-data] | 업무 데이터와 AI Session의 분리 |
| [AcpRuntime][w-acp], [Windows 실행 관리][w-process] | 현재 직접 소유하는 Agent 관리 범위 |
| [FileTools][w-files] | 현재 파일 승인 기능의 구체적인 범위 |
| [Issue #34][issue34], [기록 규약][w-records] | 원본 제안과 의사결정 기록의 경계 |
| [Client package.json][p-package] | internal 경로의 실제 export |
| [Client README][p-readme] | 외부 지원 SDK와 내부 표면의 안정성 구분 |
| [DaemonClient][p-client] | Agent 제어, 연결, 기록·구독 메서드 |
| [고수준 Client 조립][p-root] | 하나의 DaemonClient와 createPaseoApi 조합 |
| [Paseo CLI Client][p-cli-client] | 자체 제품이 같은 internal 경로를 사용한다는 근거 |
| [Server exports][p-exports], [bootstrap][p-bootstrap] | Server 패키지의 실제 기동·수명 API |
| [CLI Daemon 기동][p-cli-daemon] | 공식 supervisor 실행 경로 |
| [Provider options][p-options] | Client 선택과 별개로 남는 Provider 설정 schema |
| [AgentRequests][p-receipts] | 재사용할 요청 중복·결과 불명 처리 |

[w-readme]: https://github.com/NaruForge/worknaru/blob/d3810539d1c73caa65a38e142a2c39ee2e441943/README.md
[w-data]: https://github.com/NaruForge/worknaru/blob/d3810539d1c73caa65a38e142a2c39ee2e441943/docs/adr/0007-separate-business-data-from-ai-sessions.md
[w-acp]: https://github.com/NaruForge/worknaru/blob/d3810539d1c73caa65a38e142a2c39ee2e441943/src/acp.ts
[w-process]: https://github.com/NaruForge/worknaru/blob/d3810539d1c73caa65a38e142a2c39ee2e441943/src/windows-agent.ps1
[w-files]: https://github.com/NaruForge/worknaru/blob/d3810539d1c73caa65a38e142a2c39ee2e441943/src/file-tools.ts
[issue34]: https://github.com/NaruForge/worknaru/issues/34
[w-records]: https://github.com/NaruForge/worknaru/blob/d3810539d1c73caa65a38e142a2c39ee2e441943/docs/project-records.md
[p-package]: https://github.com/getpaseo/paseo/blob/4eab53e24e1b57c74b00945aa48a89d68ed755e3/packages/client/package.json
[p-readme]: https://github.com/getpaseo/paseo/blob/4eab53e24e1b57c74b00945aa48a89d68ed755e3/packages/client/README.md
[p-client]: https://github.com/getpaseo/paseo/blob/4eab53e24e1b57c74b00945aa48a89d68ed755e3/packages/client/src/daemon-client.ts
[p-client-options]: https://github.com/getpaseo/paseo/blob/4eab53e24e1b57c74b00945aa48a89d68ed755e3/packages/client/src/daemon-client.ts#L349
[p-config-apply]: https://github.com/getpaseo/paseo/blob/4eab53e24e1b57c74b00945aa48a89d68ed755e3/packages/client/src/daemon-client.ts#L3300
[p-root]: https://github.com/getpaseo/paseo/blob/4eab53e24e1b57c74b00945aa48a89d68ed755e3/packages/client/src/index.ts#L456
[p-cli-client]: https://github.com/getpaseo/paseo/blob/4eab53e24e1b57c74b00945aa48a89d68ed755e3/packages/cli/src/utils/client.ts
[p-exports]: https://github.com/getpaseo/paseo/blob/4eab53e24e1b57c74b00945aa48a89d68ed755e3/packages/server/src/server/exports.ts
[p-bootstrap]: https://github.com/getpaseo/paseo/blob/4eab53e24e1b57c74b00945aa48a89d68ed755e3/packages/server/src/server/bootstrap.ts
[p-cli-daemon]: https://github.com/getpaseo/paseo/blob/4eab53e24e1b57c74b00945aa48a89d68ed755e3/packages/cli/src/commands/daemon/local-daemon.ts
[p-options]: https://github.com/getpaseo/paseo/blob/4eab53e24e1b57c74b00945aa48a89d68ed755e3/packages/server/src/server/agent/providers/codex/options.ts
[p-receipts]: https://github.com/getpaseo/paseo/blob/4eab53e24e1b57c74b00945aa48a89d68ed755e3/packages/server/src/server/agent/requests/index.ts
