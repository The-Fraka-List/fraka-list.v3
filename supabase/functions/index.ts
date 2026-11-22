// Edge Function `profiles` (Fraka List v3 · Fase 2)
//
// Una sola función con varias acciones: POST { "action": "...", ...datos }
//
//  Usuario (cuenta activa):
//    me              mi persona, mis listas, alias y mis últimas peticiones
//    claimable       perfiles estáticos libres que mi rol puede reclamar
//    request_claim   { name_key, message? }  pedir vincular un perfil estático
//    cancel_claim    { request_id }
//    confirm_claim   { request_id }          confirmar tras la aprobación de un Mod (30 min)
//  Mod (se re-verifica el rol en Discord en cada llamada):
//    mod_requests    { include_closed? }     peticiones pendientes/aprobadas
//    review_claim    { request_id, approve, note? }
//    mod_people      todas las personas, listas, alias y cuenta vinculada
//    unlink          { person_id, reason? }  desvincular un perfil estático vinculado
//    rename          { person_id, new_name } el nombre viejo pasa a alias
//    add_alias       { person_id, alias }
//    mod_audit       { limit? }              últimas filas del historial
//
//  Records (fase 3):
//    submit_record   { list, kind, level_file, link, percent, hz, note?, level_data? }
//                    list 'main'|'rising'; kind 'existing'|'new' (level_data solo si 'new')
//    my_records      mis envíos activos y los últimos cerrados, y submit_name (el nombre que irá en el JSON)
//    cancel_record   { record_id }           solo envíos pendientes propios
//  Mod:
//    mod_records     { include_closed? }     envíos pendientes / en revisión (y cerrados)
//    start_record_review   { record_id }     lo abre y lo bloquea 15 min para los demás Mods
//    release_record_review { record_id }     suelta el bloqueo
//    finish_record_review  { record_id, approve, note? }  rechazar exige motivo
//
// Seguridad:
//  - El usuario sale SIEMPRE del JWT validado con admin.auth.getUser (nunca del body).
//  - Las acciones que escriben o que muestran datos de Mod re-consultan a Discord con el
//    bot: si perdió el rol, la cuenta pasa a 'hidden' y la acción se rechaza.
//  - Los cambios de estado los hacen funciones SQL (security definer) que solo ejecuta
//    service_role; aquí solo se validan los datos y se traducen los errores.
//  - Límite best-effort de 30 acciones por minuto y usuario (por instancia de la función).
import { createClient } from 'npm:@supabase/supabase-js@2'

const DISCORD_API = 'https://discord.com/api/v10'
const USER_AGENT = 'DiscordBot (https://the-fraka-list.github.io/fraka-list.v3/, 1.0)'
const ROLE_PRIORITY = ['mod', 'vip', 'rising'] as const
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_BODY_BYTES = 10_000
const ROWS = 1000 // PostgREST corta en 1000 filas por defecto: lo pedimos explícito

// deno-lint-ignore no-explicit-any
type Any = any
type Cfg = ReturnType<typeof config>

class HttpError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message?: string) {
    super(message ?? code)
    this.status = status
    this.code = code
  }
}

function config() {
  return {
    botToken: Deno.env.get('DISCORD_BOT_TOKEN') ?? '',
    guildId: Deno.env.get('DISCORD_GUILD_ID') ?? '',
    roleIds: {
      mod: Deno.env.get('ROLE_ID_MOD') ?? '',
      vip: Deno.env.get('ROLE_ID_VIP') ?? '',
      rising: Deno.env.get('ROLE_ID_RISING') ?? '',
    } as Record<string, string>,
    allowedOrigins: (Deno.env.get('ALLOWED_ORIGINS') ?? 'https://the-fraka-list.github.io')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    supabaseUrl: Deno.env.get('SUPABASE_URL') ?? '',
    secretKey: getSecretKey(),
  }
}

function getSecretKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')
    if (keys && typeof keys.default === 'string' && keys.default) return keys.default
  } catch (_) { /* seguimos con la clásica */ }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
}

function getDiscordId(user: Any): string | null {
  const identity = (user?.identities ?? []).find((i: Any) => i?.provider === 'discord')
  const candidate = identity?.identity_data?.provider_id ?? identity?.identity_data?.sub ?? null
  return typeof candidate === 'string' && /^[0-9]{15,25}$/.test(candidate) ? candidate : null
}

