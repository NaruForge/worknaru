# AI Workspace 플랫폼 및 확장 구조 조사

- 조사일: 2026-09-08
- 목적: WorkNaru의 플랫폼 설계에 앞서 유사 제품의 AI 연결성과 확장 구조를 비교한다.
- 문서 성격: 조사 자료. 아래 해석과 제안은 아키텍처 채택 결정이 아니다.
- 관련 문서: [WorkNaru의 정체성](../../README.md), [프로젝트 기록 규약](../project-records.md)

## 조사 범위와 기준

WorkNaru는 공통 실행 기반을 제공하는 플랫폼과 독립적인 업무 능력을 소유하는 Module로 구성되는 AI Workspace를 지향한다. 이번 조사는 사용자가 특히 주목한 Paseo의 AI 연결성과 Plugin을 중심으로, 이를 뒷받침할 기존 제품과 플랫폼을 비교한 것이다.

- 신생·소규모 저장소를 설계 근거로 삼지 않으며, GitHub 저장소는 별 5,000개 이상인 경우에만 참고한다.
- 별 수는 조사일에 GitHub API의 `stargazers_count`를 조회한 값이다. 이후 수치와 달라질 수 있다.
- 제품 기능과 구조는 공식 문서 및 대표 저장소의 공개 자료를 근거로 한다.
- 모델 API 연결과 외부 에이전트 연결을 구분한다.
- 도구·대화·워크플로 확장과 독립적인 업무 화면·실행 로직의 확장을 구분한다.
- 저장소의 인지도와 개별 확장 API의 안정성을 별도로 평가한다.

이번 검토는 공개 자료 기반 조사다. 설치·실행 검증, 성능 측정, 보안 감사, 소스 코드 전반의 아키텍처 검증은 수행하지 않았다.

## 비교 대상

아래 별 수와 저장소 생성일은 조사 당시 GitHub API 조회 결과다. 생성일은 저장소 기준이며 서비스 출시일이나 특정 기능의 성숙도를 뜻하지 않는다.

