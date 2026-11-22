-- =====================================================================
-- Fraka List v3 · Fase 2 · Bloque 1 · Esquema de perfiles y vinculación
-- Ejecutar en Supabase → SQL Editor (proyecto de desarrollo).
--
-- Modelo:
--   persons         identidad de una persona; "record_name" es el nombre fijo
--                   que va en records[].user de los JSON. discord_id = vínculo.
--   profiles        en qué listas ('main' / 'rising') tiene presencia la persona.
--   aliases         otros textos que apuntan a la misma persona.
--   claim_requests  peticiones de vincular un perfil estático (las aprueba un Mod).
--   audit_log       historial de solo inserción.
--
-- Seguridad: los clientes (anon / authenticated) NO pueden escribir en
-- ninguna tabla. Todo cambio pasa por las funciones de abajo, que solo puede
-- ejecutar service_role (la Edge Function, tras validar el JWT).
--
-- Requiere que public.accounts tenga: user_id, discord_id, role, status,
-- username, global_name, nick, avatar_hash.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0) Comprobación previa
-- ---------------------------------------------------------------------
do $$
declare faltan text;
begin
  select string_agg(c, ', ') into faltan
  from unnest(array['user_id','discord_id','role','status','username','global_name','nick','avatar_hash']) as c
  where not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'accounts' and column_name = c
  );
  if faltan is not null then
    raise exception 'public.accounts no existe o le faltan columnas: %', faltan;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1) Normalización de nombres
--    recortar + NFKC + minúsculas + quitar TODOS los espacios (incluye
--    nbsp y caracteres invisibles). Se conservan _ - . y tildes.
--    El JS del cliente debe hacer lo mismo:
--      s.normalize('NFKC').toLowerCase().replace(/[\s\u00a0\u1680\u2000-\u200d\u2028\u2029\u202f\u205f\u2060\u3000\ufeff]+/g,'')
-- ---------------------------------------------------------------------
create or replace function public.normalize_name(p text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select lower(regexp_replace(
    normalize(coalesce(p, ''), NFKC),
    '[\s\u00a0\u1680\u2000-\u200d\u2028\u2029\u202f\u205f\u2060\u3000\ufeff]+',
    '', 'g'))
$$;

-- ---------------------------------------------------------------------
-- 2) Tablas
-- ---------------------------------------------------------------------
create table if not exists public.persons (
  id          uuid primary key default gen_random_uuid(),
  record_name text not null,
  name_key    text not null,
  discord_id  text,
  origin      text not null default 'static' check (origin in ('static', 'account')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint persons_name_key_uq   unique (name_key),
  constraint persons_discord_id_uq unique (discord_id),
  constraint persons_name_len      check (char_length(record_name) between 1 and 40)
);

create table if not exists public.profiles (
  id         uuid primary key default gen_random_uuid(),
  person_id  uuid not null references public.persons (id) on delete cascade,
  list       text not null check (list in ('main', 'rising')),
  source     text not null default 'static' check (source in ('static', 'auto')),
  created_at timestamptz not null default now(),
  constraint profiles_person_list_uq unique (person_id, list)
);

create table if not exists public.aliases (
  id         uuid primary key default gen_random_uuid(),
  person_id  uuid not null references public.persons (id) on delete cascade,
  alias      text not null,
  alias_key  text not null,
  created_by text,
  created_at timestamptz not null default now(),
  constraint aliases_key_uq  unique (alias_key),
  constraint aliases_len     check (char_length(alias) between 1 and 40)
);
create index if not exists aliases_person_idx on public.aliases (person_id);

create table if not exists public.claim_requests (
  id                   uuid primary key default gen_random_uuid(),
  requester_user_id    uuid not null,
  requester_discord_id text not null,
  target_person_id     uuid references public.persons (id) on delete set null,
  target_record_name   text not null,
  message              text check (message is null or char_length(message) <= 500),
  status               text not null default 'pending'
                       check (status in ('pending','approved','confirmed','rejected','expired','cancelled')),
  created_at           timestamptz not null default now(),
  expires_at           timestamptz not null default (now() + interval '24 hours'),
  reviewed_by_user_id    uuid,
  reviewed_by_discord_id text,
  reviewed_at          timestamptz,
  review_note          text check (review_note is null or char_length(review_note) <= 300),
  approval_expires_at  timestamptz,
  confirmed_at         timestamptz,
  -- Un Mod no puede aprobar su propia petición (lo impone la base de datos)
  constraint claim_no_self_review check (
    (reviewed_by_user_id is null or reviewed_by_user_id <> requester_user_id)
    and (reviewed_by_discord_id is null or reviewed_by_discord_id <> requester_discord_id)
  )
);
-- una sola petición activa por usuario
create unique index if not exists claim_one_active_per_user
  on public.claim_requests (requester_user_id) where status in ('pending', 'approved');
-- un solo perfil aprobado a la vez por objetivo
create unique index if not exists claim_one_approved_per_target
  on public.claim_requests (target_person_id) where status = 'approved';
create index if not exists claim_status_idx on public.claim_requests (status, created_at);

create table if not exists public.audit_log (
  id               bigint generated always as identity primary key,
  at               timestamptz not null default now(),
  actor_discord_id text,
  action           text not null,
  person_id        uuid,
  request_id       uuid,
  details          jsonb not null default '{}'::jsonb
);

-- audit_log: solo inserción (ni update, ni delete, ni truncate)
create or replace function public.trg_audit_immutable()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'audit_log es de solo inserción';
end $$;

drop trigger if exists audit_no_change on public.audit_log;
create trigger audit_no_change before update or delete on public.audit_log
  for each row execute function public.trg_audit_immutable();
drop trigger if exists audit_no_truncate on public.audit_log;
create trigger audit_no_truncate before truncate on public.audit_log
  for each statement execute function public.trg_audit_immutable();

-- ---------------------------------------------------------------------
-- 3) Triggers de unicidad de nombres (persons.name_key y aliases.alias_key
--    comparten un único espacio de nombres, sin carreras)
-- ---------------------------------------------------------------------
create or replace function public.trg_persons_name()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.record_name := btrim(new.record_name);
  new.name_key    := public.normalize_name(new.record_name);
  if new.name_key = '' then
    raise exception 'El nombre de records no puede estar vacío' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('name:' || new.name_key, 0));
  if exists (select 1 from public.aliases a
             where a.alias_key = new.name_key and a.person_id is distinct from new.id) then
    raise exception 'El nombre "%" ya está en uso como alias', new.record_name
      using errcode = '23505';
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists persons_name on public.persons;
create trigger persons_name before insert or update of record_name on public.persons
  for each row execute function public.trg_persons_name();