function pickRole(memberRoles: string[], roleIds: Record<string, string>): string | null {
  const owned = new Set(memberRoles)
  for (const role of ROLE_PRIORITY) {
    if (roleIds[role] && owned.has(roleIds[role])) return role
  }
  return null
}

async function fetchMember(cfg: Cfg, discordId: string) {
  const res = await fetch(`${DISCORD_API}/guilds/${cfg.guildId}/members/${discordId}`, {
    headers: { Authorization: `Bot ${cfg.botToken}`, 'User-Agent': USER_AGENT },
  })
  if (res.ok) return { kind: 'ok' as const, member: await res.json() }
  let code = 0
  try { code = (await res.json())?.code ?? 0 } catch (_) { /* sin cuerpo */ }
  if (res.status === 404 && code === 10007) return { kind: 'not_in_guild' as const }
  return { kind: 'error' as const, http: res.status, code }
}

// ---------------------------------------------------------------------------
// Errores: las funciones SQL lanzan mensajes del estilo "codigo: texto".
// ---------------------------------------------------------------------------
const SQL_ERRORS: Record<string, number> = {
  no_account: 403, account_inactive: 403, not_mod: 403, forbidden: 403, self_review: 403,
  role_not_allowed: 403,
  person_not_found: 404, request_not_found: 404,
  not_claimable: 409, active_request_exists: 409, request_not_pending: 409, request_not_active: 409,
  request_not_approved: 409, requester_inactive: 409, target_unavailable: 409,
  target_already_approved: 409, not_linked: 409, not_static: 409, name_taken: 409,
  name_exhausted: 500,
  // records (fase 3)
  list_not_allowed: 403,
  submission_not_found: 404,
  invalid_list: 400, invalid_kind: 400, invalid_level: 400, invalid_percent: 400, invalid_hz: 400,
  invalid_note: 400, invalid_link: 400, invalid_level_data: 400, note_required: 400,
  limit_reached: 409, duplicate_active: 409, not_cancellable: 409, in_review_by_other: 409,
  not_pending: 409, not_your_review: 409,
}

function rpcError(err: Any): HttpError {
  const msg = String(err?.message ?? '')
  const m = /^([a-z_]+):\s*([\s\S]*)$/.exec(msg)
  if (m && m[1] in SQL_ERRORS) return new HttpError(SQL_ERRORS[m[1]], m[1], m[2])
  if (err?.code === '22023') return new HttpError(400, 'invalid_name', msg || 'Nombre no válido')
  console.error('Error de base de datos:', err?.code, msg)
  return new HttpError(500, 'database_error', 'Error de base de datos')
}

async function rpc(admin: Any, fn: string, args: Record<string, unknown> = {}) {
  const { data, error } = await admin.rpc(fn, args)
  if (error) throw rpcError(error)
  return data
}

async function rows(q: Any, what: string): Promise<Any[]> {
  const { data, error } = await q
  if (error) {
    console.error(`No se pudo leer ${what}:`, error.message)
    throw new HttpError(500, 'database_error', 'Error de base de datos')
  }
  return data ?? []
}

// ---------------------------------------------------------------------------
// Validación de datos de entrada
// ---------------------------------------------------------------------------
function reqStr(body: Any, key: string, max: number): string {
  const v = body?.[key]
  if (typeof v !== 'string' || !v.trim() || v.length > max) {
    throw new HttpError(400, 'bad_request', `Falta o no es válido: ${key}`)
  }
  return v
}

function optStr(body: Any, key: string, max: number): string | null {
  const v = body?.[key]
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string' || v.length > max) throw new HttpError(400, 'bad_request', `No es válido: ${key}`)
  return v
}

function reqInt(body: Any, key: string, min: number, max: number): number {
  const v = body?.[key]
  if (!Number.isInteger(v) || v < min || v > max) throw new HttpError(400, 'bad_request', `Falta o no es válido: ${key}`)
  return v
}

function reqUuid(body: Any, key: string): string {
  const v = body?.[key]
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new HttpError(400, 'bad_request', `Falta o no es válido: ${key}`)
  return v
}

