-- Payments of the orders, the Stripe events already handled, and the sales ledger.
-- Amounts are integer centimes of dirham.

create table payments (
  id uuid primary key,
  order_id uuid not null unique,
  buyer_id uuid not null,
  stripe_payment_intent_id text not null unique,
  amount bigint not null check (amount > 0),
  currency text not null default 'MAD' check (currency = 'MAD'),
  status text not null
    check (status in ('REQUIRES_PAYMENT', 'SUCCEEDED', 'CANCELLED', 'REFUNDED')),
  -- The share of each shop, frozen when the order was reserved: { shopId, amount, commissionBps }.
  shares jsonb not null,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A webhook delivered twice has an effect once (US-06).
create table stripe_events (
  id text primary key,
  type text not null,
  received_at timestamptz not null default now()
);

-- One sale and one commission per shop and payment; refunds reverse them.
create table ledger_entries (
  id uuid primary key,
  payment_id uuid not null references payments (id),
  order_id uuid not null,
  shop_id uuid not null,
  kind text not null check (kind in ('SALE', 'COMMISSION', 'REFUND', 'COMMISSION_REVERSAL')),
  amount bigint not null,
  created_at timestamptz not null default now(),
  check ((kind in ('SALE', 'COMMISSION_REVERSAL') and amount >= 0)
      or (kind in ('COMMISSION', 'REFUND') and amount <= 0))
);
create index ledger_shop on ledger_entries (shop_id, created_at);

-- The ledger only grows: a correction is a new entry, never an edit (R1).
create function ledger_is_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'ledger_entries is append-only';
end;
$$;
create trigger ledger_append_only
  before update or delete on ledger_entries
  for each row execute function ledger_is_append_only();
