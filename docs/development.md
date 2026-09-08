# 로컬 Daemon 개발과 저장 검증

- 관련 작업: [#6 첫 로컬 Daemon의 메시지 저장·재시작 조회 구현](https://github.com/NaruForge/worknaru/issues/6)
- 제품 책임: [README](../README.md)
- 출발 방식: [저장소 구성](design/repository-structure.md)

## 지원하는 범위

현재 Daemon은 Session과 텍스트 메시지를 SQLite에 저장하고, 재시작 뒤 기록과 최초 접수 결과를 조회한다. 한 실행에서 명시한 Workspace 하나에 접근할 수 있다. 실제 AI 연결·Chat 화면·실시간 구독은 아직 제공하지 않는다.

첫 저장 연산은 `messages.append`다. `accepted: true`는 메시지와 접수 결과가 커밋됐다는 뜻이며 `aiExecution: false`를 함께 돌려준다. 저장한 메시지를 자동으로 AI에 보내지 않는다. `runs.start`는 지원 기능에 포함하지 않고 호출하면 `METHOD_NOT_SUPPORTED`로 거절한다.

이는 [통신](design/client-daemon-protocol.md)·[저장](design/chat-storage-and-recovery.md) 초안의 전체 AI 흐름 중 기록 저장을 먼저 검증하는 구현이다. 메시지는 이 단계에서 Run 없이 저장된다. 실제 실행 접수와 메시지·Run의 연결은 ACP 단계에서 구체화한다. 기존 초안의 모든 연산과 필드를 구현했다고 해석하지 않는다.

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

동작 시험은 실제 프로세스의 강제 종료·재시작, 응답 유실 모사, 동시 중복 접수, 저장 트랜잭션 실패, 접속·대상 접근 거절, 페이지 한도, 중복 데몬, 잘못된 데이터 경로·DB 형식을 확인한다. 시험 종료 시 이번 시험이 만든 프로젝트 내부 데이터와 프로세스를 정리한다.