create or replace function public.trg_aliases_name()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.alias     := btrim(new.alias);
  new.alias_key := public.normalize_name(new.alias);
  if new.alias_key = '' then
    raise exception 'El alias no puede estar vacío' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('name:' || new.alias_key, 0));
  if exists (select 1 from public.persons p where p.name_key = new.alias_key) then
    raise exception 'El alias "%" coincide con un nombre de records existente', new.alias
      using errcode = '23505';
  end if;
  return new;
end $$;

drop trigger if exists aliases_name on public.aliases;
create trigger aliases_name before insert or update of alias on public.aliases
  for each row execute function public.trg_aliases_name();

-- ---------------------------------------------------------------------
-- 4) Funciones internas
-- ---------------------------------------------------------------------
create or replace function public.name_is_free(p_name text)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select not exists (select 1 from public.persons where name_key = public.normalize_name(p_name))
     and not exists (select 1 from public.aliases where alias_key = public.normalize_name(p_name));
$$;

create or replace function public._lists_for_role(p_role text)
returns text[] language sql immutable set search_path = public, pg_temp as $$
  select case p_role
    when 'rising' then array['rising']
    when 'vip'    then array['main', 'rising']
    when 'mod'    then array['main', 'rising']
    else array[]::text[]
  end
$$;

create or replace function public._audit(p_actor text, p_action text, p_person uuid, p_request uuid, p_details jsonb)
returns void language sql set search_path = public, pg_temp as $$
  insert into public.audit_log (actor_discord_id, action, person_id, request_id, details)
  values (p_actor, p_action, p_person, p_request, coalesce(p_details, '{}'::jsonb));
$$;

-- Cuenta activa o error. Códigos de error: el mensaje empieza por "codigo: ".
create or replace function public._require_active(p_actor uuid)
returns public.accounts language plpgsql stable set search_path = public, pg_temp as $$
declare a public.accounts;
begin
  select * into a from public.accounts where user_id = p_actor;
  if not found then raise exception 'no_account: cuenta no encontrada'; end if;
  if a.status <> 'active' then raise exception 'account_inactive: la cuenta no está activa'; end if;
  return a;
