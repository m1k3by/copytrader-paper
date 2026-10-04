# copytrader-paper

Paper-copytrading of Hyperliquid wallets. Every 30 s a Supabase Edge Function reads each trader's open
positions, mirrors new ones as $100 paper trades (entry = mid + slippage) and closes them when the
trader closes or flips (exit = mid − slippage, taker fee on both legs). Dashboard: Next.js on Vercel.

```
Supabase Cron (30 s) → monitor-traders → Hyperliquid clearinghouseState/allMids → source_trades / paper_trades
Next.js (Vercel)     → reads tables server-side with the secret key
```

- The copy delay is real, not simulated: we enter at the price when the poll notices the position (≤ 30 s late).
- Positions a trader already holds when added are tracked but not copied.
- Settings (balance, size, fee, slippage) live in the single-row `settings` table.

## Setup

```bash
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase db push
npx supabase functions deploy monitor-traders
```

Then once in the Supabase SQL editor (secret key: Project Settings → API Keys, the `default` secret key):

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<sb_secret_...>', 'secret_key');

select cron.schedule('monitor-traders', '30 seconds', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/monitor-traders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'secret_key')
    ),
    timeout_milliseconds := 25000 -- pg_net default is 5 s
  );
$$);

insert into traders (name, wallet_address) values ('Bones', '0x...');
```

Dashboard env (`.env.local` locally, Vercel project settings in production):

```
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...
```

## Dev

```bash
npm run dev
deno test supabase/functions/monitor-traders
```
