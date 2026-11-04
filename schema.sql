-- Mis Finanzas (versión con doble autenticación)
-- Pega todo esto en Supabase → SQL Editor → New query → Run.
-- ⚠️ Las dos primeras líneas borran las tablas de la versión anterior si existían.

drop table if exists public.vault;
drop table if exists public.items;

create table public.items (
  id         uuid primary key,
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  deleted    boolean not null default false,
  updated_at timestamptz not null default now()
);

create index items_user_updated on public.items (user_id, updated_at);

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := clock_timestamp();
  new.user_id := auth.uid();
  return new;
end $$;

create trigger items_touch before insert or update on public.items
for each row execute function public.touch_updated_at();

-- Seguridad a nivel de fila:
--   1) cada usuario ve SOLO sus propios datos
--   2) y SOLO si inició sesión con doble autenticación (aal2).
--      Con la contraseña sola, la base de datos no entrega nada.
alter table public.items enable row level security;

create policy "solo lo propio y con 2FA" on public.items for all to authenticated
  using      (user_id = (select auth.uid()) and (select auth.jwt() ->> 'aal') = 'aal2')
  with check (user_id = (select auth.uid()) and (select auth.jwt() ->> 'aal') = 'aal2');

-- Permisos mínimos: nada para anónimos, sin borrado físico.
revoke all on public.items from anon, authenticated;
grant select, insert, update on public.items to authenticated;
