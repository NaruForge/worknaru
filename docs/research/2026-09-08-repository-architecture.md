# 유지보수를 위한 저장소 구조와 의존 경계 조사

- 조사일: 2026-09-08
- 관련 Work Item: [#5 저장소 구조와 코드 의존 규칙 설계](https://github.com/NaruForge/worknaru/issues/5)
- 적용 기준: [제품 방향과 플랫폼·Module 책임](../../README.md), [Module 연결 규칙](../design/module-platform-contract.md), [프로젝트 기록 규약](../project-records.md)
- 사용자 조건: GitHub 저장소는 조사 시 별 5,000개 이상인 경우만 유효한 비교 대상으로 포함한다.

## 1. 조사 결론

**WorkNaru의 기본 코드 배치는 Paseo, 실행 환경과 의존 방향의 규칙은 VS Code, 기능별 진입점과 조합 방식은 Theia를 우선 참고하는 것이 적합하다.** Joplin과 AFFiNE는 여러 앱이 공통 코드를 공유하는 방식, n8n은 실행 기반과 개별 기능의 분리를 보완해서 볼 사례다. 이는 현재 WorkNaru 요구에 대한 조사자의 판단이며 구조 채택 결정은 아니다.

공통적으로 얻을 수 있는 교훈은 세 가지다.

1. 통신 계약·클라이언트·서버 구현을 구분하면 화면이 서버 내부 구현에 의존하는 것을 줄일 수 있다.
2. 실행 환경과 기능 책임을 함께 구분해야 한다. 하나의 업무 기능도 화면·서버 처리·공유 계약을 가질 수 있으며, 폴더 하나가 프로세스 하나를 뜻하지 않는다.
3. 디렉터리 설명에 더해 import 검사·공개 진입점·대표 테스트가 있어야 경계를 유지할 수 있다. 큰 저장소에도 예외와 정리 중인 경계가 존재한다.

## 2. 선정 기준과 확인 범위

GitHub REST API의 저장소 메타데이터에서 `stargazers_count`와 기본 브랜치를 조회하고, 기본 브랜치의 HEAD SHA를 고정했다. 조회는 2026-09-08 17:25 KST 전후에 수행했다. 별 수는 조회 시점의 값이며 이후 변할 수 있다. 아래 여섯 저장소는 모두 5,000개 이상 조건을 충족했고 보관 상태가 아니었다.

별 수는 대상 선정 조건으로 사용했다. 구조의 적합성은 공식 문서, 고정 커밋의 디렉터리 트리, 대표 `package.json`, 공개 진입점, lint·경계 검사 코드와 테스트·빌드 설정을 대조해 평가했다. 전체 import 그래프를 분석하거나 저장소를 빌드·실행해 결함이 없음을 검증한 것은 아니다.

| 저장소 | 확인한 별 수 | 검토 코드 | WorkNaru에서 주로 참고할 점 |
| --- | ---: | --- | --- |
| [Paseo](https://github.com/getpaseo/paseo) | 16,453 | [4eab53e](https://github.com/getpaseo/paseo/commit/4eab53e24e1b57c74b00945aa48a89d68ed755e3) | Daemon·공통 클라이언트·통신 계약·앱의 배치 |
| [VS Code](https://github.com/microsoft/vscode) | 191,474 | [35c54dc](https://github.com/microsoft/vscode/commit/35c54dc84fe361d55505628d918d2711e2e46c4c) | 책임 계층과 실행 환경을 나누는 의존 규칙 |
| [Eclipse Theia](https://github.com/eclipse-theia/theia) | 21,675 | [7c303b1](https://github.com/eclipse-theia/theia/commit/7c303b1836421183d7013f0bd679a9a30ff0b5dc) | 기능별 패키지의 화면·서버 진입점과 앱 조합 |
| [Joplin](https://github.com/laurent22/joplin) | 56,271 | [e2f3030](https://github.com/laurent22/joplin/commit/e2f30308f829d70b2b93c3b5eb46bb05cddba9da) | 여러 앱에서 공통 업무·저장 코드를 공유하는 방식 |
| [AFFiNE](https://github.com/toeverything/AFFiNE) | 72,316 | [b4331cb](https://github.com/toeverything/AFFiNE/commit/b4331cbe1ea7ba2db115be6d74e3544b41f1d495) | 앱·공통 UI·업무 기능·기반 코드·개발 도구의 구분 |
| [n8n](https://github.com/n8n-io/n8n) | 203,701 | [53ecf6b](https://github.com/n8n-io/n8n/commit/53ecf6b6be6ef987ff4383e40fd94582fa1c8539) | 실행 기반·공통 모델·개별 기능의 분리와 의존 검사 |

기본 브랜치는 각각 `main`, `main`, `master`, `dev`, `canary`, `master`다. 안정판 릴리스만을 비교한 것은 아니다. 아래의 구조 표시는 관련 부분을 발췌한 것이며 전체 폴더 목록이 아니다.

## 3. Paseo: WorkNaru의 실행 구조에 가장 가까운 출발점

```text
packages/
  protocol/   통신 스키마·코덱·공유 타입
  client/     Daemon 접속·공통 SDK
  server/     Daemon과 에이전트 실행 관리
  app/        모바일·웹과 데스크톱이 공유하는 UI
  desktop/    Electron 앱과 로컬 실행 수명 관리
  cli/        명령행 접속·실행 진입점
  plugin/     확장용 SDK의 공통·서버·클라이언트 진입점
```

**확인한 분리:** `protocol`은 서버와 클라이언트가 함께 쓰는 전송 형식의 원본이며 서버에 의존하지 않는다. `client`는 소켓 처리와 상위 SDK를 맡고 `app`은 이를 사용한다. 서버는 실행과 상태를 소유한다. 데스크톱은 공통 UI를 사용하면서 Daemon을 시작하는 역할을 맡는다. [아키텍처 설명](https://github.com/getpaseo/paseo/blob/4eab53e24e1b57c74b00945aa48a89d68ed755e3/docs/architecture.md)

패키지 의존성에서도 앱은 `client`·`protocol`을 사용하고, `client`는 `protocol`·`relay`를 사용한다. 다만 서버도 `client`에 의존하고 CLI·데스크톱은 서버 패키지에 의존하므로, 모든 패키지가 단순한 한 줄 계층을 이룬다고 해석하면 안 된다. 공통 계약의 독립성과 실행을 조립하는 진입점의 의존성을 구별해야 한다. [앱 manifest](https://github.com/getpaseo/paseo/blob/4eab53e24e1b57c74b00945aa48a89d68ed755e3/packages/app/package.json), [클라이언트 manifest](https://github.com/getpaseo/paseo/blob/4eab53e24e1b57c74b00945aa48a89d68ed755e3/packages/client/package.json), [서버 manifest](https://github.com/getpaseo/paseo/blob/4eab53e24e1b57c74b00945aa48a89d68ed755e3/packages/server/package.json)

**경계를 유지하는 장치:** Plugin SDK는 공통·서버·클라이언트별 export를 선언한다. 경계 테스트는 타입 import와 재수출까지 따라가며 공통 코드가 UI·서버 코드에 기대거나, 클라이언트가 Node 내장 모듈을 가져오는 경우 등을 검사한다. CI에는 Plugin SDK 테스트와 예시 타입 검사가 연결되어 있다. 이 검사는 Plugin SDK와 예시의 범위이며 저장소 전체의 모든 의존성을 증명하는 것은 아니다. [경계 테스트](https://github.com/getpaseo/paseo/blob/4eab53e24e1b57c74b00945aa48a89d68ed755e3/packages/plugin/src/boundaries.test.ts), [CI 설정](https://github.com/getpaseo/paseo/blob/4eab53e24e1b57c74b00945aa48a89d68ed755e3/.github/workflows/ci.yml)

**개발·검증:** npm workspaces와 루트 실행 명령으로 패키지별 빌드·타입 검사·테스트를 묶는다. 개별 패키지에도 테스트 명령이 있고 서버는 단위·통합 검증을 구분한다. [루트 manifest](https://github.com/getpaseo/paseo/blob/4eab53e24e1b57c74b00945aa48a89d68ed755e3/package.json)

**WorkNaru 적용 판단:** `protocol`·`client`·`daemon`의 책임 분리를 가장 먼저 참고할 만하다. 반면 모바일·relay·음성·Plugin 런타임까지 동일하게 배치할 근거는 현재 없다. Paseo의 `protocol`은 안정된 외부 API가 아니라고 명시돼 있고 `client`에는 전환 기간의 `internal/*` export도 있다. 구조를 참고하는 것과 패키지를 제품 의존성으로 채택하는 것은 별도 판단이다. [프로토콜 안정성 설명](https://github.com/getpaseo/paseo/blob/4eab53e24e1b57c74b00945aa48a89d68ed755e3/packages/protocol/README.md)

## 4. VS Code: 폴더에 허용 의존 방향을 부여하는 사례

```text
src/vs/
  base/                 기초 코드
  platform/             공통 서비스
  editor/               편집기 기반
  workbench/
    services/           공통 작업 환경 서비스
    contrib/            기능별 기여
  code/                 데스크톱 진입점
  server/               서버 진입점
```

**확인한 분리:** 책임 계층과 실행 환경이라는 두 축을 사용한다. 각 영역 내부의 `common`은 기본 JavaScript API, `browser`는 DOM, `node`는 Node API를 기준으로 나눈다. 기능 구현은 `workbench/contrib`에 두고 기여 진입점과 공통 API를 통해 연결하도록 규칙을 둔다. [코드 구성 지침](https://github.com/microsoft/vscode/blob/35c54dc84fe361d55505628d918d2711e2e46c4c/.github/instructions/source-code-organization.instructions.md)

**경계를 유지하는 장치:** 로컬 ESLint 규칙에 실행 환경 간 import와 특정 내부 모듈 접근 검사가 있고, 별도의 계층·순환 의존 검사 명령도 있다. 다만 확인한 `code-layering`·`code-import-patterns` 설정은 `warn`이다. 검사 코드가 있다는 사실을 모든 위반이 즉시 CI 실패로 처리된다는 뜻으로 확대하지 않는다. [ESLint 설정](https://github.com/microsoft/vscode/blob/35c54dc84fe361d55505628d918d2711e2e46c4c/eslint.config.js), [환경 계층 검사 구현](https://github.com/microsoft/vscode/blob/35c54dc84fe361d55505628d918d2711e2e46c4c/.eslint-plugin-local/code-layering.ts), [검사·테스트 명령](https://github.com/microsoft/vscode/blob/35c54dc84fe361d55505628d918d2711e2e46c4c/package.json)

**WorkNaru 적용 판단:** 공통 계약은 브라우저·Node·SQLite에 의존하지 않게 하고, UI가 서버 내부 구현을 import하지 못하게 하는 규칙을 작은 규모로 적용할 가치가 크다. VS Code 전체의 서비스 주입 체계·편집기 계층·빌드 시스템을 도입할 필요는 없다. 독립 npm 패키지를 많이 만들어야만 의존 경계를 유지할 수 있는 것도 아님을 보여준다.

## 5. Eclipse Theia: 하나의 기능에 여러 실행 환경의 진입점 제공

```text
packages/
  core/
  filesystem/
    src/common/
    src/browser/
    src/node/
    src/electron-*/
  workspace/
  terminal/
dev-packages/             개발·빌드 도구
examples/browser/         웹용 앱 조합
examples/electron/        데스크톱용 앱 조합
```

**확인한 분리:** 기능을 패키지로 묶고 패키지 안에서 실행 환경을 나눈다. `package.json`의 `theiaExtensions`가 화면·서버·Electron용 진입점을 선언하며, 앱은 필요한 확장 패키지를 의존성으로 선택한다. 실제 filesystem 패키지에서도 이 구성을 확인했다. [확장과 앱 계약](https://github.com/eclipse-theia/theia/blob/7c303b1836421183d7013f0bd679a9a30ff0b5dc/packages/core/README.md), [filesystem manifest](https://github.com/eclipse-theia/theia/blob/7c303b1836421183d7013f0bd679a9a30ff0b5dc/packages/filesystem/package.json), [브라우저 앱 manifest](https://github.com/eclipse-theia/theia/blob/7c303b1836421183d7013f0bd679a9a30ff0b5dc/examples/browser/package.json)

**경계를 유지하는 장치:** 실행 환경별 허용 관계를 문서화하고 `runtime-import-check`를 오류로 설정한다. 다른 Theia 패키지의 `src` 직접 참조도 검사한다. 후자의 규칙은 해당 경로를 `lib` 경로로 바꾸도록 돕는 검사이므로, 모든 패키지 내부 API를 단일 공개 진입점 뒤에 숨기는 규칙과 같지는 않다. [환경별 규칙](https://github.com/eclipse-theia/theia/blob/7c303b1836421183d7013f0bd679a9a30ff0b5dc/doc/code-organization.md), [lint 설정](https://github.com/eclipse-theia/theia/blob/7c303b1836421183d7013f0bd679a9a30ff0b5dc/configs/errors.eslintrc.json), [환경 검사 구현](https://github.com/eclipse-theia/theia/blob/7c303b1836421183d7013f0bd679a9a30ff0b5dc/dev-packages/private-eslint-plugin/rules/runtime-import-check.js), [src 참조 검사](https://github.com/eclipse-theia/theia/blob/7c303b1836421183d7013f0bd679a9a30ff0b5dc/dev-packages/private-eslint-plugin/rules/no-src-import.js)

**개발·검증:** 런타임 패키지·개발 도구·앱 조합을 분리하고 패키지별 빌드·테스트 및 브라우저·Electron 검증 명령을 둔다. [개발 안내](https://github.com/eclipse-theia/theia/blob/7c303b1836421183d7013f0bd679a9a30ff0b5dc/doc/Developing.md), [루트 manifest](https://github.com/eclipse-theia/theia/blob/7c303b1836421183d7013f0bd679a9a30ff0b5dc/package.json)

**WorkNaru 적용 판단:** 보고서 Module의 화면·업무 처리·공유 데이터 계약을 하나의 업무 책임 아래 두되, 실행 위치에 맞는 진입점을 나누는 설계에 유용하다. Theia 확장과 WorkNaru 업무 Module은 동일한 제품 개념이 아니며, 이 사례를 외부 Plugin 설치·격리 체계 채택으로 연결하지 않는다.

## 6. Joplin: 여러 앱과 공통 업무·저장 코드의 관계가 명확한 사례

```text
packages/
  app-desktop/
  app-mobile/
  app-cli/
  lib/                    공통 업무·저장·동기화 기능
  renderer/               Markdown·HTML 렌더링
  server/                 기기 간 동기화 등을 제공하는 서버
  tools/                  개발 도구
```

**확인한 분리:** 데스크톱·모바일·CLI의 화면과 시스템 통합은 다르지만 공통 백엔드 코드를 공유한다. 백엔드를 서비스·모델·SQLite 저장 계층으로 설명한다. 여기서 공통 백엔드는 각 앱에서 사용되는 코드이며, 모든 앱이 WorkNaru처럼 동일한 로컬 Daemon 하나에 접속한다는 뜻은 아니다. Joplin Server는 별도의 동기화 역할이다. [아키텍처 설명](https://github.com/laurent22/joplin/blob/e2f30308f829d70b2b93c3b5eb46bb05cddba9da/readme/dev/spec/architecture.md)

**개발·검증과 경계:** Yarn workspaces로 앱과 공통 코드를 관리하며 루트에서 패키지별 타입 검사·테스트를 실행한다. `checkLibPaths`는 상대 경로로 다른 공통 패키지의 구현에 접근하는 특정 패턴을 검사한다. 이 검사는 경로 사용 규칙으로, 모든 내부 API 접근을 금지하는 완전한 공개 API 검사는 아니다. [빌드 안내](https://github.com/laurent22/joplin/blob/e2f30308f829d70b2b93c3b5eb46bb05cddba9da/readme/dev/BUILD.md), [루트 명령](https://github.com/laurent22/joplin/blob/e2f30308f829d70b2b93c3b5eb46bb05cddba9da/package.json), [공통 패키지 경로 검사](https://github.com/laurent22/joplin/blob/e2f30308f829d70b2b93c3b5eb46bb05cddba9da/packages/tools/checkLibPaths.ts)

**WorkNaru 적용 판단:** 화면과 저장·업무 처리를 분리하는 사례로 적합하다. 하지만 여러 독립 업무 Module을 수용할 WorkNaru에서 모든 업무 규칙을 하나의 `lib`에 모으면 기존 플랫폼·Module 책임이 흐려질 수 있다. Joplin의 공통 노트 업무와 WorkNaru의 서로 다른 업무 서비스라는 차이를 반영해야 한다.

## 7. AFFiNE: 앱·공통 UI·업무 기능·기반 코드·테스트의 배치

```text
packages/
  frontend/
    apps/web/
    apps/electron/
    apps/electron-renderer/
    core/src/modules/     기능별 코드
    component/            공통 UI
    electron-api/         데스크톱 연결 경계
  backend/server/
  common/                 여러 영역에서 사용하는 기반 패키지
blocksuite/               편집 관련 코드
tools/                    개발 도구
tests/                    앱·패키지를 함께 검증하는 테스트
```

**확인한 분리:** 웹 앱은 공통 frontend core와 component 등을 조립하고, core에는 기능별 `modules`가 있다. 웹·Electron 본체·Electron renderer의 패키지를 구분한다. `common`, `tools`, 제품별 테스트도 별도 위치에 있다. [고정 커밋 트리](https://github.com/toeverything/AFFiNE/tree/b4331cbe1ea7ba2db115be6d74e3544b41f1d495), [웹 앱 manifest](https://github.com/toeverything/AFFiNE/blob/b4331cbe1ea7ba2db115be6d74e3544b41f1d495/packages/frontend/apps/web/package.json), [core manifest](https://github.com/toeverything/AFFiNE/blob/b4331cbe1ea7ba2db115be6d74e3544b41f1d495/packages/frontend/core/package.json)

**경계와 검증:** lint 설정은 선언되지 않은 내부 패키지 의존성도 검사 대상으로 넣는다. Vitest 설정은 common·frontend의 단위 검증과 Electron·BlockSuite 테스트 프로젝트를 구분한다. 다만 core는 `electron-api`에도 의존하고 `./*`를 소스 경로로 넓게 export한다. 따라서 `core`라는 이름만으로 실행 환경과 무관한 순수 코어라고 판단하거나, 공개 API가 좁다고 평가할 수는 없다. [lint 설정](https://github.com/toeverything/AFFiNE/blob/b4331cbe1ea7ba2db115be6d74e3544b41f1d495/.oxlintrc.json), [테스트 구성](https://github.com/toeverything/AFFiNE/blob/b4331cbe1ea7ba2db115be6d74e3544b41f1d495/vitest.config.ts)

**문서 대조:** 기존 코드 투어의 `packages/frontend/workspace/src/type.ts` 참조는 검토한 트리에 없었다. 이 조사에서는 그 부분을 현재 구조의 근거로 사용하지 않고 트리·manifest를 우선했다. [코드 투어](https://github.com/toeverything/AFFiNE/blob/b4331cbe1ea7ba2db115be6d74e3544b41f1d495/docs/contributing/tutorial.md)

**WorkNaru 적용 판단:** 실행 앱과 재사용 UI, 업무 기능, 개발 도구, 여러 부분을 함께 검증하는 테스트를 나누는 데 참고할 가치가 있다. 편집기·협업·여러 기기를 위한 전체 패키지 수와 초기 빌드 구성을 가져올 이유는 없다.

## 8. n8n: 실행 기반과 개별 기능의 분리, 경계 검사의 실제 한계

```text
packages/
  workflow/               양쪽에서 쓰는 워크플로 모델·인터페이스와 관련 코드
  core/                   실행 기반
  nodes-base/             개별 노드 구현
  cli/                    제품 실행·API를 조립하는 부분
  frontend/editor-ui/     편집 화면
  testing/                공통 검증 도구·시나리오
```

**확인한 분리:** 실행 기반인 core와 개별 기능인 nodes-base가 구분되고 둘 다 workflow 패키지를 사용한다. CLI는 명령 파서만이 아니라 제품 서버·API를 포함한 조립 지점이다. 따라서 `cli`라는 폴더 이름만 보고 작은 보조 도구라고 해석하면 안 된다. [기여 문서의 디렉터리 설명](https://github.com/n8n-io/n8n/blob/53ecf6b6be6ef987ff4383e40fd94582fa1c8539/CONTRIBUTING.md), [core manifest](https://github.com/n8n-io/n8n/blob/53ecf6b6be6ef987ff4383e40fd94582fa1c8539/packages/core/package.json), [nodes-base manifest](https://github.com/n8n-io/n8n/blob/53ecf6b6be6ef987ff4383e40fd94582fa1c8539/packages/nodes-base/package.json)

**개발·검증:** pnpm workspaces와 Turbo로 패키지별 작업을 묶으며 단위·통합·UI 검증 명령을 나눈다. `lint:ci`에는 패키지 경계 검사와 workspace 의존 검사도 연결되어 있다. [루트 manifest](https://github.com/n8n-io/n8n/blob/53ecf6b6be6ef987ff4383e40fd94582fa1c8539/package.json), [Turbo 설정](https://github.com/n8n-io/n8n/blob/53ecf6b6be6ef987ff4383e40fd94582fa1c8539/turbo.json), [lint CI](https://github.com/n8n-io/n8n/blob/53ecf6b6be6ef987ff4383e40fd94582fa1c8539/.github/workflows/test-linting-reusable.yml)

**확인한 한계:** `check-boundaries.mjs`는 경계 위반이 0인지 검사하는 대신 기존 기준값보다 개수가 늘었는지 검사한다. 검토 커밋의 기준값은 164다. 이는 이번 조사에서 직접 측정한 현재 위반 수가 아니다. 코드 주석도 같은 개수 안에서 새 위반과 해결된 위반이 서로 대체되는 경우를 구분하지 못한다고 설명한다. [경계 검사 코드](https://github.com/n8n-io/n8n/blob/53ecf6b6be6ef987ff4383e40fd94582fa1c8539/scripts/check-boundaries.mjs), [기준값 파일](https://github.com/n8n-io/n8n/blob/53ecf6b6be6ef987ff4383e40fd94582fa1c8539/.boundaries-baseline.json)

**WorkNaru 적용 판단:** 공통 실행 수단과 업무별 기능 구현을 분리하는 발상은 유용하다. 다만 n8n의 노드는 WorkNaru의 업무 서비스 Module과 같은 단위가 아니며, workflow 패키지도 순수 전송 DTO만 담은 패키지가 아니다. 신규 저장소에서는 처음부터 작은 의존 규칙을 검사해 기존 위반 기준값이 필요한 상황을 줄이는 편이 적합하다.

## 9. #5에서 비교할 구조와 우선순위

| #5의 질문 | 우선 참고 | 적용할 내용 |
| --- | --- | --- |
| 데몬·화면·공통 계약을 어디에 둘까? | Paseo | 계약과 접속 코드를 서버 구현에서 분리 |
| 브라우저 코드에 Node·DB 코드가 섞이지 않게 하려면? | VS Code, Theia | 실행 환경별 import 규칙과 검사 |
| 업무 Module에 화면과 서버 처리가 함께 필요하면? | Theia | 업무 책임 아래 환경별 진입점을 구분하고 앱이 조립 |
| 웹·데스크톱이 무엇을 공유할까? | Paseo, Joplin, AFFiNE | 공유 코드와 앱별 통합 코드의 경계를 명시 |
| 개별 업무가 공통 실행 기반을 잠식하지 않게 하려면? | n8n, VS Code | 실행 계약과 기능 구현을 나누고 내부 참조를 제한 |
| 테스트·도구·생성물을 어떻게 관리할까? | Theia, AFFiNE, Joplin | 패키지 근처의 테스트와 통합 검증·개발 도구의 책임을 구분 |

WorkNaru 구조 초안에서는 우선 아래 의존 규칙을 검토할 것을 제안한다. 폴더명·패키지 수·도구 선택은 #5에서 별도로 정한다.

- **공통 통신 계약:** 메시지 스키마·런타임 검증·전송 타입을 소유한다. UI·Daemon 내부·SQLite·ACP 어댑터 구현을 import하지 않는다.
- **공통 클라이언트:** 통신 계약에 의존하고 접속·요청·구독·복원을 맡는다. Module은 공통 클라이언트가 제공하는 플랫폼 기능을 사용한다.
- **Daemon:** 플랫폼의 상태·저장·실행을 소유한다. 내부의 전송 처리·상태 변경·SQLite·ACP 연결은 책임별로 구분하되 모두 별도 패키지로 만들지는 않는다.
- **업무 Module:** 업무 규칙·데이터·사용자 흐름을 소유한다. 실제 서버 처리가 생기면 서버용 진입점을 구분한다. 공통 플랫폼의 내부 저장 구현에 직접 기대지 않는다.
- **앱 조립 지점:** 필요한 Module과 플랫폼 구현을 연결한다. 코어가 특정 Chat 화면을 import하게 만드는 역방향 의존을 피한다.
- **경계 검사:** 공개 경로 외의 내부 참조, UI에서 서버 코드 참조, 공통 계약에서 앱·서버 구현 참조, 순환 의존을 대표 검증 대상으로 삼는다. 단순 타입 검사만으로 이 규칙이 충족된다고 가정하지 않는다.

첫 적용 사례는 이미 제안한 메시지 접수 → SQLite 저장 → 재시작 후 조회다. 이 흐름에서 각 책임·공개 진입점·테스트 위치를 설명할 수 있는 최소 구조를 먼저 설계한다. 이번 조사는 그 설계의 근거이며, 저장소 구조 확정·폴더 생성·패키지 설치·제품 구현을 수행한 것은 아니다.
