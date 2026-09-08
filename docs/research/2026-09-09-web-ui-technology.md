# WorkNaru의 확장 방향을 기준으로 한 화면 기술 비교

- 조사일: 2026-09-09
- 관련 작업: [첫 Chat Web UI #10](https://github.com/NaruForge/worknaru/issues/10)
- 제품 기준: [README](../../README.md), [Module 계약](../design/module-platform-contract.md), [승인된 화면 기준](../design/workspace-chat-ui.md)
- 선택 제안과 결정 상태의 원본: [ADR-0015](../adr/0015-use-react-typescript-and-vite-for-web-ui.md)

## 판단의 출발점

WorkNaru는 Chat 앱을 크게 만드는 제품이 아니다. Chat, 보고서 작성, 문서 정형화처럼 서로 다른 업무 화면을 하나의 Workspace에서 이용하는 플랫폼이다. 보고서와 문서 정형화는 제품 방향의 예시이며, 기존 프로젝트의 이식이나 특정 편집기 도입이 확정된 것은 아니다.

화면 기술은 다음 요구를 함께 만족해야 한다.

| 제품 방향 | 화면 기술에서 확인할 점 | 우선순위 |
| --- | --- | --- |
| 공통 작업 환경 안의 독립적인 Module | 공통 탐색과 각 업무 화면을 분리하고, 목록 없는 화면도 구성할 수 있는가 | 필수 |
| AI 없이도 남는 업무 데이터 | 에디터·양식·검토 화면이 Chat 또는 AI Session의 상태에 묶이지 않는가 | 필수 |
| Daemon이 실행과 기록의 원본 | WebSocket 구독·재접속을 UI 수명과 분리하고, 전송 중복과 오래된 응답을 제어할 수 있는가 | 필수 |
| 웹과 Windows 데스크톱의 공통 Web UI | 브라우저에서 동작하는 정적 산출물로 시작하고, 데스크톱 컨테이너 선택을 미룰 수 있는가 | 필수 |
| 다양한 업무 도구의 점진적 추가 | 문서 편집·표·그래프 등 기존 UI 라이브러리의 통합 경로가 있는가 | 높음 |
| 작은 코어와 첫 Chat 검증 | 아직 필요 없는 서버·패키지·플러그인 프레임워크 없이 시작할 수 있는가 | 높음 |
| 장기 유지보수 | 컴포넌트·상태·구독의 책임을 읽고 테스트할 수 있으며, 업그레이드 비용을 통제할 수 있는가 | 높음 |

이 기준은 평가자의 제품 적합성 판단이다. 시장 점유율이나 임의의 숫자 점수를 근거로 순위를 만들지 않는다. 팀의 프레임워크 숙련도, 실제 문서 편집 성능과 최종 데스크톱 메모리 사용량은 아직 측정하지 않았다.

## 비교 대상

화면 작성 기술은 React, Vue 3, Svelte, Angular, Lit/Web Components를 비교한다. TypeScript는 이들과 조합하는 언어이며, Vite는 개발·빌드 도구다. Next.js 등의 애플리케이션 프레임워크와 Electron·Tauri 등의 데스크톱 컨테이너는 별도 선택 축으로 다룬다.

| 후보 | WorkNaru에 맞는 점 | 부담과 확인할 점 | 이번 판단 |
| --- | --- | --- | --- |
| **React + TypeScript** | 컴포넌트 합성으로 공통 화면과 Module 화면을 구성할 수 있다. 명시적인 상태와 외부 저장소 구독을 연결할 수 있으며, 업무용 UI 통합 후보를 확인했다. | 상태·Effect·렌더링 수명을 개발자가 설계해야 한다. 프레임워크 선택만으로 재접속 일관성이나 성능이 해결되지 않는다. | **첫 구현의 추천안.** 작은 클라이언트에서 시작하고 다양한 업무 화면으로 확장할 선택지를 확보한다. |
| **Vue 3 + TypeScript** | SFC와 Composition API로 화면·스타일·반응형 로직을 구성한다. Router·Pinia 등 공식 생태계의 선택 경로도 명확하다. 공통 화면과 Module의 분리가 가능하다. | `.vue` 템플릿과 관련 타입 도구를 함께 관리한다. React보다 확장성이 떨어진다는 근거는 없으며, 실제 업무 도구 조합과 팀 경험에 따라 더 적합할 수 있다. | **가장 가까운 대안.** 팀의 Vue 숙련도 또는 핵심 Module의 Vue 자산이 확인되면 우선순위가 바뀔 수 있다. |
| **Svelte + TypeScript** | 컴파일 기반 컴포넌트와 반응성으로 화면 코드를 간결하게 구성할 수 있다. Svelte Flow 등 복잡한 업무 UI 후보도 있다. | Svelte 전용 반응성·컴파일 모델을 익혀야 한다. 목표 편집기·컴포넌트의 지원 형태를 실제 조합별로 검증해야 한다. | 충분히 가능한 대안. 코드 간결성이 강점이지만 현재는 특정 Module 통합상의 결정적 이득을 확인하지 못했다. |
| **Angular** | 컴포넌트, 의존성 주입, 라우팅·폼 등 일관된 앱 구성 수단이 있다. 큰 팀이 공통 규칙을 따르는 업무 앱에 활용할 수 있다. | 현재 첫 Chat에서 사용하지 않을 개념과 앱 규약을 먼저 받아들이는 비용이 있다. 향후 복잡하다는 이유만으로 지금부터 전체 구조를 도입할 필요는 없다. | 팀 규모와 통합 규약의 필요가 입증된 경우 재검토. 현재의 점진적 개발 방식에는 우선하지 않는다. |
| **Lit / Web Components** | 웹 표준 Custom Elements 기반으로 특정 프레임워크 밖에서도 재사용할 수 있는 컴포넌트를 만든다. | 전체 앱의 상태·탐색·폼·라이브러리 통합을 별도로 조합해야 한다. Shadow DOM의 스타일·포커스·접근성도 확인해야 한다. | 여러 프레임워크에 배포할 공통 위젯 요구가 생기면 유용하다. 외부 Module 설치 계약이 없는 현재의 기본 화면 기술로는 이르다. |
| **프레임워크 없는 DOM + TypeScript** | 의존성이 작고 기존 시안을 직접 옮기기 쉽다. | 대화별 초안, 스트리밍, 모달 포커스, 여러 비동기 요청의 수명을 직접 조정하는 코드가 늘어난다. | 시안에는 적합했다. 지속적으로 업무 화면을 추가할 제품 기반에는 컴포넌트 기술을 선택한다. |

React의 컴포넌트·빌드 구성은 [React 공식 안내](https://react.dev/learn/build-a-react-app-from-scratch), 외부 상태 구독은 [useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore)를 근거로 확인했다. Vue의 선언형 렌더링·SFC·Composition API는 [Vue 3 소개](https://vuejs.org/guide/introduction.html), Svelte의 컴파일 기반 구성은 [Svelte 개요](https://svelte.dev/docs/svelte/overview), Angular의 앱 구성 수단은 [Angular 개요](https://angular.dev/overview), Lit의 Custom Elements 기반은 [Lit 문서](https://lit.dev/docs/)에서 확인했다. 표의 적합성·비용 평가는 이 기능들과 저장소 요구를 연결한 판단이다.

## ‘업무 UI 생태계’를 구체적으로 확인한 결과

React에만 업무용 라이브러리가 있다는 주장은 하지 않는다. 다음은 통합 후보의 존재를 확인한 자료이며, 해당 라이브러리의 채택·라이선스 적합성·모든 기능의 동등성을 확인한 결과가 아니다.

| 예상 업무 표현 | 확인한 경로 | 선택에 주는 의미 |
| --- | --- | --- |
| 보고서·문서 편집 | [Tiptap](https://tiptap.dev/docs/editor/getting-started/overview)은 headless 편집기이며 여러 프레임워크의 통합 경로를 제공한다. | React와 Vue 등에서 검토할 수 있다. 문서 편집 하나만으로 React가 필수라는 근거는 아니다. |
| 표·데이터 검토 | [AG Grid](https://www.ag-grid.com/javascript-data-grid/getting-started/)는 JavaScript와 프레임워크별 사용 경로를 제공한다. | 그리드 기능·라이선스·성능은 Module 도입 시 검토한다. 프레임워크 선정을 위해 미리 설치하지 않는다. |
| 노드·연결 기반 작업 화면 | [React Flow](https://reactflow.dev/learn), [Vue Flow](https://vueflow.dev/), [Svelte Flow](https://svelteflow.dev/)를 확인했다. | 세 후보 모두 구현 경로가 있다. 기능·API가 같거나 WorkNaru의 워크플로 엔진이 승인됐다는 뜻은 아니다. |

이번 자료만으로 React의 시장 규모나 모든 라이브러리의 우위를 증명할 수는 없다. **React를 추천하는 이유는 복수의 업무 UI 경로를 확인하면서, TypeScript 컴포넌트와 별도의 Daemon 클라이언트로 작은 첫 구현을 구성할 수 있다는 종합 판단**이다. Vue도 이 조건을 대부분 만족한다. 결정적인 독점 기능이 있어서 선택하는 것은 아니다.

가까운 후보 중 React에 무게를 둔 구체적인 출발 비용은 기존 타입 검사 도구의 재사용이다. React의 `.tsx` 화면은 기존 TypeScript 검사에 포함할 수 있다. Vue의 권장 SFC 방식을 쓰면 템플릿을 확인하는 `vue-tsc`를 함께 운용한다. Vue도 TSX를 지원하므로 불가능의 차이는 아니며, 현재 별도 프런트엔드 자산·팀 선호가 없는 상황에서 기존 TypeScript 도구와 일반 TS 로직의 연결을 우선한 선택이다. [React TypeScript](https://react.dev/learn/typescript), [Vue TypeScript와 SFC 검사](https://vuejs.org/guide/typescript/overview.html)

## Vite와 서버 프레임워크의 구분

[Vite](https://vite.dev/guide/)는 개발 서버와 정적 자산 빌드를 제공한다. 현재 Node 24 환경에서 사용할 수 있으며 구체 버전과 호환성은 설치·빌드로 검증한다. React뿐 아니라 Vue·Svelte 등의 템플릿도 제공하므로 Vite 선택이 React만 가능한 구조를 만드는 것은 아니다.

React 공식 문서는 새 앱에 프레임워크 사용을 먼저 권하고, 제약이 맞지 않을 때 Vite 등으로 직접 구성하는 경로도 안내한다. WorkNaru는 이미 별도 Daemon이 실행·인증·저장을 담당하고, 현재 SEO·서버 렌더링·서버 액션 요구가 없다. 따라서 첫 UI에는 정적 클라이언트 빌드를 선택한다. 라우팅·데이터 로딩·오류 처리를 직접 책임져야 한다는 비용은 남는다.

[Next.js도 정적 내보내기를 지원](https://nextjs.org/docs/app/guides/static-exports)하므로 Daemon 구조와 기술적으로 충돌한다고 배제하는 것은 아니다. 현재 필요한 것보다 넓은 앱 규약을 도입할 이득이 확인되지 않았다는 판단이다. 공개 콘텐츠나 서버 렌더링 요구가 생기면 해당 화면의 요구로 다시 검토한다.

## 데스크톱과 Module 확장에 관한 한계

[Tauri는 프런트엔드 구성을 별도로 받으며](https://v2.tauri.app/start/frontend/), [Electron의 renderer는 웹 화면을 실행](https://www.electronjs.org/docs/latest/tutorial/process-model)한다. 따라서 이번 화면 기술 선택으로 Electron 또는 Tauri를 확정할 필요가 없다. 실제 컨테이너에서는 WebView 호환성, IPC·Origin 인증, Daemon 실행·종료, 배포와 업데이트를 별도로 검증해야 한다. 브라우저 검증을 데스크톱 검증이라고 부르지 않는다.

플랫폼과 기본 제공 Module의 화면은 한 기술로 일관되게 작성하되, **플랫폼의 통신 계약과 업무 데이터 모델에는 React 타입을 넣지 않는다.** 화면 안의 공통 레이아웃은 React에 의존해도 되지만 AI 실행 API가 React 또는 Chat을 요구해서는 안 된다. 다른 Module이 목록을 생략하고 전체 본문을 쓰는 구조는 승인된 A안을 따른다.

외부 Module이 반드시 React를 써야 하는지, 다른 프레임워크·iframe·Web Components를 어떻게 허용할지는 이번 선택에 포함하지 않는다. iframe이나 Web Components를 사용한다고 자동으로 신뢰·권한 격리가 생기지 않는다. 설치·버전·신뢰 계약이 필요해질 때 결정한다. 현재 이를 위한 범용 어댑터나 동적 로더를 만들지 않는다.

## 선택과 재검토 기준

첫 공통 작업 화면과 Chat은 **React + TypeScript + Vite**로 구현하는 것을 추천한다. 스타일은 승인 시안을 바탕으로 CSS로 작성하며, 상태 관리·라우터·컴포넌트 라이브러리는 실제 필요가 확인될 때 추가한다.

첫 구현에서 확인할 것은 TypeScript 검사·정적 빌드, 실제 Daemon과의 생성·응답·취소·재접속, 대화 전환 시 초안 유지, 한국어 입력, 좁은 화면과 포커스, 긴 기록과 저장 실패 표시다. 아직 선택하지 않은 문서 편집기를 넣어 전체 확장성을 검증했다고 주장하지 않는다.

다음 근거가 생기면 선택 또는 적용 범위를 재검토한다: 팀의 강한 다른 기술 숙련도, 핵심 Module의 기존 UI 자산과 이식 비용, 필수 라이브러리의 지원·라이선스 제약, 실제 WebView에서 재현되는 호환성 문제, 측정된 렌더링·메모리 문제가 구조 개선으로 해결되지 않는 경우. 한 번의 벤치마크나 유행만으로 기존 화면 전체를 교체하지 않는다.
