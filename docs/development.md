# 로컬 Daemon 개발과 저장 검증

- 관련 작업: [#6 첫 로컬 Daemon의 메시지 저장·재시작 조회 구현](https://github.com/NaruForge/worknaru/issues/6)
- 제품 책임: [README](../README.md)
- 출발 방식: [저장소 구성](design/repository-structure.md)

## 지원하는 범위

Daemon은 Session과 텍스트 메시지를 SQLite에 저장하고, 재시작 뒤 기록과 최초 접수 결과를 조회한다. 한 실행에서 명시한 Workspace 하나에 접근할 수 있다. Windows에서 `--acp`로 실행하면 아래의 실제 Codex 대화와 실행별 구독을 추가로 제공한다. Chat 화면은 후속 범위다.

저장 연산은 `messages.append`다. `accepted: true`는 메시지와 접수 결과가 커밋됐다는 뜻이며 `aiExecution: false`를 함께 돌려준다. 저장한 메시지를 자동으로 AI에 보내지 않는다. 실제 AI 실행은 `--acp`가 활성화된 데몬의 `runs.start`로 요청한다.

이는 [통신](design/client-daemon-protocol.md)·[저장](design/chat-storage-and-recovery.md) 초안 중 첫 텍스트 흐름을 검증하는 구현이다. `messages.append`는 Run 없이 저장하며, `runs.start`는 Run과 사용자·답변 메시지를 함께 만든다. 아래 계약은 현재 구현 기준이며 초안의 모든 연산과 필드를 제공한다는 뜻은 아니다.

## 준비와 실행

확인한 개발 환경은 Windows, Node.js 24.18.0과 npm 11.14.1이다. Node.js 24.18 이상 24.x를 대상으로 한다. 아래 명령은 저장소 루트의 PowerShell에서 실행한다.

```powershell
npm ci --cache .npm-cache --ignore-scripts
npm test
$env:WORKNARU_TOKEN = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
npm start -- --data-dir .worknaru-dev --workspace .
```

`npm test`는 빌드 후 동작 시험을 실행한다. 별도로 빌드할 때는 `npm run build`, 타입만 확인할 때는 `npm run typecheck`를 사용한다. 구조 검사는 없다.

시작하면 접속 URL, Workspace ID, `storeEpoch`와 `daemonInstanceId`가 JSON 한 줄로 출력된다. 포트는 기본적으로 빈 포트를 선택하며 `--port 4317`처럼 지정할 수 있다. 토큰은 출력하지 않는다. 종료는 Ctrl+C다. 클라이언트가 연결을 닫아도 독립 Daemon은 유지된다.

데이터 경로는 이 저장소 내부의 별도 디렉터리여야 한다. Workspace는 존재하는 폴더를 지정하며 해당 폴더에 데이터를 생성하지 않는다. 개발·시험 데이터와 npm 캐시는 Git에서 제외한다. 사용자용 설치·OS 데이터 경로·자격증명 저장은 아직 제공하지 않는다.

## 접속과 호출 예

출력된 `ws://127.0.0.1:<port>/ws`에 연결한 뒤 첫 메시지로 아래 JSON을 보낸다. 클라이언트는 데몬 실행에 사용한 `WORKNARU_TOKEN`을 알고 있어야 한다. 토큰을 URL에 넣지 않는다.

```json
{ "type": "hello", "protocolMajor": 1, "token": "<WORKNARU_TOKEN>" }
```

`ready`를 받은 뒤 지원 기능과 `storeEpoch`를 확인한다. Session 생성 요청은 다음과 같다. `<workspaceId>`와 `<storeEpoch>`는 시작 출력과 `ready`에서 얻은 실제 값으로 바꾼다.

```json
{
  "type": "request", "callId": "create-1", "method": "sessions.create",
  "requestId": "new-session-1", "storeEpoch": "<storeEpoch>",
  "params": { "workspaceId": "<workspaceId>", "title": "첫 저장 검증" }
}
```

응답의 `result.session.sessionId`로 메시지를 저장한다.

```json
{
  "type": "request", "callId": "append-1", "method": "messages.append",
  "requestId": "new-message-1", "storeEpoch": "<storeEpoch>",
  "params": { "sessionId": "<sessionId>", "text": "다시 시작한 뒤에도 조회할 메시지" }
}
```

조회에는 새로운 `callId`를 사용한다.

```json
{
  "type": "request", "callId": "list-1", "method": "messages.list",
  "params": { "sessionId": "<sessionId>", "limit": 20 }
}
```

같은 데이터 경로와 Workspace로 재시작하면 기존 Session ID로 조회할 수 있다. 토큰을 바꿔 재시작해도 현재 단일 로컬 소유자의 기록은 유지된다. `storeEpoch`는 유지되고 `daemonInstanceId`는 바뀐다.

| 연산 | 입력과 결과 |
| --- | --- |
| `workspaces.get` | 빈 params로 현재 허용된 Workspace를 조회한다. |
| `sessions.create` | Workspace·제목과 요청 ID·epoch로 생성한다. |
| `sessions.get` | Session ID로 정보를 조회한다. |
| `sessions.list` | Workspace·선택적인 `after`·`limit`으로 목록을 조회한다. |
| `messages.append` | Session·텍스트와 요청 ID·epoch로 저장한다. |
| `messages.list` | Session·선택적인 `after`·`upTo`·`limit`으로 메시지를 조회한다. |
| `requests.get` | params의 Workspace·요청 ID·`storeEpoch`로 최초 접수 결과를 조회한다. |

변경 요청의 `requestId`는 같은 Workspace·서버 호출 범위에서 재시작 뒤에도 보존한다. 같은 ID와 같은 정규화 내용은 최초 결과를 반환하며 다른 내용·연산은 충돌이다. 응답을 놓쳤다면 `requests.get`으로 확인한다. 저장 장애나 epoch 불일치는 ‘접수 기록 없음’이 아니다.

메시지 페이지의 `nextAfter`가 있으면 그 값을 다음 `after`로 보내고 첫 페이지의 `upTo`를 유지한다. 새 메시지가 추가돼도 읽고 있던 이력의 상한이 바뀌지 않는다.

## 현재 접속·저장 조건

- IPv4 loopback에만 바인딩한다. 정확한 Host·`/ws` 경로를 확인하고 URL의 query를 거절한다. Origin이 있는 접속은 기본적으로 거절하며, 로컬 개발 화면에 필요할 때 `--origin http://127.0.0.1:3000`처럼 정확히 지정한다.
- 첫 메시지에서 토큰과 버전을 확인한다. 인증 전 업무 데이터는 보내지 않는다. 토큰은 이 실행의 단일 로컬 소유자를 인증하며 서버가 Module 범위를 `chat`으로 정한다. 요청의 자체 Module 선언이나 다른 Workspace·Session ID로 범위를 넓힐 수 없다.
- 토큰은 환경 변수로 전달하는 개발용 방식이다. 실행 중 토큰 폐기·변경은 제공하지 않으며, 데몬을 종료하고 새 토큰으로 재시작한다. 같은 OS 사용자의 악성 코드까지 격리하는 기능은 아니다.
- 수신 프레임은 64KiB, 텍스트는 UTF-8 16KiB, 응답은 256KiB, 메시지 페이지 본문은 약 192KiB 이하로 제한한다. 연결은 최대 16개, 연결별 요청은 초당 120개까지다. 인증 대기는 5초이며 송신 대기량은 512KiB 이하로 제한한다.
- 플랫폼 기록은 `records.sqlite`에 저장한다. WAL·FULL 동기화와 트랜잭션을 사용한다. 별도의 `owner.sqlite` 연결이 배타 잠금을 유지해 같은 데이터 영역의 두 번째 데몬을 거절한다. 이 파일은 업무 DB가 아니라 소유권 잠금용이며 실행 중 삭제·교체하지 않는다.
- 프로세스가 종료되면 잠금도 해제된다. 기록은 삭제하지 않는다. DB·잠금 파일의 외부 교체·동기화와 네트워크 파일시스템 사용, 백업 복원은 지원하지 않는다. 지원 밖 스키마나 손상 파일은 빈 DB로 대체하지 않는다.
- 저장 실패 시 해당 실행의 새 변경을 차단한다. 관련 기록은 함께 롤백하며 원시 SQL 오류·토큰·본문을 로그나 오류 응답에 복제하지 않는다. 복구 후 재시작해 접수 결과를 확인한다.

현재 Node.js 내장 SQLite API는 동기 방식이며 이 버전 계열에서 release candidate다. 작은 입력의 첫 저장 검증에 사용하며 전체 제품의 처리량·응답성을 검증한 것은 아니다. 외부 네이티브 DB 패키지를 추가하지 않고 설치된 런타임에서 시험했다. [Node.js SQLite 문서](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)

WebSocket 서버는 `ws`, 입력 검증은 `zod`, 시험은 Node.js 내장 test runner를 사용한다. 실제 사용 버전은 루트 manifest와 lockfile에 고정한다. [ws 공식 문서](https://github.com/websockets/ws/blob/master/README.md), [Zod API](https://zod.dev/api)

동작 시험은 실제 프로세스의 강제 종료·재시작, 응답 유실 모사, 동시 중복 접수, 저장 트랜잭션 실패, 접속·대상 접근 거절, 페이지 한도, 중복 데몬, 잘못된 데이터 경로·DB 형식을 확인한다. 불완전한 HTTP 연결이 남아 있어도 정상 종료와 저장소 잠금 해제가 완료되는지도 확인한다. 시험 종료 시 이번 시험이 만든 프로젝트 내부 데이터와 프로세스를 정리한다.

## 실제 Codex 텍스트 대화

- 작업: [#8 ACP로 첫 실제 AI 대화 실행 연결](https://github.com/NaruForge/worknaru/issues/8).
- 환경: Windows, Node.js 24.18 이상 24.x, PATH에서 실행 가능한 PowerShell 7의 `pwsh.exe`, 유효한 Codex 로그인이 필요하다.
- 연결: `@agentclientprotocol/sdk` 1.4.0의 안정 ACP v1과 `@agentclientprotocol/codex-acp` 1.10.0을 사용한다. 실제 검증은 설치된 Codex CLI 0.153.4를 명시했다. 버전은 manifest·lockfile에 기록한다.

앞 절의 토큰을 설정한 터미널에서 데몬을 실행한다. `--codex-path`를 생략하면 ACP 어댑터가 제공하는 Codex 실행 파일 탐색을 사용한다.

```powershell
npm run build
npm start -- --data-dir .worknaru-dev --workspace . --acp --codex-path (Get-Command codex.exe).Source
```

다른 터미널에 같은 `WORKNARU_TOKEN`을 설정한 뒤, 출력된 URL로 질문한다. 첫 호출은 Session을 만들며 마지막 줄에 `sessionId`와 `runId`를 출력한다. 같은 데몬의 기존 대화에 후속 질문을 보낼 때는 출력된 Session ID를 지정한다.

```powershell
npm run chat -- --url ws://127.0.0.1:<port>/ws --text "안녕"
npm run chat -- --url ws://127.0.0.1:<port>/ws --session <sessionId> --text "앞선 대화를 요약해 줘"
```

클라이언트에서 Ctrl+C를 누르면 해당 실행의 취소를 요청한다. 클라이언트 연결만 끊기면 데몬은 실행을 계속한다. 데몬의 Ctrl+C는 새 요청을 막고 관리하는 에이전트를 정리한 뒤 저장소를 닫는다.

기존 CLI의 `CODEX_HOME` 또는 기본 `.codex`에 있는 `auth.json`을 개발 데이터 안의 `codex/auth.json`으로 복사해 사용한다. 원본 CLI 설정·로그인은 변경하지 않는다. 에이전트 기록과 임시 파일도 개발 데이터 안에 둔다. 이 영역에는 인증정보와 대화 기록이 있으므로 Git에 추가하지 않는다. 별도의 로그인 UI나 자격증명 관리 기능은 제공하지 않는다.

### 실행 계약

| 연산 | 입력과 결과 |
| --- | --- |
| `runs.start` | 변경 요청 ID·epoch와 `sessionId`, `text`를 받는다. Run·사용자 메시지·빈 답변 메시지·최초 접수 결과를 한 번에 커밋한다. 반환하는 `accepted`는 접수 확정이며 AI 완료를 뜻하지 않는다. |
| `runs.get` | `runId`로 현재 상태, 저장된 답변 `text`, `revision`, `errorCode`, `stopReason`, `storageAvailable`을 조회한다. |
| `runs.watch` | `runId`의 현재 스냅샷을 반환하고 그 뒤 커밋을 `run.changed`로 보낸다. 같은 이벤트 루프에서 조회·구독을 등록하므로 중간 커밋이 빠지지 않는다. |
| `runs.unwatch` | 해당 연결의 Run 구독을 해제한다. |
| `runs.cancel` | 변경 요청 ID·epoch와 `runId`를 받는다. `cancelling`을 저장하고 ACP 취소 및 프로세스 정리를 수행한다. 종료 확인 이후 `cancelled`를 저장한다. 이미 최종 상태인 Run은 유지한다. |

변경 연산은 기존 `requestId`·내용 충돌 규칙을 따른다. 같은 실행 요청을 재전송해도 최초 접수 결과만 반환하며 AI에 다시 전달하지 않는다. **최초 접수 결과의 Run은 당시 스냅샷이다. 현재 상태는 `runs.get` 또는 `runs.watch`로 확인한다.** 같은 Session에서 다른 Run이 미종료 상태라면 `SESSION_BUSY`로 거절한다.

`messages.list`에 `role`(`user` 또는 `assistant`)과 `runId`가 추가된다. 실행 중 답변 메시지는 커밋마다 갱신된다. 메시지 페이지의 `upTo`는 메시지 순번 상한이며 실행 중 본문을 과거 시점에 고정하는 값은 아니다. 실행의 일관된 답변 스냅샷에는 `runs.get/watch`의 `revision`을 사용한다. 답변 조각은 저장 후 전달하며, 종료 상태는 늦은 출력으로 되돌리지 않는다.

`run.changed`는 전체 Run 스냅샷이다. 클라이언트는 현재 Run과 revision을 기준으로 반영하고 재접속하면 다시 구독한다. 전체 대화를 이벤트로 보관·재생하지 않는다. 저장 장애 중에는 `storageAvailable: false`로 마지막 저장 상태와 현재 실행 여부를 구분한다. 저장하지 못한 완료를 확정하지 않으며, 클라이언트는 조회로 저장소 상태도 확인해야 한다.

### 종료와 재시작

Windows 감독 프로세스가 이름이 있는 Job Object를 만들고, 에이전트를 일시 정지 상태로 생성해 Job에 명시적으로 넣은 뒤 실행한다. 자식 프로세스도 같은 관리 범위에 들어간다. Job 이름은 생성 전에 저장하며 PID 목록으로 소유권을 추정하지 않는다. 데몬의 시작 확인 응답 전에는 에이전트를 실행하지 않고, 입력 파이프가 닫히거나 감독 프로세스가 종료되면 Job을 정리한다. 재시작 시 저장된 Job을 정리하고 활성 프로세스가 없는지 확인한다. [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

중단된 입력은 자동 재전송하지 않는다. 전달 전 중단은 `INTERRUPTED_BEFORE_DELIVERY`, 전달을 시도했으나 결과가 불명확하면 `EXECUTION_OUTCOME_UNKNOWN`으로 실패 처리한다. 정리를 확인하지 못하면 `PROCESS_CLEANUP_UNKNOWN`과 미종료 상태를 유지하며 해당 Session의 새 실행을 막는다. 이 오류는 파일 변경이 없었다는 뜻이 아니다.

첫 구현은 프로바이더 Session의 재개·불러오기를 제공하지 않는다. 같은 데몬에서 정상 완료한 대화는 후속 입력을 받지만, 취소·연결 실패·데몬 재시작 뒤에는 기록을 열람하고 새 Session을 시작한다. `sessions.get`의 `aiUnavailable`과 `SESSION_UNAVAILABLE`로 이를 구분한다. 저장한 전문을 새 에이전트에 자동 전송해 기존 맥락처럼 취급하지 않는다. ACP 비활성 상태에서도 실행 기록은 조회할 수 있으나 미확정 프로세스 정리는 `--acp` 재시작으로 수행한다.

### 현재 한도와 검증 범위

- 텍스트 입력과 실행별 답변은 각각 UTF-8 16KiB다. 답변 한도 초과 시 저장된 부분을 보존하고 `OUTPUT_LIMIT`으로 실패 처리한다. 첨부 파일·이미지·큰 답변의 조각 조회는 후속 범위다.
- 데몬당 열린 에이전트 연결은 최대 4개, 클라이언트당 Run 구독은 최대 16개다. 연결 해제 UI·유휴 정리 정책은 후속 범위이며 초기 연결은 정상 대화의 맥락 유지를 위해 유지한다.
- 감독 프로세스 준비 15초, ACP 초기화·Session 생성 각 30초, 질문 실행 120초의 한도를 적용한다. 정상 취소는 ACP 알림 뒤 프로세스 트리 정리까지 확인한다. Job 조사·종료를 확인하지 못하면 성공으로 간주하지 않는다.
- 텍스트 응답을 지시하고 셸·앱·플러그인 등 연결 기능을 끈 개발 설정으로 실행한다. ACP 파일·터미널 기능을 제공하거나 권한 요청을 자동 승인하지 않는다. 도구 이벤트는 `TOOLS_UNSUPPORTED`, 권한 요청은 `PERMISSION_UNSUPPORTED`로 실패 처리한다. 이 클라이언트 설정은 악성 에이전트를 격리하는 보안 경계가 아니며, 어댑터의 `read-only`라는 모드 이름도 실제 파일시스템 읽기 전용을 보장하지 않는다. 도구 실행·승인 UI는 후속 범위다.
- 저장소 v1을 처음 열면 SQLite `VACUUM INTO`로 `records-v1-<uuid>.sqlite` 백업을 만든 다음 트랜잭션으로 v2로 전환한다. 메시지·최초 접수 결과·epoch를 유지한다. 지원 밖 형식이나 실패한 변경을 빈 DB로 대체하지 않는다. 사용자용 백업·복원 기능은 제공하지 않는다.

`npm test`는 실제 SQLite와 별도 ACP 시험 프로세스로 중복·경쟁·스트리밍·취소·시작 중 취소·강제 종료·재시작·저장 장애·출력 및 프로토콜 한도·v1 변환·개발용 클라이언트를 검증한다. 시험용 에이전트 선택은 시험 진입점에만 있으며 제품 실행 옵션으로 노출하지 않는다.

실제 Codex와의 확인은 별도로 실행하며 모델 요청을 발생시킨다. 기존 로그인이 있어야 한다. 두 차례 질문으로 응답 스트리밍과 대화 맥락을 확인하고 데몬 재시작 후 저장 기록을 비교한다. 시험이 생성한 데이터·인증 사본·프로세스는 종료 시 정리한다.

```powershell
$env:WORKNARU_CODEX_PATH = (Get-Command codex.exe).Source
npm run test:live
```

관련 공식 자료: [ACP 초기화](https://agentclientprotocol.com/protocol/v1/initialization), [질문과 취소](https://agentclientprotocol.com/protocol/v1/prompt-turn), [Codex ACP 어댑터](https://github.com/agentclientprotocol/codex-acp), [Codex 설정](https://learn.chatgpt.com/codex/config-reference).