end $$;

create or replace function public._require_mod(p_actor uuid)
returns public.accounts language plpgsql stable set search_path = public, pg_temp as $$
declare a public.accounts;
begin
  a := public._require_active(p_actor);
  if a.role <> 'mod' then raise exception 'not_mod: se necesita el rol Mod'; end if;
  return a;
end $$;

create or replace function public.expire_claim_requests()
returns void language sql set search_path = public, pg_temp as $$
  update public.claim_requests set status = 'expired'
  where (status = 'pending'  and expires_at < now())
     or (status = 'approved' and approval_expires_at < now());
$$;

-- ---------------------------------------------------------------------
-- 5) Acciones (solo service_role). Todas devuelven datos simples.
-- ---------------------------------------------------------------------

-- 5.1 Crea (si falta) la persona de una cuenta activa y le asigna perfiles
--     según su rol. Idempotente. Nombre asignado = @usuario de Discord
--     limpio, con sufijo numérico si choca con un nombre o alias existente.
create or replace function public.ensure_account_person(p_actor uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a public.accounts; pid uuid; base text; cand text; n int := 0; l text;
begin
  a := public._require_active(p_actor);
  perform pg_advisory_xact_lock(hashtextextended('acct:' || a.discord_id, 0));

  select id into pid from public.persons where discord_id = a.discord_id;
  if pid is null then
    base := left(regexp_replace(coalesce(a.username, ''), '[^A-Za-z0-9_.-]', '', 'g'), 20);
    if base = '' then base := 'user'; end if;
    loop
      cand := case when n = 0 then base else base || n::text end;
      begin
        insert into public.persons (record_name, discord_id, origin)
        values (cand, a.discord_id, 'account') returning id into pid;
        exit;
      exception when unique_violation then
        n := n + 1;
        if n > 1000 then raise exception 'name_exhausted: no se encontró un nombre libre'; end if;
      end;
    end loop;
    perform public._audit(a.discord_id, 'person_created', pid, null,
      jsonb_build_object('record_name', cand, 'role', a.role));
  end if;

  foreach l in array public._lists_for_role(a.role) loop
    insert into public.profiles (person_id, list, source) values (pid, l, 'auto')
    on conflict (person_id, list) do nothing;
  end loop;
  return pid;
end $$;

-- 5.2 El usuario pide vincular un perfil estático.
create or replace function public.request_claim(p_actor uuid, p_person uuid, p_message text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a public.accounts; t public.persons; allowed text[]; plists text[]; rid uuid;
begin
  perform public.expire_claim_requests();
  a := public._require_active(p_actor);

  select * into t from public.persons where id = p_person for update;
  if not found then raise exception 'person_not_found: perfil no encontrado'; end if;
  if t.origin <> 'static' or t.discord_id is not null then
    raise exception 'not_claimable: ese perfil no está disponible para reclamar';
  end if;

  allowed := public._lists_for_role(a.role);
  select coalesce(array_agg(list), array[]::text[]) into plists from public.profiles where person_id = t.id;
  if exists (select 1 from unnest(plists) x where not (x = any (allowed))) then
    raise exception 'role_not_allowed: tu rol no permite reclamar ese perfil';
  end if;

  begin
    insert into public.claim_requests (requester_user_id, requester_discord_id, target_person_id,
                                       target_record_name, message)
    values (p_actor, a.discord_id, t.id, t.record_name, nullif(btrim(coalesce(p_message, '')), ''))
    returning id into rid;
  exception when unique_violation then
    raise exception 'active_request_exists: ya tienes una petición activa';
  end;

  perform public._audit(a.discord_id, 'claim_requested', t.id, rid, jsonb_build_object('target', t.record_name));
  return rid;
end $$;

-- 5.3 Un Mod aprueba o rechaza. Devuelve 'approved' o 'rejected'.
create or replace function public.review_claim(p_actor uuid, p_request uuid, p_approve boolean, p_note text default null)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  m public.accounts; r public.claim_requests; t public.persons; ra public.accounts;
begin
  perform public.expire_claim_requests();
  m := public._require_mod(p_actor);

  select * into r from public.claim_requests where id = p_request for update;
  if not found then raise exception 'request_not_found: petición no encontrada'; end if;
  if r.status <> 'pending' then raise exception 'request_not_pending: la petición ya no está pendiente'; end if;
  if r.requester_user_id = p_actor or r.requester_discord_id = m.discord_id then
    raise exception 'self_review: no puedes revisar tu propia petición';
  end if;

  if p_approve then
    select * into ra from public.accounts where user_id = r.requester_user_id;
    if not found or ra.status <> 'active' then
      raise exception 'requester_inactive: la cuenta solicitante no está activa';
    end if;
    select * into t from public.persons where id = r.target_person_id for update;
    if not found or t.discord_id is not null then
      raise exception 'target_unavailable: el perfil ya no está disponible';
    end if;
    begin
      update public.claim_requests
         set status = 'approved', reviewed_by_user_id = p_actor, reviewed_by_discord_id = m.discord_id,
             reviewed_at = now(), review_note = left(nullif(btrim(coalesce(p_note, '')), ''), 300),
             approval_expires_at = now() + interval '30 minutes'
       where id = r.id;
    exception when unique_violation then
      raise exception 'target_already_approved: ese perfil ya tiene una aprobación en curso';
    end;
    perform public._audit(m.discord_id, 'claim_approved', r.target_person_id, r.id,
      jsonb_build_object('requester', r.requester_discord_id, 'target', r.target_record_name));
    return 'approved';
  else
    update public.claim_requests
       set status = 'rejected', reviewed_by_user_id = p_actor, reviewed_by_discord_id = m.discord_id,
           reviewed_at = now(), review_note = left(nullif(btrim(coalesce(p_note, '')), ''), 300)
     where id = r.id;
    perform public._audit(m.discord_id, 'claim_rejected', r.target_person_id, r.id,
      jsonb_build_object('requester', r.requester_discord_id, 'target', r.target_record_name));
    return 'rejected';
  end if;
end $$;

-- 5.4 El usuario cancela su propia petición (pendiente o aprobada).
create or replace function public.cancel_claim(p_actor uuid, p_request uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.claim_requests;
begin
  perform public.expire_claim_requests();
  select * into r from public.claim_requests where id = p_request for update;
  if not found or r.requester_user_id <> p_actor then
    raise exception 'request_not_found: petición no encontrada';
  end if;
  if r.status not in ('pending', 'approved') then
    raise exception 'request_not_active: la petición ya no está activa';
  end if;
  update public.claim_requests set status = 'cancelled' where id = r.id;
  perform public._audit(r.requester_discord_id, 'claim_cancelled', r.target_person_id, r.id, '{}'::jsonb);
end $$;

-- 5.5 El usuario confirma dentro de los 30 min posteriores a la aprobación.
--     Si ya tenía persona propia se fusionan (el nombre sobrante queda como alias).
create or replace function public.confirm_claim(p_actor uuid, p_request uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a public.accounts; r public.claim_requests; t public.persons; x public.persons;
  canonical uuid; other public.persons; merged boolean := false; pr record;
begin
  perform public.expire_claim_requests();
  a := public._require_active(p_actor);

  select * into r from public.claim_requests where id = p_request for update;
  if not found or r.requester_user_id <> p_actor then
    raise exception 'request_not_found: petición no encontrada';
  end if;
  if r.status <> 'approved' then
    raise exception 'request_not_approved: la petición no está aprobada o ya caducó';
  end if;

  select * into t from public.persons where id = r.target_person_id for update;
  if not found or t.discord_id is not null then
    raise exception 'target_unavailable: el perfil ya no está disponible';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('acct:' || a.discord_id, 0));

  -- cualquier otra petición sobre el mismo perfil queda rechazada
  update public.claim_requests
     set status = 'rejected', review_note = 'El perfil fue vinculado a otra cuenta', reviewed_at = now()
   where target_person_id = t.id and status in ('pending', 'approved') and id <> r.id;

  select * into x from public.persons where discord_id = a.discord_id for update;
  if not found then
    update public.persons set discord_id = a.discord_id where id = t.id;
    canonical := t.id;
  else
    merged := true;
    if x.origin = 'static' then
      canonical := x.id; other := t;
    else
      canonical := t.id;  other := x;
      update public.persons set discord_id = null where id = x.id;   -- libera el vínculo
    end if;

    for pr in select * from public.profiles where person_id = other.id loop
      insert into public.profiles (person_id, list, source) values (canonical, pr.list, pr.source)
      on conflict (person_id, list) do update
        set source = case when public.profiles.source = 'auto' and excluded.source = 'static'
                          then 'static' else public.profiles.source end;
    end loop;
    update public.aliases set person_id = canonical where person_id = other.id;
    delete from public.persons where id = other.id;                   -- libera el nombre
    insert into public.aliases (person_id, alias, created_by)
    values (canonical, other.record_name, 'system:merge');
    if canonical = t.id then
      update public.persons set discord_id = a.discord_id where id = t.id;
    end if;
  end if;

  update public.claim_requests set status = 'confirmed', confirmed_at = now() where id = r.id;
  perform public._audit(a.discord_id, 'claim_confirmed', canonical, r.id,
    jsonb_build_object('target', r.target_record_name, 'merged', merged,
                       'approved_by', r.reviewed_by_discord_id));
  return canonical;
end $$;

-- 5.6 Un Mod desvincula un perfil ESTÁTICO ya vinculado. No toca records:
--     el perfil queda libre para reclamarse otra vez (con una petición nueva).
create or replace function public.unlink_person(p_actor uuid, p_person uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.accounts; t public.persons;
begin
  m := public._require_mod(p_actor);
  select * into t from public.persons where id = p_person for update;
  if not found then raise exception 'person_not_found: perfil no encontrado'; end if;
  if t.discord_id is null then raise exception 'not_linked: ese perfil no está vinculado'; end if;
  if t.origin <> 'static' then
    raise exception 'not_static: solo se pueden desvincular perfiles estáticos';
  end if;
  delete from public.profiles where person_id = t.id and source = 'auto';
  update public.persons set discord_id = null where id = t.id;
  perform public._audit(m.discord_id, 'unlink', t.id, null,
    jsonb_build_object('former_discord_id', t.discord_id, 'record_name', t.record_name,
                       'reason', left(coalesce(p_reason, ''), 300)));
end $$;

-- 5.7 Un Mod cambia el nombre de records; el nombre viejo pasa a alias.
create or replace function public.rename_person(p_actor uuid, p_person uuid, p_new_name text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.accounts; t public.persons; old_name text; new_key text;
begin
  m := public._require_mod(p_actor);
  select * into t from public.persons where id = p_person for update;
  if not found then raise exception 'person_not_found: perfil no encontrado'; end if;
  old_name := t.record_name;
  new_key  := public.normalize_name(p_new_name);
  begin
    if new_key = t.name_key then
      update public.persons set record_name = p_new_name where id = t.id;   -- solo mayúsculas/espacios
    else
      delete from public.aliases where person_id = t.id and alias_key = new_key;
      update public.persons set record_name = p_new_name where id = t.id;
      insert into public.aliases (person_id, alias, created_by) values (t.id, old_name, m.discord_id);
    end if;
  exception when unique_violation then
    raise exception 'name_taken: ese nombre ya está en uso';
  end;
  perform public._audit(m.discord_id, 'renamed', t.id, null,
    jsonb_build_object('from', old_name, 'to', btrim(p_new_name)));
end $$;

-- 5.8 Un Mod añade un alias a una persona.
create or replace function public.add_alias(p_actor uuid, p_person uuid, p_alias text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.accounts;
begin
  m := public._require_mod(p_actor);
  if not exists (select 1 from public.persons where id = p_person) then
    raise exception 'person_not_found: perfil no encontrado';
  end if;
  begin
    insert into public.aliases (person_id, alias, created_by) values (p_person, p_alias, m.discord_id);
  exception when unique_violation then
    raise exception 'name_taken: ese alias ya está en uso';
  end;
  perform public._audit(m.discord_id, 'alias_added', p_person, null, jsonb_build_object('alias', btrim(p_alias)));
end $$;

-- ---------------------------------------------------------------------
-- 6) Vistas públicas (lo único que lee la web sin sesión).
--    Corren con los privilegios del dueño a propósito: así leen accounts
--    sin abrirla. Solo exponen las columnas listadas. Si el linter de
--    Supabase avisa de "security definer view", es esperado.
-- ---------------------------------------------------------------------
create or replace view public.public_profiles as
select
  pr.id         as profile_id,
  pr.list       as list,
  p.record_name as record_name,
  p.name_key    as name_key,
  (p.discord_id is not null) as claimed,
  (p.discord_id is null or coalesce(a.status = 'active', false)) as visible,
  case when a.status = 'active'
       then coalesce(nullif(a.nick, ''), nullif(a.global_name, ''), a.username) end as display_name,
  case when a.status = 'active' then a.username end as discord_username,
  case when a.status = 'active' and a.avatar_hash is not null
       then 'https://cdn.discordapp.com/avatars/' || a.discord_id || '/' || a.avatar_hash || '.png?size=128' end as avatar_url
from public.profiles pr
join public.persons  p on p.id = pr.person_id
left join public.accounts a on a.discord_id = p.discord_id;

create or replace view public.public_aliases as
select al.alias_key, p.name_key
from public.aliases al
join public.persons p on p.id = al.person_id;

-- ---------------------------------------------------------------------
-- 7) Permisos y RLS
-- ---------------------------------------------------------------------
alter table public.persons        enable row level security;
alter table public.profiles       enable row level security;
alter table public.aliases        enable row level security;
alter table public.claim_requests enable row level security;
alter table public.audit_log      enable row level security;

revoke all on public.persons, public.profiles, public.aliases,
              public.claim_requests, public.audit_log from anon, authenticated;

-- el usuario solo puede LEER sus propias peticiones (y solo estas columnas)
drop policy if exists claim_requests_select_own on public.claim_requests;
create policy claim_requests_select_own on public.claim_requests
  for select to authenticated using (requester_user_id = (select auth.uid()));
grant select (id, target_person_id, target_record_name, message, status, created_at, expires_at,
              review_note, approval_expires_at, confirmed_at)
  on public.claim_requests to authenticated;

revoke all on public.public_profiles, public.public_aliases from anon, authenticated;
grant select on public.public_profiles, public.public_aliases to anon, authenticated;

-- funciones: nadie por la API pública; solo service_role
revoke all on function public.normalize_name(text)                          from public, anon, authenticated;
revoke all on function public.name_is_free(text)                            from public, anon, authenticated;
revoke all on function public._lists_for_role(text)                         from public, anon, authenticated;
revoke all on function public._audit(text, text, uuid, uuid, jsonb)         from public, anon, authenticated;
revoke all on function public._require_active(uuid)                         from public, anon, authenticated;
revoke all on function public._require_mod(uuid)                            from public, anon, authenticated;
revoke all on function public.expire_claim_requests()                       from public, anon, authenticated;
revoke all on function public.ensure_account_person(uuid)                   from public, anon, authenticated;
revoke all on function public.request_claim(uuid, uuid, text)               from public, anon, authenticated;
revoke all on function public.review_claim(uuid, uuid, boolean, text)       from public, anon, authenticated;
revoke all on function public.cancel_claim(uuid, uuid)                      from public, anon, authenticated;
revoke all on function public.confirm_claim(uuid, uuid)                     from public, anon, authenticated;
revoke all on function public.unlink_person(uuid, uuid, text)               from public, anon, authenticated;
revoke all on function public.rename_person(uuid, uuid, text)               from public, anon, authenticated;
revoke all on function public.add_alias(uuid, uuid, text)                   from public, anon, authenticated;

grant execute on function public.normalize_name(text)                          to service_role;
grant execute on function public.name_is_free(text)                            to service_role;
grant execute on function public.expire_claim_requests()                       to service_role;
grant execute on function public.ensure_account_person(uuid)                   to service_role;
grant execute on function public.request_claim(uuid, uuid, text)               to service_role;
grant execute on function public.review_claim(uuid, uuid, boolean, text)       to service_role;
grant execute on function public.cancel_claim(uuid, uuid)                      to service_role;
grant execute on function public.confirm_claim(uuid, uuid)                     to service_role;
grant execute on function public.unlink_person(uuid, uuid, text)               to service_role;
grant execute on function public.rename_person(uuid, uuid, text)               to service_role;
grant execute on function public.add_alias(uuid, uuid, text)                   to service_role;

-- =====================================================================
-- REINICIO (solo desarrollo): descomenta, ejecuta, y vuelve a ejecutar todo
-- el archivo desde arriba. Borra TODOS los perfiles, alias y peticiones.
-- =====================================================================
-- drop view if exists public.public_aliases, public.public_profiles;
-- drop table if exists public.claim_requests, public.aliases, public.profiles,
--                      public.persons, public.audit_log cascade;
