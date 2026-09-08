# 0003. 폴더 기반 Workspace 채택

- 날짜: 2026-09-08
- Status: Accepted
- 관련 Work Item: [#3 WorkNaru 플랫폼 초기 아키텍처 설계](https://github.com/NaruForge/worknaru/issues/3)
- 관련 ADR: [0002. Daemon 중심 코어와 웹·데스크톱 공통 접속 구조](0002-use-daemon-core-with-web-and-desktop-clients.md)
- 관련 문서: [제품 방향](../../README.md), [프로젝트 기록 규약](../project-records.md)

## Context

WorkNaru에서 파일, Module의 업무와 에이전트 실행이 속할 작업 공간의 기준이 필요하다. 폴더를 기반으로 작업 공간을 정의하는 방식과 파일 시스템에 독립적인 논리 공간으로 정의하는 방식을 검토했다. Workspace 위에 Project 계층을 둘지도 미정이었다.

폴더 기반 공간은 사용자가 보유한 파일과 실제 작업 위치를 직접 연결할 수 있다. 논리 공간은 폴더 없는 작업이나 여러 저장 위치를 묶는 데 유연하지만, 초기부터 별도의 소속·파일 연결 규칙이 필요하다.

## Decision

**Workspace는 폴더를 기반으로 정의한다. Project 계층은 현재 정의하지 않는다.**

초기 플랫폼은 별도의 Project 객체나 Project와 Workspace 사이의 계층을 전제로 설계하지 않는다. Project의 향후 도입 여부는 실제 요구가 생길 때 결정한다.

### 승인 근거

2026-09-08 사용자가 다음과 같이 명시했다.

> Workspace는 폴더로 정합니다. 아직 프로젝트 레벨은 정의하지 않겠습니다.

이 사용자 결정을 근거로 `Accepted`로 기록한다.

### 후속 설계로 남기는 사항

- Workspace 식별자, 경로 정규화와 동일 폴더 판별, 폴더 이동·삭제 처리
- 세션이 Workspace에 소속되는 관계의 상세 모델과 세션 수, Module 간 공유 방식
- 폴더 밖 파일 접근 정책과 Workspace 관련 메타데이터의 저장 위치

세션의 Workspace 소속과 Module 간 공유의 후속 지원은 사용자가 제시한 방향이다. Workspace마다 여러 세션을 허용하고 생성한 Module이 사용하는 구체적인 모델은 제안 단계이며, 이번 승인 범위에 포함하지 않는다.

## Consequences

- 사용자가 작업할 폴더와 Workspace를 연결하는 명확한 출발점을 확보한다.
- Project 계층을 먼저 구현하지 않고 Workspace 중심으로 초기 플랫폼을 설계할 수 있다.
- 폴더 없는 작업 공간이나 여러 폴더를 하나의 공간으로 묶는 요구는 추가 설계가 필요하다.
- 폴더 이동·삭제와 경로 별칭이 생겨도 세션·기록의 연결을 어떻게 유지할지 정해야 한다.
- Workspace 폴더는 작업 공간의 기준이다. 이 결정만으로 에이전트의 파일 접근 권한이나 샌드박스 경계를 확정하지 않는다.

진행 상태와 후속 작업의 범위는 관련 GitHub Issue와 전용 Project에서 관리한다.
