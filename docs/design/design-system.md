# WorkNaru Design System

관련 작업과 사용자 선택: [#25](https://github.com/NaruForge/worknaru/issues/25).
제품 책임은 [README](../../README.md), 기존 탐색·입력 기준은 [공통 UI 기준](workspace-chat-ui.md)을 따른다.

## 컨셉과 선택 절차

WorkNaru의 UI는 조용하고 구조적이며 업무 중심이어야 한다. 사용자의 작업·결과·AI 실행 상태를 명확히 보여주고, 같은 의미의 조작은 같은 표현과 동작을 사용한다.

사용자가 지정한 Main Color 하나로 배색을 생성한다. 개인 색 설정은 동일 origin의 브라우저에 저장하며 Module 전체에 적용한다. Daemon이나 Workspace 공통 설정이 아니다.

사용자는 2026-09-09 컨셉 v1의 A(강조색 중심)를 선택했다. [선택 기록](https://github.com/NaruForge/worknaru/issues/25#issuecomment-5597906453). A의 낮은 표면 채도와 강조색·대비 보정 방식을 배색의 기준으로 삼는다. v1 소스는 commit `1e31892`에서 확인할 수 있다.

조작 체험 v5는 제품의 공통 control과 Main Color 설정 구현을 사용한다. 예제 Chat·설정·연결 화면의 업무 조립은 실제 업무 계약을 검증하는 대체 구현이 아니다. 실제 Daemon을 사용하는 기존 브라우저 시험을 함께 유지한다.

컨셉은 사용자와 먼저 논의하고 A/B 또는 수정안을 직접 체험한 뒤 선택받는다. 선택 후 실제 공통 control과 설정의 미리보기·적용·취소를 체험하도록 제공한다. 새로운 시각·상호작용 결정은 해당 프로토타입의 명시적 선택을 받아 적용한다. 무응답을 승인으로 취급하지 않는다. 선택 근거와 버전은 이슈에 연결한다.

2026-09-09 사용자는 v3에서 파일 승인을 입력창 바로 위에 배치하고 나머지 시안을 승인했다. 공통 컨트롤·설정은 Main에서 조작하고, Chat의 Model·Reasoning Effort는 작은 선택값과 아이콘으로 표시한다. 오류 안내는 입력창 위에 작은 상태 문구로 제공한다. 파일 승인 패널은 처음 접힌 상태이며 내용을 펼친 뒤 명시적으로 허용·거절·중지한다.

사용자는 이어 v5의 설정 전용 메뉴와 모바일 탐색을 모두 승인했다. [조작·탐색 선택 기록](https://github.com/NaruForge/worknaru/issues/25#issuecomment-5598901563). 설정은 **화면·연결·AI** 메뉴를 갖는 독립된 플랫폼 화면이다. Chat의 대화 목록을 설정에서 재사용하지 않는다. 현재 Module의 업무 서비스 정의나 등록 체계는 확장하지 않는다.

넓은 화면에서는 서비스 탐색·해당 화면의 목록·Main을 나란히 표시한다. 860px 미만에서는 **Module 선택 → 목록 → Main** 중 한 단계만 표시하고, 44px 이상 높이의 목록 복귀 버튼을 제공한다. 브라우저 뒤로·앞으로 가기도 같은 탐색 기록을 사용한다. 목록이 없는 화면은 바로 Main을 표시할 수 있다. 화면 이동은 AI 실행·Session·승인 요청의 수명을 바꾸지 않는다.

대화 초안은 기존 Chat 상태가 소유한다. 목록으로 돌아가거나 설정을 오갈 때 선택 항목·목록 위치를 유지한다. Chat과 설정의 데스크톱 목록 접힘 상태는 각각 유지한다. 탐색 기록에는 화면 선택과 Session 식별자만 담고 초안·연결 키·승인 결정을 넣지 않는다. 다른 Workspace나 저장 세대에는 이전 대화의 탐색 기록을 적용하지 않는다.

## 책임과 사용 규칙

- 플랫폼은 semantic token, 기본 control, 공통 shell, focus·overlay 표현을 제공한다. Module은 업무 목록·본문·입력 의미와 화면 구성을 소유한다.
- UI primitive는 표시값과 callback을 받는다. Daemon 연결·저장·실행 성공·권한 판단은 소유하지 않는다.
- Chat의 Enter 전송·한글 조합·초안 규칙을 generic TextArea에 넣지 않는다. 창 닫기나 Escape를 승인·거절·실행 중지로 해석하지 않는다.
- Main Color와 상태의 의미를 구분한다. 위험·경고·성공은 서로 식별할 수 있는 색·문구·아이콘으로 전달하고, Light/Dark 모두 전경과 배경의 대비를 확인한다.
- 새 control을 만들기 전에 현재 소비처와 같은 의미·행동인지 확인한다. 미사용 variant와 Module 이름에 따라 분기하는 primitive는 만들지 않는다.
- 색·치수의 값은 token 코드, component API는 TypeScript, 동작 기준은 시험이 소유한다. 문서에 별도 수동 catalog를 복제하지 않는다.

## 개인 배색 설정

설정의 화면 배색에서 색상 선택기 또는 HEX 입력으로 미리 본다. ‘배색 적용’은 현재 탭 적용과 localStorage 저장을 수행한다. ‘취소’와 설정 화면 나가기는 마지막 적용색으로 복귀한다. ‘기본색 복원’도 먼저 미리 보며 적용 버튼으로 저장한다. AI 모델 설정의 즉시 저장 정책과는 별개다.

같은 origin의 다른 탭에서 배색을 저장하면 현재 미리보기를 종료하고 해당 저장값을 반영하며 안내한다. 저장하지 못한 경우 현재 탭 적용만 유지하고 실패를 알린다. 손상된 값·지원하지 않는 저장 버전은 기본색으로 시작한다. 접속 주소나 포트가 다르면 브라우저 저장 영역도 다르다.

Light/Dark는 기존처럼 OS의 초기 선호를 읽고 화면에서 전환한다. 이번 변경은 Main Color의 저장이며 테마 모드 저장이나 Daemon 설정 동기화 기능을 추가하지 않는다.

## 시안의 검증 범위

OKLCH 변환은 [CSS Color 4의 색공간 정의](https://www.w3.org/TR/css-color-4/#color-conversion-code)를 참고한다. sRGB 범위 밖의 색은 chroma를 줄여 매핑하며, 주요 텍스트와 control 경계의 대비를 생성된 HEX 값으로 검증한다. CSS의 전체 gamut-mapping 알고리즘 구현을 표방하지 않는다.

현재 제품의 baseline은 main `268cc629a6abd61aa3dd6dfa83976d7db8dacd2a`에서 가짜 ACP를 사용해 캡처한다. 컨셉 선택은 미관과 사용성의 판단이며 자동 대비 시험으로 대신하지 않는다. 키보드·스크린리더·제품 기능 전체의 검증과 최종 사용자 확인은 실제 적용 단계에서 수행한다.

실행과 검증 명령은 [로컬 개발 안내](../development.md#디자인-컨셉-프로토타입)를 따른다.

## 공통 control의 크기와 상태

기본 한 줄 Button·Input·Select는 같은 글자 크기·테두리 공간·최소 높이를 사용한다. 강조 variant는 geometry를 바꾸지 않는다. native Select는 Edge의 고유 줄높이를 감안해 공통 Select 안에서 block padding을 보정한다. 높이를 고정해 긴 label이나 확대된 글자를 자르지 않는다. 관련 보강: [#32](https://github.com/NaruForge/worknaru/issues/32).

작은 보조 버튼은 `density="compact"`, Chat의 native 선택기는 `compact`, 원형 전송·중지는 `shape="round"`, composer의 테두리 없는 TextArea는 `presentation="plain"`으로 의미 있는 차이를 선택한다. 모델 선택기의 아이콘과 화살표, 숨긴 label 처리는 공통 Select·Field가 담당한다. 소비 화면은 배치와 가용 너비를 정한다. 여러 줄 navigation row와 문장 속 복구 링크는 form control과 다른 역할이므로 기존 행 배치·작은 텍스트 조치 규격을 유지한다. 모바일 복귀 버튼의 최소 hit area도 유지한다.

Field의 오류는 설명·ARIA 연결과 테두리를 함께 유지하고 focus ring과 공존한다. 테두리 없는 inline control은 내부 밑줄로 오류를 표현한다. `focus-ring`은 강조색과 별개의 의미이며 Button·Input·TextArea·Select가 직접 소비한다. 개인 배색 생성이나 업무 상태·권한 계약은 이 규칙의 책임이 아니다.

모바일 탐색 전환의 focus는 화면 배치 직후 설정한다. 다음 animation frame으로 미뤄 사용자가 시작한 입력에서 focus를 빼앗지 않는다.

공통 control fixture는 기존 시안의 ‘공통 컨트롤’ 화면을 사용한다. 크기·상태 검사는 실제 component와 전체 제품 CSS를 사용하며, 대표 제품 화면은 실제 Daemon을 사용하는 E2E에서 별도로 비교한다. 새 이미지 기준은 PR에서 사람이 검토할 후보이며 생성이나 자동 시험 통과를 사용자 승인으로 간주하지 않는다. 승인 뒤에는 의도적인 변경의 전후 비교와 이유를 확인하여 갱신한다.
