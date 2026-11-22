// Login con Discord + verificación de rol (fase 1).
// Módulo ES: se carga con <script type="module" src="assets/js/auth.js"></script>
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.2/+esm';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './supabase-config.js';

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    // PKCE: el regreso del login usa ?code=... y no toca el #hash que usa el router de la página.
    auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
});

const ROLE_LABELS = { mod: 'Mod', vip: 'VIP', rising: 'Rising' };
const DENIED_MESSAGES = {
    no_role: 'Tu cuenta de Discord no tiene un rol autorizado (VIP, Rising o Mod). Cuando lo tengas, vuelve a iniciar sesión.',
    not_in_guild: 'No estás en el servidor de Discord de la Fraka List. Únete y vuelve a intentarlo.',
    not_discord: 'Solo se puede entrar con una cuenta de Discord.',
    banned: 'Tu cuenta está suspendida. Habla con un moderador.',
    hidden: 'Tu cuenta está oculta porque ya no tienes un rol autorizado. Cuando lo recuperes, vuelve a iniciar sesión.',
};

class Denied extends Error {
    constructor(code) { super(code); this.code = code; }
}

// ── Avatar ───────────────────────────────────────────────────────────────
// El hash cambia cada vez que la persona cambia su foto en Discord; se refresca en cada login.
export function discordAvatarUrl(discordId, hash, size = 128) {
    if (hash) {
        const ext = String(hash).startsWith('a_') ? 'gif' : 'png';
        return `https://cdn.discordapp.com/avatars/${discordId}/${hash}.${ext}?size=${size}`;
    }
    let index = 0;
    try { index = Number((BigInt(discordId) >> 22n) % 6n); } catch (_) { /* usa 0 */ }
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

// ── Estado ───────────────────────────────────────────────────────────────
let currentAccount = null;
let currentUserId = null;
let busy = false;
let currentMe = null; // respuesta de la acción 'me' (persona, listas, alias, peticiones)

function emitChange() {
    window.dispatchEvent(new CustomEvent('fraka-auth-change', { detail: { account: currentAccount } }));
}

// ── Interfaz ─────────────────────────────────────────────────────────────
const slot = document.getElementById('auth-slot');
let toastTimer = null;

function showMessage(text) {
    let toast = document.getElementById('auth-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'auth-toast';
        toast.className = 'auth-toast';
        toast.setAttribute('role', 'status');
        document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 9000);
}

function renderSignedOut(disabled = false) {
    if (!slot) return;
    slot.replaceChildren();
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'auth-btn';
    btn.disabled = disabled;
    btn.setAttribute('aria-label', 'Entrar con Discord');
    const icon = document.createElement('img');
    icon.src = 'assets/img/discord-icon.svg';
    icon.alt = '';
    const text = document.createElement('span');
    text.className = 'auth-btn__text';
    text.textContent = disabled ? 'Verificando…' : 'Entrar con Discord';
    btn.append(icon, text);
    btn.addEventListener('click', signIn);
    slot.appendChild(btn);
}

function renderSignedIn(account) {
    if (!slot) return;
    slot.replaceChildren();

    const avatarBtn = document.createElement('button');
    avatarBtn.type = 'button';
    avatarBtn.className = 'auth-avatar-btn';
    avatarBtn.setAttribute('aria-haspopup', 'true');
    avatarBtn.setAttribute('aria-expanded', 'false');
    avatarBtn.setAttribute('aria-label', 'Menú de tu cuenta');
    const img = document.createElement('img');
    img.src = discordAvatarUrl(account.discord_id, account.avatar_hash, 128);
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => { img.src = 'assets/img/pfp/default.png'; }, { once: true });
    avatarBtn.appendChild(img);

    const menu = document.createElement('div');
    menu.className = 'auth-menu';

    const name = document.createElement('div');
    name.className = 'auth-menu__name';
    name.textContent = account.nick || account.global_name || account.username;

    const user = document.createElement('div');
    user.className = 'auth-menu__user';
    user.textContent = '@' + account.username;

    const role = document.createElement('span');
    role.className = 'auth-menu__role auth-menu__role--' + account.role;
    role.textContent = ROLE_LABELS[account.role] || account.role;

    const logout = document.createElement('button');
    logout.type = 'button';
    logout.className = 'auth-menu__logout';
    logout.textContent = 'Cerrar sesión';
    logout.addEventListener('click', signOut);

    const actions = document.createElement('div');
    actions.className = 'auth-menu__actions';

    menu.append(name, user, role, actions, logout);
    slot.append(avatarBtn, menu);
    updateMenuActions();

    avatarBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = menu.classList.toggle('open');
        avatarBtn.setAttribute('aria-expanded', String(open));
    });
}

