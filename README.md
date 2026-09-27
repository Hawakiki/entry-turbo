# entry-turbo

## 개발

```bash
pnpm install
pnpm lint          # 고치기: pnpm lint:fix
pnpm build         # dist/ 에 확장 파일만 모은다
pnpm release       # dist/ → release/entry-turbo-v<버전>.zip + .sha256 (같은 커밋이면 같은 해시)
```

크롬에 넣기(배포 없이): `chrome://extensions` → 개발자 모드 → "압축해제된 확장 프로그램을 로드합니다" → `dist/`.
코드를 고치면 `pnpm build` → 확장 카드의 새로고침 → 작품 탭 새로고침.

릴리스: `manifest.json` 의 `version` 을 올리고 `pnpm release` → GitHub 릴리스 태그 `v<버전>` 에 zip 과 해시를 올린다.
팝업은 열릴 때 GitHub API 로 최신 릴리스 번호를 확인해 새 버전을 알린다(6시간마다 한 번). `manifest.json` 의 `key` 는
확장 ID 를 고정한다(어느 폴더에 풀어도 같은 확장).

## 검증

entry-test(공개하지 않은 별도 도구 모음: CDP·블록 DSL)를 쓴다. 이 저장소 옆 폴더 `../entry-test`, 또는 `ENTRY_TEST` 환경 변수.

```bash
node bench/run.js                      # 오프라인 에디터 A/B: 결과·틱 수 대조 (Entry.exe 재시작)
node bench/ui-check.js                 # UI 블록(이동·말하기·기다리기·신호·복제본): 무대 상태 대조
node bench/func-check.js               # 함수(매개변수·지역변수·값 함수·재귀): 상태·틱 수 대조
node bench/compile-check.js 작품.ent    # 실행 없이 전부 컴파일해 보기 (Entry.exe 재시작)
node bench/web-linux.js                # 웹 공개작(진짜 리눅스)에 확장 스크립트를 넣고/빼고 (디버깅 크롬 9333)
node bench/fingerprints.js             # 새 엔트리 빌드의 코드를 읽고 규칙을 확인한 뒤 KNOWN 갱신
```

linux-real 비트 대조: `node linux-real/verify-app.js --turbo <이 폴더>/src/turbo.js [--boost]` (entry-test 에서).
