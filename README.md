# entry-extension

## 개발

```bash
pnpm install
pnpm lint          # 고치기: pnpm lint:fix
pnpm build         # dist/ 에 확장 파일만 모은다
```

크롬에 넣기(배포 없이): `chrome://extensions` → 개발자 모드 → "압축해제된 확장 프로그램을 로드합니다" → `dist/`.
코드를 고치면 `pnpm build` → 확장 카드의 새로고침 → 작품 탭 새로고침.

## 검증

`C:/path/to/entry-test` 의 도구(CDP·블록 DSL)를 쓴다.

```bash
node bench/run.js                      # 오프라인 에디터 A/B: 결과·틱 수 대조 (Entry.exe 재시작)
node bench/compile-check.js 작품.ent    # 실행 없이 전부 컴파일해 보기 (Entry.exe 재시작)
node bench/web-linux.js                # 웹 공개작(진짜 리눅스)에 확장 스크립트를 넣고/빼고 (디버깅 크롬 9333)
node bench/fingerprints.js             # 새 엔트리 빌드의 코드를 읽고 규칙을 확인한 뒤 KNOWN 갱신
```

linux-real 비트 대조: `node linux-real/verify-app.js --turbo <이 폴더>/src/turbo.js [--boost]` (entry-test 에서).