function closeMenu() {
    const menu = slot && slot.querySelector('.auth-menu');
    if (menu) menu.classList.remove('open');
    const btn = slot && slot.querySelector('.auth-avatar-btn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
}

function menuAction(label, handler) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'auth-menu__action';
    b.textContent = label;
    b.addEventListener('click', () => { closeMenu(); handler(); });
    return b;
}

function goToProfile(listCode) {
    window.location.hash = 'player/' + encodeURIComponent(currentMe.person.record_name) + '/' + listCode;
}

// Rellena "Ver perfil / Vincular perfil / Panel de Mods" según lo que devolvió 'me'. Solo es presentación:
// el servidor vuelve a comprobar los permisos en cada acción.
function updateMenuActions() {
    const box = slot && slot.querySelector('.auth-menu__actions');
    if (!box) return;
    box.replaceChildren();
    if (!currentAccount) return;
    if (currentMe && currentMe.person) {
        const lists = (currentMe.lists || []).filter((l) => l === 'main' || l === 'rising');
        if (lists.length > 1) {
            box.append(menuAction('Perfil (Lista)', () => goToProfile('list')));
            box.append(menuAction('Perfil (Rising)', () => goToProfile('rising')));
        } else if (lists.length === 1) {
            box.append(menuAction('Ver perfil', () => goToProfile(lists[0] === 'rising' ? 'rising' : 'list')));
        }
    }
    box.append(menuAction('Enviar record', () => {
        if (window.frakaRecords) window.frakaRecords.openSubmit(); else showMessage('El módulo de records no cargó. Recarga la página.');
    }));
    box.append(menuAction('Ver envíos', () => {
        if (window.frakaRecords) window.frakaRecords.openMine(); else showMessage('El módulo de records no cargó. Recarga la página.');
    }));
    box.append(menuAction('Vincular perfil', () => {
        if (window.frakaClaim) window.frakaClaim.open(); else showMessage('El módulo de vinculación no cargó. Recarga la página.');
    }));
    if (currentAccount.role === 'mod') {
        box.append(menuAction('Panel de Mods', () => {
            if (window.frakaModPanel) window.frakaModPanel.open(); else showMessage('El panel de Mods no cargó. Recarga la página.');
        }));
    }
}

document.addEventListener('click', (e) => {
    const menu = slot && slot.querySelector('.auth-menu');
    if (menu && !slot.contains(e.target)) menu.classList.remove('open');
});

