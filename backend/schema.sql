-- Neforball: базовая схема для коллекции
-- Применять через Supabase CLI (supabase db push) или руками в SQL Editor

create table if not exists public.nefory (
  id bigint generated always as identity primary key,
  telegram_user_id text not null,
  name text not null,
  life smallint not null check (life between 0 and 10),
  dmg smallint not null check (dmg between 0 and 10),
  depr smallint not null check (depr between 0 and 10),
  photo_url text not null,
  created_at timestamptz not null default now()
);

alter table public.nefory enable row level security;

-- каждый видит и добавляет только свои записи (telegram_user_id передаётся из Mini App)
create policy "select own nefory"
  on public.nefory for select
  using (telegram_user_id = current_setting('request.jwt.claims', true)::json->>'sub' or true);
  -- ВРЕМЕННО: `or true` разрешает читать всем, пока нет настоящей аутентификации
  -- через Telegram initData. Убрать `or true`, как только подключим проверку
  -- подписи Telegram на бэкенде (см. TODO в CLAUDE.md).

create policy "insert own nefory"
  on public.nefory for insert
  with check (true);
  -- вставка идёт через Edge Function на service_role, так что RLS тут
  -- скорее для прямых клиентских вызовов в будущем

-- бакет для фото/спрайтов, публичный на чтение
insert into storage.buckets (id, name, public)
values ('nefory-photos', 'nefory-photos', true)
on conflict (id) do nothing;

create policy "public read nefory photos"
  on storage.objects for select
  using (bucket_id = 'nefory-photos');

create policy "anyone can upload nefory photos"
  on storage.objects for insert
  with check (bucket_id = 'nefory-photos');
  -- ВРЕМЕННО: без ограничений, ужесточить когда появится реальная авторизация
