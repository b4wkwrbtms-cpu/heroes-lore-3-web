# 영웅서기3 웹앱 (iPhone 홈 화면용)

[dlunch/wie](https://github.com/dlunch/wie) (MIT) 기반 WIPI 에뮬레이터를 GitHub Pages에 배포해
아이폰 홈 화면 웹앱으로 쓰는 프로젝트입니다. 게임 파일은 포함되어 있지 않습니다.

## 사용법
1. Settings → Pages → Source를 **GitHub Actions**로 설정 (최초 1회)
2. Actions 탭에서 빌드가 끝나면 `https://<계정>.github.io/<저장소>/` 로 접속
3. iPhone Safari → 공유 → **홈 화면에 추가** → 홈 화면 아이콘으로 열기
4. 게임 zip(LGT: app_info + .jar 묶음)을 가져오기 → 이후엔 열자마자 자동 실행
   - 라이브러리 화면으로 가려면 `?library` 를 붙여 접속

## 변경점 (upstream 대비)
- `.github/workflows/pages.yml`: Pages 자동 빌드/배포
- `wie-web/public/manifest.webmanifest`, `icon-*.png`, `index.html` 메타: 홈 화면 앱 이름/아이콘
- `wie-web/src/ts/library.ts`: 게임이 1개면 자동 실행
