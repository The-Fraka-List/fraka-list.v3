-- =====================================================================
-- Fraka List v3 · Fase 3 · Bloque 1 · Cola de records
-- Ejecutar en Supabase → SQL Editor, DESPUES de 01_schema.sql y 02_seed_names.sql.
--
-- Reglas:
--   * Un envio es de una lista ('main' / 'rising') y de un tipo:
--       'existing' = record nuevo en un nivel que ya existe.
--       'new'      = nivel nuevo (level_data lleva los datos del generador).
--   * VIP y Mod pueden enviar a las dos listas; Rising solo a 'rising'.
--   * Maximo 4 envios ACTIVOS por persona (pending + in_review). Un envio
--     rechazado, cancelado, aprobado o caducado libera el cupo.
--   * Un envio activo por persona, lista y nivel.
--   * Los pendientes caducan a los 30 dias.
--   * Revision: un Mod "abre" el envio y queda bloqueado (in_review) para los
--     demas Mods durante 15 minutos. El Mod que llega despues recibe error.
--   * Los Mods pueden enviar y aprobar sus propios records; queda marcado
--     (self_review) y en el historial de auditoria.
--   * user_name (el texto que va en records[].user del JSON) se calcula en el
--     servidor: el alias de cuenta de la persona (el creado al vincular, con
--     created_by = 'system:merge'); si no tiene, su nombre de record.
--   * "Aprobado" NO significa publicado: el Mod sube el JSON a mano.
--
-- Seguridad: nadie desde el navegador toca la tabla. Todo pasa por las
-- funciones, que solo ejecuta service_role (la Edge Function).
-- =====================================================================

-- 0) Comprobacion previa
do $$
begin
  if to_regclass('public.persons') is null or to_regclass('public.aliases') is null then
    raise exception 'Ejecuta primero 01_schema.sql (faltan persons / aliases)';
  end if;
  if to_regprocedure('public.ensure_account_person(uuid)') is null
     or to_regprocedure('public._require_mod(uuid)') is null then
    raise exception 'Ejecuta primero 01_schema.sql (faltan funciones base)';
  end if;
end $$;

-- 1) Tabla
create table if not exists public.record_submissions (
  id                   uuid primary key default gen_random_uuid(),
  submitter_user_id    uuid not null,
  submitter_discord_id text not null,
  person_id            uuid references public.persons (id) on delete set null,
  list                 text not null check (list in ('main', 'rising')),
  kind                 text not null check (kind in ('existing', 'new')),
  user_name            text not null check (char_length(user_name) between 1 and 40),
  level_file           text not null check (char_length(level_file) between 1 and 100
                                            and level_file !~ '[/\\]'),
  link                 text not null check (char_length(link) <= 300
                                            and link ~ '^https://[^[:space:]]+$'),
  percent              integer not null check (percent between 1 and 100),
  hz                   integer not null check (hz between 30 and 1000),
  note                 text check (note is null or char_length(note) <= 300),
  level_data           jsonb,
  status               text not null default 'pending'
                       check (status in ('pending', 'in_review', 'approved', 'rejected', 'cancelled', 'expired')),
  created_at           timestamptz not null default now(),
  expires_at           timestamptz not null default (now() + interval '30 days'),
  reviewer_user_id     uuid,
  reviewer_discord_id  text,
  review_expires_at    timestamptz,
  reviewed_at          timestamptz,
  review_note          text check (review_note is null or char_length(review_note) <= 300),
  self_review          boolean not null default false,
  constraint rs_level_data_kind check ((kind = 'new') = (level_data is not null)),
  constraint rs_level_data_size check (level_data is null or octet_length(level_data::text) <= 6000)
);

create index if not exists rs_user_idx   on public.record_submissions (submitter_user_id, status);
create index if not exists rs_status_idx on public.record_submissions (status, created_at);
-- un envio activo por persona, lista y nivel
create unique index if not exists rs_one_active_per_level
  on public.record_submissions (submitter_user_id, list, lower(level_file))
  where status in ('pending', 'in_review');

