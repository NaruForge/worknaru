# 프로젝트 기록 규약

## Provider와 적용 대상

- Work Item provider: **GitHub**.
- 저장소: [NaruForge/worknaru](https://github.com/NaruForge/worknaru) (공개).
- Project: [worknaru #6](https://github.com/users/NaruForge/projects/6), 소유자 `NaruForge`, 비공개, ID `PVT_kwHOAmTnZc4BiyCQ`.
- Progress field: native `Status`, ID `PVTSSF_lAHOAmTnZc4BiyCQzhhoxCo`.
- Board: [Repository work](https://github.com/users/NaruForge/projects/6/views/1), Status별 그룹, filter `repo:NaruForge/worknaru is:issue`.
- 초기 선택 근거: 기존 GitHub 원격과 활성화된 Issues, 지속적인 제품 개발 목적. 설치 당시 로컬 기록, Issue, PR, Milestone, 연결된 Project가 없었다.
- Project를 읽거나 쓸 수 없는 경우 진행 상태를 로컬 backlog나 status label로 대신 기록하지 않고 접근 문제를 보고한다.

2026-09-08 사용자가 저장소 주소 변경을 확인했다. GitHub에서 현재 저장소와 Project의 소유자, 비공개 여부, 저장소 연결 및 동일한 Project ID를 재확인해 위 주소를 갱신했다. 사용자 요청에 따라 Board filter도 현재 저장소 주소로 수정하고 재조회로 적용을 확인했다. 설치 당시의 근거와 Blueprint provenance는 당시 기록으로 보존한다.

2026-09-09 사용자가 “내가 공개로 전환했습니다.”라고 저장소 공개 전환을 확인했다. GitHub에서 저장소 소유자 `NaruForge`와 공개 상태, 동일한 Project ID 및 Project의 비공개 상태를 재확인해 현재 저장소 표시만 갱신했다. Project 공개 범위·구성과 설치 당시 provenance는 변경하지 않는다.

이 문서와 Agent 지침, GitHub의 native surface만으로 운영한다. Blueprint 재열람, bootstrap Skill, 서비스, 데이터베이스, 상태 동기화나 수동 index는 일상 운영의 전제 조건이 아니다.

## 기록의 원본

| 정보 | 유일한 authoritative source |
| --- | --- |
| Repository work의 내용 | 이 저장소 GitHub Issue의 제목과 본문 |
| Kind | Issue label 중 `idea`, `work`, `bug` 정확히 하나 |
| Progress | 위 전용 Project의 native `Status` field |
| Modifier | Issue의 `blocked`, `needs-triage` label |
| Closure | Issue의 open/closed 및 `state_reason`; 세부 사유는 종료 comment |
| Issue 간 dependency | GitHub native `blocked by` / `blocking` 관계 |
| 외부 선행조건과 위험 | Issue 본문의 해당 항목 |
| Release scope | Issue의 Milestone; 실제 release 또는 delivery 범위만 표현 |
| 담당자 | Issue Assignees |
| Priority와 area | 초기에는 별도 분류를 사용하지 않음; 도입 전에 원본을 지정한 변경안 승인 |
| Personal next action | 사용자가 사용하는 개인 시스템; 이 설치에서는 만들지 않음 |
| 완료된 구현 이력 | Git commit 및 merged PR |
| Durable decision 및 그 상태 | 해당 `docs/adr/NNNN-kebab-case-title.md` 파일 |

Project의 Labels, Assignees, Milestone 등의 native 표시는 Issue 원본의 조회 화면이다. 같은 정보를 별도 custom field에 복제하지 않는다. Issue 본문, status label, 로컬 문서, 수동 index에 progress를 복제하지 않는다. 개인 reminder에는 Issue 링크를 둘 수 있지만 두 번째 backlog나 진행 원본으로 사용하지 않는다. 별도의 완료 장부나 ADR 상태 표를 만들지 않는다.

## Work Item 종류와 내용

- `idea`: 구현 승인 전 제안. 승인되면 동일 Issue의 kind를 `work`로 바꾼다. 승인 전에는 Ready로 올리지 않는다.
- `work`: 승인된 검증 가능한 결과 하나. 승인 근거를 Issue에서 찾을 수 있어야 한다.
- `bug`: 기대 동작과 다른 재현 가능한 동작. 확인되지 않은 사실을 만들어 넣지 않는다.

모든 Issue에는 배경 또는 문제, 원하는 결과, 범위, 비목표, 검증 가능한 완료 조건, 외부 선행조건 또는 위험, 관련 증거가 있어야 한다. Bug에는 환경, 재현 단계, 기대 동작, 실제 동작을 추가한다. 미확인 정보는 미확인이라고 명시한다. 종류별 접수 양식은 `.github/ISSUE_TEMPLATE/`에 있다. 빈 Issue로 접수한 경우에도 같은 내용 기준을 적용한다.

Issue 간 선행관계는 native dependency에 기록하고 본문에 목록을 복사하지 않는다. 외부 장애는 본문에 설명하고 `blocked`로 표시한다. native dependency만으로 발생한 차단을 `blocked` label로 다시 복제하지 않는다. `needs-triage`는 분류 또는 검토가 필요하다는 뜻이다. 두 modifier는 progress 단계가 아니다.

## Lifecycle

`Inbox -> Backlog -> Ready -> In progress -> In review -> Done`

| Canonical 단계 | Project `Status` 값 | 진입 기준 |
| --- | --- | --- |
| Inbox | `Inbox` | 접수, 미분류 |
| Backlog | `Backlog` | 검토 후 보관, 착수 미확정 |
| Ready | `Ready` | 승인, 범위, 완료 조건과 선행조건 확인 |
| In progress | `In progress` | 실제 작업 시작 |
| In review | `In review` | 결과 검토 또는 검증 중 |
| Done | `Done` | 완료 조건 충족, Issue를 completed로 종료 |

이 저장소의 새 Issue는 전용 Project의 native `Auto-add to project` workflow로 자동 등록한다. 대상 저장소는 `NaruForge/worknaru`, 필터는 `is:issue`로 설정해 PR과 다른 저장소의 Issue를 제외한다. 기존 `Item added to project` workflow는 Issue가 추가될 때 native `Status`를 `Inbox`로 설정하며, 이후에는 실제 근거에 따라 전이한다. PR은 구현 증거로 Issue에 연결하며 별도 Work Item이나 두 번째 lifecycle로 운영하지 않는다.

Auto-add 활성화만으로 기존 미등록 Issue를 소급 등록하지는 않는다. 다만 필터에 맞는 기존 미등록 Issue도 이후 수정되면 자동 등록되어 Inbox로 시작할 수 있다. 이는 [GitHub native auto-add 동작](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/adding-items-automatically)이다. 기존 항목을 다시 추가하거나 Status를 초기화하지 않고, 별도 승인 없는 일괄 등록·상태 변경은 하지 않는다. Project 밖 Issue는 진행 상태 미지정이며, 제목·본문·label에서 상태를 추정하지 않는다. 자동 등록이 확인되지 않으면 접근 권한과 workflow 설정을 확인하고 문제를 보고한다. 수동 등록이 필요한 경우 해당 작업의 권한과 승인을 확인하고 기존 항목과의 중복을 피한다.

완료 시 검증 증거 및 구현 링크를 Issue에 남기고 `Status = Done`, `state = closed`, `state_reason = completed`의 일치를 확인한다. 한쪽 갱신 실패 시 불일치를 보고하고 완료했다고 주장하지 않는다.

Rejected, duplicate, obsolete 또는 abandoned는 `not_planned`로 종료한다. 종료 comment에 구체적 disposition과 근거를 남기고 duplicate라면 원본 Issue를 링크한다. 이 경우 Done으로 옮기지 않고 마지막 progress를 유지한다. Board에서도 Issue의 closed 상태와 종료 사유를 함께 읽는다. 기존 `duplicate`, `wontfix` 등의 label은 보존하되 closure의 원본으로 사용하지 않는다.

재개가 승인되면 Issue를 open으로 바꾸고 실제 단계로 Status를 되돌린다. 자동 close-to-Done, merge-to-Done 및 Status 기반 자동 종료는 사용하지 않는다. 승인 없이 Issue를 생성·종료하거나 lifecycle을 시험하지 않는다.

## ADR

ADR 위치는 provider와 무관하게 `docs/adr/`다. 이후 작업을 크게 제약하거나, 의미 있는 대안 중 선택하거나, 되돌리기 어렵거나, 미래 유지보수자가 이유를 알아야 하는 실제 결정이 처음 생길 때만 directory와 ADR을 만든다. 작업 순서, 일시적인 조사, 일반 구현 세부 사항은 Work Item이나 일반 문서에 남긴다. 설치 증명을 위한 ADR은 만들지 않는다.

- 파일명: `NNNN-kebab-case-title.md`. 최초 번호는 `0001`, 이후 기존 최대 번호 다음 값. 기존 번호를 바꾸거나 재사용하지 않는다.
- 파일 자체에 제목, 날짜, `Status: Proposed | Accepted | Rejected | Superseded`와 관련 링크를 기록한다.
- 필수 section: `Context`, `Decision`, `Consequences`.
- `Context`: 문제, 제약, 근거와 의미 있는 대안.
- `Decision`: 제안하거나 채택한 선택과 이유.
- `Consequences`: 장점, 비용, 위험과 후속 영향.
- 새 제안은 Proposed. Accepted 또는 Rejected는 권한 있는 사람의 실제 결정을 근거로 기록한다. Agent가 임의로 승인하지 않는다.
- Accepted 또는 Rejected 기록은 역사적 근거다. 결정 변경으로 원래 의미를 덮어쓰지 않는다. 새 ADR을 작성하고 대체 결정이 승인되면 기존 기록을 Superseded로 표시하며 양방향 링크한다.
- ADR 상태는 그 파일만 소유한다. 별도 Decision Log, 상태 index 또는 Issue label에 복제하지 않는다.

Work Item, ADR, commit과 PR은 서로 링크하고 내용을 복사하지 않는다.

## Native 구성과 승인 경계

승인된 초기 원격 구성은 비공개 `worknaru` Project 하나, 이 저장소 연결, 위 여섯 Status, Status별 `Repository work` board, item 추가 시 Inbox workflow, 새 label `idea`, `work`, `blocked`, `needs-triage`다. 기존 label 10개는 보존한다. 2026-09-09 사용자 승인으로 이 저장소 Issue만 대상으로 하는 native auto-add를 활성화하고 기존 Issue 추가 시 Inbox workflow를 유지했다. 자동 close-to-Done와 merge-to-Done는 비활성화하며 자동 archive와 자동 종료는 사용하지 않는다. 이번 변경은 자동 등록과 초기 Inbox 설정에 한정하며, 기존 Issue의 상태 변경을 포함하지 않는다. 프로젝트 로컬 운영 방식 변경이므로 Blueprint 계약과 Installation Receipt의 revision/source는 유지한다. Milestone, Priority, area는 실제 필요가 승인될 때 도입한다.

Issue forms는 기본 브랜치에 게시되어야 GitHub New issue 화면에서 사용할 수 있다. 기본 label은 저장소에 이미 존재해야 적용된다. 양식 자체는 담당자나 Project를 배정하지 않으며 `blank_issues_enabled: true`를 유지한다. 양식 또는 빈 Issue 등 생성 경로와 관계없이 위 native auto-add workflow가 Project 등록을 담당한다.

Provider 선택은 인증, 권한 확대 또는 원격 쓰기 승인이 아니다. 향후 원격 변경, 게시, commit, push, Issue 조작, ADR 승인·대체는 해당 작업의 사용자 승인과 프로젝트 정책에 따른다. 이번 설치 승인은 반복 운영에 대한 포괄적 승인이 아니다.

## 검증과 충돌 처리

설치 당시 저장소는 첫 commit이 없는 빈 비공개 개인 저장소였다. ruleset API는 요금제 제한으로 403을 반환했다. 원격 ruleset과 필수 검사는 미확인으로 취급하며 없다고 단정하지 않는다.

변경 전 현재 지침, Git 변경, 기존 기록과 remote 대상을 읽는다. 모든 생성 경로를 대상 프로젝트 root 내부로 제한하고 symlink 또는 junction을 통한 이탈도 거부한다. 사용자 홈, 전역 Skill directory, 공유 경로에는 생성하지 않는다.

로컬 검증은 파일 재독해, Agent 링크, YAML 및 form 필수 항목, 원본 소유권, 정확히 하나인 Installation Receipt의 revision/source 일치, 승인 파일만의 Git diff로 한다. 샘플 Issue, placeholder ADR, 빈 운영 directory 또는 별도 validator/runtime은 만들지 않는다.

원격 변경 후 Project 소유자, 비공개 여부, 저장소 연결, Status 옵션, view, workflow, labels와 게시된 forms를 재조회한다. Fake lifecycle activity로 검증하지 않는다. 설치 설정 검증과 실제 lifecycle 실사용 검증을 구분한다.

인증 또는 권한 부족, 대상 소유권 불일치, 기존 동명 객체의 의미 충돌, 정책 충돌, 진행/종료 모순, 확인할 수 없는 상태나 승인 밖 변경이 필요하면 해당 작업을 중단하고 미적용 또는 부분 적용 상태를 보고한다. 기존 기록을 자동 migration, rename, renumber, normalize 또는 overwrite하지 않는다. 원복은 이번 변경과 사용자 변경을 구분한 뒤 별도 승인 범위에서 수행하며 원격 객체를 자동 삭제하지 않는다.

설치 provenance는 [.agents/blueprints/establish-project-records.yaml](../.agents/blueprints/establish-project-records.yaml) 하나에 기록한다. 자동 upstream 갱신은 없다. Blueprint 업데이트를 요청받으면 canonical 경로의 마지막 변경 commit과 Receipt를 비교하고, 의미 변화 및 로컬 의도를 검토한 승인안 없이 재생성하지 않는다.