// ---------------------------------------------------------------------------
// Límite de uso (best-effort, en memoria de la instancia)
// ---------------------------------------------------------------------------
const hits = new Map<string, number[]>()
function throttle(userId: string, limit = 30, windowMs = 60_000) {
  const now = Date.now()
  const arr = (hits.get(userId) ?? []).filter((t) => now - t < windowMs)
  if (arr.length >= limit) throw new HttpError(429, 'rate_limited', 'Demasiadas acciones seguidas, espera un momento')
  arr.push(now)
  hits.set(userId, arr)
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k)
  }
}

// ---------------------------------------------------------------------------
// Cuenta del llamante
// ---------------------------------------------------------------------------
async function loadAccount(admin: Any, userId: string): Promise<Any> {
  const { data, error } = await admin.from('accounts').select('*').eq('user_id', userId).maybeSingle()
  if (error) {
    console.error('No se pudo leer accounts:', error.message)
    throw new HttpError(500, 'database_error', 'Error de base de datos')
  }
  if (!data) throw new HttpError(403, 'no_account', 'Tu cuenta aún no está registrada')
  if (data.status === 'banned') throw new HttpError(403, 'banned', 'Cuenta baneada')
  return data
}

// Re-verifica en Discord, con el bot, que el usuario sigue en el server con rol autorizado.
// Actualiza la cuenta (rol, nombre, foto). Nunca crea ni borra cuentas.
async function syncLive(admin: Any, cfg: Cfg, user: Any): Promise<Any> {
  const acc = await loadAccount(admin, user.id)
  const discordId = getDiscordId(user)
  if (!discordId || discordId !== acc.discord_id) {
    throw new HttpError(403, 'not_discord', 'La identidad de Discord no coincide con la cuenta')
  }

  const result = await fetchMember(cfg, discordId)
  if (result.kind === 'error') {
    console.error('Discord respondió con error', result.http, result.code)
    throw new HttpError(502, 'discord_error', 'No se pudo verificar tu rol en Discord, inténtalo de nuevo')
  }
  if (result.kind === 'not_in_guild') throw new HttpError(403, 'not_in_guild', 'Ya no estás en el servidor')

  const member = result.member
  const role = pickRole(Array.isArray(member?.roles) ? member.roles : [], cfg.roleIds)
  if (!role) {
    if (acc.status === 'active') {
      await admin.from('accounts')
        .update({ status: 'hidden', updated_at: new Date().toISOString() }).eq('user_id', user.id)
    }
    throw new HttpError(403, 'no_role', 'Ya no tienes un rol autorizado')
  }

  const { data: saved, error } = await admin.from('accounts').update({
    role,
    status: 'active', // 'banned' ya se cortó arriba; si estaba 'hidden' recupera el rol
    username: member?.user?.username ?? acc.username,
    global_name: member?.user?.global_name ?? null,
    nick: member?.nick ?? null,
    avatar_hash: member?.user?.avatar ?? null,
    updated_at: new Date().toISOString(),
  }).eq('user_id', user.id).select('*').single()
  if (error) {
    console.error('No se pudo actualizar la cuenta:', error.message)
    throw new HttpError(500, 'database_error', 'Error de base de datos')
  }

  if (role !== acc.role || acc.status !== 'active') {
    const { error: ensureErr } = await admin.rpc('ensure_account_person', { p_actor: user.id })
    if (ensureErr) console.error('ensure_account_person falló:', ensureErr.message)
  }
  return saved
}

function publicAccount(a: Any) {
  return {
    role: a.role, status: a.status, username: a.username, global_name: a.global_name,
    nick: a.nick, avatar_hash: a.avatar_hash,
  }
}

function avatarUrl(discordId: string | null, hash: string | null, size = 64): string | null {
  return discordId && hash ? `https://cdn.discordapp.com/avatars/${discordId}/${hash}.png?size=${size}` : null
}

// ---------------------------------------------------------------------------
// Acciones
// ---------------------------------------------------------------------------
interface Ctx { admin: Any; user: Any; account: Any; body: Any }
interface Action { live: boolean; mod: boolean; run: (c: Ctx) => Promise<unknown> }

const REQUEST_COLUMNS =
  'id, target_record_name, message, status, created_at, expires_at, review_note, approval_expires_at, confirmed_at'

