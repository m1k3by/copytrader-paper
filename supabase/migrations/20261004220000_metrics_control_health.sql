-- Random-direction control: every copied trade gets a twin with a coin-flip side, same coin, timing, size and resizes.
-- If real copies don't beat their twins, the trader's direction calls aren't what earns the money.
alter table paper_trades add column control boolean not null default false;
alter table paper_trades drop constraint paper_trades_source_trade_id_key;
alter table paper_trades add constraint paper_trades_source_trade_id_control_key unique (source_trade_id, control);

-- Copy fidelity: the trader's own volume-weighted exit, next to exit_price (the mid when we noticed the close).
alter table source_trades add column trader_exit_price numeric;
-- How often the trader added to / partially closed the position while we tracked it.
alter table source_trades add column resizes int not null default 0;

-- Health: last failed sync per trader (shown when newer than synced_at).
alter table traders add column last_error text;
alter table traders add column last_error_at timestamptz;

-- Metrics are computed in the dashboard from the trades themselves now.
drop view trader_stats;
