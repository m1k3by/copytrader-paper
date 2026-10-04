-- PnL already booked from partial closes of a still-open copy (fees included); added to pnl on the final close.
alter table paper_trades add column realized_pnl numeric not null default 0;

alter table traders add constraint traders_platform_check check (platform in ('hyperliquid', 'invo'));
comment on column traders.wallet_address is 'Hyperliquid wallet, or the Invo portfolio id when platform = invo';