-- 2) Permisos y RLS
alter table public.record_submissions enable row level security;
revoke all on public.record_submissions from anon, authenticated;
grant select, insert, update on public.record_submissions to service_role;

-- 3) Utilidades

-- Nombre que va en records[].user: alias de cuenta (system:merge) o, si no hay, el nombre de record.
create or replace function public._submission_name(p_person uuid)
returns text language sql stable set search_path = public, pg_temp as $$
  select coalesce(
    (select al.alias from public.aliases al
      where al.person_id = p_person and al.created_by = 'system:merge'
      order by al.created_at, al.id limit 1),
    (select p.record_name from public.persons p where p.id = p_person)
  );
$$;

-- Suelta bloqueos de revision caducados y caduca pendientes viejos.
create or replace function public.expire_record_submissions()
returns void language sql set search_path = public, pg_temp as $$
  update public.record_submissions
     set status = 'pending', reviewer_user_id = null, reviewer_discord_id = null, review_expires_at = null
   where status = 'in_review' and review_expires_at < now();
  update public.record_submissions
     set status = 'expired', reviewed_at = now()
   where status = 'pending' and expires_at < now();
$$;

-- 4) Acciones. Los errores empiezan por "codigo: ".

-- 4.1 Enviar un record. Devuelve el id del envio.
create or replace function public.submit_record(
  p_actor uuid, p_list text, p_kind text, p_level_file text, p_link text,
  p_percent integer, p_hz integer, p_note text default null, p_level_data jsonb default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a public.accounts; allowed text[]; pid uuid; uname text; sid uuid; n int;
  lf text; lnk text; nt text; ld jsonb; cr jsonb; lvl_id text; lvl_pct text;
begin
  perform public.expire_record_submissions();
  a := public._require_active(p_actor);
  perform pg_advisory_xact_lock(hashtextextended('subm:' || a.discord_id, 0));

  if coalesce(p_list, '') not in ('main', 'rising') then
    raise exception 'invalid_list: lista no valida';
  end if;
  if coalesce(p_kind, '') not in ('existing', 'new') then
    raise exception 'invalid_kind: tipo de envio no valido';
  end if;
  allowed := public._lists_for_role(a.role);
  if not (p_list = any (allowed)) then
    raise exception 'list_not_allowed: tu rol no permite enviar a esa lista';
  end if;

  lf  := btrim(coalesce(p_level_file, ''));
  lnk := btrim(coalesce(p_link, ''));
  nt  := nullif(btrim(coalesce(p_note, '')), '');
  if char_length(lf) < 1 or char_length(lf) > 100 or lf ~ '[/\\]' then
    raise exception 'invalid_level: nombre de nivel no valido';
  end if;
  if p_percent is null or p_percent < 1 or p_percent > 100 then
    raise exception 'invalid_percent: el porcentaje debe estar entre 1 y 100';
  end if;
  if p_hz is null or p_hz < 30 or p_hz > 1000 then
    raise exception 'invalid_hz: los hz deben estar entre 30 y 1000';
  end if;
  if nt is not null and char_length(nt) > 300 then
    raise exception 'invalid_note: la nota es demasiado larga (maximo 300)';
  end if;

  pid   := public.ensure_account_person(p_actor);
  uname := public._submission_name(pid);

  if p_kind = 'new' then
    if p_level_data is null or jsonb_typeof(p_level_data) <> 'object' then
      raise exception 'invalid_level_data: faltan los datos del nivel';
    end if;
    lvl_id  := p_level_data ->> 'id';
    lvl_pct := p_level_data ->> 'percentToQualify';
    cr      := p_level_data -> 'creators';
    if lvl_id is null or lvl_id !~ '^[0-9]{1,12}$' then
      raise exception 'invalid_level_data: el ID del nivel debe ser un numero';
    end if;
    if char_length(btrim(coalesce(p_level_data ->> 'name', ''))) not between 1 and 100 then
      raise exception 'invalid_level_data: falta el nombre del nivel';
    end if;
    if char_length(btrim(coalesce(p_level_data ->> 'author', ''))) not between 1 and 100 then
      raise exception 'invalid_level_data: falta el autor';
    end if;
    if cr is null or jsonb_typeof(cr) <> 'array' then
      raise exception 'invalid_level_data: faltan los creators';
    end if;
    if jsonb_array_length(cr) < 1 or jsonb_array_length(cr) > 30 then
      raise exception 'invalid_level_data: creators debe tener entre 1 y 30 elementos';
    end if;
    if exists (select 1 from jsonb_array_elements(cr) e
               where jsonb_typeof(e) <> 'string'
                  or char_length(btrim(e #>> '{}')) not between 1 and 150) then
      raise exception 'invalid_level_data: cada creator debe ser un texto de 1 a 150 caracteres';
    end if;
    if coalesce(p_level_data ->> 'verification', '') !~ '^https://[^[:space:]]+$'
       or char_length(p_level_data ->> 'verification') > 300 then
      raise exception 'invalid_level_data: el enlace de verificacion debe ser https';
    end if;
    if lvl_pct is null or lvl_pct !~ '^[0-9]{1,3}$' or lvl_pct::int < 1 or lvl_pct::int > 100 then
      raise exception 'invalid_level_data: percentToQualify debe estar entre 1 y 100';
    end if;
    if char_length(coalesce(p_level_data ->> 'password', '')) > 100 then
      raise exception 'invalid_level_data: la contrasena es demasiado larga';
    end if;
    -- objeto limpio: solo claves conocidas; el verificador lo fija el servidor
    ld := jsonb_build_object(
      'id',               lvl_id::bigint,
      'name',             btrim(p_level_data ->> 'name'),
      'author',           btrim(p_level_data ->> 'author'),
      'creators',         cr,
      'verifier',         uname,
      'verification',     btrim(p_level_data ->> 'verification'),
      'percentToQualify', lvl_pct,
      'password',         coalesce(p_level_data ->> 'password', ''));
    lnk := ld ->> 'verification';   -- el record del verificador lleva el enlace de verificacion
  else
    ld := null;
  end if;

  if lnk !~ '^https://[^[:space:]]+$' or char_length(lnk) > 300 then
    raise exception 'invalid_link: el enlace debe empezar por https://';
  end if;

  select count(*) into n from public.record_submissions
   where submitter_user_id = p_actor and status in ('pending', 'in_review');
  if n >= 4 then
    raise exception 'limit_reached: ya tienes 4 envios activos';
  end if;

  begin
    insert into public.record_submissions
      (submitter_user_id, submitter_discord_id, person_id, list, kind, user_name,
       level_file, link, percent, hz, note, level_data)
    values (p_actor, a.discord_id, pid, p_list, p_kind, uname, lf, lnk, p_percent, p_hz, nt, ld)
    returning id into sid;
  exception when unique_violation then
    raise exception 'duplicate_active: ya tienes un envio activo para ese nivel en esa lista';
  end;

  perform public._audit(a.discord_id, 'record_submitted', pid, sid,
    jsonb_build_object('list', p_list, 'kind', p_kind, 'level', lf, 'user', uname));
  return sid;
end $$;

-- 4.2 El usuario cancela un envio PENDIENTE suyo (libera el cupo).
create or replace function public.cancel_record(p_actor uuid, p_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.accounts; r public.record_submissions;
begin
  perform public.expire_record_submissions();
  a := public._require_active(p_actor);
  select * into r from public.record_submissions where id = p_id for update;
  if not found or r.submitter_user_id <> p_actor then
    raise exception 'submission_not_found: envio no encontrado';
  end if;
  if r.status <> 'pending' then
    raise exception 'not_cancellable: solo se pueden cancelar envios pendientes';
  end if;
  update public.record_submissions set status = 'cancelled', reviewed_at = now() where id = r.id;
  perform public._audit(a.discord_id, 'record_cancelled', r.person_id, r.id,
    jsonb_build_object('level', r.level_file));
end $$;

-- 4.3 Un Mod abre un envio para revisarlo: lo bloquea 15 minutos para los demas.
create or replace function public.start_record_review(p_actor uuid, p_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.accounts; r public.record_submissions;
begin
  perform public.expire_record_submissions();
  m := public._require_mod(p_actor);
  select * into r from public.record_submissions where id = p_id for update;
  if not found then
    raise exception 'submission_not_found: envio no encontrado';
  end if;
  if r.status = 'in_review' then
    if r.reviewer_user_id = p_actor then
      update public.record_submissions set review_expires_at = now() + interval '15 minutes' where id = r.id;
      return;
    end if;
    raise exception 'in_review_by_other: otro Mod ya lo esta revisando';
  end if;
  if r.status <> 'pending' then
    raise exception 'not_pending: este envio ya esta resuelto';
  end if;
  update public.record_submissions
     set status = 'in_review', reviewer_user_id = p_actor, reviewer_discord_id = m.discord_id,
         review_expires_at = now() + interval '15 minutes'
   where id = r.id;
end $$;

-- 4.4 El Mod suelta el bloqueo sin resolver.
create or replace function public.release_record_review(p_actor uuid, p_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.accounts;
begin
  m := public._require_mod(p_actor);
  update public.record_submissions
     set status = 'pending', reviewer_user_id = null, reviewer_discord_id = null, review_expires_at = null
   where id = p_id and status = 'in_review' and reviewer_user_id = p_actor;
end $$;

-- 4.5 El Mod aprueba o rechaza un envio que tiene abierto. Devuelve 'approved' o 'rejected'.
--     Rechazar exige un motivo (el usuario lo ve).
create or replace function public.finish_record_review(
  p_actor uuid, p_id uuid, p_approve boolean, p_note text default null)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.accounts; r public.record_submissions; nt text; st text; selfr boolean;
begin
  m := public._require_mod(p_actor);
  select * into r from public.record_submissions where id = p_id for update;
  if not found then
    raise exception 'submission_not_found: envio no encontrado';
  end if;
  if r.status <> 'in_review' or r.reviewer_user_id is distinct from p_actor then
    raise exception 'not_your_review: abre el envio antes de resolverlo (puede que otro Mod lo tenga o que el bloqueo caducara)';
  end if;
  nt := nullif(btrim(coalesce(p_note, '')), '');
  if nt is not null and char_length(nt) > 300 then
    raise exception 'invalid_note: la nota es demasiado larga (maximo 300)';
  end if;
  if not coalesce(p_approve, false) and (nt is null or char_length(nt) < 3) then
    raise exception 'note_required: escribe el motivo del rechazo';
  end if;
  st := case when coalesce(p_approve, false) then 'approved' else 'rejected' end;
  selfr := (r.submitter_user_id = p_actor) or (r.submitter_discord_id = m.discord_id);
  update public.record_submissions
     set status = st, reviewed_at = now(), review_note = nt, self_review = selfr, review_expires_at = null
   where id = r.id;
  perform public._audit(m.discord_id, 'record_' || st, r.person_id, r.id,
    jsonb_build_object('level', r.level_file, 'submitter', r.submitter_discord_id, 'self_review', selfr));
  return st;
end $$;

-- 5) Quien puede ejecutar que
revoke all on function public._submission_name(uuid)                                   from public, anon, authenticated;
revoke all on function public.expire_record_submissions()                              from public, anon, authenticated;
revoke all on function public.submit_record(uuid, text, text, text, text, integer, integer, text, jsonb)
                                                                                       from public, anon, authenticated;
revoke all on function public.cancel_record(uuid, uuid)                                from public, anon, authenticated;
revoke all on function public.start_record_review(uuid, uuid)                          from public, anon, authenticated;
revoke all on function public.release_record_review(uuid, uuid)                        from public, anon, authenticated;
revoke all on function public.finish_record_review(uuid, uuid, boolean, text)          from public, anon, authenticated;

grant execute on function public.expire_record_submissions()                           to service_role;
grant execute on function public.submit_record(uuid, text, text, text, text, integer, integer, text, jsonb)
                                                                                       to service_role;
grant execute on function public.cancel_record(uuid, uuid)                             to service_role;
grant execute on function public.start_record_review(uuid, uuid)                       to service_role;
grant execute on function public.release_record_review(uuid, uuid)                     to service_role;
grant execute on function public.finish_record_review(uuid, uuid, boolean, text)       to service_role;
