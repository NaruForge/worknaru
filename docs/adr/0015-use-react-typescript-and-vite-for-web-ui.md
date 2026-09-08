# 0015. 공통 Web UI에 React·TypeScript·Vite 사용 제안

- 날짜: 2026-09-09
- Status: Proposed
- 관련 작업: [첫 Chat Web UI #10](https://github.com/NaruForge/worknaru/issues/10)
- 비교 근거: [미래 방향을 기준으로 한 화면 기술 비교](../research/2026-09-09-web-ui-technology.md)
- 관련 결정: [공통 Web UI](0002-use-daemon-core-with-web-and-desktop-clients.md), [작은 초기 패키지](0013-start-with-one-package-and-explicit-code-boundaries.md), [서비스·Module 탐색](0014-separate-service-navigation-from-module-navigation.md)

## Context

WorkNaru는 Chat에 이어 서로 다른 업무 Module을 추가하는 AI Workspace다. 공통 탐색과 Module 화면을 구분하고, 업무 데이터·AI 실행의 원본은 UI와 분리해야 한다. 첫 A안 화면이 승인됐으며 실제 Daemon에 연결할 화면 기술이 필요하다.

React, Vue 3, Svelte, Angular, Lit/Web Components와 직접 DOM 구성을 비교했다. React·Vue·Svelte 모두 핵심 요구를 충족할 수 있다. React만 확장 가능하다는 판단은 하지 않는다. 확인한 업무 UI 통합 경로, TypeScript 컴포넌트 구성과 현재의 작은 시작 방식을 함께 고려해 React를 추천한다. 구체적인 장단점·공식 출처·미확인 항목은 비교 문서를 따른다.

가까운 Vue 대안과 비교하면, 기존 TypeScript 검사 도구로 TSX까지 확인하면서 프레임워크와 무관한 접속·업무 로직을 함께 다룰 수 있다는 출발 비용을 우선했다. Vue SFC도 별도 타입 도구로 같은 목적을 달성할 수 있다. 팀 선호나 기존 Module 자산이 확인되면 이 판단은 달라질 수 있다.

## Decision

다음 선택을 제안하고 첫 Chat 구현에서 검증한다.

1. 공통 작업 화면과 첫 기본 제공 Chat은 React와 TypeScript로 작성한다. 공통 탐색과 Chat의 목록·본문 책임을 분리한다.
2. Vite로 개발 서버와 정적 화면 산출물을 만든다. 실행·저장·인증의 원본은 기존 Daemon에 유지한다. 현재 서버 렌더링 또는 별도 UI 서버 런타임을 도입하지 않는다.
3. 통신 클라이언트와 데이터 계약은 React에 의존하지 않는다. 화면 수명과 AI 실행 수명을 분리하고, 접수 불명 요청은 같은 요청 ID로 조회한다.
4. 루트 패키지 하나에서 실제 UI 코드와 별도 브라우저 빌드 설정만 추가한다. 스타일은 CSS로 시작하고, 외부 상태 관리·라우터·UI 라이브러리·범용 Module 로더는 필요 전에 추가하지 않는다.

### 작업 지시와 결정 상태

2026-09-09 사용자는 기술 선택 이유를 확인한 뒤 “이 프로젝트가 추구하는 미래의 방향성에 부합하는 화면 기술을 비교해서 문서로 정리한 뒤 그 선택 근거를 남겨줘. 그리고 후속 작업을 진행해”라고 요청했다. 이를 비교 문서 작성과 선택안에 따른 후속 구현·검증의 근거로 기록한다. 특정 비교 결과에 대한 명시적인 채택 확인은 아직 없으므로, 프로젝트 기록 규약에 따라 Agent가 이 ADR을 Accepted로 바꾸지 않는다. 구현·검증은 승인된 후속 작업이며 ADR 최종 채택과 구분한다.

## Consequences

- 다양한 Module 화면을 같은 컴포넌트 모델로 구성하고 별도 Daemon 클라이언트를 사용할 수 있다. React가 Module 설치·신뢰·업무 데이터 계약을 대신하지는 않는다.
- React의 렌더링·구독 수명, 비동기 응답 경쟁과 상태 소유권을 명시적으로 다뤄야 한다. TypeScript만으로 런타임 입력 검증을 대체하지 않는다.
- React 의존 UI의 교체에는 재작성 비용이 있다. 통신·업무 규칙을 화면 밖에 유지해 영향을 줄이되, 가상의 프레임워크 교체를 위한 범용 계층은 만들지 않는다.
- Vue는 가까운 대안이다. 실제 팀 숙련도·기존 Module 자산·필수 라이브러리·측정 성능의 근거가 달라지면 재검토한다.
- 데스크톱 컨테이너, 외부 Module의 화면 기술·격리, 보고서 편집기, 제품 배포 방식은 확정하지 않는다. 기존 Accepted ADR을 대체하지 않는다.
