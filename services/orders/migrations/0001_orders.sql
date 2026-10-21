-- Orders, their lines frozen by the catalog, and one shipment per shop (docs/database.md).
-- Amounts are integer centimes of dirham.

create table orders (
  id uuid primary key,
  buyer_id uuid not null,
  status text not null
    check (status in ('PENDING', 'AWAITING_PAYMENT', 'CONFIRMED', 'FULFILLED', 'REJECTED', 'CANCELLED')),
  -- Replays of the same request return the same order (US-05).
  idempotency_key text not null,
  request_hash text not null,
  total_amount bigint check (total_amount >= 0),
  currency text not null default 'MAD' check (currency = 'MAD'),
  shipping_address jsonb not null,
  payment_deadline timestamptz,
  cancellation_reason text
    check (cancellation_reason in ('PAYMENT_FAILED', 'PAYMENT_EXPIRED', 'BUYER_CANCELLED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (buyer_id, idempotency_key),
  -- An order awaiting its payment always has an amount and a deadline.
  check (status <> 'AWAITING_PAYMENT' or (total_amount is not null and payment_deadline is not null))
);
create index orders_buyer on orders (buyer_id, created_at desc);
-- The sweeper of expired payments reads only what can expire.
create index orders_payment_deadline on orders (payment_deadline) where status = 'AWAITING_PAYMENT';

-- What the buyer asked for: identifiers and quantities only, never a price.
create table order_items (
  order_id uuid not null references orders (id) on delete cascade,
  position int not null,
  product_id uuid not null,
  quantity int not null check (quantity between 1 and 99),
  primary key (order_id, position)
);

-- What the catalog reserved, at the prices and commission rates of that moment.
create table order_lines (
  order_id uuid not null references orders (id) on delete cascade,
  position int not null,
  product_id uuid not null,
  shop_id uuid not null,
  title jsonb not null,
  unit_price bigint not null check (unit_price >= 0),
  quantity int not null check (quantity between 1 and 99),
  commission_bps int not null check (commission_bps between 0 and 5000),
  primary key (order_id, position)
);
-- The seller space lists the lines of one shop.
create index order_lines_shop on order_lines (shop_id, order_id);

create table shipments (
  order_id uuid not null references orders (id) on delete cascade,
  shop_id uuid not null,
  status text not null check (status in ('PREPARING', 'SHIPPED', 'DELIVERED')),
  tracking_number text,
  shipped_at timestamptz,
  delivered_at timestamptz,
  primary key (order_id, shop_id),
  check (status = 'PREPARING' or tracking_number is not null)
);
