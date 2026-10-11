# Claude Code 모드 5종

Claude Code를 더 빠르고 저렴하게 쓰게 해주는 5가지 추가 기능입니다. 자세한 설명과 그림은 **`사용설명서.html`** 을 브라우저로 여세요. 설명 영상은 `media/claude-mods-explainer.mp4`(62초)입니다.

| 모드 | 하는 일 |
|---|---|
| context-band | 입력창 위 컨텍스트 막대, 캐시 남은 시간, 캐시 만료 시 전송 보류, 압축·인계 노트 버튼 |
| job-watch | 오래 걸리는 작업을 모델 호출 없이 감시하고 끝나면 결과를 한 번 전달 (`/jobs`) |
| handoff | 로그인처럼 사람이 할 일을 표시하고, 확인 명령으로 완료를 자동 확인 |
| plan-track | 단계 계획 진행 줄과 [다음 단계] 버튼, 프로젝트별로 새 세션에서도 이어짐 |
| change-check | 수정한 파일 자동 검사, [오류 전달] 버튼, 오래된 미커밋 경고 (`/check`) |

## 설치

**방법 A (권장)** — Finder에서 `mods` 안의 다섯 폴더를 `~/.claude/skills/` 로 복사(⇧⌘G로 `~/.claude` 이동, `skills` 폴더가 없으면 생성) → Claude Code 새 세션.

**방법 B** — 터미널에서:

```
sh install.sh
```

"Operation not permitted"가 나오면 터미널에 iCloud Drive 접근 권한이 없는 것이므로 방법 A를 쓰거나, 폴더를 다운로드 폴더 등으로 옮긴 뒤 실행하세요.

## 확인

```
claude plugin list
```

`context-band@skills-dir` 등 5개가 `✔ loaded` 이면 설치 완료입니다. 끄기: `claude plugin disable <모드>@skills-dir`.

## 구성

```
claude-mods/
├─ 사용설명서.html    상세 설명서 (움직이는 다이어그램, 영상 포함)
├─ README.md
├─ install.sh
├─ media/            설명 영상(MP4), 장면 미리보기
└─ mods/             모드 5개 (각 폴더에 테스트 포함: claude plugin test <폴더>)
```

요구 사항: Claude Code 2.1.29x 이상(데스크탑 앱 Code 탭 또는 터미널).