const RECORD_COLUMNS =
  'id, list, kind, user_name, level_file, link, percent, hz, note, status, created_at, expires_at, reviewed_at, review_note'
const RECORD_ACTIVE = ['pending', 'in_review']
const RECORD_CLOSED = ['approved', 'rejected', 'cancelled', 'expired']
const MAX_ACTIVE_RECORDS = 4

const ACTIONS: Record<string, Action> = {
  // ---- usuario -----------------------------------------------------------
  me: {
    live: false, mod: false,
    run: async ({ admin, user, account }) => {
      await rpc(admin, 'expire_claim_requests')
      const people = await rows(
        admin.from('persons').select('id, record_name, name_key, origin').eq('discord_id', account.discord_id), 'persons')
      const person = people[0] ?? null
      let lists: string[] = []
      let aliases: string[] = []
      if (person) {
        lists = (await rows(admin.from('profiles').select('list').eq('person_id', person.id), 'profiles'))
          .map((r) => r.list).sort()
        aliases = (await rows(admin.from('aliases').select('alias').eq('person_id', person.id), 'aliases'))
          .map((r) => r.alias).sort()
      }
      const requests = await rows(
        admin.from('claim_requests').select(REQUEST_COLUMNS).eq('requester_user_id', user.id)
          .order('created_at', { ascending: false }).limit(5), 'claim_requests')
      return {
        account: publicAccount(account),
        person: person && { record_name: person.record_name, name_key: person.name_key, origin: person.origin },
        lists, aliases, requests,
      }
    },
  },

  claimable: {
    live: false, mod: false,
    run: async ({ admin, account }) => {
      const allowed = account.role === 'rising' ? ['rising'] : ['main', 'rising']
      const people = await rows(
        admin.from('persons').select('id, record_name, name_key').eq('origin', 'static').is('discord_id', null)
          .limit(ROWS), 'persons')
      const profiles = await rows(admin.from('profiles').select('person_id, list').limit(ROWS * 10), 'profiles')
      const listsBy = new Map<string, string[]>()
      for (const p of profiles) (listsBy.get(p.person_id) ?? listsBy.set(p.person_id, []).get(p.person_id)!).push(p.list)
      const out = people
        .map((p) => ({ name_key: p.name_key, record_name: p.record_name, lists: (listsBy.get(p.id) ?? []).sort() }))
        .filter((p) => p.lists.length > 0 && p.lists.every((l) => allowed.includes(l)))
        .sort((a, b) => a.record_name.localeCompare(b.record_name))
      return { profiles: out }
    },
  },

  request_claim: {
    live: true, mod: false,
    run: async ({ admin, user, body }) => {
      const wanted = reqStr(body, 'name_key', 80)
      const message = optStr(body, 'message', 500)
      const key = await rpc(admin, 'normalize_name', { p: wanted })
      const found = await rows(admin.from('persons').select('id').eq('name_key', key).limit(1), 'persons')
      if (!found.length) throw new HttpError(404, 'person_not_found', 'Perfil no encontrado')
      const id = await rpc(admin, 'request_claim', { p_actor: user.id, p_person: found[0].id, p_message: message })
      return { request_id: id }
    },
  },

  cancel_claim: {
    live: false, mod: false,
    run: async ({ admin, user, body }) => {
      await rpc(admin, 'cancel_claim', { p_actor: user.id, p_request: reqUuid(body, 'request_id') })
      return { ok: true }
    },
  },

  confirm_claim: {
    live: true, mod: false,
    run: async ({ admin, user, body }) => {
      await rpc(admin, 'confirm_claim', { p_actor: user.id, p_request: reqUuid(body, 'request_id') })
      return { ok: true }
    },
  },

  // ---- mods ----------------------------------------------------------------
  mod_requests: {
    live: true, mod: true,
    run: async ({ admin, body }) => {
      await rpc(admin, 'expire_claim_requests')
      const open = await rows(
        admin.from('claim_requests').select('*').in('status', ['pending', 'approved'])
          .order('created_at', { ascending: true }).limit(200), 'claim_requests')
      let closed: Any[] = []
      if (body?.include_closed === true) {
        closed = await rows(
          admin.from('claim_requests').select('*').in('status', ['confirmed', 'rejected', 'expired', 'cancelled'])
            .order('created_at', { ascending: false }).limit(30), 'claim_requests')
      }
      const all = [...open, ...closed]
      const accounts = await rows(
        admin.from('accounts').select('user_id, discord_id, role, status, username, global_name, nick, avatar_hash')
          .limit(ROWS), 'accounts')
      const accBy = new Map(accounts.map((a) => [a.user_id, a]))
      const profiles = await rows(admin.from('profiles').select('person_id, list').limit(ROWS * 10), 'profiles')
      const listsBy = new Map<string, string[]>()
      for (const p of profiles) (listsBy.get(p.person_id) ?? listsBy.set(p.person_id, []).get(p.person_id)!).push(p.list)
      const persons = await rows(admin.from('persons').select('id, name_key').limit(ROWS), 'persons')
      const keyBy = new Map(persons.map((p) => [p.id, p.name_key]))
      return {
        requests: all.map((r) => {
          const a = accBy.get(r.requester_user_id)
          return {
            id: r.id, status: r.status, message: r.message, review_note: r.review_note,
            created_at: r.created_at, expires_at: r.expires_at, approval_expires_at: r.approval_expires_at,
            reviewed_by_discord_id: r.reviewed_by_discord_id, reviewed_at: r.reviewed_at,
            target: {
              record_name: r.target_record_name,
              name_key: r.target_person_id ? keyBy.get(r.target_person_id) ?? null : null,
              lists: r.target_person_id ? (listsBy.get(r.target_person_id) ?? []).sort() : [],
            },
            requester: a && {
              discord_id: a.discord_id, role: a.role, status: a.status, username: a.username,
              display_name: a.nick || a.global_name || a.username, avatar_url: avatarUrl(a.discord_id, a.avatar_hash),
            },
          }
        }),
      }
    },
  },

  review_claim: {
    live: true, mod: true,
    run: async ({ admin, user, body }) => {
      if (typeof body?.approve !== 'boolean') throw new HttpError(400, 'bad_request', 'Falta o no es válido: approve')
      const result = await rpc(admin, 'review_claim', {
        p_actor: user.id, p_request: reqUuid(body, 'request_id'), p_approve: body.approve,
        p_note: optStr(body, 'note', 300),
      })
      return { result }
    },
  },

  mod_people: {
    live: true, mod: true,
    run: async ({ admin }) => {
      const persons = await rows(
        admin.from('persons').select('id, record_name, name_key, origin, discord_id').order('record_name').limit(ROWS), 'persons')
      const profiles = await rows(admin.from('profiles').select('person_id, list, source').limit(ROWS * 10), 'profiles')
      const aliases = await rows(admin.from('aliases').select('person_id, alias').limit(ROWS * 10), 'aliases')
      const accounts = await rows(
        admin.from('accounts').select('discord_id, role, status, username, global_name, nick, avatar_hash').limit(ROWS), 'accounts')
      const accBy = new Map(accounts.map((a) => [a.discord_id, a]))
      const group = (list: Any[]) => {
        const m = new Map<string, Any[]>()
        for (const x of list) (m.get(x.person_id) ?? m.set(x.person_id, []).get(x.person_id)!).push(x)
        return m
      }
      const pBy = group(profiles)
      const aBy = group(aliases)
      return {
        people: persons.map((p) => {
          const a = p.discord_id ? accBy.get(p.discord_id) : null
          return {
            id: p.id, record_name: p.record_name, name_key: p.name_key, origin: p.origin,
            claimed: !!p.discord_id,
            lists: (pBy.get(p.id) ?? []).map((x) => x.list).sort(),
            aliases: (aBy.get(p.id) ?? []).map((x) => x.alias).sort(),
            account: a && {
              discord_id: a.discord_id, role: a.role, status: a.status, username: a.username,
              display_name: a.nick || a.global_name || a.username, avatar_url: avatarUrl(a.discord_id, a.avatar_hash),
            },
          }
        }),
      }
    },
  },

  unlink: {
    live: true, mod: true,
    run: async ({ admin, user, body }) => {
      await rpc(admin, 'unlink_person', {
        p_actor: user.id, p_person: reqUuid(body, 'person_id'), p_reason: optStr(body, 'reason', 300),
      })
      return { ok: true }
    },
  },

  rename: {
    live: true, mod: true,
    run: async ({ admin, user, body }) => {
      await rpc(admin, 'rename_person', {
        p_actor: user.id, p_person: reqUuid(body, 'person_id'), p_new_name: reqStr(body, 'new_name', 40),
      })
      return { ok: true }
    },
  },

  add_alias: {
    live: true, mod: true,
    run: async ({ admin, user, body }) => {
      await rpc(admin, 'add_alias', {
        p_actor: user.id, p_person: reqUuid(body, 'person_id'), p_alias: reqStr(body, 'alias', 40),
      })
      return { ok: true }
    },
  },

  mod_audit: {
    live: true, mod: true,
    run: async ({ admin, body }) => {
      const n = Number.isInteger(body?.limit) ? Math.min(Math.max(body.limit, 1), 200) : 100
      const log = await rows(admin.from('audit_log').select('*').order('id', { ascending: false }).limit(n), 'audit_log')
      return { log }
    },
  },

  // ---- records: usuario (fase 3) ----------------------------------------------
  submit_record: {
    live: true, mod: false,
    run: async ({ admin, user, body }) => {
      const kind = reqStr(body, 'kind', 10)
      let levelData: Any = null
      if (kind === 'new') {
        const ld = body?.level_data
        if (!ld || typeof ld !== 'object' || Array.isArray(ld)) {
          throw new HttpError(400, 'bad_request', 'Faltan los datos del nivel')
        }
        levelData = ld
      }
      const id = await rpc(admin, 'submit_record', {
        p_actor: user.id,
        p_list: reqStr(body, 'list', 10),
        p_kind: kind,
        p_level_file: reqStr(body, 'level_file', 100),
        // en un nivel nuevo el servidor usa el enlace de verificación como enlace del record
        p_link: kind === 'new' ? (optStr(body, 'link', 300) ?? '') : reqStr(body, 'link', 300),
        p_percent: reqInt(body, 'percent', 1, 100),
        p_hz: reqInt(body, 'hz', 30, 1000),
        p_note: optStr(body, 'note', 300),
        p_level_data: levelData,
      })
      return { id }
    },
  },

  my_records: {
    live: false, mod: false,
    run: async ({ admin, user, account }) => {
      await rpc(admin, 'expire_record_submissions')
      const active = await rows(
        admin.from('record_submissions').select(RECORD_COLUMNS).eq('submitter_user_id', user.id)
          .in('status', RECORD_ACTIVE).order('created_at', { ascending: true }).limit(20), 'record_submissions')
      const closed = await rows(
        admin.from('record_submissions').select(RECORD_COLUMNS).eq('submitter_user_id', user.id)
          .in('status', RECORD_CLOSED).order('reviewed_at', { ascending: false }).limit(40), 'record_submissions')
      // Nombre que irá en records[].user / verifier: el mismo criterio que usa submit_record
      // (alias creado al vincular; si no hay, el nombre de record).
      const people = await rows(
        admin.from('persons').select('id, record_name').eq('discord_id', account.discord_id).limit(1), 'persons')
      let submitName: string | null = null
      if (people.length) {
        const al = await rows(
          admin.from('aliases').select('alias').eq('person_id', people[0].id).eq('created_by', 'system:merge')
            .order('created_at', { ascending: true }).limit(1), 'aliases')
        submitName = al.length ? al[0].alias : people[0].record_name
      }
      return { active, closed, max: MAX_ACTIVE_RECORDS, submit_name: submitName }
    },
  },

  cancel_record: {
    live: false, mod: false,
    run: async ({ admin, user, body }) => {
      await rpc(admin, 'cancel_record', { p_actor: user.id, p_id: reqUuid(body, 'record_id') })
      return { ok: true }
    },
  },

  // ---- records: mods (fase 3) -------------------------------------------------
  mod_records: {
    live: true, mod: true,
    run: async ({ admin, user, body }) => {
      await rpc(admin, 'expire_record_submissions')
      const open = await rows(
        admin.from('record_submissions').select('*').in('status', RECORD_ACTIVE)
          .order('created_at', { ascending: true }).limit(200), 'record_submissions')
      let closed: Any[] = []
      if (body?.include_closed === true) {
        closed = await rows(
          admin.from('record_submissions').select('*').in('status', RECORD_CLOSED)
            .order('reviewed_at', { ascending: false }).limit(50), 'record_submissions')
      }
      const accounts = await rows(
        admin.from('accounts').select('user_id, discord_id, role, status, username, global_name, nick, avatar_hash')
          .limit(ROWS), 'accounts')
      const accBy = new Map(accounts.map((a) => [a.user_id, a]))
      return {
        pending_count: open.filter((r) => r.status === 'pending').length,
        records: [...open, ...closed].map((r) => {
          const a = accBy.get(r.submitter_user_id)
          return {
            id: r.id, list: r.list, kind: r.kind, user_name: r.user_name, level_file: r.level_file,
            link: r.link, percent: r.percent, hz: r.hz, note: r.note, level_data: r.level_data,
            status: r.status, created_at: r.created_at, expires_at: r.expires_at,
            reviewed_at: r.reviewed_at, review_note: r.review_note, self_review: r.self_review,
            review_expires_at: r.review_expires_at,
            mine: r.submitter_user_id === user.id,
            locked_by_me: r.status === 'in_review' && r.reviewer_user_id === user.id,
            reviewer_discord_id: r.reviewer_discord_id,
            submitter: a && {
              discord_id: a.discord_id, role: a.role, status: a.status, username: a.username,
              display_name: a.nick || a.global_name || a.username, avatar_url: avatarUrl(a.discord_id, a.avatar_hash),
            },
          }
        }),
      }
    },
  },

  start_record_review: {
    live: true, mod: true,
    run: async ({ admin, user, body }) => {
      await rpc(admin, 'start_record_review', { p_actor: user.id, p_id: reqUuid(body, 'record_id') })
      return { ok: true }
    },
  },

  release_record_review: {
    live: true, mod: true,
    run: async ({ admin, user, body }) => {
      await rpc(admin, 'release_record_review', { p_actor: user.id, p_id: reqUuid(body, 'record_id') })
      return { ok: true }
    },
  },

  finish_record_review: {
    live: true, mod: true,
    run: async ({ admin, user, body }) => {
      if (typeof body?.approve !== 'boolean') throw new HttpError(400, 'bad_request', 'Falta o no es válido: approve')
      const result = await rpc(admin, 'finish_record_review', {
        p_actor: user.id, p_id: reqUuid(body, 'record_id'), p_approve: body.approve,
        p_note: optStr(body, 'note', 300),
      })
      return { result }
    },
  },
}

