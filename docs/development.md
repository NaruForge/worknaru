# 로컬 개발과 Daemon 계약

현재 제품은 [ADR-0016](adr/0016-use-paseo-for-agent-management.md)과 [전환 #35](https://github.com/NaruForge/worknaru/issues/35)에 따라 Paseo 기반의 새 데이터에서 실행한다. 대화 목록·첫/후속 입력·응답과 도구 기록·모델/추론 선택·권한 1회 허용/거절·취소를 UI와 headless에서 제공한다. [#42](https://github.com/NaruForge/worknaru/issues/42)에서 화면·연결·AI Settings와 공통 탐색을 현재 계약에 연결했다. 기존 ACP 대화·파일 승인·Run API·운영 CLI·Hub는 이식하지 않는다.

## 준비와 실행

Windows, Node.js `>=24.18.0 <25`, PowerShell 7, Codex CLI와 기존 로그인이 필요하다. `@getpaseo/server`와 `@getpaseo/client`는 **0.8.0-beta.1**로 고정한다. 패키지 고정은 외부 Codex executable의 버전까지 고정하지 않는다.

```powershell
npm ci --cache .npm-cache   # 최초 설치 또는 의존성 변경 시
npm run dev
```

설치 script를 허용한다. 배포 서버는 `node-pty`와 speech native 패키지·플랫폼 의존성을 포함하며 root 타입 검사에는 `@types/express`가 필요하다. `--ignore-scripts` 설치는 실행 검증을 대체하지 않는다. 별도 빈 설치 디렉터리에서 표준 `npm ci`와 실제 서버 기동·Client 연결·종료를 확인했다.

개발 실행은 최신 Daemon·UI를 빌드하고 Vite와 제품을 시작해 브라우저를 연다. UI는 기본 `http://127.0.0.1:15173/`, Daemon은 `ws://127.0.0.1:4310/ws`다. 실제 제품 주소를 HTML에 주입해 자동 연결하며 정확한 loopback Host·Origin만 허용한다. UI 소스 변경은 Vite가 반영한다. Daemon 변경은 종료 후 다시 실행한다.

개발 UI는 출력된 `127.0.0.1` 주소로 연다. 통합 개발 실행의 Host 검사에서는 `localhost`로 바꾼 주소를 허용하지 않는다. 브라우저를 직접 열려면 `npm run dev -- --no-open`을 사용한다.

| 개발 옵션 | 기본값·동작 |
| --- | --- |
| `--web-port` | `15173`, UI 포트 |
| `--daemon-port` | `4310`, UI와 다른 제품 포트 |
| `--workspace` | `.`, 기존 Workspace 폴더 |
| `--data-dir` | `.worknaru-dev/paseo-v1`, 프로젝트 내부의 별도 새 데이터 영역 |
| `--codex-path` | 명시값 → `WORKNARU_CODEX_PATH` → PATH의 `codex.exe` |
| `--no-open` | 브라우저 자동 열기 생략 |
| `--help` | 도움말만 출력 |

상대 경로는 저장소 루트 기준이다. 사용 중인 포트를 자동 변경하거나 기존 프로세스를 종료하지 않는다. Windows 예약 포트 문제나 충돌이 있으면 `npm run dev -- --web-port 15175 --daemon-port 14310`처럼 지정한다. 설치·로그인은 자동 수행하지 않는다.

### 실행 명령의 차이

| 명령 | 시작하는 대상 | 빌드·변경 반영 |
| --- | --- | --- |
| `npm run dev` | 전용 runtime·WorkNaru Daemon·Vite, 브라우저 자동 열기 | 실행 전 전체 빌드. UI 소스는 자동 반영하고 Daemon 변경은 재시작 |
| `npm run dev:web` | UI 개발용 Vite | UI 소스 자동 반영. Daemon은 별도로 실행 |
| `npm run preview:web` | 빌드된 `dist/web`의 확인용 서버 | 먼저 `build:web` 필요. 소스 변경·환경변수 변경은 다시 빌드 |
| `npm start -- --web-ui` | 전용 runtime·WorkNaru Daemon과 내장 UI | 먼저 전체 `build` 필요. 브라우저는 직접 열기 |

일상 개발은 `npm run dev`로 시작한다. UI만 따로 실행하는 명령은 Daemon을 기동하거나 종료하지 않는다.

### 독립 실행

```powershell
npm run build:daemon
npm start -- --workspace . --data-dir .worknaru-dev/paseo-v1
```

이 경로는 Web 빌드·Vite·브라우저 없이 실행한다. 내장 UI가 필요하면 `npm run build` 후 `npm start -- --web-ui`로 시작하고 `http://127.0.0.1:4310/`을 연다. 브라우저를 자동으로 열지는 않는다.

독립 실행 옵션은 `--data-dir`, `--workspace`, `--codex-path`, `--port`(기본 `4310`, `0`은 빈 포트), `--web-ui`, 반복 가능한 `--origin`, `--help`다. 별도 UI는 `--origin http://127.0.0.1:15173`처럼 명시한다. 제품은 loopback에서 실행하며 원격 공유·접속키 옵션을 제공하지 않는다. Paseo의 전용 인증은 제품 내부에서만 사용한다.

### Daemon과 UI를 따로 실행

통합 개발 실행을 Ctrl+C로 종료한 뒤, 저장소 루트의 **터미널 A**에서 Daemon을 실행한다.

```powershell
npm run build:daemon
npm start -- --origin http://127.0.0.1:15173
```

같은 저장소의 **터미널 B**에서 UI 개발 서버를 실행하고 `http://127.0.0.1:15173/`을 연다.

```powershell
$env:VITE_WORKNARU_URL = 'ws://127.0.0.1:4310/ws'
npm run dev:web
```

빌드된 UI를 확인하려면 터미널 B의 Vite를 종료하고 다음 명령을 실행한다. 터미널 A의 Daemon은 계속 사용한다.

```powershell
$env:VITE_WORKNARU_URL = 'ws://127.0.0.1:4310/ws'
npm run build:web
npm run preview:web
```

`VITE_WORKNARU_URL`은 UI 개발 서버를 시작할 때 또는 UI를 **빌드할 때** 적용된다. `preview:web` 직전에 환경변수만 바꿔도 이미 빌드한 UI의 접속 주소는 바뀌지 않는다. 환경변수를 지정하지 않은 빌드의 기본값은 UI를 제공한 주소의 `/ws`이므로, 별도 preview 서버에서는 위처럼 Daemon 주소를 넣어 빌드한다. 내장 UI의 기본 연결로 되돌리려면 터미널 B에서 `Remove-Item Env:VITE_WORKNARU_URL -ErrorAction SilentlyContinue` 후 `npm run build:web`을 실행한다.

UI 포트를 바꾸면 Vite의 `--port`와 Daemon의 `--origin`을 함께 맞춘다. Daemon 포트를 바꾸면 `--port`와 `VITE_WORKNARU_URL`을 맞춘다. 두 프로세스는 각 터미널에서 Ctrl+C로 종료한다. UI 서버를 끝내도 별도로 시작한 Daemon과 AI 실행은 유지된다.

### 실행 문제가 생겼을 때

| 증상 | 확인할 내용 |
| --- | --- |
| 포트가 사용 중이거나 바인딩할 수 없음 | 통합 실행의 `--web-port`·`--daemon-port`를 다른 포트로 지정한다. 기존 프로세스는 자동 종료하지 않는다. |
| 개발 UI가 403을 반환함 | 통합 실행이 출력한 `http://127.0.0.1:포트/` 주소를 사용한다. |
| UI가 연결 확인 중에 머무름 | Daemon 실행 여부, 허용한 UI Origin과 실제 주소, UI의 Daemon 주소를 확인한다. 빌드된 UI의 주소 변경은 재빌드한다. |
| 모델 목록 조회 실패로 전송이 막힘 | 오류의 ‘상태 확인’ 또는 대화 목록 ‘새로고침’으로 모델 목록과 상태를 다시 조회한다. 정상화되면 초안을 유지한 채 전송할 수 있다. |
| Codex 실행 파일을 찾지 못함 | `--codex-path` 또는 `WORKNARU_CODEX_PATH`로 실제 `codex.exe` 경로를 지정한다. |
| 데이터 형식·Workspace·동시 소유 오류 | 같은 데이터는 같은 Workspace의 한 실행만 사용한다. 다른 Workspace나 첫 전환에는 프로젝트 내부의 별도 빈 `--data-dir`을 지정하고 기존 자료를 보존한다. |

### Settings와 화면 탐색

설정은 Chat과 분리된 화면·연결·AI 메뉴를 갖는다. 화면 배색은 같은 origin의 브라우저 개인 설정으로, 미리보기·적용·취소와 다른 탭의 저장 반영을 제공한다. 적용하지 않고 화면 설정을 떠나면 마지막 적용색으로 돌아간다. Light/Dark는 OS의 초기 선호를 읽고 수동으로 전환한다.

연결 메뉴는 WorkNaru·AI 실행 환경·Workspace·저장·모델 조회 상태를 표시한다. 고정한 Paseo 버전의 Provider `ready`나 모델 목록은 로그인 성공의 증거로 사용하지 않는다. 현재 제품 연결은 별도 인증 판정을 제공하지 않으므로 인증은 ‘확인 불가’로 표시한다. 인증 실패 시 실행 환경의 Codex 로그인을 점검하며, 화면에서 로그인·계정 전환이나 개인 설정 변경을 수행하지 않는다.

AI 메뉴에서 선택한 새 대화 기본 모델·추론 강도는 즉시 Daemon의 현재 데이터 영역에 저장된다. 기존 대화의 설정은 유지한다. 새 대화의 입력창에서 바꾼 선택은 그 대화에만 적용되고, 기본값을 바꾸지는 않는다. 지원하지 않는 저장값은 재선택을 요구하며 다른 모델로 자동 fallback하지 않는다. 두 화면의 동시 변경은 저장 버전으로 판정하고, 충돌 시 최신 저장값을 다시 표시한다.

860px 이상은 서비스 탐색·화면별 목록·Main을 나란히 표시한다. Chat·Settings의 목록 접힘 상태는 각각 유지한다. 860px 미만은 Module 선택·목록·Main을 한 단계씩 표시하며, 목록 복귀 버튼과 브라우저 뒤로/앞으로 가기를 지원한다. 열린 앱 안에서 대화별 초안·읽던 위치·최신 출력 따라가기 여부와 목록 위치를 유지한다. 이전 기록을 추가하면 기준 메시지의 화면 위치를 보정하며, 기록 교체로 기준 메시지가 사라졌을 때는 가능한 기존 스크롤 위치로 복귀한다. 읽는 도중의 새 출력은 강제 이동하지 않고 ‘최근 내용으로 이동’으로 확인한다.

미전송 초안·스크롤 위치의 새로고침 후 영구 복원은 제공하지 않는다. 탐색 이력에는 화면·선택만 기록하고, Daemon의 `storeId`와 Workspace가 다르면 이전 대화 식별자를 적용하지 않는다.

### 종료와 소유권

개발·독립 실행 모두 **실행 터미널의 Ctrl+C**로 종료한다. 진행 중인 작업을 중단하고 이번 실행이 소유한 runtime·서버를 정리한다. `stopped` 출력의 `clean: true`와 종료 코드 0이 정리 확인이며, 정리 미확인은 오류와 실패 종료 코드로 표시한다. 화면의 별도 서버 종료 버튼은 제공하지 않는다.

탭 닫기·새로고침·RPC 도구 종료는 연결만 닫는다. 제품의 명시적 종료가 전용 Paseo 인스턴스를 정리하며 Windows Job Object는 owner의 비정상 종료 때도 그 인스턴스와 자식 프로세스를 정리한다. Agent별 실행·취소·세션은 Paseo가 소유한다. 부모가 기동한 프로세스에는 부모 전용 IPC 종료를 사용하며 공개 WS에 운영 종료 요청을 추가하지 않는다.

`build:daemon`은 이 checkout의 생성물 `dist`를 정리하고 빌드하므로 삭제된 구형 진입점이 남지 않는다. 데이터 영역은 지우지 않는다. 내장 UI를 쓸 때는 전체 `build`를 실행한다.

## 전용 구성과 데이터

WorkNaru는 전용 Node child에서 Server root의 설정·Daemon·logger·수명 API를 사용하며, 내부 DaemonClient 하나로 연결한다. 공식 Paseo CLI와 별도 소스 포크를 함께 운영하지 않는다.

| 항목 | 설정 |
| --- | --- |
| runtime 접속 | IPv4 loopback, 동적 포트, 실행별 전용 인증 |
| relay | 비활성화, 실행 중 활성화 불가 |
| Paseo Web UI, MCP와 Agent MCP 주입 | 비활성화 |
| Plugin, browser tools, terminal hooks | 비활성화 |
| 네 가지 speech provider 기능 | 모두 명시적으로 비활성화 |
| Provider | Codex만 활성화, 실제 executable 지정 |
| Codex 권한 | `workspace-write`, `approval_policy: on-request` |
| 네트워크·웹 검색·native multi-agent | 비활성화 |

데이터 영역에는 `worknaru-format.json` 표식, `worknaru.sqlite`, `paseo/`, `codex/`, `tmp/`가 있다. 전용 runtime의 `TEMP`·`TMP`도 이 영역을 사용한다. 처음에는 빈 디렉터리만 허용하고 재시작에서는 동일 형식·Workspace를 확인한다. 링크·junction을 통한 데이터 경로 이탈, 구형 자료, 다른 Workspace, 동시 소유는 거절한다. 개인 Codex의 `auth.json`만 전용 home으로 복사하고 개인 설정·MCP·Plugin 구성은 가져오지 않는다. 개인 Paseo의 데이터·서비스·설정은 변경하지 않는다.

Workspace의 파일 수정은 기본 허용한다. 추가 권한은 요청 시 1회 허용·거절하며 영구 자동 허용이나 지원하지 않는 질문·모드 변경 양식은 제공하지 않는다. Workspace 내부 읽기 명령도 Windows 실행 환경에 따라 추가 권한을 요청할 수 있다. 매 파일 수정에 구형 diff 승인이 제공된다는 뜻은 아니다.

## 공통 Daemon 계약

UI와 headless는 `/ws`의 **protocol 2**를 사용한다. 최초 프레임은 `{"type":"hello","version":2}`, 이후 요청은 `{"type":"call","id":"request-id","method":"runtime.get","params":{}}`다. `ready`를 받은 뒤 호출한다. 응답은 `reply`의 `ok: true / result` 또는 `ok: false / error.code / error.message`다. 구형 hello, 임의 Origin/Host와 공개하지 않은 메서드는 거절한다.

공개 타입은 대화·timeline·모델·권한을 표현한다. Paseo 객체·runtime 주소·인증을 넘기지 않는다. 연결된 client는 `changed` 알림을 받으면 상태·기록을 다시 조회하며 `message.finished`의 `messageId`, `outcome`(`completed`, `failed`, `cancelled`)을 확인한다. `messages.send`의 `accepted`는 전달 접수, 취소의 `requested`는 취소 요청이며 실행 완료 증거가 아니다.

| 요청 | params |
| --- | --- |
| `runtime.get`, `models.list`, `chats.list` | `{}` |
| `settings.get` | `{}` → `{revision, defaults: {model, effort}}` |
| `settings.update` | `{expectedRevision, defaults: {model, effort}}` → 저장된 설정 |
| `chats.create` | `{id: UUID, title, selection?: {model, effort}}` |
| `chats.recover`, `chats.get`, `chats.watch` | `{chatId: UUID}` |
| `chats.timeline` | `{chatId, before?: 이전 응답의 before}` |
| `chats.configure` | `{chatId, selection: {model, effort}}` |
| `messages.send` | `{chatId, messageId: UUID, text}` |
| `messages.cancel` | `{chatId}` |
| `permissions.respond` | `{chatId, permissionId, decision: "allow" 또는 "deny"}` |

`chats.get`과 `chats.watch`는 현재 대화와 최신 timeline을 반환한다. 이전 기록은 `hasOlder`·`before`를 사용해 조회한다. 알림 연결을 닫아도 실행은 계속된다. 생성·입력 ID는 UUID, 제목은 1~100자, 입력은 공백 제거 후 1~32,000자다. UI 제목은 첫 입력 텍스트에서 결정하며 부가 AI 호출을 하지 않는다.

`runtime.get`과 최초 `ready.info`에는 데이터 영역의 안정적인 `storeId`가 포함된다. 이는 탐색 구분용이며 인증 정보가 아니다. protocol 2에서 필드를 추가하고 `chats.create.selection`을 선택 사항으로 확장했다. 기존에 선택값을 명시하는 호출은 그대로 사용할 수 있다.

`chats.create`에서 선택값을 생략하면 Daemon이 접수 시 확인한 저장 기본값을 사용한다. 같은 생성 ID·제목을 다시 조회/생성하면 최초에 보관한 선택값을 유지하며 그 사이 바뀐 기본값으로 Agent를 다시 만들지 않는다. 명시한 선택값이나 제목이 기존 생성 내용과 다르면 `CREATION_CONFLICT`다.

`settings.update`는 모델 지원을 확인한 뒤 `expectedRevision`이 현재 버전과 같을 때만 저장하고 버전을 하나 증가시킨다. 다르면 `SETTINGS_CONFLICT`, 미지원 선택은 `MODEL_UNSUPPORTED`, 저장 장애는 `STORAGE_UNAVAILABLE`다. 성공하면 다른 연결에 `changed`를 보내 재조회를 유도한다. 응답 유실은 성공·실패로 추정하거나 자동 재저장하지 않고 `settings.get`으로 현재 버전·값을 확인한다. 이 조회는 현재 저장 상태이며 특정 유실 요청의 성공 영수증은 아니다. 그 뒤 의도한 값과 다를 때 사용자가 최신 버전으로 새 변경을 요청한다.

### UI 없는 공통 호출 도구

`npm run rpc`는 기본 `ws://127.0.0.1:4310/ws`에 `runtime.get`을 호출한다. `--url`, `--file`, `--watch`, `--help`를 지원한다. `--watch`는 응답 후 같은 연결에서 이벤트를 출력한다. PowerShell 인용 문제를 피하려면 저장소 안의 JSON 요청 파일을 사용한다.

```powershell
New-Item -ItemType Directory -Force .worknaru-test | Out-Null
$chatId = [guid]::NewGuid().ToString()
@{ method = 'chats.create'; params = @{ id = $chatId; title = '첫 대화'; selection = @{ model = 'gpt-5.6-luna'; effort = 'low' } } } |
  ConvertTo-Json -Depth 4 | Set-Content .worknaru-test/request.json
npm run rpc -- --file .worknaru-test/request.json

# 생성이 확인된 뒤 별도의 입력으로 전송한다.
$messageId = [guid]::NewGuid().ToString()
@{ method = 'messages.send'; params = @{ chatId = $chatId; messageId = $messageId; text = '안녕하세요' } } |
  ConvertTo-Json -Depth 4 | Set-Content .worknaru-test/request.json
npm run rpc -- --file .worknaru-test/request.json --watch
```

같은 파일의 `method`·`params`를 표에 맞춰 바꿔 조회·설정·승인·취소한다. 예를 들어 취소는 `{"method":"messages.cancel","params":{"chatId":"대화 UUID"}}`, 권한 응답은 `{"method":"permissions.respond","params":{"chatId":"대화 UUID","permissionId":"조회한 권한 ID","decision":"deny"}}`다. 생성·입력 ID는 요청마다 한 번 정하고 응답을 잃었다고 새 ID를 만들어 재전송하지 않는다. 실제 테스트에서는 아래의 모델 확인을 강제하는 시험 진입점을 사용한다.

새 대화 기본값도 UI 없이 조회·변경한다. 다음 예제의 `expectedRevision`은 반드시 직전 조회의 실제 값으로 바꾼다. 이 예제는 설정 변경이며 AI 입력을 보내지 않는다.

```powershell
@{ method = 'settings.get'; params = @{} } |
  ConvertTo-Json -Depth 4 | Set-Content .worknaru-test/request.json
npm run rpc -- --file .worknaru-test/request.json

# 조회 결과가 revision 0인 경우의 예. 다른 값이면 해당 숫자로 변경한다.
@{ method = 'settings.update'; params = @{ expectedRevision = 0; defaults = @{ model = 'gpt-5.6-luna'; effort = 'low' } } } |
  ConvertTo-Json -Depth 4 | Set-Content .worknaru-test/request.json
npm run rpc -- --file .worknaru-test/request.json

# 저장된 기본값으로 생성만 수행하며 입력은 별도로 보낸다.
@{ method = 'chats.create'; params = @{ id = [guid]::NewGuid().ToString(); title = '기본값으로 만든 대화' } } |
  ConvertTo-Json -Depth 4 | Set-Content .worknaru-test/request.json
npm run rpc -- --file .worknaru-test/request.json
```

## 저장과 결과 불명 처리

WorkNaru SQLite에는 대화와 Agent의 연결, 생성 요청의 재식별 정보, 미확정 입력·설정·권한 처리 정보와 새 대화 기본값을 저장한다. native 세션·timeline·Provider 전달 장부는 Paseo가 소유한다. WorkNaru가 별도의 Agent 실행 상태 기계를 복제하지 않는다.

기존 Paseo 기반 데이터에는 `chat_settings` singleton 테이블을 추가한다. 기존 chats·Agent 연결은 변경하지 않으며, 처음 한 번 기본값 `gpt-5.6-luna / low`, 버전 0, 고유 `storeId`를 저장한다. 이후에는 저장된 값과 식별자를 유지한다. 다른 데이터 영역은 독립된 기본값과 식별자를 사용한다. 이는 현재 Paseo 데이터의 추가 설정이며 구형 ACP 데이터 이식은 아니다. 선택값은 사용할 때 지원 여부를 검증한다.

생성은 안정적인 ID와 요청 저장 → `idempotencyKey`로 Agent 생성(`initialPrompt` 없음) → Agent 연결 저장 → 별도 `messageId` 입력 순서다. 생성 응답이나 연결 저장 실패는 `chats.recover`에서 같은 생성 식별자로 확인한다. 입력·권한 응답 결과가 불명확하면 자동 재전송하지 않고 현재 상태와 기록을 조회한다.

첫 생성의 모델 조회·지원 검증도 요청 식별자를 저장한 뒤 수행한다. 이 검증이 실패하면 Agent나 입력을 만들지 않고 생성 중 대화와 앱 안의 초안을 유지한다. `chats.recover` 역시 저장된 선택의 지원 여부를 다시 검사한다. 지원하지 않는 선택은 자동 변경하지 않으며, 기존 초안을 확인·복사해 지원하는 선택의 새 대화에서 이어갈 수 있다. 설정 저장 장애가 발생해도 성공한 기존 대화·기록 조회는 표시하며 새 입력은 차단한다.

Daemon은 대화별 짧은 접수 구간을 직렬화한다. 실행·승인·취소·결과 불명 상태에서는 새 입력을 거절하고, 실행 전체 동안 접수 잠금을 유지하지 않아 취소·권한 응답은 사용할 수 있다. 두 client의 입력·승인도 같은 판정을 받는다. 모델·추론 변경은 유휴 상태에서만 적용하고 실제 설정을 다시 확인한다. 부분 실패에서는 실제 표시값을 확인·재설정하기 전까지 입력을 막는다.

취소는 접수 당시의 입력·실행을 대상으로 한다. 입력 전달 응답을 기다리는 사이 해당 실행이 완료되고 후속 입력이 시작됐다면, 이전 취소를 후속 입력에 적용하지 않는다. 새 대화의 첫 전송에서는 초안을 생성된 대화로 옮긴다. 생성 실패 시에도 그 대화에서 초안을 확인할 수 있으며, 별도로 작성한 새 대화 초안은 유지한다.

native `idle`, 마지막 답변, timeout은 성공·취소 완료 증거가 아니다. 입력과 해당 turn의 종료 이벤트를 연결해 확인하며, 종료 이벤트를 놓친 입력은 재접속·재시작 후에도 `unknown`을 유지한다. 기록을 확인하고 필요하면 새 대화에서 이어간다. 완료가 확인된 대화는 제품 재시작 뒤 후속 입력을 받을 수 있다. Paseo의 저장된 `closed` snapshot은 lazy load 전 상태이므로 연결부가 native 기록 조회로 복구하고 실제 snapshot을 다시 확인한다.

## 검증

```powershell
npm run typecheck
npm run test:daemon  # UI 빌드·Vite 없이 계약과 실제 runtime 기동 검사
npm test            # 전체 빌드, 저장·경쟁·제품·개발 실행과 프로세스 소유 검사
npm run test:web    # Edge의 새 Chat과 공통 control·디자인 시안 검사
```

기본 브라우저 시험 포트는 `15174`이며 충돌 시 `WORKNARU_TEST_WEB_PORT`를 지정한다. 시험 데이터·브라우저 profile은 `.worknaru-test` 아래에 둔다. fake 시험은 실제 SQLite 저장 실패, 생성/전달/승인 응답 유실, 두 client의 경쟁, 부분 설정, 재접속과 재시작을 검사한다. 별도 프로세스 시험은 정상·강제 종료, 자식 프로세스 정리, 포트 충돌, 같은 새 데이터로 재기동과 UI 없는 동일 API를 확인한다.

새 계약을 바꾸면 `tests/chat-daemon.test.mjs`의 UI 없는 WS/RPC 호출과 `tests/chat-service.test.mjs`의 저장·재시작·충돌·실패 시험을 함께 갱신하고 `npm run test:daemon`을 통과시킨다. Settings·모델 조회 복구·긴 대화·모바일 탐색은 `tests/chat-web.spec.mjs`의 실제 제품 경로에서 검사한다. `design-prototype`·공통 control 시험은 시안/공통 표현 검증이며 제품 기능 지원의 증거로 대신하지 않는다.

### 실제 AI 응답 검증

실제 AI 응답 테스트는 반드시 저비용 모델 **`gpt-5.6-luna`, 추론 강도 `low`**를 사용한다. 첫 입력·후속 입력·취소·승인·재시도마다 지원 여부와 실제 적용값을 확인하며, 실패하면 질문을 보내지 않는다. 개인 기본값·화면 선택·자동 fallback으로 대체하지 않는다. 다른 모델 선택은 fake로 검사하고 제목·브랜치명·요약 등의 부가 AI 호출을 만들지 않는다. 실패는 fake와 연결 검사로 먼저 좁힌다. 각 호출의 시나리오·모델·추론·횟수·결과는 시험 폴더의 `verification.jsonl`에 기록한다.

```powershell
$env:WORKNARU_LIVE = '1'
$env:WORKNARU_CODEX_PATH = (Get-Command codex.exe).Source
npm run test:live           # UI/headless 제품 흐름 5회 입력
# runtime 연결 자체를 변경한 경우의 좁은 실제 시험:
npm run test:live:paseo      # 첫 입력·후속 입력·취소 3회
```

기본 시험은 모델을 호출하지 않는다. 실제 시험은 환경변수로 명시적으로 켠다. 매 입력을 보낼 때 catalog와 native 적용 모델·추론 값을 재확인한다. UI 선택값만 검사하지 않는다. 제품 실검증은 파일 읽기 도구, headless 후속 입력, UI 허용으로 지정 파일 생성, 재시작 후 UI 거절로 기존 파일 무변경, UI 취소를 확인한다. 개인 Paseo/Codex 설정·인증 hash 무변경과 소유 runtime 종료도 확인한다.

2026-09-09 Windows `10.0.26200`, Node `24.18.0`, npm `11.14.1`, Codex CLI `0.153.4`에서 runtime 3회·제품 5회 시나리오가 통과했다. 실행 파일은 `C:\Users\swBaek\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe`였다. 패키지 또는 외부 executable 변경 시 해당 환경을 다시 기록하고 관련 시험을 수행한다.

2026-09-10 기본 진입점 전환과 전용 임시 경로 적용 후 제품 실검증 5회가 다시 통과했다. 전체 동작 검사 26개·브라우저 검사 24개, 정상 개발 명령의 빌드·브라우저 자동 연결·새로고침·headless·종료도 확인했다. 모든 실제 입력은 `gpt-5.6-luna / low`였으며 개인 설정·인증은 변경되지 않았다.

같은 날 독립 리뷰에서 발견한 지연 취소의 후속 입력 오취소와 새 대화 초안 재등장을 수정했다. 수정 전 실패를 확인한 회귀 시험을 포함해 전체 동작 27개·브라우저 25개가 통과했다. 변경된 제품 취소 경로는 `gpt-5.6-luna / low` 입력 1회로 추가 확인했으며, 취소 완료·소유 runtime 정리·개인 설정 무변경을 검증했다.

2026-09-10 #42의 Chat·Settings 복구에서는 타입 검사, 전체 Node 시험 32개, 브라우저 37개(전체 36개와 동일 빌드의 추가 짧은 화면 시험 1개)가 통과했다. Node 24.18.0·npm 11.14.1·Codex 0.153.4·Edge 152.0.4191.66 환경이다. 브라우저 확대 배치는 CSS zoom 2로 확인했으며 실제 브라우저 UI의 200% 확대 조작이나 스크린리더 낭독을 대신하지 않는다. 실모델은 Settings 기본값 저장·재시작 보존을 포함한 제품 5회 입력과 마지막 조회 처리 보강 후 첫/후속 입력 2회, 총 7회를 `gpt-5.6-luna / low`로 확인했다. 각 입력·권한 응답·취소 전에 지원과 native 실제 적용값을 확인했고 소유 runtime 종료·개인 설정 무변경을 검증했다. 기존 최초 점검의 2회 입력은 이 구현 검증 7회와 별도다.

PR #43의 GPT 아스트라 독립 리뷰에서 첫 생성의 모델 검증 실패 시 초안 유실과 Settings 저장 장애 시 기존 기록 표시 차단을 재현해 수정했다. 두 제품 회귀 시험은 수정 전 실패·수정 후 통과했고 독립 재검토에서도 해결을 확인했다. 최종 타입 검사·빌드, Node 32개·브라우저 39개(제품 18·공통 control 13·시안 8)가 통과했다. 수정 후 같은 환경에서 제품 실검증 5회 입력을 추가해 읽기·후속 입력·허용·재시작 후 거절·취소를 확인했다. 모두 `gpt-5.6-luna / low`로 매 입력·권한 응답·취소 전에 지원과 native 실제 적용값을 확인했으며 소유 runtime 종료·개인 설정 무변경을 검증했다. #42 구현·리뷰 대응의 실제 입력 합계는 12회이며 최초 점검 2회는 별도다.

### 디자인 컨셉 프로토타입

`npm run build:prototype` 후 `npm run preview:prototype`으로 `http://127.0.0.1:15176`을 연다. 기존 배색·Settings·탐색·파일 diff 시안은 디자인 선택의 기록과 공통 control 검증용 예제다. 실제 AI·Daemon·파일 변경은 없으며 현재 제품 범위와 구분한다. 공통 primitive와 토큰은 제품과 함께 사용하고 예제의 구형 데이터 타입은 시안 내부에 한정한다. 빌드는 `.worknaru-test/design-prototype`에 생성하며 제품 번들에 포함하지 않는다. 종료는 Ctrl+C다. [Design System](design/design-system.md)을 참고한다.

## 이전 실행 환경으로 복귀

새 runtime을 명시적으로 종료한 뒤 전환 전 코드 `375793b6825ef5e58ef46980d9528e3afb801415`와 해당 lockfile로 검증한 바이너리를 **별도 빈 데이터**에서 실행한다. 저장소 안의 별도 checkout 또는 소스 묶음을 사용하고 기존 작업 트리·Workspace 파일을 덮어쓰지 않는다. 해당 버전의 `npm ci`·빌드·시작·종료 안내를 따른다.

새 Paseo/WorkNaru 자료는 그대로 남긴다. 구형 대화 복원, 새 DB의 역변환, 이미 수행한 Workspace 파일 수정의 자동 원복은 제공하지 않는다. 이번 전환은 WorkNaru의 직접 ACP 연결·Codex 프로세스 관리·구형 진입점 제거이며, Paseo의 하위 의존성에 ACP 관련 패키지가 남는 것은 허용한다.

2026-09-10 위 commit의 별도 소스 묶음에서 표준 설치·빌드 후 빈 데이터로 `daemon start --web-ui --acp`를 실행해 UI 응답·인증된 RPC·상태 조회·정상 종료를 확인했다. 복귀 검증은 모델 질문을 보내지 않았고 새 제품 자료와 개인 설정을 보존했다.
