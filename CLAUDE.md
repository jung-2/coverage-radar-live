# 커버리지 레이더 라이브 — Claude Code 작업 지침

## 이 프로젝트가 뭔지
반도체/AI인프라 커버리지 뉴스·텔레그램을 자동으로 모아 보여주는 개인용 대시보드.
라이브 주소: https://coverage-radar-live.vercel.app/

- `scraper/poll.mjs` + `scraper/sources.mjs`: GitHub Actions 워크플로 2개가 각각 5분마다 따로 실행(`poll-telegram.yml` → `node scraper/poll.mjs telegram`, `poll-keywords.yml` → `node scraper/poll.mjs keywords`). 별도로 `poll-prices.yml` → `node scraper/prices.mjs`가 장중에 KIS 시세(등락률)를 `price_moves`에 저장. 텔레그램 공개채널(`t.me/s/<handle>`) / Google News RSS(추적 키워드, 2개씩 `OR`로 묶어 검색, 매 실행마다 전체 순회)를 긁어서 Supabase `items` 테이블에 저장. 서로 영향 없게 일부러 분리한 것
- `web/index.html`: 대시보드 화면(단일 파일). Vercel이 `web` 폴더를 정적 호스팅. Supabase Realtime 구독으로 새 데이터 즉시 반영
- `api/summarize.js`: Vercel 서버리스 함수. 브리핑 탭의 "수동 버튼"을 누르면 새로 쌓인 기사를 Claude API(Haiku)로 묶고 요약해서 `clusters`/`briefings` 테이블에 저장
- `supabase/schema.sql`: 테이블 정의 + 초기 키워드 시드. 주의: `clusters`, `briefings` 테이블은 이 파일에 없음(나중에 Supabase에서 직접 추가됨). 스키마를 바꿀 땐 이 파일도 같이 맞춰 줄 것

## 배포 흐름 (중요)
- `main` 브랜치에 push하면 Vercel이 자동 재배포함. GitHub Actions 수집 스크립트도 push된 코드로 다음 실행부터 바뀜
- 그래서 push = 실서비스 반영. push 전에 반드시 변경 내용을 요약해서 보여주고 확인을 받을 것
- 비밀키는 절대 코드에 넣지 말 것. `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`는 GitHub Secrets, `ANTHROPIC_API_KEY`와 Supabase 키는 Vercel 환경변수에 있음. `web/index.html`에는 anon 키만 들어가도 됨(service_role 키는 절대 금지)
- 로컬에 Supabase 키가 없으니, DB를 실제로 읽어야 확인되는 건 "Supabase 대시보드에서 이렇게 확인해 봐"처럼 사용자에게 방법을 알려 줄 것

## 사용자에 대해
- 코딩 경험이 거의 없음. 설명은 쉬운 한국어로, 명령어는 그대로 복사해서 쓸 수 있게
- 한자 쓰지 말고 순한글로. 캐주얼하고 직설적인 톤 선호
- 실수가 있으면 바로 인정하고 고칠 것
- 윈도우 PC, PowerShell 사용

## 이미 정해진 결정사항 (되돌리지 말 것)
- 브리핑은 자동 스케줄 없이 **수동 버튼만**. 버튼 누를 때만 요약 실행
- 브리핑은 **오늘/어제 뉴스만** 보면 됨. 48시간보다 오래 밀린 백로그는 버림(`MAX_BACKLOG_MS`). 오래된 것부터 순서대로 다 처리하는 방식은 사용자가 싫어함
- 브리핑 탭은 **텔레그램 / 추적 키워드 2탭 체제**이고 **둘은 독립적으로 동작**(2026-09-29 변경). 텔레그램 탭만 AI 요약(수동 버튼, `summarize.js`는 텔레그램 글만 처리). 추적 키워드 탭은 AI 요약 없이 `items`를 화면(`web/index.html`)이 바로 읽어서 회사(`keyword_match`)별 카드 + 제목 비슷한 기사 묶음(규칙 기반)으로 정리. 키워드 탭에 AI 요약/버튼을 다시 붙이지 말 것(속도 때문에 뺀 것). 키워드 탭의 중요도(핵심/중요/일반)는 AI가 아니라 제목 단어 규칙(`web/index.html`의 `KW_RULES`/`KW_NOISE`, `kwScoreTitle`)으로 매김 — 회사에 실질 영향이 있는 재료(수주·계약, M&A, 실적, 증자, 투자·증설, 목표가 변경, 리스크, 주가 급등락)가 위로 오고 잡음(투자분석 글, 연예/스포츠 등)은 아래로. 규칙은 실제 기사 제목으로 시험하며 다듬은 것이라 잘못 분류되면 이 규칙만 고칠 것. 키워드 탭 맨 위에는 급등/급락(±5% 이상) 종목의 회사 카드 구역이 있고 그 아래에 뉴스 정리(중요도순)가 이어짐. 급등락은 KIS 시세가 있으면 그 값 기준(`scraper/prices.mjs` → `price_moves` 테이블 → 화면의 `kisMoves`, 오늘 기사가 없는 종목도 카드로 뜸), KIS에 없는 종목(해외/테마)은 기사 제목 기준. KIS 키는 GitHub Secrets의 `KIS_APP_KEY`/`KIS_APP_SECRET`(실전투자 시세 조회용)이고 코드에 넣지 말 것. 시세 수집은 `poll-prices.yml`이 평일 장 시간(09:00~15:55 KST)에만 돎. "시황" 자동분류 탭은 AI 분류가 부정확해서 없앴음. 다만 AI가 targets에 "시황"이라는 단어를 쓰는 것 자체는 막지 않음
- 텔레그램은 공개 채널만(봇 인증·비공개 채널 안 씀)
- DART 공시 연동은 일단 빠져 있음. 나중에 붙일 수 있음
- `keywords`/`telegram_channels`는 화면에서 누구나 추가/삭제 가능하게 열려 있음(개인용 전제)
- Vercel 무료 플랜: 함수 최대 300초. `summarize.js`는 `TIME_BUDGET_MS` 180초로 여유를 두고 멈추게 돼 있음. 늘리지 말 것

## 디자인 규칙 (web/index.html)
- 촘촘한 레이아웃: 작은 폰트, 좁은 간격, 정보 밀도 높게
- Inter 폰트, 통계 박스는 크림톤 #F5F4ED(테두리 없음), 텍스트 블록은 흰색 #FFFFFF + 얇은 테두리 #E8E8E8
- 색상: 긍정 #1D9E75, 부정 #D64545, 주의 #D18F2E, 정보 #2F7DD1
- 금액: 달러는 $1bn/$100mn, 원화는 억원/조원

## 작업 방식
- 큰 변경은 먼저 계획을 보여주고 확인받은 뒤 진행
- 수정 후 `node --check <파일>`로 문법 오류 확인
- 커밋 메시지는 한국어로 무엇을 왜 바꿨는지 짧게
