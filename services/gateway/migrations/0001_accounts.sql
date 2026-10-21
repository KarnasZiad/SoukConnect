-- Accounts of buyers, sellers and moderators. Sessions, carts and login attempts live in Redis.

create table accounts (
  id uuid primary key,
  -- Normalized (trimmed, lower case); a deleted account keeps a placeholder (loi 09-08, RGPD).
  email text not null unique,
  -- Argon2id; null once the account is deleted.
  password_hash text,
  display_name text not null,
  role text not null check (role in ('buyer', 'seller', 'moderator')),
  locale text not null default 'fr' check (locale in ('fr', 'en', 'ar')),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (deleted_at is not null or password_hash is not null)
);
