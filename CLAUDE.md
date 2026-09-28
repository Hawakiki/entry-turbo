# CLAUDE.md

엔트리(playentry.org) 작품의 블록을 JS 로 컴파일해 빠르게 돌리는 크롬 확장(MV3). 개발 명령·검증 도구는 [README.md](README.md) 아래쪽 "개발" 절.

## 지켜야 할 것

- **결과는 엔트리 실행기와 똑같아야 한다.** 양보 위치(반복 끝·빈 문장·Promise), BigNumber `+ - * /`, 값 변환 규칙까지.
  확실하지 않은 블록은 컴파일하지 말고 원래 방식(페이지 원본 func)으로 넘긴다. 빨라지는 것보다 틀리지 않는 게 먼저.
- 엔트리 코드를 베낀 부분은 지문(`KNOWN`)으로 지킨다. 새 엔트리 빌드는 `node bench/fingerprints.js` 로 코드를 읽고 확인한 뒤에만 추가.
- 코드 주석은 영어, 문서·팝업·콘솔 출력은 한국어. 작품 속 이름(`완료` 등)은 주석 안에서도 그대로.
- 수치는 실측/추정을 밝힌다. 속도 주장은 `bench/` 로 잰 것만.
- `bench/` 의 에디터 도구는 **Entry.exe 를 재시작**한다 — 돌리기 전에 말한다.
- 파일을 옮기거나 이름을 바꾸면 README·이 파일의 경로도 같은 커밋에서 고친다.
- 끝났다고 하기 전에 `pnpm lint`. 확장 코드를 바꿨으면 `pnpm build` 까지.

## 브랜치

- `main` = 배포된 코드. 직접 커밋하지 않는다.
- 작업은 `develop` 에서 → PR(`develop → main`) → CI 통과 → **머지는 사용자가** 한다.
- 원격 push·PR·태그는 사용자가 그때그때 말할 때만.
- 머지 뒤: `git switch main && git pull --ff-only`, 그리고 `develop` 을 `main` 으로 fast-forward.
- 릴리스 태그 `v<버전>` 은 `main` 에서, `manifest.json` 의 `version` 과 같게. 태그 푸시 → `release.yml` 이 초안 릴리스를 만든다.
- 시험판은 `develop` 에서 `vX.Y.Z-rc.N` 태그(→ 프리릴리스). `version` 은 `X.Y.Z.N`, `version_name` 은 `X.Y.Z-rc.N`
  (`scripts/version.js`, README "개발" 절 표). 정식으로 낼 때 `version_name` 을 지운다.

## 커밋

기능 묶음 하나에 커밋 하나. 형식은 `type: 요약` (범위가 분명하면 `type(범위): 요약`, 예: `fix(osd): …`).

| type       | 쓰는 곳                                  |
| ---------- | ---------------------------------------- |
| `feat`     | 새 기능, 새로 컴파일되는 블록            |
| `fix`      | 버그, 엔트리와 결과가 달랐던 것          |
| `perf`     | 결과는 그대로, 더 빠르게                 |
| `refactor` | 동작 그대로 구조만                       |
| `test`     | `bench/` 검증·측정 도구                  |
| `docs`     | README·이 파일·JSDoc                     |
| `ci`       | `.github/workflows/`                     |
| `chore`    | 설정·빌드 스크립트·이름·버전 같은 나머지 |

- 요약은 한국어로, 무엇이 달라지는지. 본문은 길어도 된다: 파일별로 무엇을 왜 바꿨는지, 잰 수치(실측/추정), 검증 결과(A/B 일치 등).
- 마지막 줄은 `Co-Authored-By: Claude …` 를 그대로 둔다.
- 커밋·태그는 GPG 서명(저장소 로컬 설정 `commit.gpgsign`). 서명 끄기(`--no-gpg-sign`)나 훅 건너뛰기 금지.
- `ref/`, `release/`, `dist/`, `.env*` 는 커밋하지 않는다(`.gitignore`).
