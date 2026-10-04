-- For the 30s schedule (job itself is created by hand, see README: it needs project secrets).
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Traders whose Hyperliquid positions we mirror.
create table traders (
  id bigint generated always as identity primary key,
  name text not null,
  platform text not null default 'hyperliquid',
  wallet_address text not null unique,
  enabled boolean not null default true,
  score numeric,
  -- null until the first poll; positions already open at that poll are tracked but not copied
  synced_at timestamptz
);

-- One row per trader position lifecycle (opened -> closed), as observed by the worker.
create table source_trades (
  id bigint generated always as identity primary key,
  trader_id bigint not null references traders on delete cascade,
  coin text not null,
  side text not null check (side in ('long', 'short')),
  entry_price numeric not null, -- trader's own entryPx
  size numeric not null,        -- coins
  leverage numeric,
  opened_at timestamptz not null default now(),
  exit_price numeric,           -- mid price when we noticed the close
  closed_at timestamptz
);
-- at most one open position per trader and coin; also stops overlapping worker runs from double-opening
create unique index source_trades_one_open on source_trades (trader_id, coin) where closed_at is null;

create table paper_trades (
  id bigint generated always as identity primary key,
  source_trade_id bigint not null unique references source_trades on delete cascade,
  coin text not null,
  side text not null check (side in ('long', 'short')),
  entry_price numeric not null, -- mid at copy time + slippage
  exit_price numeric,
  size_usd numeric not null,
  fees numeric not null default 0,
  pnl numeric,
  status text not null default 'open' check (status in ('open', 'closed')),
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);

-- single row
create table settings (
  id boolean primary key default true check (id),
  starting_balance numeric not null default 10000,
  position_size numeric not null default 100, -- USD notional per copied trade
  fee_bps numeric not null default 4.5,       -- Hyperliquid base-tier taker fee 0.045%
  slippage_bps numeric not null default 5     -- assumption, tune once real fills exist
);
insert into settings default values;

create view trader_stats with (security_invoker = on) as
select
  t.id,
  t.name,
  t.wallet_address,
  t.enabled,
  count(p.id) filter (where p.status = 'closed') as closed_trades,
  count(p.id) filter (where p.status = 'open') as open_trades,
  coalesce(sum(p.pnl), 0) as realized_pnl,
  avg((p.pnl > 0)::int) filter (where p.status = 'closed') as winrate
from traders t
left join source_trades s on s.trader_id = t.id
left join paper_trades p on p.source_trade_id = s.id
group by t.id;

-- No policies: only the secret key (worker + dashboard server side) can read or write.
alter table traders enable row level security;
alter table source_trades enable row level security;
alter table paper_trades enable row level security;
alter table settings enable row level security;

grant select, insert, update, delete on traders, source_trades, paper_trades, settings to service_role;
grant select on trader_stats to service_role;
