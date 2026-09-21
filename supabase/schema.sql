-- 커버리지 레이더 라이브 — Supabase 스키마
-- Supabase 프로젝트 생성 후 SQL Editor에서 이 파일 전체를 실행하세요.

create extension if not exists pgcrypto;

-- 뉴스/공시/텔레그램 아이템
create table if not exists items (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  summary text,
  url text not null unique,
  source text,
  source_type text not null default 'newswire', -- newswire | telegram | ir | research | tw_revenue
  category text not null default 'other',       -- packaging | hbm | cpo | power | ai_server | korea | biotech | infra | disclosure | telegram | other
  ticker text,
  keyword_match text,
  sentiment text not null default 'neutral',     -- beat | miss | note | neutral
  importance text not null default 'medium',     -- high | medium | low
  published_at timestamptz not null,
  added_at timestamptz not null default now()
);

create index if not exists items_published_at_idx on items (published_at desc);
create index if not exists items_category_idx on items (category);

-- 추적 키워드 (대시보드 화면에서 추가/삭제)
create table if not exists keywords (
  id bigint generated always as identity primary key,
  term text not null unique,
  added_at timestamptz not null default now()
);

-- 텔레그램 공개채널 목록 (대시보드 화면에서 추가/삭제)
create table if not exists telegram_channels (
  id bigint generated always as identity primary key,
  handle text not null unique,
  added_at timestamptz not null default now()
);

-- 수집 상태 (poll 스크립트가 매 실행마다 갱신)
create table if not exists status (
  id int primary key default 1,
  last_run_at timestamptz,
  last_note text,
  total_items int default 0,
  constraint singleton check (id = 1)
);
insert into status (id) values (1) on conflict (id) do nothing;

-- 키워드 로테이션 커서 (poll 스크립트 전용, 매 실행마다 다음 배치로 이동)
create table if not exists poll_cursor (
  id int primary key default 1,
  idx int not null default 0,
  constraint singleton check (id = 1)
);
insert into poll_cursor (id) values (1) on conflict (id) do nothing;

-- RLS: items는 전체 공개 읽기만, 쓰기는 서비스 롤(=GitHub Action)만 가능
alter table items enable row level security;
create policy "items public read" on items for select using (true);

-- keywords / telegram_channels: 대시보드에서 직접 추가삭제하므로 읽기+쓰기 모두 공개
-- (링크를 가진 사람은 누구나 수정 가능하다는 뜻 — README의 "공개 범위" 항목 참고)
alter table keywords enable row level security;
create policy "keywords public read" on keywords for select using (true);
create policy "keywords public insert" on keywords for insert with check (true);
create policy "keywords public delete" on keywords for delete using (true);

alter table telegram_channels enable row level security;
create policy "channels public read" on telegram_channels for select using (true);
create policy "channels public insert" on telegram_channels for insert with check (true);
create policy "channels public delete" on telegram_channels for delete using (true);

alter table status enable row level security;
create policy "status public read" on status for select using (true);

-- 초기 키워드 시드
-- 주의: 이전 대시보드(artifact)에 있던 64개 키워드 목록은 아티팩트 삭제와 함께 완전히 유실됨(복구 불가).
-- 아래는 메모리에 남은 커버리지 종목/테마로 재구성한 목록임 — 대시보드 화면에서 직접 검토하고 빠진 종목 추가할 것.
insert into keywords (term) values
  ('삼성전자'), ('SK하이닉스'), ('DB하이텍'), ('두산에너빌리티'), ('SK실트론'),
  ('이수페타시스'), ('코스텍시스'),
  ('Micron'), ('Nvidia'), ('AMD'), ('Marvell'), ('Broadcom'), ('ARM Holdings'),
  ('Amazon AWS'), ('Meta Platforms'), ('Amphenol'), ('Lam Research'), ('FormFactor'),
  ('Coherent'), ('Lumentum'), ('Soitec'), ('onsemi'), ('Infineon'),
  ('Monolithic Power Systems'), ('Allegro MicroSystems'),
  ('TSMC'), ('ASE Technology'), ('Chroma ATE'), ('Innolux'),
  ('CXMT'),
  ('CoWoS'), ('CoPoS'), ('HBM4'), ('HBM3E'), ('CPO 광인터커넥트'),
  ('800VDC 전력반도체'), ('AI서버 capex'), ('GLP-1 비만치료제'), ('PCB CCL 소재')
on conflict (term) do nothing;

insert into telegram_channels (handle) values ('aetherjapanresearch')
on conflict (handle) do nothing;