| 대상 및 대표 저장소 | 별 수 | 저장소 생성일 | 제품의 중심 | WorkNaru 관점의 참고 가치 |
| --- | ---: | --- | --- | --- |
| [Paseo](https://github.com/getpaseo/paseo) | 16,413 | 2025-10-13 | 여러 외부 AI 코딩 에이전트의 실행·관리 | AI 연결, Workspace, 화면과 서버를 확장하는 Plugin |
| [Eclipse Theia](https://github.com/eclipse-theia/theia) | 21,674 | 2017-02-24 | 확장 가능한 도구·IDE를 만드는 플랫폼 | 공통 플랫폼과 독립 기능의 구성 방식 |
| [Dify](https://github.com/langgenius/dify) | 154,903 | 2023-04-12 | AI 애플리케이션과 워크플로 구축 | 모델·도구·에이전트 실행 전략의 확장 경계 |
| [Open WebUI](https://github.com/open-webui/open-webui) | 151,274 | 2023-10-06 | 여러 모델을 사용하는 AI 작업 환경 | 모델 연결, 도구, 메시지 처리 확장 |
| [LibreChat](https://github.com/danny-avila/LibreChat) | 42,904 | 2023-02-12 | 여러 모델과 사용자 정의 AI 에이전트를 사용하는 대화 환경 | 에이전트 설정, MCP 연결, 파일과 도구 권한 |
| [LobeHub](https://github.com/lobehub/lobehub) | 82,304 | 2023-05-21 | 여러 AI 에이전트와 함께 일하는 작업 공간 | 프로젝트·공유 작업 공간·에이전트를 결합한 제품 경험 |

Paseo는 사용자가 지정한 주요 조사 대상이며 별 수 기준을 충족한다. 다만 다른 비교 대상보다 저장소 이력이 짧으며, Plugin API의 실험적 성격은 별도로 고려한다. Theia는 일반 사용자용 서비스뿐 아니라 제품 제작용 플랫폼이라는 점에서 비교에 포함했다.

## Paseo

### 확인된 사실: AI 연결

Paseo는 이미 설치하고 인증한 외부 에이전트 CLI를 실행하고 관리한다. 사용자의 기존 인증, 설정, Skills, MCP 구성을 유지하면서 UI, CLI, 연결 중계, 오케스트레이션 기능을 제공한다.

Provider는 Paseo와 외부 에이전트 CLI 사이의 계약이다. CLI 실행 방법, 출력 스트리밍, 입력 전달, 지원 모드 등을 연결한다. 주요 에이전트는 전용 어댑터로 지원하고, Agent Client Protocol(ACP)을 지원하는 에이전트에는 공통 어댑터와 카탈로그를 제공한다. 실제 에이전트는 사용자 머신의 별도 프로세스로 실행된다. [공식 Providers 문서](https://paseo.sh/docs/providers.md)

### 확인된 사실: Plugin

조사 당시 공식 문서는 v0.7을 Current, v0.8을 Preview로 구분한다. 아래 내용은 v0.7 문서를 기준으로 하며, 차기 버전 전용 기능을 현재 기능으로 취급하지 않는다. Plugin API는 실험적이며 릴리스 간 변경될 수 있다고 명시되어 있다. [Plugin 문서 버전 안내](https://paseo.sh/docs/plugins.md)

v0.7 Plugin은 다음 기능을 추가할 수 있다.

- Workspace 탭으로 열리는 패널과 에이전트 패널
- 전역 화면과 사이드바 항목
- Command Center 항목과 메시지 입력창 명령
- 서버 측 RPC와 데몬 동작
- Paseo SDK를 사용하는 Workspace·에이전트 등의 조작
- 메시지 입력창에서 검색하고 첨부하는 외부 리소스

Plugin은 클라이언트 화면과 서버 동작을 함께 제공할 수 있다. Paseo는 화면의 공통 틀과 Plugin 생명주기를 관리하고, Plugin은 화면 내부와 고유 동작을 소유한다. 클라이언트와 서버 코드는 별도 번들로 구성되며, 해제 시 등록과 화면, 연결 등의 정리가 이루어진다. [Plugin Quickstart](https://paseo.sh/docs/plugins/v0.7.md), [Plugin Reference](https://paseo.sh/docs/plugins/v0.7/reference.md)

Plugin 코드는 신뢰된 코드로 취급한다. 서버 코드는 데몬 사용자 권한으로 샌드박스 없이 실행되고, 클라이언트 코드는 Paseo 앱 안에서 실행된다. 프로세스 분리가 곧 권한 격리를 의미하지는 않는다. [Plugin 실행 모델](https://paseo.sh/docs/plugins/v0.7/reference.md)

### 확인된 사실: Workspace

Paseo는 프로젝트 아래에 Workspace를 두고, Workspace 안에 에이전트·터미널·브라우저 등의 세션을 배치한다. Workspace는 작업 디렉터리를 기반으로 하며, 기존 디렉터리를 사용하는 Local 방식과 Git worktree를 사용하는 방식이 있다. Workspace 생성과 에이전트 생성은 별개의 동작이다. [Workspaces 문서](https://paseo.sh/docs/workspaces.md)

### WorkNaru에 대한 해석

Paseo는 AI 연결성과 애플리케이션 확장을 함께 살펴볼 수 있는 가장 직접적인 참고 대상이다. 특히 Plugin이 도구 호출뿐 아니라 업무 화면과 서버 로직을 제공할 수 있다는 점이 WorkNaru의 Module 개념과 가깝다.

다만 다음을 별도로 판단해야 한다.

- WorkNaru의 AI 연결을 모델 API 호출만으로 정의하면 Paseo와 같은 기존 에이전트 연결 경험을 충분히 설명하지 못한다.
- Paseo의 프로젝트·Workspace 계층과 작업 디렉터리 중심 모델을 WorkNaru에 그대로 적용할 근거는 아직 없다.
- 실험적 Plugin API를 안정된 범용 계약으로 간주할 수 없다.
- 신뢰된 로컬 Plugin의 실행 모델이 향후 WorkNaru의 Module 제공자와 사용자 환경에도 적합한지는 미확정이다.

## Eclipse Theia

### 확인된 사실

Theia는 완성된 IDE이면서 독자적인 도구와 IDE를 만들 수 있는 플랫폼이다. 코어를 포함한 기능을 Theia Extension으로 구성하고, 필요한 확장을 선택해 제품을 조립할 수 있다. Theia Extension은 빌드 시 포함되며, 복잡한 화면과 서비스 및 플랫폼 내부 API에 접근할 수 있다.

별도로 런타임에 설치하고 정해진 API를 사용하는 VS Code 확장을 지원한다. 공식 문서는 확장 방식별 API 범위와 실행 시점을 구분한다. [Extensions and Plugins](https://theia-ide.org/docs/extensions/)

Theia AI는 일반 Agent와 Chat Agent를 구분한다. 일반 Agent는 에디터·위젯 등 다양한 화면에서 호출될 수 있고, Chat Agent는 기본 대화 UI에 통합되는 특수한 형태다. 모델 연결, 프롬프트 관리, 도구 함수, 결과 표시 등의 기반을 제공한다. [Theia AI](https://theia-ide.org/docs/theia_ai/)

### WorkNaru에 대한 해석

Theia는 플랫폼과 독립 기능의 구성 관계를 설계할 때 특히 유용하다. AI 기능 전체를 Chat 구조에 종속시키지 않고, 공통 기반과 업무별 화면·동작을 분리하는 사례다.

기능이 독립적인 Module이라는 것과 사용자가 실행 중 Plugin을 설치할 수 있다는 것은 별개의 요구다. 초기에는 제품과 함께 빌드되는 독립 Module로 시작하고, 실제 필요에 따라 외부 설치 기능을 도입하는 선택지도 가능하다. Module 구조를 위해 마켓플레이스와 동적 로딩 체계를 처음부터 모두 만들 필요는 없다.

이는 구조에 대한 참고 의견이며, Theia를 WorkNaru의 기반 프레임워크로 채택하자는 결정은 아니다. 채택 시에는 필요한 기능에 비해 플랫폼 체계가 얼마나 큰지 별도 검토해야 한다.

## Dify

### 확인된 사실

Dify는 AI 애플리케이션과 워크플로를 구축하는 플랫폼이다. Plugin 유형을 Model, Tool, Agent Strategy, Extension, Datasource, Trigger 등으로 구분한다.

Model은 모델을 연결하고, Tool은 에이전트나 워크플로가 호출할 기능을 제공한다. Agent Strategy는 도구 선택과 반복 실행 등의 추론 전략을 확장한다. Extension은 외부에서 호출하는 HTTP 진입점을 제공한다. Datasource는 지식 기반에 데이터를 공급하고, Trigger는 외부 사건으로 워크플로를 시작한다. [Plugin 유형 안내](https://docs.dify.ai/en/develop-plugin/getting-started/choose-plugin-type)

### WorkNaru에 대한 해석

모델 연결, 개별 도구 실행, 에이전트 실행 전략을 서로 다른 책임으로 구분하는 점이 유용하다. 서로 다른 요구를 하나의 거대한 확장 인터페이스에 넣지 않도록 참고할 수 있다.

다만 확인한 확장 지점은 AI 앱과 워크플로 실행 중심이다. 독립적인 업무 화면과 흐름을 가진 WorkNaru Module과 동일한 구조로 볼 근거는 부족하다.

## Open WebUI

### 확인된 사실

Open WebUI는 Tools와 Functions를 제공한다. Functions는 모델 연결 등을 위한 Pipe, 메시지 처리를 위한 Filter, UI 동작을 위한 Action으로 구분된다. 외부 서비스는 MCP와 OpenAPI로 연결할 수 있다. Tools와 Functions는 서버 프로세스 안에서 실행되며, 외부 도구 서버는 별도의 서비스로 실행할 수 있다. [Extensibility 문서](https://docs.openwebui.com/features/extensibility/)

### WorkNaru에 대한 해석

공통 AI 실행 과정에 어떤 확장 지점을 둘지 참고하기 좋다. 다만 도구, 모델 연결, 메시지 처리 확장을 제공한다는 사실만으로 독립적인 업무 Module의 구성 문제가 해결되지는 않는다.

## LibreChat

### 확인된 사실

LibreChat은 모델, 지침, 파일과 도구 등을 조합한 사용자 정의 에이전트를 제공한다. MCP 서버를 연결하고, 에이전트별로 사용할 도구를 선택할 수 있다. MCP 연결에서 사용자별 인증과 연결 격리, 접근 제어를 지원한다. [Agents](https://www.librechat.ai/docs/features/agents), [MCP](https://www.librechat.ai/docs/features/mcp)

### WorkNaru에 대한 해석

에이전트 구성과 도구 접근 권한을 플랫폼이 어떻게 관리할지 참고할 수 있다. 주된 확장 단위는 에이전트의 능력과 대화 기능이며, 독립적인 업무 화면과 실행 로직을 가진 Module의 참고 대상으로는 범위를 구분해야 한다.

## LobeHub

### 확인된 사실

LobeHub의 공식 README는 Agent Groups, Pages, Schedule, Project, Workspace를 함께 소개한다. Agent Builder와 도구·MCP 호환 Plugin을 통해 에이전트의 능력을 구성하고, 여러 에이전트와 함께 작업하는 제품 경험을 제시한다. [공식 README](https://github.com/lobehub/lobehub#readme)

### WorkNaru에 대한 해석

여러 AI 기능을 하나의 작업 공간에서 사용하는 제품 경험을 비교하기에 적합하다. 다만 기능의 존재와 새로운 업무 기능을 독립 Module로 추가할 수 있는 구조는 별개의 사항이다.

이번에 확인한 자료만으로 WorkNaru가 지향하는 Module 계약까지 갖췄다고 판단하지 않았다. README에 연결된 Plugin 개발 문서 경로는 조회 당시 404를 반환했으므로, 구체적인 Plugin 개발 계약은 추가 확인이 필요하다.

## 조사에서 도출한 설계 제안

이 절은 확인된 사실을 바탕으로 한 제안이다. 프레임워크 채택이나 구현 방식은 미확정이다.

### AI 연결의 두 가지 책임

| 연결 방식 | 플랫폼이 맡을 책임의 차이 |
| --- | --- |
| 모델 API 연결 | 모델 호출을 조합해 도구 실행, 대화 흐름, 에이전트 반복 실행 등을 구성해야 한다. 이 중 일부는 별도 실행 라이브러리에 맡길 수도 있다. |
| 기존 에이전트 연결 | 외부 에이전트의 실행, 입출력, 상태와 사용자 개입을 연결하고 관리한다. 에이전트 자체가 소유하는 실행 동작과 경계를 맞춰야 한다. |

Paseo에서 인상받은 연결성을 목표로 한다면, WorkNaru의 AI 기반을 모델 API 호출 계층으로만 정의해서는 부족하다. 두 연결 방식을 어디까지 지원할지는 플랫폼 설계에서 정해야 한다.

### 확장 개념의 구분

- **Module:** 사용자가 수행하는 업무 기능의 책임 단위. 자신의 화면과 업무 흐름을 소유하고 플랫폼의 공통 서비스를 사용한다.
- **Provider:** AI 실행 주체를 연결하는 책임. 모델 API 연결과 외부 에이전트 연결의 차이를 표현할 수 있어야 한다.
- **Tool:** 에이전트나 업무 흐름이 호출하는 개별 실행 수단.
- **Plugin:** Module·Provider·Tool 등을 설치하고 배포하는 방식으로 구분해볼 수 있다. Module과 반드시 같은 뜻으로 사용할 필요는 없다.

위 명칭과 관계는 설계 검토를 위한 구분안이다. 모든 유형을 즉시 구현해야 한다는 기능 명세가 아니다.

### 참고 우선순위

1. Paseo를 AI 에이전트 연결, 실행 관리, Workspace와 Plugin 경계의 핵심 참고 대상으로 삼는다.
2. Theia를 플랫폼과 독립 기능의 구성 방식, Chat에 종속되지 않는 AI 기능 구조의 핵심 참고 대상으로 삼는다.
3. Dify를 모델·도구·에이전트 전략의 책임 구분에 참고한다.
4. Open WebUI와 LibreChat을 공통 AI 실행 확장과 도구 연결·접근 제어에 참고한다.
5. LobeHub를 여러 에이전트와 업무 기능을 하나의 작업 공간에서 사용하는 제품 경험에 참고한다.

## 미확인 사항과 추가 검토 항목

- WorkNaru에서 기존 에이전트 연결과 모델 API 연결 중 무엇을 우선 제공할지
- Workspace와 Project의 관계 및 작업 디렉터리 의존 여부
- Module이 소유할 화면·데이터·실행 흐름과 플랫폼이 공개할 최소 API
- 제품에 포함되는 Module과 외부에서 설치하는 Plugin을 구분할 필요가 있는지
- 신뢰된 내부 Module과 제삼자 코드의 권한·실행 격리를 어떻게 다룰지
- Provider마다 다른 실행 상태, 취소, 승인 요청, 세션 재연결을 어느 범위까지 공통화할 수 있는지
- LobeHub의 현재 Plugin 개발 계약과 독립 업무 화면 확장 가능 여부
- 특정 제품을 기반으로 채택하거나 코드를 재사용할 경우의 유지보수 비용과 라이선스 조건

후속 설계에서는 Paseo의 Provider·Plugin·Workspace 구조와 Theia의 확장 구조를 바탕으로, WorkNaru 플랫폼의 책임과 Module에 공개할 최소 계약을 검토할 수 있다. 실제로 채택한 중요한 설계 결정은 프로젝트 기록 규약에 따라 별도 ADR에 남기고 이 문서를 근거로 연결한다.