// ---------------------------------------------------------------------------
// Servidor
// ---------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  const cfg = config()
  const origin = req.headers.get('origin')
  const cors = {
    'Access-Control-Allow-Origin': origin && cfg.allowedOrigins.includes(origin) ? origin : cfg.allowedOrigins[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  try {
    if (!cfg.botToken || !cfg.guildId || !cfg.roleIds.mod || !cfg.roleIds.vip || !cfg.roleIds.rising ||
        !cfg.supabaseUrl || !cfg.secretKey) {
      console.error('Configuración incompleta: faltan secretos de la función')
      throw new HttpError(500, 'server_misconfigured')
    }

    const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (!jwt) throw new HttpError(401, 'unauthorized')

    const len = Number(req.headers.get('content-length') ?? '0')
    if (len > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large')
    let body: Any = {}
    try { body = await req.json() } catch (_) { body = {} }
    if (!body || typeof body !== 'object' || Array.isArray(body)) body = {}

    const action = typeof body.action === 'string' && Object.hasOwn(ACTIONS, body.action) ? ACTIONS[body.action] : null
    if (!action) throw new HttpError(400, 'unknown_action', 'Acción desconocida')

    const admin = createClient(cfg.supabaseUrl, cfg.secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt)
    const user = userData?.user
    if (userErr || !user) throw new HttpError(401, 'unauthorized')

    throttle(user.id)

    let account: Any
    if (action.live) {
      account = await syncLive(admin, cfg, user)
    } else {
      account = await loadAccount(admin, user.id)
      if (account.status !== 'active') throw new HttpError(403, 'account_inactive', 'La cuenta no está activa')
    }
    if (action.mod && account.role !== 'mod') throw new HttpError(403, 'not_mod', 'Se necesita el rol Mod')

    return json(await action.run({ admin, user, account, body }))
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status)
    console.error('Error inesperado:', e)
    return json({ error: 'internal_error' }, 500)
  }
})