-- 커버리지 레이더 — 5분마다 자동 처리(수집 + 텔레그램 요약·중요도 분류) 예약 (2026-11-26)
-- Supabase 대시보드 → SQL Editor → 이 파일 내용 전체 붙여넣기 → Run. 한 번만 하면 됨(다시 실행해도 안전).
--
-- 왜 Supabase에서 예약하나: GitHub Actions 예약 실행은 "5분마다"로 해 둬도 실제론 6~10시간에 한 번만 돌고,
-- Vercel 무료 플랜 예약은 하루 1번만 됨. Supabase의 pg_cron은 무료 플랜에서도 5분마다 정확히 돎.
-- 하는 일: 5분마다 https://coverage-radar-live.vercel.app/api/tick 을 부름(api/tick.js 참고).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 같은 이름 예약이 이미 있으면 지우고 새로 만듦(다시 실행해도 두 개가 되지 않게)
select cron.unschedule(jobid) from cron.job where jobname = 'coverage-radar-tick';

select cron.schedule(
  'coverage-radar-tick',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://coverage-radar-live.vercel.app/api/tick?by=cron',
    body := '{}'::jsonb,
    timeout_milliseconds := 290000
  );
  $$
);

-- 잘 등록됐는지 확인: 아래 결과에 coverage-radar-tick 한 줄이 보이면 됨
select jobid, jobname, schedule, active from cron.job where jobname = 'coverage-radar-tick';

-- (나중에 확인용) 최근 실행 기록 — status가 succeeded면 정상
-- select start_time, status, return_message from cron.job_run_details order by start_time desc limit 10;

-- (끄고 싶을 때) select cron.unschedule('coverage-radar-tick');
