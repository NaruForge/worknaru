# WorkNaru Design System

관련 작업과 사용자 선택: [#25](https://github.com/NaruForge/worknaru/issues/25).
제품 책임은 [README](../../README.md), 기존 탐색·입력 기준은 [공통 UI 기준](workspace-chat-ui.md)을 따른다.

## 컨셉과 선택 절차

WorkNaru의 UI는 조용하고 구조적이며 업무 중심이어야 한다. 사용자의 작업·결과·AI 실행 상태를 명확히 보여주고, 같은 의미의 조작은 같은 표현과 동작을 사용한다.

사용자가 지정한 Main Color 하나로 배색을 생성한다. 개인 색 설정은 동일 origin의 브라우저에 저장하며 Module 전체에 적용한다. Daemon이나 Workspace 공통 설정이 아니다.

컨셉 v1은 A(강조색 중심)와 B(표면에도 색감)를 같은 예제 화면에서 비교한다. 배색 계수는 사용자 선택 전의 후보이며 제품의 확정값이 아니다. 비교 화면의 ‘현재 배색’은 기존 CSS를 사용한다. 예제 Chat·설정·연결 화면의 조립은 배색 비교용이며 실제 업무 계약을 검증하는 대체 구현이 아니다. Shell·Dialog·아이콘·모델 선택·파일 미리보기는 제품 구현을 재사용한다.

컨셉은 사용자와 먼저 논의하고 A/B 또는 수정안을 직접 체험한 뒤 선택받는다. 선택 후 실제 공통 control과 설정의 미리보기·적용·취소를 체험하도록 제공한다. 새로운 시각·상호작용 결정은 해당 프로토타입의 명시적 선택을 받아 적용한다. 무응답을 승인으로 취급하지 않는다. 선택 근거와 버전은 이슈에 연결한다.

## 책임과 사용 규칙

- 플랫폼은 semantic token, 기본 control, 공통 shell, focus·overlay 표현을 제공한다. Module은 업무 목록·본문·입력 의미와 화면 구성을 소유한다.
- UI primitive는 표시값과 callback을 받는다. Daemon 연결·저장·실행 성공·권한 판단은 소유하지 않는다.
- Chat의 Enter 전송·한글 조합·초안 규칙을 generic TextArea에 넣지 않는다. 창 닫기나 Escape를 승인·거절·실행 중지로 해석하지 않는다.
- Main Color와 상태의 의미를 구분한다. 위험·경고·성공은 서로 식별할 수 있는 색·문구·아이콘으로 전달하고, Light/Dark 모두 전경과 배경의 대비를 확인한다.
- 새 control을 만들기 전에 현재 소비처와 같은 의미·행동인지 확인한다. 미사용 variant와 Module 이름에 따라 분기하는 primitive는 만들지 않는다.
- 색·치수의 값은 token 코드, component API는 TypeScript, 동작 기준은 시험이 소유한다. 문서에 별도 수동 catalog를 복제하지 않는다.

## 시안의 검증 범위

v1의 OKLCH 변환은 [CSS Color 4의 색공간 정의](https://www.w3.org/TR/css-color-4/#color-conversion-code)를 참고한다. sRGB 범위 밖의 색은 chroma를 줄여 매핑하며, 주요 텍스트와 control 경계의 대비를 생성된 HEX 값으로 검증한다. CSS의 전체 gamut-mapping 알고리즘 구현을 표방하지 않는다.

현재 제품의 baseline은 main `268cc629a6abd61aa3dd6dfa83976d7db8dacd2a`에서 가짜 ACP를 사용해 캡처한다. 컨셉 선택은 미관과 사용성의 판단이며 자동 대비 시험으로 대신하지 않는다. 키보드·스크린리더·제품 기능 전체의 검증과 최종 사용자 확인은 실제 적용 단계에서 수행한다.

실행과 검증 명령은 [로컬 개발 안내](../development.md#디자인-컨셉-프로토타입)를 따른다.
