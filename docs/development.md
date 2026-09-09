# 로컬 Daemon 개발과 저장 검증

- 관련 작업: [#6 첫 로컬 Daemon의 메시지 저장·재시작 조회 구현](https://github.com/NaruForge/worknaru/issues/6)
- 제품 책임: [README](../README.md)
- 출발 방식: [저장소 구성](design/repository-structure.md)

## 지원하는 범위

Daemon은 Session과 텍스트 메시지를 SQLite에 저장하고, 재시작 뒤 기록과 최초 접수 결과를 조회한다. 한 실행에서 명시한 Workspace 하나에 접근할 수 있다. Windows에서 `--acp`로 실행하면 아래의 실제 Codex 대화와 실행별 구독을 추가로 제공한다. Chat Web UI는 별도 로컬 개발 서버 또는 독립 CLI의 `--web-ui`로 제공하며 같은 Daemon 계약에 연결한다.

저장 연산은 `messages.append`다. `accepted: true`는 메시지와 접수 결과가 커밋됐다는 뜻이며 `aiExecution: false`를 함께 돌려준다. 저장한 메시지를 자동으로 AI에 보내지 않는다. 실제 AI 실행은 `--acp`가 활성화된 데몬의 `runs.start`로 요청한다.

이는 [통신](design/client-daemon-protocol.md)·[저장](design/chat-storage-and-recovery.md) 초안 중 첫 텍스트 흐름을 검증하는 구현이다. `messages.append`는 Run 없이 저장하며, `runs.start`는 Run과 사용자·답변 메시지를 함께 만든다. 아래 계약은 현재 구현 기준이며 초안의 모든 연산과 필드를 제공한다는 뜻은 아니다.

## 준비와 실행

### 통합 개발 실행과 화면에서 종료

설치부터 UI 점검까지의 기본 순서는 [README 빠른 시작](../README.md#빠른-시작-로컬-개발-점검)을 따릅니다. `npm run dev`는 `scripts/dev.mjs`를 실행하며, Windows·Node.js·PowerShell·의존성·Codex 경로를 확인하고 Daemon 및 UI를 빌드합니다. 그 뒤 이 실행이 소유하는 Daemon과 Vite 개발 서버를 시작하고 UI 응답을 확인한 후 브라우저를 엽니다. UI 소스 변경은 Vite가 반영하며, Daemon 소스 변경은 종료 후 다시 실행해야 반영됩니다.

```powershell
npm run dev
npm run dev -- --hub
npm run dev -- --web-port 15174 --daemon-port 14310
npm run dev -- --workspace . --data-dir .worknaru-dev --codex-path (Get-Command codex.exe).Source
npm run dev -- --help
```

| 옵션 | 기본값과 동작 |
| --- | --- |
| `--hub` | 기존 Artifact Preview Hub에 20분 동안 연결한다. 기본 로컬 실행에서는 연결하지 않는다. |
| `--require-key` | 기본은 꺼짐. 지정한 실행에서만 Daemon·종료 요청의 접속키 인증과 키 입력 화면을 켠다. `--hub`와 함께 사용할 수 있다. |
| `--web-port` | `15173`. UI의 IPv4 loopback 포트. |
| `--daemon-port` | `4310`. Daemon의 IPv4 loopback 포트. UI와 다른 포트여야 한다. |
| `--workspace` | 저장소 루트. 기존 Workspace 폴더를 지정한다. |
| `--data-dir` | `.worknaru-dev`. 기존과 동일하게 저장소 내부의 별도 폴더만 허용하며 링크 경로를 거절한다. |
| `--codex-path` | 명시값 → `WORKNARU_CODEX_PATH` → PATH의 `codex.exe` 순으로 선택한다. |
| `--no-open` | 브라우저 자동 열기를 생략하고 주소를 출력한다. |
| `--no-clipboard` | 기본 실행에서는 복사 자체가 없어 효과가 없다. `--require-key`에서 복사를 생략하려면 유효한 `WORKNARU_TOKEN`을 먼저 지정한다. |

경로 옵션의 상대 경로는 저장소 루트를 기준으로 한다. 이 개발 PC에서 5173 바인딩이 `EACCES`로 실패해 통합 실행은 확인된 15173을 기본값으로 사용한다. 개별 `dev:web`·`preview:web`의 기존 기본값은 5173이다. 사용 중인 포트를 자동 변경하거나 기존 프로세스를 종료하지 않는다. 시작 실패 시 이번 실행이 연 서버와 데이터 잠금을 정리한다. 의존성 설치나 Codex 로그인은 자동 수행하지 않는다. 기존 Codex 로그인 파일을 사용하는 ACP 동작은 아래 절과 같다.

`npm run dev`와 `npm run dev -- --hub`는 접속키 인증을 기본적으로 비활성화한다. 키를 생성·전달·저장하지 않으며 `WORKNARU_TOKEN`도 사용하지 않는다. 화면의 개발 실행 정보에 따라 키 입력 없이 자동 연결하고 새로고침 후에도 같은 방식으로 연결한다. 연결 실패 시 주소와 재시도 화면을 표시한다. 브라우저 열기만 실패하면 출력된 주소로 직접 진입한다.

`--require-key`를 지정하면 기존 키 인증을 켠다. `WORKNARU_TOKEN`이 있으면 그 값을 사용하고, 없으면 실행마다 32바이트 무작위 값으로 생성해 클립보드에 복사한다. URL·HTML·정적 빌드·로그·브라우저 저장소에 넣지 않는다. 키는 화면 메모리에만 남고 새로고침 시 다시 입력한다. 이 모드에서 클립보드 복사에 실패하면 서버를 정리하고 오류를 표시한다. 개별 `npm start`로 실행하는 Daemon의 기존 키 인증은 유지한다.

화면의 **개발 서버 종료**는 통합 실행에서만 표시한다. 기본 실행은 종료 시에도 키를 요구하지 않는다. `--require-key`에서는 연결 전에도 연결 창의 종료 버튼으로 같은 키를 입력해 종료할 수 있다. 서버가 모든 탭의 실행을 조회하고, 진행 중인 응답이 있으면 중단 확인을 받는다. 확인을 취소하면 점검을 계속한다. 실제 종료 직전에도 다시 조회하므로 상태 조회 후 시작된 실행을 확인 없이 중단하지 않는다. 중단을 확인한 경우 종료 시점의 모든 실행을 대상으로 한다.

종료는 새 Daemon 요청을 차단한 뒤 AI 실행·조회 프로세스 정리, 저장소 닫기, UI 서버 종료 순서다. 응답 처리 도중에는 진행 상황을 표시하고, 정리가 확인됐을 때만 완료 문구를 표시한다. 프로세스 정리 실패 또는 응답 유실은 완료로 표시하지 않는다. AI 프로세스 정리를 확인하지 못하면 종료 코드는 실패이며 다음 실행의 기존 복구 절차를 따른다. `Ctrl+C`도 같은 종료 경로를 사용한다. 탭 닫기·새로고침은 종료 요청이 아니며, 저장된 대화·설정은 삭제하지 않는다. 보내지 않은 초안은 저장되지 않고 중단한 대화에는 기존 후속 질문 제한이 적용된다.

개발 종료 제어는 Vite 개발 서버에만 설치한 `/__worknaru_dev/status`(GET), `/__worknaru_dev/stop`(POST)이다. 두 요청 모두 이번 실행의 `X-WorkNaru-Dev-Instance`를 요구하며 정확한 Host와, Origin이 있으면 허용된 UI Origin을 확인한다. `--require-key`에서만 Daemon 연결 키의 Bearer 인증도 요구한다. 기본 실행에는 Authorization 헤더가 필요 없다. 진행 중인 실행이 있으면 stop은 `409 { activeRuns }`로 확인을 요구하고, 명시적으로 중단을 확인한 요청은 `X-WorkNaru-Confirm-Stop: yes`를 보낸다. 정상 종료는 `200 { stopped: true }`, 정리 미확인은 500으로 반환한다. 새 실행은 다른 instance ID를 사용하므로 이전 탭의 종료 요청을 거절한다. 일반 Daemon의 WebSocket 계약에 종료 명령을 추가하지 않으며 `dev:web`·`preview:web`에는 이 제어 경로와 버튼이 없다.

`npm test`는 키 없는 연결·종료와 선택적 키 인증, 버전·Origin·실행 식별자, 포트 충돌 시 정리, 종료 전 실행 재확인, ACP 프로세스 트리 정리, 같은 포트·데이터로 재실행을 검증한다. `npm run test:web`는 로컬·Hub 경로의 키 없는 자동 연결·새로고침·채팅·종료, 선택적 키 입력, 화면 종료, 다른 탭 응답의 중단 확인과 취소, 연결 전 종료, 작은 화면, 탭 닫기 후 서버 유지, 종료 후 기록 조회도 검증한다. 가짜 ACP 에이전트를 사용하며 실제 모델 질문을 보내지 않는다.

### Hub로 같은 개발 서버 공유

`npm run dev -- --hub`는 기존 `C:\Projects\TailscaleOps`의 Artifact Preview Hub를 이용한다. `scripts/dev-hub.ps1`은 그 저장소의 예약 포트와 Tailscale 상태, 고정 9191 Serve 설정을 확인하고 기존 New/Attach/Detach 명령을 호출한다. Serve·Funnel·방화벽 설정을 변경하지 않는다. Hub 백엔드가 꺼져 있으면 기존 Attach 명령이 시작하며, 공유 해제나 WorkNaru 종료 시에도 공유 Hub 자체는 계속 실행한다.

UI는 `http://127.0.0.1:15173/p/<id>/`, 외부 접속은 `https://bsw-home.tailec99c3.ts.net:9191/p/<id>/`를 사용한다. 같은 Tailscale 네트워크에서 허용된 기기만 접속할 수 있다. 파일·데이터 복사나 별도 앱 서버는 만들지 않고, Hub의 기존 상태 영역에 연결 정보만 등록한다. 기본 실행은 별도 접속키를 요구하지 않는다. 이 PC의 로컬 접속과 해당 Preview에 접근 가능한 Tailnet 기기는 대화 조회·AI 실행·서버 종료를 사용할 수 있다. `--require-key`를 지정한 실행은 원격 기기에서도 키를 입력한다.

Vite의 base와 HMR 경로를 Preview 경로로 맞춘다. 화면의 연결 주소는 페이지와 같은 출처의 `/p/<id>/__worknaru_ws`로 자동 설정되며 HTTPS 화면에서는 WSS를 사용한다. 개발 서버의 고정 중계 경로가 정확한 Host와 허용 Origin을 확인한 뒤 자신이 실행한 loopback Daemon의 `/ws`에만 연결한다. Daemon은 hello 버전을 확인하며 키 검증은 `--require-key`에서만 수행한다. 지정 Workspace와 전송 한도는 유지하고 임의 주소를 중계하지 않는다. 플랫폼 WebClient는 기본 loopback 주소 외에 화면이 지정한 정확한 개발 중계 주소 하나만 허용한다. 종료 요청도 Preview 경로 아래의 `__worknaru_dev`를 사용하고 instance ID를 검증하며 키 검증은 실행 옵션을 따른다.

공유는 기본 20분이다. 만료·Dashboard 해제는 연결 경로만 제거하고 개발 프로세스를 종료하지 않는다. 개발 서버 종료 시에는 이번 ID만 해제하며, 이미 만료 후 정리되거나 해제된 연결은 다시 삭제하지 않는다. 해제 실패는 터미널에서 ID와 함께 알린다. 외부 연결·공유 경로가 없어져도 서버가 실행 중이면 로컬 Preview 경로에서 이어 점검할 수 있다.

실행할 때마다 Preview ID와 주소가 달라진다. 저장된 대화와 설정은 그대로지만, 미확정 요청의 브라우저 접수 장부는 기존과 같이 같은 Origin·탭·Daemon 주소 범위에 한정된다. 새 공유 주소로 이동해 이전 주소의 미확정 요청을 자동 복구하거나 다시 전송하지 않는다. 연결 해제 후 재개 시에는 저장된 대화와 접수 상태를 확인한다.

터미널에는 정확한 ID·만료 시각·공유 주소와 아래 형태의 명령을 출력한다. `<id>`는 해당 실행의 실제 값으로 바꾼다.

```powershell
& 'C:\Projects\TailscaleOps\scripts\artifact-preview\Extend-ArtifactPreview.ps1' -Id <id> -Minutes 20
& 'C:\Projects\TailscaleOps\scripts\artifact-preview\Detach-ArtifactDevServer.ps1' -Id <id>
```

일반 서버·브라우저 검사는 로컬에서 Hub 경로와 채팅·HMR·종료를 확인하며 실제 공유를 만들지 않는다. 실제 Hub 통합 검증은 아래 명령으로 별도 실행한다. 가짜 ACP 에이전트의 임시 서버를 연결해 Local/Tailnet HTTP, WSS 채팅, HMR을 검증하고 해당 공유와 임시 서버를 정리한다. 공유 Hub는 실행 상태로 남으며 실제 모델 질문은 보내지 않는다.

```powershell
npm run build
$env:WORKNARU_TEST_HUB = '1'
node --test tests/dev-hub-live.mjs
Remove-Item Env:WORKNARU_TEST_HUB
```

### 개별 Daemon 실행

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

## 독립 Daemon CLI

관련 작업: [#26](https://github.com/NaruForge/worknaru/issues/26). 이 절은 일반 업무 WebSocket과 구분되는 로컬 실행·운영 계약이다. 현재 checkout의 `node dist/cli.js`를 사용한다. `package.json`의 `worknaru` bin은 같은 파일을 가리키며, 전역 설치·npm 배포·OS 서비스·백그라운드 상주는 제공하지 않는다.

```powershell
# UI 없는 빌드와 실행
npm run build:daemon
$env:WORKNARU_TOKEN = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
node dist/cli.js daemon start --foreground --data-dir .worknaru-dev --workspace . --port 4310

# 위 실행을 종료한 뒤, 번들 UI 및 AI 실행을 켜는 예
npm run build
node dist/cli.js daemon start --data-dir .worknaru-dev --workspace . --port 4310 --acp --codex-path (Get-Command codex.exe).Source --web-ui --open
```

`start`는 저장소 초기화·복구, listen, 요청한 UI의 산출물 검증과 운영 정보 준비가 끝난 뒤 stdout에 `daemon.ready` JSON 한 줄을 출력한다. `url`, `httpOrigin`, `workspace`, `storeEpoch`, `daemonInstanceId`, `webUi`, `aiExecution`을 포함한다. 준비 완료와 제공자 로그인·실제 모델 호출 성공은 별개다. 업무 접속키는 출력하지 않는다.

### 명령과 대상

| 명령/옵션 | 의미 |
| --- | --- |
| `daemon start` / `--foreground` | 터미널에 붙은 실행. `--background`는 오류다. |
| `start --data-dir <dir> --workspace <folder>` | 두 값 모두 필수. data-dir은 checkout 안의 별도 디렉터리, Workspace는 기존 폴더다. 두 상대 경로 모두 cwd와 무관하게 CLI가 속한 checkout root 기준이다. |
| `start --port <n>` | 기본 0: 사용 가능한 포트 배정. 명시한 1~65535 포트가 사용 중이면 실패하며 다른 프로세스를 종료하거나 다른 포트로 이동하지 않는다. |
| `start --origin <url>` | 기존 정확한 로컬 Origin 허용 목록. 여러 번 지정할 수 있다. 번들 UI의 실제 origin은 자동으로 포함한다. wildcard나 외부 바인딩을 허용하지 않는다. |
| `start --acp --codex-path <file>` | 기존 Codex ACP 실행을 켠다. codex-path는 acp와 함께 사용하며, 생략 시 기존 codex-acp의 실행 파일 탐색을 사용한다. |
| `start --web-ui` | `dist/web`의 빌드 산출물을 Daemon의 HTTP origin에서 제공한다. Vite/빌드/설치를 자동 실행하지 않는다. 산출물 누락·부적합은 시작 실패다. |
| `start --open` / `--no-open` | 기본은 브라우저를 열지 않음. open은 web-ui가 필요하며 두 옵션 동시 지정은 오류다. 브라우저 열기 실패는 경고와 URL을 남기고 준비된 Daemon을 유지한다. |
| `daemon status --data-dir <dir> [--json]` | 실제 인스턴스의 응답을 확인한다. 없거나 잘못된 데이터 영역을 생성·수정하지 않는다. |
| `daemon stop --data-dir <dir>` | 활성 Run·승인 대기가 없을 때 정상 종료한다. 작업이 있으면 거절한다. |
| `daemon stop --data-dir <dir> --cancel-active` | 활성 Run·승인 대기를 중단하고 정상 종료한다. 승인 자동 허용·이미 적용한 파일 변경 원복·기록 삭제는 하지 않는다. |
| `--help` / `--version` | 실행·인증·데이터 변경 없이 도움말 또는 package version을 출력한다. |

같은 데이터 영역에서는 기존 SQLite 소유권 잠금을 얻은 하나의 Daemon만 실행한다. 새 CLI는 잠금 획득 후, 저장된 Workspace가 요청한 폴더와 다른지 검사하고 `WORKSPACE_CONFLICT`로 거절한다. 다른 Workspace로 조용히 연결하거나 기존 데이터를 이동하지 않는다. 기존 `npm start`/`startDaemon()`의 과거 여러 Workspace 조회·저장 의미는 변경하지 않았다. 그런 데이터 영역에 여러 Workspace가 있으면 새 CLI는 거절하며 별도 데이터 영역을 지정해야 한다.

### 인증과 종료 수명

업무 WebSocket은 기존 `WORKNARU_TOKEN` 인증을 유지한다. 번들 화면은 같은 origin의 `/ws`를 기본 주소로 표시하고 사용자가 키를 입력한다. 키는 화면 메모리에만 두며 URL·HTML·브라우저 저장소에 넣지 않는다. 새로고침 뒤에는 다시 입력한다. 번들 UI에는 개발 서버 종료 버튼이 없다. `npm run dev`의 선택적 키 인증과 개발 종료·Hub 동작은 그대로다.

운영 제어는 `ops.token`의 별도 무작위 키를 사용한다. 이 파일은 해당 instance ID와 키를 담고, Windows에서는 **내용을 쓰기 전에 현재 사용자만 허용하는 DACL**을 적용한다. 다른 플랫폼에서는 0600으로 만든다. 일반 발견 정보 `runtime.json`에는 키가 없다. 상태·종료 명령은 먼저 일회성 challenge에 대한 HMAC 응답으로 상대가 해당 운영 키를 가지고 있는지 확인하고, data-dir·instance ID·앱/계약 버전을 대조한 뒤 운영 요청을 보낸다. 발견 정보와 키의 인스턴스가 달라진 경우 다시 조회해야 한다. 원본 `WORKNARU_TOKEN`은 운영 요청에 사용하지 않는다.

제어 경로는 같은 loopback 서버의 `/__worknaru_ops/identify`(GET), `/status`(GET), `/stop`(POST)다. `/status`, `/stop`은 해당 접두 경로 아래에 있다. 정확한 Host를 요구하며 **Origin이 있는 운영 요청은 모두 거절**한다. 상태·종료는 Bearer 운영 키와 `X-WorkNaru-Instance`를 확인한다. `--cancel-active`는 `X-WorkNaru-Cancel-Active: yes`로 전달한다. 이 경로는 일반 업무 capability에 포함하지 않는다. 동일 OS 사용자나 관리자에 대한 격리는 제공하지 않는다. 실제 Windows 시험은 토큰 파일 DACL과 잘못된 키·Host·Origin·인스턴스 거절을 확인하며, 별도 OS 사용자로 가장해 접근하는 시험은 포함하지 않는다.

종료는 활성 실행을 확인하고 같은 동기 구간에서 새 업무 접수를 막는다. 이어 새 TCP/HTTP 접수를 중지하고, 소유 ACP·연결·저장소를 정리한다. 운영 파일 정리는 SQLite 소유권을 놓기 전에 해당 인스턴스 파일에만 수행한다. stop 응답 연결 하나는 완료 본문을 보낼 때까지 남긴다. 키·소켓·저장 정리가 확인된 경우에만 해당 instance ID의 `stopped: true`를 반환한다. 응답 유실·timeout·저장/프로세스 정리 실패를 성공으로 추정하지 않는다.

Foreground Ctrl+C/SIGTERM은 활성 작업 중단을 포함한 같은 정리 경로를 사용한다. 탭 닫기·새로고침·RPC 클라이언트 종료는 Daemon이나 접수된 Run을 종료하지 않는다. 정상 종료와 비정상 종료 후에도 기존 기록·설정·접수 장부를 보존하며, 다음 시작은 기존 복구 정책을 따른다. 미확정 실행을 재전송하거나 파일을 자동 원복하지 않는다.

### 출력·오류·복구

`status --json` 성공은 stdout에 `daemon.status` 한 줄을 출력하며 `running`, `instanceId`, `dataDir`, `workspace`, `port`, `url`, `httpOrigin`, `protocolMajor`, `appVersion`, `webUi`, `aiExecution`, `activeRuns`, `pendingApprovals`를 포함한다. 기본 status는 사람이 읽는 텍스트다. stop 성공은 stdout의 `daemon.stopped` JSON이다. 모든 오류는 stderr의 `cli.error` 한 줄(`code`, `message`, busy일 때 실행·승인 개수)과 아래 종료 코드를 사용한다. `cli.warning`은 브라우저 열기 실패 같은 비치명적 안내이며 Daemon은 유지한다.

| 종료 코드 | 의미와 대표 오류 |
| --- | --- |
| 0 | 도움말/버전·조회·확인된 정상 종료 성공 |
| 1 | 일반 기동/저장 오류: `DATA_IN_USE`, `PORT_IN_USE`, `WORKSPACE_CONFLICT`, `WEB_UI_UNAVAILABLE` 등 |
| 2 | 사용법·설정 오류: `USAGE`, `INVALID_PORT`, `INVALID_ORIGIN`, `INVALID_DATA_PATH`, `INVALID_WORKSPACE`, `INVALID_AUTH_CONFIG` |
| 3 | 데이터 영역 또는 발견 정보 부재: `DATA_NOT_FOUND`, `NOT_RUNNING` |
| 4 | 실제 응답 없음·중단·시간 초과: `NO_RESPONSE`. 생존/종료 결과를 확정하지 않는다. |
| 5 | 운영 키·서버 인증 실패: `AUTH_FAILED`, `INVALID_OPS_TOKEN` |
| 6 | 인스턴스/버전/경로 불일치 또는 손상·링크된 발견 정보: `TARGET_MISMATCH`, `INVALID_DISCOVERY` |
| 7 | 활성 실행/승인 대기로 종료 거절: `DAEMON_BUSY` |
| 8 | 정리 실패 또는 유효한 완료 응답 없음: `STOP_UNCONFIRMED` |

신원 확인은 총 3초, status는 그 뒤 총 5초, stop은 그 뒤 총 180초가 한도다. 데이터를 조금씩 받더라도 전체 기한은 늘어나지 않는다. 네트워크 응답은 16KiB로 제한한다. 중간 연결 단절이나 잘못된 JSON은 비영 코드로 끝난다. CLI의 stop 대기 기한 초과는 서버에 재전송·강제 kill을 지시하는 동작이 아니다.

```powershell
# 다른 터미널: 업무 키를 복사하지 않아도 같은 사용자의 운영 파일로 확인한다.
node dist/cli.js daemon status --data-dir .worknaru-dev --json
$LASTEXITCODE
node dist/cli.js daemon stop --data-dir .worknaru-dev
# busy일 때 영향을 확인하고 명시적으로 중단한다.
node dist/cli.js daemon stop --data-dir .worknaru-dev --cancel-active
```

`NOT_RUNNING`은 이 CLI의 발견 정보가 없다는 뜻이다. 운영 메타데이터를 만들지 않는 기존 `npm start`/`npm run dev`로 실행한 Daemon은 관리 대상이 아니며, 그 실행의 기존 종료 방법을 사용한다. 발견 정보가 있어도 실제 응답이 없으면 오래된 것으로 확정해 삭제하거나 PID·포트로 다른 프로세스를 종료하지 않는다. 기존 foreground 터미널과 명시한 데이터 경로를 확인한다. 재시작은 소유권 잠금을 다시 획득한 실행만 운영 정보를 갱신하며, 기존 인스턴스가 살아 있으면 거절한다. 손상된 업무 DB를 삭제하거나 접수된 요청을 새 요청으로 반복해서 보내지 않는다.

정적 제공은 검증된 `dist/web` 안의 파일로 제한한다. 잘못된 index/참조 산출물, 경로 이탈·링크/hard link, 잘못된 Host·Origin, 제어 경로와의 충돌을 거절한다. API 오류를 index.html로 대체하는 SPA fallback은 제공하지 않는다. HTML/asset은 no-store로 제공하며 런타임에 Web 빌드가 없으면 요청한 UI 실행만 실패한다.

### 검증

`test:daemon`은 Web 빌드 없이 CLI 시험을 포함한다. 별도 Daemon-only checkout fixture에서도 CLI 기동·공개 RPC 저장·종료와 UI 누락 오류를 확인한다. `npm test`는 기존 개발 실행 검사와 정적 번들 검사를 포함한다. `test:web`는 기존 화면 시험과 실제 별도 CLI 프로세스의 번들 UI 인증·채팅·재접속·탭 종료 후 무접속 실행 완료를 검증한다.

CLI 시험은 실제 SQLite·가짜 ACP와 별도 프로세스를 사용한다. 저장 실패 시 종료 실패 보고·하위 프로세스 정리, 실제 승인 대기 거절, 두 start의 소유권 경쟁, 운영 파일 접근 제한, 위조/손상/오래된 발견 정보와 응답 유실을 확인한다. Windows의 SIGINT 시험은 시험 전용 IPC wrapper에서 실제 SIGINT handler를 호출한다. 실제 콘솔 키 입력·로그오프·재부팅 후 수명을 검증했다고 주장하지 않는다. 실제 유료 모델이나 실제 Hub lease는 사용하지 않는다.

## 접속과 호출 예

### UI 없는 공통 호출 도구

관련 작업: [#23](https://github.com/NaruForge/worknaru/issues/23). `npm run build:daemon`은 TypeScript 서버·공통 코드·개발 클라이언트만 컴파일한다. `npm run test:daemon`은 Web 빌드·Vite·브라우저 없이 저장·ACP·설정·파일 승인·접속 클라이언트·RPC 도구의 Node 검사를 실행한다. 가짜 ACP를 사용하므로 유료 모델 질문이나 Codex 로그인이 필요하지 않다. 같은 패키지에서 의존성을 설치하며, `npm test`와 `npm run test:web`는 기존 전체 검증으로 유지한다.

`npm run rpc`는 기존 Daemon 계약을 호출하는 개발용 도구다. UI를 띄우지 않고 기록 저장, 설정 변경, 실행과 취소, 파일 승인·거절을 요청한다. 업무별 전용 CLI나 자동 작업 실행기는 아니다.

```powershell
npm run build:daemon
$env:WORKNARU_TOKEN = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
npm start -- --data-dir .worknaru-dev --workspace . --port 4310
# 실제 AI 실행이 필요하면 위 Daemon을 종료한 뒤 다음 명령으로 실행한다.
npm start -- --data-dir .worknaru-dev --workspace . --port 4310 --acp --codex-path (Get-Command codex.exe).Source
```

다른 터미널에서 **같은** `WORKNARU_TOKEN`을 설정하고 다음 예제를 실행한다. URL은 실제 Daemon의 출력과 일치시킨다. 아래에서 `--silent`는 npm 안내 문구를 생략해 JSON만 파이프로 전달하기 위한 옵션이다.

```powershell
$rpcUrl = 'ws://127.0.0.1:4310/ws'
$ready = npm run --silent rpc -- --url $rpcUrl | ConvertFrom-Json
$ready.capabilities
$ready.storeEpoch

# 요청 파일을 사용할 때: 저장소 내부의 개발 임시 파일이다.
New-Item -ItemType Directory -Force .worknaru-test | Out-Null
@{ method = 'workspaces.get'; params = @{} } | ConvertTo-Json -Depth 10 |
    Set-Content -Encoding utf8 .worknaru-test/rpc-request.json
npm run --silent rpc -- --url $rpcUrl --request-file .worknaru-test/rpc-request.json
```

| 옵션 | 의미 |
| --- | --- |
| `--url` | 필수. `ws://127.0.0.1:<port>/ws` 형태의 로컬 Daemon 주소. URL 자격증명·query·fragment와 Hub 중계 주소는 받지 않는다. Hub와 함께 실행했어도 이 PC의 직접 Daemon 주소로 호출한다. |
| `--request-file <파일>` | UTF-8 JSON 요청 하나. 원문과 전송 요청은 각각 64KiB 이하. 생략하면 연결의 `ready`를 출력하고 종료한다. |
| `--request-file -` | 같은 JSON을 표준 입력에서 읽는다. |
| `--no-key` | 키 없는 개발 실행에 명시적으로 사용한다. 환경 변수의 키를 전송하지 않는다. 기본은 `WORKNARU_TOKEN`을 사용하며 인증 실패 후 자동 전환하지 않는다. |
| `--timeout-ms` | 연결 확인 및 요청 응답에 각각 적용하는 시간. 기본 60000ms, 1~2147483647 정수. `runs.watch` 초기 응답 이후에는 완료 대기 시간 제한을 두지 않는다. |
| `--help` | 사용법 표시. |

요청은 `{ method, params }`를 사용하고, 변경 요청에는 **직접 지정한** `requestId`, `storeEpoch`를 추가한다. `type`과 `callId`는 도구가 생성하므로 입력하지 않는다. 필드와 입력 검증은 기존 서버 계약을 사용하며 지원 여부는 `ready.capabilities`로 확인한다. 잘못된 식별자나 저장 세대를 자동으로 고치지 않는다.

일반 호출은 기존 `response` 봉투 하나를 JSON으로 출력한다. `runs.watch`는 초기 응답과 이후 `run.changed`를 한 줄씩 출력하고 `completed`, `failed`, `cancelled`에서 종료한다. 저장 장애는 revision 증가 없이 전달될 수 있으므로 같은 revision의 알림도 출력하며, 더 오래된 revision만 제외한다. 정상 조회의 종료 코드 0은 조회 성공을 뜻하며, 조회한 Run 자체가 성공했다는 뜻은 아니다. 입력·연결·프로토콜·서버 오류는 종료 코드 1이고 진단은 표준 오류에 출력한다. 인증키는 출력하지 않는다. 응답에는 요청한 대화·파일 본문이 포함될 수 있다.

다음 함수는 표준 입력으로 요청을 보내는 예제다. 업무 판정이나 자동 재시도는 하지 않는다.

```powershell
function Invoke-WorkNaruRpc([hashtable]$Request) {
    $rpcJson = $Request | ConvertTo-Json -Depth 10
    $rpcOutput = $rpcJson | node dist/rpc-client.js --url $rpcUrl --request-file -
    if ($LASTEXITCODE -ne 0) { throw '호출 확인 실패. 변경 요청은 재전송 전에 접수 결과를 확인하세요.' }
    return ($rpcOutput | ConvertFrom-Json).result
}
$workspace = Invoke-WorkNaruRpc @{ method = 'workspaces.get'; params = @{} }
$createId = [guid]::NewGuid().ToString()
$created = Invoke-WorkNaruRpc @{
    method = 'sessions.create'; params = @{ workspaceId = $workspace.workspaceId; title = 'Headless 점검' }
    requestId = $createId; storeEpoch = $ready.storeEpoch
}
$sessionId = $created.session.sessionId

# AI 없이 저장·조회. 이 연산은 AI에게 질문하지 않는다.
$appendId = [guid]::NewGuid().ToString()
Invoke-WorkNaruRpc @{
    method = 'messages.append'; params = @{ sessionId = $sessionId; text = '저장 확인' }
    requestId = $appendId; storeEpoch = $ready.storeEpoch
}
Invoke-WorkNaruRpc @{ method = 'messages.list'; params = @{ sessionId = $sessionId } }
```

이하 AI 메타데이터·설정 변경·실행·승인은 `--acp`를 켠 Daemon에서 수행한다. `ai.get` 성공 후 제공자가 지원하는 모델·추론 강도로 설정한다. 설정과 인증 조회 자체는 모델 질문을 보내지 않는다.

```powershell
$info = Invoke-WorkNaruRpc @{ method = 'ai.get'; params = @{} }
$info.models
$selection = @{ model = 'gpt-5.6-luna'; reasoningEffort = 'low' }
Invoke-WorkNaruRpc @{
    method = 'settings.update'; params = @{ selection = $selection }
    requestId = [guid]::NewGuid().ToString(); storeEpoch = $ready.storeEpoch
}
Invoke-WorkNaruRpc @{ method = 'settings.get'; params = @{} }
Invoke-WorkNaruRpc @{
    method = 'sessions.configure'; params = @{ sessionId = $sessionId; selection = $selection }
    requestId = [guid]::NewGuid().ToString(); storeEpoch = $ready.storeEpoch
}

# 실제 모델 질문 1회.
# 파일 승인 점검은 Workspace에 sample.txt를 준비한 뒤 text를
# 'sample.txt를 읽고 마지막 문장을 검토 완료로 바꿔줘'로 바꿔 요청한다.
$runRequestId = [guid]::NewGuid().ToString()
$started = Invoke-WorkNaruRpc @{
    method = 'runs.start'; params = @{ sessionId = $sessionId; text = '안녕하세요' }
    requestId = $runRequestId; storeEpoch = $ready.storeEpoch
}
$runId = $started.run.runId
@{ method = 'runs.watch'; params = @{ runId = $runId } } | ConvertTo-Json |
    node dist/rpc-client.js --url $rpcUrl --request-file -
```

구독 도중 `Ctrl+C`는 연결만 닫으며 Run을 취소하지 않는다. 구독을 닫은 뒤 또는 별도 터미널에서 같은 키·URL·식별자로 다음 요청을 보낼 수 있다.

```powershell
$run = Invoke-WorkNaruRpc @{ method = 'runs.get'; params = @{ runId = $runId } }
$run.tools | Format-List path,before,after,state,toolId

# 실제 pending 수정안의 경로와 전체 before/after를 검토한 경우에만 응답한다.
$toolId = ($run.tools | Where-Object state -eq 'pending' | Select-Object -First 1).toolId
$decision = 'reject' # 검토 후 허용하려면 'allow'를 명시한다.
Invoke-WorkNaruRpc @{
    method = 'permissions.respond'; params = @{ runId = $runId; toolId = $toolId; decision = $decision }
    requestId = [guid]::NewGuid().ToString(); storeEpoch = $ready.storeEpoch
}

# 진행 중인 실행을 명시적으로 중단할 때만 호출한다.
Invoke-WorkNaruRpc @{
    method = 'runs.cancel'; params = @{ runId = $runId }
    requestId = [guid]::NewGuid().ToString(); storeEpoch = $ready.storeEpoch
}
```

시간 초과·연결 유실로 변경 응답을 확인하지 못해도 서버가 이미 접수했을 수 있다. 도구는 자동 재전송하지 않고 사용한 요청 식별자와 저장 세대를 진단에 남긴다. 예를 들어 위 실행 요청의 응답을 놓쳤다면 다음처럼 **같은** 식별자를 조회한다.

```powershell
$receipt = Invoke-WorkNaruRpc @{
    method = 'requests.get'
    params = @{ workspaceId = $workspace.workspaceId; requestId = $runRequestId; storeEpoch = $ready.storeEpoch }
}
if ($receipt.found) {
    $receipt.result
    # 접수 당시 결과다. 현재 상태는 반환된 runId로 runs.get을 다시 호출한다.
}
```

`found: false`와 조회 실패·저장 세대 불일치는 다르다. 도구는 어느 경우에도 새 요청으로 자동 재실행하지 않는다. 파일 적용 완료 여부는 Run의 파일 기록으로 확인하며, 결과 불명은 실제 파일 확인이 필요하다. 승인 대기와 만료 정책은 UI와 동일하고 연결이 없어도 자동 허용하지 않는다. Daemon을 종료하려면 소유 실행기나 Daemon 터미널을 사용한다.

### 원시 WebSocket 봉투

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
| `sessions.get` | Session ID로 정보와 `aiUnavailable`, `latestRunId`, `latestRunState`, `storageAvailable`, 선택한 `model`·`reasoningEffort`를 조회한다. 최신 실행의 상세 본문은 `runs.get/watch`로 확인한다. |
| `sessions.list` | Workspace·선택적인 `after`·`limit`·`order`로 같은 요약 정보의 목록을 조회한다. 기본 `asc`는 기존 오름차순이고, `desc`는 최신 생성 순이다. `after: 0`에서 시작해 `nextAfter`를 같은 정렬의 다음 페이지에 사용한다. |
| `messages.append` | Session·텍스트와 요청 ID·epoch로 저장한다. |
| `messages.list` | Session·선택적인 `after`·`upTo`·`limit`으로 메시지를 조회한다. |
| `requests.get` | params의 Workspace·요청 ID·`storeEpoch`로 최초 접수 결과를 조회한다. |

변경 요청의 `requestId`는 같은 Workspace·서버 호출 범위에서 재시작 뒤에도 보존한다. 같은 ID와 같은 정규화 내용은 최초 결과를 반환하며 다른 내용·연산은 충돌이다. 응답을 놓쳤다면 `requests.get`으로 확인한다. 저장 장애나 epoch 불일치는 ‘접수 기록 없음’이 아니다.

메시지 페이지의 `nextAfter`가 있으면 그 값을 다음 `after`로 보내고 첫 페이지의 `upTo`를 유지한다. 새 메시지가 추가돼도 읽고 있던 이력의 상한이 바뀌지 않는다.

## 현재 접속·저장 조건

- IPv4 loopback에만 바인딩한다. 정확한 Host·`/ws` 경로를 확인하고 URL의 query를 거절한다. Origin이 있는 접속은 기본적으로 거절하며, 로컬 개발 화면에 필요할 때 `--origin http://127.0.0.1:3000`처럼 정확히 지정한다.
- 첫 메시지에서 hello 버전을 확인한다. 개별 Daemon 및 `--require-key` 통합 실행은 토큰도 검증하고 인증 전 업무 데이터를 보내지 않는다. 키 없는 통합 실행은 `{ "type": "hello", "protocolMajor": 1 }`로 연결하며, 토큰이 생략된 요청을 키 인증 모드에 보내면 `AUTH_FAILED`로 거절한다. 토큰을 사용할 때에는 이 실행의 단일 로컬 소유자를 인증한다. 서버가 Module 범위를 `chat`으로 정한다. 요청의 자체 Module 선언이나 다른 Workspace·Session ID로 범위를 넓힐 수 없다.
- 토큰은 환경 변수로 전달하는 개발용 방식이다. 실행 중 토큰 폐기·변경은 제공하지 않으며, 데몬을 종료하고 새 토큰으로 재시작한다. 같은 OS 사용자의 악성 코드까지 격리하는 기능은 아니다.
- 수신 프레임은 64KiB, 텍스트는 UTF-8 16KiB, 응답은 256KiB, 메시지 페이지 본문은 약 192KiB 이하로 제한한다. 연결은 최대 16개, 연결별 요청은 초당 120개까지다. hello 대기는 5초이며 송신 대기량은 512KiB 이하로 제한한다.
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

기존 CLI의 `CODEX_HOME` 또는 기본 `.codex`에 있는 `auth.json`을 개발 데이터 안의 `codex/auth.json`으로 시작 시 복사해 사용한다. 원본 CLI 설정·로그인은 변경하지 않는다. 에이전트 기록과 임시 파일도 개발 데이터 안에 둔다. 이 영역에는 인증정보와 대화 기록이 있으므로 Git에 추가하지 않는다. Settings는 이 사본을 사용하는 제공자의 인증 상태를 조회한다. 로그인·로그아웃·계정 전환 UI는 제공하지 않는다. 원본 CLI의 로그인 변경을 반영하려면 Daemon을 다시 실행한다.

### 실행 계약

| 연산 | 입력과 결과 |
| --- | --- |
| `runs.start` | 변경 요청 ID·epoch와 `sessionId`, `text`를 받는다. Run·사용자 메시지·빈 답변 메시지·최초 접수 결과를 한 번에 커밋한다. 반환하는 `accepted`는 접수 확정이며 AI 완료를 뜻하지 않는다. |
| `runs.get` | `runId`로 현재 상태, 저장된 답변 `text`, `revision`, `errorCode`, `stopReason`, `storageAvailable`, 실행에 선택한 `model`·`reasoningEffort`, 전달 직전 제공자 확인 여부인 `modelConfirmed`(0 또는 1)를 조회한다. |
| `runs.watch` | `runId`의 현재 스냅샷을 반환하고 그 뒤 커밋을 `run.changed`로 보낸다. 같은 이벤트 루프에서 조회·구독을 등록하므로 중간 커밋이 빠지지 않는다. |
| `runs.unwatch` | 해당 연결의 Run 구독을 해제한다. |
| `runs.cancel` | 변경 요청 ID·epoch와 `runId`를 받는다. `cancelling`을 저장하고 ACP 취소 및 프로세스 정리를 수행한다. 종료 확인 이후 `cancelled`를 저장한다. 이미 최종 상태인 Run은 유지한다. |

변경 연산은 기존 `requestId`·내용 충돌 규칙을 따른다. 같은 실행 요청을 재전송해도 최초 접수 결과만 반환하며 AI에 다시 전달하지 않는다. **최초 접수 결과의 Run은 당시 스냅샷이다. 현재 상태는 `runs.get` 또는 `runs.watch`로 확인한다.** 같은 Session에서 다른 Run이 미종료 상태라면 `SESSION_BUSY`로 거절한다.

`messages.list`에 `role`(`user` 또는 `assistant`)과 `runId`가 추가된다. 실행 중 답변 메시지는 커밋마다 갱신된다. 메시지 페이지의 `upTo`는 메시지 순번 상한이며 실행 중 본문을 과거 시점에 고정하는 값은 아니다. 실행의 일관된 답변 스냅샷에는 `runs.get/watch`의 `revision`을 사용한다. 답변 조각은 저장 후 전달하며, 종료 상태는 늦은 출력으로 되돌리지 않는다.

`run.changed`는 전체 Run 스냅샷이다. 클라이언트는 현재 Run과 revision을 기준으로 반영하고 재접속하면 다시 구독한다. 전체 대화를 이벤트로 보관·재생하지 않는다. 저장 장애 중에는 `storageAvailable: false`로 마지막 저장 상태와 현재 실행 여부를 구분한다. 저장하지 못한 완료를 확정하지 않으며, 클라이언트는 조회로 저장소 상태도 확인해야 한다.

### 종료와 재시작

Windows 감독 프로세스가 이름이 있는 Job Object를 만들고, 에이전트를 일시 정지 상태로 생성해 Job에 명시적으로 넣은 뒤 실행한다. 자식 프로세스도 같은 관리 범위에 들어간다. Job 이름은 생성 전에 저장하며 PID 목록으로 소유권을 추정하지 않는다. 데몬의 시작 확인 응답 전에는 에이전트를 실행하지 않는다. 입력 파이프 종료 감지와 별개로 데몬의 프로세스 핸들을 감시하므로, 에이전트의 입력 읽기가 멈춰도 데몬 종료 시 Job을 정리한다. 감독 프로세스 종료 시에도 Job을 정리한다. 재시작 시 저장된 Job을 정리하고 활성 프로세스가 없는지 확인한다. [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

중단된 입력은 자동 재전송하지 않는다. 전달 전 중단은 `INTERRUPTED_BEFORE_DELIVERY`, 전달을 시도했으나 결과가 불명확하면 `EXECUTION_OUTCOME_UNKNOWN`으로 실패 처리한다. 정리를 확인하지 못하면 `PROCESS_CLEANUP_UNKNOWN`과 미종료 상태를 유지하며 해당 Session의 새 실행을 막는다. 이 오류는 파일 변경이 없었다는 뜻이 아니다.

같은 데이터 경로·Workspace로 `--acp` 재시작하면, 이전 프로세스의 정리가 확인되고 마지막 Run이 `completed`이며 provider Session ID가 있는 대화를 다시 사용할 수 있다. 정상 종료와 강제 종료 모두 마지막 답변의 저장된 완료 상태를 기준으로 판단한다. 취소·실패·실행 중 중단된 대화와 정리 불명 대화는 기록 보기로 유지한다. 실행 중 에이전트 연결이 끊긴 경우에도 그 자리에서 자동 재개하지 않는다.

재시작은 에이전트를 한꺼번에 열거나 질문을 자동 전송하지 않는다. 기존 대화에서 사용자가 후속 질문을 보내면 에이전트를 시작하고 초기화 응답의 기능을 확인한다. `sessionCapabilities.resume`을 지원하면 `session/resume`, 그렇지 않고 `loadSession`을 지원하면 `session/load`를 호출한다. 저장된 provider Session ID·같은 Workspace·빈 MCP 서버 목록을 사용하고, 시작 중에도 원래 ID를 보존한다. 기존 텍스트 전용 설정을 다시 적용한다. `session/load`의 과거 메시지 알림은 새 Run 출력으로 저장하지 않으며, WorkNaru의 SQLite 기록을 화면 원본으로 유지한다. 새 Session을 만들거나 저장 전문을 새 질문으로 재전송해 재개를 대신하지 않는다. [ACP 세션 설정](https://agentclientprotocol.com/protocol/v1/session-setup), [Codex thread 재개](https://learn.chatgpt.com/codex/app-server#start-or-resume-a-thread)

`sessions.get`의 `aiUnavailable: 0`은 새 실행을 접수할 수 있다는 뜻이며 재개 성공 보장은 아니다. `runs.start`의 접수 결과와 실제 재개·질문 실행을 구분한다. 재개 미지원은 `SESSION_RESUME_UNSUPPORTED`, 재개 거절·프로바이더 기록 없음은 `SESSION_RESUME_FAILED`, 30초 초과는 `SESSION_RESUME_TIMEOUT`으로 실패한다. 이때 새 질문의 `delivery`는 `not_attempted`이고 입력·빈 답변·실패 Run 및 기존 기록이 보존된다. UI는 재개 실패를 안내하며 새 대화를 시작할 수 있다. 실패·취소 후 해당 대화는 `aiUnavailable: 1`과 `SESSION_UNAVAILABLE`로 추가 실행을 막으며 재시작만으로 실패한 질문을 재시도하지 않는다. 정리까지 확인하지 못하면 `PROCESS_CLEANUP_UNKNOWN`이 우선한다.

ACP 비활성 상태에서도 기록은 조회할 수 있다. 프로세스 정리·재개 자격 확인은 `--acp` 재시작에서 수행한다. 프로바이더 기록은 개발 데이터의 `codex` 하위에 있으므로 SQLite 파일만 복사해서는 맥락 재개를 보장하지 않는다. 현재 저장 형식은 파일 승인 기록을 추가한 v4다. 파일 승인 migration은 아래 파일 수정 절을, 이전 대화의 모델 선택과 v3 변경은 Settings 절을 따른다. 관련 작업: [#12 재실행 후 대화 이어가기](https://github.com/NaruForge/worknaru/issues/12).

### 현재 한도와 검증 범위

- 텍스트 입력과 실행별 답변은 각각 UTF-8 16KiB다. 답변 한도 초과 시 저장된 부분을 보존하고 `OUTPUT_LIMIT`으로 실패 처리한다. 첨부 파일·이미지·큰 답변의 조각 조회는 후속 범위다.
- 데몬당 열린 에이전트 연결은 최대 4개, 클라이언트당 Run 구독은 최대 16개다. 종료된 에이전트는 연결 수에서 제외하고 해당 Session을 사용 불가로 표시한다. 연결 해제 UI·유휴 정리 정책은 후속 범위이며 초기 연결은 정상 대화의 맥락 유지를 위해 유지한다.
- 감독 프로세스 준비 15초, ACP 초기화·Session 생성·재개 각 30초, 질문 실행 120초의 한도를 적용한다. 정상 취소는 ACP 알림 뒤 프로세스 트리 정리까지 확인한다. 재개 중 취소는 준비 중인 프로세스를 정리하며 새 질문을 보내지 않는다. Job 조사·종료를 확인하지 못하면 성공으로 간주하지 않는다.
- 텍스트 대화와 아래의 전용 Workspace 파일 도구를 제공한다. 셸·앱·플러그인 등 기존 연결 기능은 끈다. 전용 파일 도구의 ACP 표시 이벤트만 허용하고, 다른 도구 이벤트는 `TOOLS_UNSUPPORTED`, 별도 ACP 권한 요청은 `PERMISSION_UNSUPPORTED`로 종료한다. 파일 변경 승인은 Daemon이 직접 처리한다. 이 클라이언트 설정은 악성 에이전트를 격리하는 보안 경계가 아니며, 어댑터의 `read-only`라는 모드 이름도 실제 파일시스템 읽기 전용을 보장하지 않는다.
- 저장소 v1을 처음 열면 SQLite `VACUUM INTO`로 `records-v1-<uuid>.sqlite` 백업을 만든 다음 트랜잭션으로 v2를 거쳐 현재 v4로 전환한다. v2의 백업·전환은 아래 Settings 절을 따른다. 메시지·최초 접수 결과·epoch를 유지한다. 지원 밖 형식이나 실패한 변경을 빈 DB로 대체하지 않는다. 사용자용 백업·복원 기능은 제공하지 않는다.

`npm test`는 실제 SQLite와 별도 ACP 시험 프로세스로 중복·경쟁·스트리밍·취소·시작 중 취소·강제 종료·재시작·저장 장애·출력 및 프로토콜 한도·v1 변환·개발용 클라이언트를 검증한다. 시험용 에이전트 선택은 시험 진입점에만 있으며 제품 실행 옵션으로 노출하지 않는다.

실제 Codex와의 확인은 별도로 실행하며 모델 요청을 발생시킨다. 기존 로그인과 명시적인 `WORKNARU_CODEX_PATH`가 있어야 한다. `test:live`와 `test:web:live`는 이 환경 변수가 없으면 실제 검증을 건너뛴다. 두 시험 모두 `gpt-5.6-luna`·`low`를 실행 정책으로 고정하고, 다른 선택값이나 제공자의 미지원·적용 확인 실패를 질문 전달 전에 차단한다. 개인 CLI 기본값이나 화면 설정으로 시험 정책을 우회하지 않는다. 각 시험은 첫 질문 후 데몬을 종료·재시작하고 같은 대화의 후속 질문으로 이전 답변의 맥락을 확인하는 실제 요청 2회를 보낸다. 필요한 시험 하나를 명시적으로 실행하며 일반 `npm test`·`test:web`는 가짜 에이전트를 사용한다. 시험이 생성한 데이터·인증 사본·프로세스는 종료 시 정리한다.

```powershell
$env:WORKNARU_CODEX_PATH = (Get-Command codex.exe).Source
npm run test:live
```

관련 공식 자료: [ACP 초기화](https://agentclientprotocol.com/protocol/v1/initialization), [질문과 취소](https://agentclientprotocol.com/protocol/v1/prompt-turn), [Codex ACP 어댑터](https://github.com/agentclientprotocol/codex-acp), [Codex 설정](https://learn.chatgpt.com/codex/config-reference).

## 첫 Chat Web UI

- 작업: [#10 첫 Chat Web UI와 화면 기술 선택 근거](https://github.com/NaruForge/worknaru/issues/10)
- 화면 기준: [A안](design/workspace-chat-ui.md), 비교·선택 근거: [화면 기술 비교](research/2026-09-09-web-ui-technology.md)

화면과 Daemon을 별도로 실행한다. 첫 터미널에서 다음 명령을 사용한다. 토큰은 Daemon과 화면 사이의 개발용 연결 키이며 Codex 로그인 토큰과 다르다.

```powershell
npm run build
$env:WORKNARU_TOKEN = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
$env:WORKNARU_TOKEN | Set-Clipboard
npm start -- --data-dir .worknaru-dev --workspace . --port 4310 --origin http://127.0.0.1:5173 --acp --codex-path (Get-Command codex.exe).Source
```

두 번째 터미널에서 `npm run dev:web`를 실행하고 `http://127.0.0.1:5173`을 연다. 연결 창의 Daemon 주소는 `ws://127.0.0.1:4310/ws`이며, 연결 키에 복사한 값을 붙여 넣는다. 빌드 산출물을 확인할 때는 개발 서버를 종료한 뒤 `npm run preview:web`를 사용한다. 두 화면 서버는 같은 포트를 사용하며, 충돌 시 임의 포트로 이동하지 않는다.

연결 후 **새 대화 → 메시지 전송 → 응답 확인 → 필요 시 중지**를 사용할 수 있다. 정상 완료한 대화는 같은 데이터·Workspace로 Daemon을 재시작한 뒤에도 목록에서 선택해 후속 질문을 보낼 수 있다. 위의 재개 조건과 지원 기능을 확인한 뒤 기존 AI 맥락을 이어간다. 취소·실패·실행 중 중단된 대화는 저장 기록을 보고 새 대화를 시작한다. `--acp` 없이 실행한 Daemon에서는 기록만 조회한다. 페이지를 닫아도 독립 Daemon의 실행은 계속된다.

### 상태와 입력 보존

- 연결 키는 화면 메모리에서만 사용한다. URL·브라우저 저장소·빌드 환경 변수에 넣지 않는다. 새로고침 후에는 다시 입력한다. 현재 화면은 IPv4 loopback의 정확한 `/ws` 주소만 허용한다.
- 일반 초안과 목록 접기·테마는 열린 화면의 메모리에서 유지한다. 다른 대화를 선택해도 초안이 남지만 새로고침·탭 종료 후 일반 초안을 복구하는 기능은 제공하지 않는다.
- 변경 요청은 전송 전에 `requestId`, `storeEpoch`, Workspace, 연산과 필요한 미확정 입력을 같은 탭의 `sessionStorage`에 기록한다. 보관할 수 없으면 보내지 않는다. 접수 확인 후 제거하며 대화 전문을 별도 원본으로 저장하지 않는다.
- 응답을 놓친 요청은 `requests.get`으로 조회한다. 저장소가 같고 접수 기록이 없다고 확인된 경우 입력을 복원하고 사용자의 직접 전송을 기다린다. epoch 불일치나 저장 장애는 접수 없음으로 바꾸지 않는다. 미확정 입력은 안내에서 펼쳐 볼 수 있다.
- 위 접수 복구는 같은 화면 Origin·탭·Daemon 주소·Workspace 범위다. Daemon을 같은 포트로 재시작해야 같은 보관 키를 찾는다. 브라우저 저장 데이터 삭제·새 탭·브라우저 재실행까지 보존을 약속하지 않는다.
- 최신 실행은 스냅샷 구독과 1초 간격 조회로 확인한다. 목록은 약 5초 간격으로 갱신하며, 화면 이동은 실행 취소로 취급하지 않는다. 다른 대화의 표시에는 최근 조회 시점의 상태가 반영된다.
- 다른 클라이언트가 후속 질문을 시작해 최신 실행이 바뀌면, 화면에 남은 이전 실행의 미종료 스냅샷도 조회한다. 이전 답변을 오래된 부분 응답이나 실행 중 상태로 덮어쓰지 않는다.
- 기록은 처음부터 50개씩 조회하고 ‘다음 기록 불러오기’로 이어 읽는다. 읽고 있는 페이지는 `upTo`를 유지한다. 중간 기록이 남아 있어도 최신 실행은 별도로 확인해 새 입력 가능 여부를 판단한다. 마지막 페이지에서는 새 기록을 이어 조회한다.
- 한글 조합 중 Enter는 전송하지 않는다. 응답 중에도 초안을 작성할 수 있고 중지는 별도 버튼으로 요청한다. UTF-8 16KiB 초과 입력은 유지하면서 전송을 막는다. 출력은 일반 텍스트로 표시하며 HTML·Markdown을 실행하거나 렌더링하지 않는다.

### 코드 경계와 검증

`src/web-client.ts`는 React·Node 런타임에 의존하지 않는 플랫폼 접속 코드다. 응답을 Zod로 확인하고 호출 응답과 실행 알림을 구분한다. `src/chat-state.ts`는 Chat의 대화 탐색·초안·접수 복구를 소유한다. `web/workspace.tsx`는 공통 작업 화면, `web/chat.tsx`는 Chat 화면이다. 아직 없는 외부 Module 등록·설치 또는 별도 서비스의 실행 계층을 만들지 않는다.

Daemon과 브라우저의 TypeScript 설정은 분리하되 루트 패키지 하나를 유지한다. `npm run build`는 Daemon과 정적 화면을 빌드한다. 브라우저 산출물은 `dist/web`이고, 개발 서버는 화면·접속 소스와 의존성 디렉터리만 파일 제공 대상으로 허용한다. 개발 데이터·인증 파일을 정적 화면에 포함하지 않는다. 이 실행 방식은 로컬 개발용이며 제품 배포·원격 공개·데스크톱 포장까지 구현한 것은 아니다.

```powershell
npm run typecheck
npm test
npm run test:web
# 기존 Codex 로그인을 사용하는 실제 모델 요청 2회: 종료·재실행 후 맥락 확인
$env:WORKNARU_CODEX_PATH = (Get-Command codex.exe).Source
npm run test:web:live
```

브라우저 시험은 설치된 Microsoft Edge를 사용한다. 별도 ACP 시험 프로세스와 실제 Daemon으로 실행·취소·초안·IME·입력 한도·응답 유실 후 새로고침·기록 페이지·Daemon 재시작 후 대화 재개·모달 포커스·320/390/736px·테마를 확인한다. 저장 장애와 실행 종료 불명의 화면 표시는 WebSocket 응답 변형으로 검증하며 실제 SQLite 장애와 프로세스 정리는 기존 Daemon 시험이 맡는다. 실제 Codex 시험은 첫 응답 뒤 Daemon을 종료·재실행하고 같은 대화에서 임의 토큰을 다시 답하게 해 기존 맥락과 기록 중복 없음을 확인한다. 전체 데스크톱 컨테이너·스크린리더 조합·대용량 문서 편집 성능을 검증한 결과는 아니다.

Windows의 예약 포트 범위 등으로 5173에서 `EACCES`가 발생하면 검증 시 `$env:WORKNARU_TEST_WEB_PORT = '15173'`처럼 사용 가능한 포트를 지정한다. `test:web`와 `test:web:live` 모두 화면 서버·허용 Origin·브라우저 주소를 함께 맞춘다. 기본값은 5173이며 자동으로 임의 포트로 바꾸지 않는다. 수동 실행에서는 `npm run dev:web -- --port 15173` 또는 `npm run preview:web -- --port 15173`와 Daemon의 `--origin http://127.0.0.1:15173`을 함께 사용한다.

## Workspace 파일 수정과 승인

관련 작업은 [#22](https://github.com/NaruForge/worknaru/issues/22)다. `npm run dev`로 실행하고 Chat에서 기존 파일의 경로와 원하는 변경을 요청한다. 예를 들어 Workspace에 있는 `sample.txt`에 대해 “sample.txt를 읽고 마지막 문장을 ‘검토 완료’로 바꿔줘”라고 요청한다. 파일 도구는 Workspace 안의 기존 UTF-8 텍스트 파일 하나를 다루며, 읽기와 수정 전후 내용은 각각 8KiB 이하다.

공통 **파일 수정 승인** 화면에서 경로와 파일 전체의 수정 전후 내용을 확인한다. **이번 수정 허용**은 해당 수정안만 적용하고, **거절**은 파일을 유지한 채 거절 결과를 AI에 전달한다. **실행 중지**는 대기 요청을 취소하고 해당 AI 실행을 정리한다. 창을 닫는 것은 승인이 아니며 상단의 승인 버튼으로 다시 연다. 같은 Daemon에 재접속하면 저장된 대기 요청을 다시 표시한다. 승인 대기는 최대 5분이고, AI의 120초 응답 제한에는 이 대기 시간을 포함하지 않는다.

파일 경로와 수정 전후 내용, 상태·오류는 플랫폼 SQLite에 보관한다. Chat의 파일 기록을 펼쳐 확인하며 이후 질문이나 재시작 뒤에도 조회할 수 있다. 설정과 파일 내용은 AI가 사용하는 자료이므로 사용자가 지정한 파일만 요청한다. 파일 읽기는 별도의 승인 창 없이 수행하며, 파일 수정 도구가 실제로 쓰기 전에 승인을 기다린다.

다음 조건을 적용한다.

- 상대 경로의 기존 일반 파일만 사용한다. Workspace 밖, `..`, 링크·junction·hard link, Windows 예약 이름·ADS, `.git`·`.codex`·`.agents`·`node_modules` 및 이번 Daemon 데이터 영역은 거절한다. 파일 생성·삭제·이동, 디렉터리 작업과 임의 셸 실행은 제공하지 않는다.
- 에이전트가 보낸 `before`가 실제 원문과 일치해야 수정안을 접수한다. 허용 시 내용과 파일 식별·변경 시각을 다시 비교한다. 승인 대기 중 원본이 달라지면 `FILE_CONFLICT`로 종료하고 덮어쓰지 않는다.
- 한 Run에서 최대 4개의 수정 요청을 기록하고, 동시에 하나만 승인 대기한다. 각 요청은 한 파일이며 별도 승인이 필요하다.
- 두 탭의 응답은 첫 유효 응답만 처리한다. 같은 요청 ID의 재전송은 최초 접수 결과를 반환하고 실제 수정을 반복하지 않는다. 다른 요청 ID로 이미 처리된 승인에 응답하면 `PERMISSION_RESOLVED`다.
- 허용 접수와 파일 적용 완료는 다르다. 화면이 응답을 놓치면 기존 `requests.get`으로 접수를 확인하고 `runs.get/watch`로 현재 결과를 조회한다. 새 요청으로 자동 전송하지 않는다.
- Run 취소·종료, 에이전트 종료, 승인 시간 초과에는 대기 요청을 취소한다. Daemon 재시작 시 미실행 요청은 취소하고 이미 적용을 시도하던 요청은 `unknown / FILE_OUTCOME_UNKNOWN`으로 남긴다. SQLite와 파일 쓰기는 하나의 원자적 작업이 아니므로 중단 시 파일이 일부 또는 전부 바뀌었을 수 있다. 자동 재적용·원복하지 않으며 실제 파일을 확인한다.

`permissions.respond`는 다음 변경 요청으로 호출한다. `runId`와 `toolId`는 `runs.get/watch`의 `tools` 배열에서 가져온다. 요청 ID와 epoch는 다른 변경 연산과 같은 접수 계약을 사용한다.

```json
{
  "type": "request", "callId": "approve-call-1", "method": "permissions.respond",
  "requestId": "approve-request-1", "storeEpoch": "<storeEpoch>",
  "params": { "runId": "<runId>", "toolId": "<toolId>", "decision": "allow" }
}
```

`decision`은 `allow` 또는 `reject`다. 성공 응답은 `{ accepted: true, requestId, run }`이고 접수 시점의 Run 스냅샷을 포함한다. `tools`에는 `toolId`, `path`, `before`, `after`, `state`, `errorCode`, `createdAt`이 있다. 상태는 `pending → approved → applying → completed` 또는 `rejected`, `failed`, `cancelled`, `unknown`이다. 내부 파일 식별자와 도구 연결 토큰은 클라이언트에 전달하지 않는다. ACP를 끈 기록 조회 실행에서도 파일 기록은 읽을 수 있지만 승인 응답은 받지 않는다. 터미널 Chat 클라이언트에는 승인 입력 UI가 없으므로 Web UI 또는 공통 `rpc` 도구의 `permissions.respond`로 승인·거절한다.

구현은 기존 ACP 연결을 유지하며, 대화별 Codex 설정으로 `worknaru_files` MCP stdio 도구 두 개(`read_text_file`, `edit_text_file`)를 제공한다. `codex-acp` 1.10.0의 표준 `mcpServers` 변환은 도구별 승인 모드와 시간 제한을 전달하지 않으므로 대화의 `CODEX_CONFIG`에 함께 전달한다. 이 두 내부 도구의 Codex 승인 모드는 `approve`, 호출 제한은 360초다. 이는 내부 도구 진입 시 중복 승인을 생략하는 설정이며 실제 파일 쓰기는 항상 WorkNaru의 사용자 승인을 기다린다. 다른 ACP 승인 요청은 자동 허용하지 않는다. 메타데이터 조회에는 파일 도구를 연결하지 않는다. [Codex 설정 계약](https://learn.chatgpt.com/docs/config-file/config-reference)

stdio 연결 프로세스는 직접 파일에 접근하지 않고 대화별 임시 토큰으로 Daemon의 loopback 파일 도구 서버에 요청한다. 서버는 정확한 Host·경로, Origin 부재, 토큰과 현재 Session·Run을 확인한다. 도구 프로세스는 기존 Windows Job에 속하고, 대화 종료 시 토큰을 폐기하며 Daemon 종료 시 도구 서버를 닫는다. 이는 동일 OS 사용자의 악성 코드나 악성 프로바이더를 격리하는 기능은 아니다.

저장소 v3을 처음 열 때 `records-v3-<uuid>.sqlite`로 백업한 다음 파일 승인 테이블을 추가해 v4로 전환한다. 기존 메시지·Session·Run·설정·접수 결과·epoch를 보존한다. v1/v2에서도 해당 버전의 기존 백업 후 v4까지 전환한다.

일반 `npm test`와 `npm run test:web`는 실제 모델 대신 가짜 ACP와 실제 MCP stdio 연결을 사용해 승인·거절·취소, 두 탭 경쟁, 재접속·접수 유실, 원본 충돌과 재시작을 검증한다. 실제 Codex 파일 수정 검증은 임시 Workspace의 `sample.txt`만 대상으로, `gpt-5.6-luna / low`의 요청 2회로 브라우저 허용과 재시작 후 거절을 확인한다.

```powershell
$env:WORKNARU_CODEX_PATH = (Get-Command codex.exe).Source
$env:WORKNARU_TEST_WEB_PORT = '15173'
npm run test:files:live
```

## Settings와 대화별 AI 설정

관련 작업: [#14 Settings와 대화별 모델·추론 강도](https://github.com/NaruForge/worknaru/issues/14).

좌측 서비스 탐색 하단의 **설정(Settings)** 에서 Daemon 연결 설정, Codex 인증 상태, 새 대화의 기본 Model·Reasoning Effort를 확인한다. 좁은 화면에서는 상단 서비스 버튼으로 Settings를 연다. 기존 상단 연결 상태 버튼도 연결 창을 연다. Permission에는 **Workspace 텍스트 파일 수정 · 요청마다 승인**을 표시한다. 로그인·로그아웃·계정 전환, 상시 허용과 범용 도구 권한 정책 편집은 제공하지 않는다.

기본값과 대화별 선택의 원본은 플랫폼 SQLite다. 초기 기본값은 `gpt-5.6-luna`·`low`이며 일반 대화에서는 지원 모델 중 직접 바꿀 수 있다. 기본값은 동일 데이터 영역에서 이후 생성하는 대화에만 복사한다. 기존 대화의 선택은 바뀌지 않는다. Chat 입력창에서 바꾸는 값은 해당 대화의 다음 메시지부터 적용하며, 실행 중에는 서버에서도 `SESSION_BUSY`로 변경을 거절한다. 모델을 바꿀 때 현재 추론 강도를 지원하면 유지하고, 지원하지 않으면 `low` 또는 제공자가 나열한 첫 지원값으로 전환한다.

### 조회와 저장 계약

Settings를 열거나 ‘상태 새로고침’을 누르면 저장된 기본값도 다시 조회해 다른 클라이언트의 변경을 반영한다. 조회 중에는 기본값 변경을 막고, 조회에 실패하면 오류를 표시하고 기본값 선택을 비활성화한다. 연결을 바꾼 뒤 도착한 이전 조회 결과는 반영하지 않는다.

| 연산 | 입력과 결과 |
| --- | --- |
| `ai.get` | 빈 params. ACP를 통해 확인한 `models`(각 `id`, `name`, `efforts`, `fallbackEffort`), `authentication`, `checkedAt`을 반환한다. |
| `settings.get` | 빈 params. `selection: { model, reasoningEffort }`와 `storageAvailable`을 반환한다. ACP 비활성 상태에서도 조회할 수 있다. |
| `settings.update` | 요청 ID·epoch와 `selection`으로 새 대화 기본값을 저장한다. 접수 결과는 `{ accepted, requestId, settings }`다. |
| `sessions.configure` | 요청 ID·epoch와 `sessionId`, `selection`으로 해당 대화의 선택을 저장한다. 접수 결과는 `{ accepted, requestId, session }`이다. |

설정 변경 전에 같은 Daemon에 `ai.get`을 호출해 제공자 목록을 확인한다. 미확인 목록은 `AI_CATALOG_REQUIRED`, 지원 밖 조합은 `MODEL_UNSUPPORTED`로 거절한다. 변경은 기존 요청 ID·epoch·접수 장부 규칙을 그대로 사용한다. 설정 저장과 접수 결과를 함께 커밋하며, 응답 유실 후 `requests.get`으로 확인한다. 최초 접수 스냅샷을 현재 설정으로 간주하지 않고 `settings.get` 또는 `sessions.get`을 다시 조회한다. 브라우저는 미확정 설정 요청도 같은 탭의 접수 장부에 보관하고 자동 재전송하지 않는다. 설정 변경은 작성 중인 메시지 초안을 지우지 않는다.

```json
{ "type": "request", "callId": "ai-1", "method": "ai.get", "params": {} }
```

목록 확인 후 기본값을 저장하는 예시다. 기존 대화를 바꿀 때는 method를 `sessions.configure`로 바꾸고 params에 실제 `sessionId`를 추가한다.

```json
{
  "type": "request", "callId": "settings-1", "method": "settings.update",
  "requestId": "save-default-model-1", "storeEpoch": "<storeEpoch>",
  "params": { "selection": { "model": "gpt-5.6-luna", "reasoningEffort": "low" } }
}
```

### 제공자 확인과 실행 적용

`ai.get`은 설치된 `codex-acp` 1.10.0에 ACP 초기화 후 읽기 전용 `authentication/status` 확장을 요청한다. 인증된 경우 조회 전용 provider Session의 `configOptions`와 `session/set_config_option`으로 모델별 추론 강도를 확인한다. 이 세션에는 `session/prompt`를 보내지 않고, WorkNaru의 사용자 Session·메시지·Run을 만들지 않는다. provider Session ID를 별도로 보관해 같은 Workspace의 다음 조회에서 재개하고, 조회 후 `session/close`와 관리 프로세스 종료를 수행한다. 메타데이터 프로세스의 Job 이름도 시작 전에 저장하고 Daemon 재시작 때 정리한다. 조회용 provider 기록이 사라지면 현재 조회를 실패로 알리고 다음 명시적 조회에서 다시 만든다. Workspace를 바꾸면 그 Workspace의 조회용 Session을 생성한다. [ACP 어댑터](https://github.com/agentclientprotocol/codex-acp), [ACP 세션 설정](https://agentclientprotocol.com/protocol/v1/session-setup)

동시 조회는 하나로 합치고 성공한 결과는 30초 동안 재사용한다. 전체 조회는 45초, 개별 ACP 요청은 15초 한도를 두며 프로세스 정리 시간은 별도다. 인증 결과는 `chatgpt`, `apiKey`, `other`, `signedOut` 중 하나만 화면에 전달한다. 이메일·토큰·계정 식별자를 반환하지 않는다. ‘로그인 정보 확인됨’은 현재 제공자가 인증 정보를 인식했다는 뜻이며, 원격 자격증명의 만료 여부나 잔여 사용량 검증을 뜻하지 않는다. 조회 실패는 `AI_INFO_UNAVAILABLE`로 알리고 사용자 대화나 질문을 생성하지 않는다. 인증되지 않은 경우 모델 목록은 비어 있으며 로그인부터 안내한다.

사용자 Session을 새로 열거나 재개할 때 자식 프로세스의 `CODEX_CONFIG`에 선택한 `model`·`model_reasoning_effort`를 명시한다. ACP `configOptions`로 적용값을 읽고, 매 질문 전에 `session/set_config_option`으로 모델·추론 강도를 지정해 다시 확인한다. 선택이 같은 기존 연결도 이 확인을 생략하지 않는다. 모델·추론 강도가 지원되며 선택값과 일치한 것을 확인한 뒤에만 Run의 `delivery = attempting`, `modelConfirmed = 1`과 함께 질문을 전달한다. 제공자가 적용값을 반환하지 않거나 다른 값을 유지하면 `MODEL_UNCONFIRMED`, 지원하지 않으면 `MODEL_UNSUPPORTED`로 질문을 보내기 전에 실패한다. 실제 검증의 고정 정책 위반은 `TEST_MODEL_REQUIRED`다. `modelConfirmed`는 제공자의 설정 확인 결과이며 과금 내역 검증 필드는 아니다.

선택 저장 완료와 제공자 적용 완료는 다르다. 화면은 실행 전 ‘다음 메시지에 적용’을 표시하고, 해당 선택값으로 실행한 기록에서 제공자 확인을 마치면 ‘최근 적용’을 표시한다. 재시작 후에도 저장된 대화 선택을 사용하며 기본값으로 덮어쓰지 않는다. 적용 실패 후에는 기존 실패·기록 보기 정책을 따른다. 입력·빈 답변·실패 Run은 남고 질문은 자동 재시도하지 않는다.

### v3 저장 형식

v3는 기본값·조회용 provider 식별자와 대화별 선택, Run별 선택·적용 확인을 추가한다. v2 데이터는 `records-v2-<uuid>.sqlite`에 일관된 백업을 만든 뒤 트랜잭션으로 전환한다. v1 데이터는 기존 v1 백업을 만든 뒤 v2·v3 변경을 순서대로 수행한다. 메시지·접수 장부·epoch는 유지한다.

이전 형식에서 생성한 대화와 Run의 모델 필드는 `null`로 남긴다. 과거 실행 모델을 추정하거나 새 기본값을 소급하지 않는다. 기존 대화를 이어 쓰려면 UI에서 모델·추론 강도를 한 번 선택해야 하며, 선택 전 `runs.start`는 `AI_SETTINGS_REQUIRED`로 거절한다. 정상 완료·정리 확인 등 기존 재개 조건도 충족해야 한다.