// ── Acciones ─────────────────────────────────────────────────────────────
function siteUrl() {
    // URL de la página sin ?query, #hash ni index.html (debe estar en "Redirect URLs" de Supabase)
    return window.location.href.split(/[?#]/)[0].replace(/index\.html$/, '');
}

async function signIn() {
    const { error } = await supabase.auth.signInWithOAuth({
        provider: 'discord',
        options: { redirectTo: siteUrl() },
    });
    if (error) showMessage('No se pudo iniciar el login con Discord. Intenta de nuevo.');
}

async function signOut() {
    await supabase.auth.signOut({ scope: 'local' }); // local: no depende de que el servidor aún conozca la sesión
    currentAccount = null;
    currentMe = null;
    currentUserId = null;
    renderSignedOut();
    emitChange();
}

async function fetchOwnAccount() {
    const { data, error } = await supabase
        .from('accounts')
        .select('discord_id, role, status, username, global_name, nick, avatar_hash')
        .maybeSingle();
    if (error) throw new Error(error.message);
    return data; // null si todavía no existe
}

// Nombre con el que Supabase publicó la Edge Function (Dashboard → Edge Functions). Cámbialo si el tuyo es otro.
const REGISTER_FUNCTION = 'clever-endpoint';
const REVERIFY_MS = 10 * 60 * 1000; // re-verificar el rol si la pestaña vuelve a primer plano tras 10 min

async function callRegister() {
    const { data, error } = await supabase.functions.invoke(REGISTER_FUNCTION, { body: {} });
    if (error) {
        let code = null;
        try { code = (await error.context.json()).error; } catch (_) { /* sin cuerpo */ }
        if (code && DENIED_MESSAGES[code]) throw new Denied(code);
        throw new Error(code || error.message);
    }
    return data.account;
}

// Nombre con el que Supabase publicó la Edge Function de perfiles (el slug de su URL).
const PROFILES_FUNCTION = 'rapid-service';
const PROFILE_REJECT_CODES = { no_role: 'no_role', banned: 'banned', not_in_guild: 'not_in_guild', account_inactive: 'hidden' };

// Llama a la función de perfiles. Lanza Error con .code ('name_taken', 'self_review', 'network'...).
async function callProfiles(action, body = {}) {
    let res;
    try {
        res = await supabase.functions.invoke(PROFILES_FUNCTION, { body: { action, ...body } });
    } catch (e) {
        const err = new Error('No se pudo conectar.');
        err.code = 'network';
        throw err;
    }
    if (res.error) {
        let payload = null;
        try { payload = await res.error.context.json(); } catch (_) { /* sin cuerpo */ }
        const code = (payload && payload.error) || 'network';
        const err = new Error((payload && payload.message) || res.error.message || code);
        err.code = code;
        if (PROFILE_REJECT_CODES[code]) await rejectSession(PROFILE_REJECT_CODES[code]);
        throw err;
    }
    return res.data;
}

async function refreshMe() {
    const me = await callProfiles('me');
    currentMe = me;
    updateMenuActions();
    return me;
}

let verifiedAt = 0;

async function rejectSession(code) {
    currentAccount = null;
    currentMe = null;
    currentUserId = null;
    verifiedAt = 0;
    await supabase.auth.signOut({ scope: 'local' });
    renderSignedOut();
    emitChange();
    showMessage(DENIED_MESSAGES[code] || DENIED_MESSAGES.no_role);
}

// Verifica contra Discord (vía Edge Function) en CADA carga de la página, no solo al iniciar sesión.
async function handleSession(session, opts = {}) {
    if (!session) { currentAccount = null; currentMe = null; currentUserId = null; verifiedAt = 0; renderSignedOut(); emitChange(); return; }
    if (busy) return;
    const fresh = currentAccount && currentUserId === session.user.id && (Date.now() - verifiedAt) < REVERIFY_MS;
    if (fresh) return; // Supabase emite SIGNED_IN al volver a la pestaña: no repetir si ya se verificó hace poco
    busy = true;
    if (!currentAccount) renderSignedOut(true);
    try {
        const account = await callRegister();
        if (account.status !== 'active') throw new Denied(account.status);
        currentAccount = account;
        currentUserId = session.user.id;
        verifiedAt = Date.now();
        renderSignedIn(account);
        emitChange();
        refreshMe().catch((e) => console.warn('No se pudo cargar el perfil de la cuenta:', e));
    } catch (err) {
        if (err instanceof Denied) {
            await rejectSession(err.code);
        } else {
            // Fallo temporal (red, Discord caído...). La sesión se conserva y solo se muestra lo guardado,
            // sin dar poderes: el servidor vuelve a comprobar el rol en cada acción importante.
            console.error('No se pudo verificar la cuenta:', err);
            try {
                const cached = await fetchOwnAccount();
                if (cached && cached.status === 'active') {
                    currentAccount = cached;
                    currentUserId = session.user.id;
                    renderSignedIn(cached);
                    emitChange();
                } else { renderSignedOut(); emitChange(); }
            } catch (_) { renderSignedOut(); emitChange(); }
            showMessage('No se pudo verificar tu cuenta con Discord. Intenta de nuevo en unos minutos.');
        }
    } finally {
        busy = false;
    }
}

// ── Arranque ─────────────────────────────────────────────────────────────
function cleanAuthParamsFromUrl() {
    const url = new URL(window.location.href);
    const hadParams = ['code', 'error', 'error_code', 'error_description'].some((k) => url.searchParams.has(k));
    if (!hadParams) return;
    if (url.searchParams.get('error')) showMessage('Se canceló el inicio de sesión con Discord.');
    ['code', 'error', 'error_code', 'error_description'].forEach((k) => url.searchParams.delete(k));
    window.history.replaceState(window.history.state, '', url.pathname + (url.search || '') + url.hash);
}

renderSignedOut();

supabase.auth.onAuthStateChange((event, session) => {
    // Importante: no hacer await de llamadas a Supabase dentro de este callback (puede bloquearse).
    if (event === 'SIGNED_OUT') { setTimeout(() => handleSession(null), 0); return; }
    if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') setTimeout(() => handleSession(session), 0);
});

document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !currentAccount) return;
    const { data } = await supabase.auth.getSession();
    if (data && data.session) handleSession(data.session);
});

setTimeout(cleanAuthParamsFromUrl, 1500);

// Para las próximas fases (otros scripts de la página pueden leer la cuenta y el cliente)
window.frakaAuth = {
    supabase, getAccount: () => currentAccount, discordAvatarUrl,
    callProfiles, showMessage, getMe: () => currentMe, refreshMe,
};