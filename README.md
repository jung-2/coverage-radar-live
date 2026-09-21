# 커버리지 레이더 라이브 — 배포 가이드

Claude Cowork 세션(WebSearch 기반) 대신, 실제 RSS/텔레그램을 5분 주기로 직접 폴링해서
Supabase DB에 쓰고, 그 DB를 실시간 구독하는 정적 페이지로 보여주는 구조입니다.
Claude 세션과 완전히 독립적으로 24/7 동작합니다.

## 왜 이전보다 나은가

- **소스**: Google News RSS(발행 후 몇 분 내 색인) + 텔레그램 공개채널 직접 스크래핑.
  둘 다 검색엔진 인덱스 지연이 없는 라이브 소스라, 이전 WebSearch 기반보다 신선도가 훨씬 높음.
- **주기**: GitHub Actions가 5분마다 실행 (참고: GitHub 스케줄러 특성상 정확히 5분은 아니고
  보통 5~15분 사이로 밀릴 수 있음 — "몇 분 전 속보" 수준이지 초 단위 실시간은 아님).
- **날짜 정확성**: RSS의 pubDate/텔레그램의 datetime을 그대로 씀 — 예전처럼 "날짜 불확실하면
  오늘로 채움" 같은 추측이 없어서, 오래된 뉴스가 오늘 뉴스로 잘못 표시되는 버그 자체가 구조적으로 없음.
- **화면**: Supabase Realtime 구독이라 새 행이 DB에 써지는 순간 새로고침 없이 바로 반영됨.

## 알아둘 점 (한계)

- DART 공시 연동은 이번엔 뺐음(API 키 없음). 필요해지면 `scraper/poll.mjs`에 DART Open API
  호출을 추가하면 됨 — 공시는 접수 즉시 반영되는 소스라 지금 구조에서도 잘 맞음.
- `keywords`/`telegram_channels` 테이블은 대시보드 화면에서 링크만 있으면 누구나 수정 가능하게
  열어뒀음(개인용 단일 사용자 전제). 링크를 공유하지 말 것. 더 안전하게 하려면 Supabase RLS를
  로그인 사용자 전용으로 바꿔야 함(추가 작업 필요, 원하면 다음에 붙일 수 있음).
- 이전 아티팩트 대시보드의 64개 키워드 원본 목록은 삭제와 함께 유실됨 — `supabase/schema.sql`에
  메모리에 남은 커버리지 종목으로 재구성한 목록을 시드로 넣어뒀음. 배포 후 화면에서 빠진 종목 추가할 것.

## 배포 순서

### 1. Supabase (DB + 실시간)
1. https://supabase.com 무료 계정 생성 → New Project.
2. 프로젝트 생성 후 좌측 메뉴 **SQL Editor** 에서 `supabase/schema.sql` 내용 전체 복붙 실행.
3. 좌측 메뉴 **Database → Replication** 에서 `items`, `status`, `keywords`, `telegram_channels`
   테이블의 Realtime 토글을 켬 (화면 실시간 반영에 필요).
4. 좌측 메뉴 **Settings → API** 에서 다음 세 개를 복사해둠:
   - `Project URL`
   - `anon public` 키
   - `service_role` 키 (절대 프론트엔드에 넣지 말 것 — GitHub Actions 시크릿 전용)

### 2. GitHub (5분마다 수집 실행)
1. 이 폴더 전체를 새 GitHub 리포지토리로 올림 (public도 되고 private도 됨).
2. 리포 **Settings → Secrets and variables → Actions** 에서 시크릿 2개 추가:
   - `SUPABASE_URL` = 위에서 복사한 Project URL
   - `SUPABASE_SERVICE_KEY` = 위에서 복사한 service_role 키
3. **Actions** 탭에서 워크플로가 보이면 활성화. `workflow_dispatch`로 한 번 수동 실행해서
   정상 동작 확인 (Actions 탭 → 커버리지 레이더 수집 → Run workflow).
4. 참고: GitHub는 60일간 커밋 없는 리포의 스케줄 실행을 자동으로 꺼버림 — 그땐 리포에 아무 커밋이나
   하나 하면 다시 살아남.

### 3. Vercel (대시보드 페이지 호스팅)
1. `web/index.html` 상단의 `SUPABASE_URL`, `SUPABASE_ANON_KEY` 두 값을 1번에서 복사한
   실제 값으로 바꿔서 커밋 (anon 키는 RLS로 보호되므로 프론트엔드에 노출돼도 됨 — service_role과 다름).
2. https://vercel.com 계정으로 이 GitHub 리포 Import.
3. 프레임워크는 "Other"로 두고, Root Directory를 `web`으로 지정 (또는 리포 루트의 `vercel.json`이
   자동으로 `web`을 아웃풋 디렉토리로 잡아줌).
4. Deploy. 끝나면 나오는 `*.vercel.app` 주소가 대시보드 링크.

## 로컬 테스트

```bash
npm install
SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scraper/poll.mjs
```

## 파일 구조

```
.github/workflows/poll.yml   GitHub Actions 5분 주기 실행 설정
scraper/poll.mjs             수집 본체 (RSS + 텔레그램 → Supabase)
scraper/sources.mjs          고정 테마, 카테고리/감성 분류 규칙
supabase/schema.sql          테이블 정의 + 초기 키워드 시드
web/index.html                대시보드 페이지 (Vercel에 배포)
```
