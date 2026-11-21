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

    menu.append(name, user, role, logout);
    slot.append(avatarBtn, menu);

    avatarBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = menu.classList.toggle('open');
        avatarBtn.setAttribute('aria-expanded', String(open));
    });
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

async function callRegister() {
    const { data, error } = await supabase.functions.invoke('register', { body: {} });
    if (error) {
        let code = null;
        try { code = (await error.context.json()).error; } catch (_) { /* sin cuerpo */ }
        if (code && DENIED_MESSAGES[code]) throw new Denied(code);
        throw new Error(code || error.message);
    }
    return data.account;
}

async function handleSession(session, event) {
    if (!session) { currentAccount = null; currentUserId = null; renderSignedOut(); emitChange(); return; }
    if (busy) return;
    // Supabase también emite SIGNED_IN al volver a la pestaña: si ya tenemos esta cuenta, no repetir nada.
    if (currentAccount && currentUserId === session.user.id) return;
    busy = true;
    renderSignedOut(true);
    try {
        const flagKey = 'fraka_registered_' + session.user.id;
        // Al iniciar sesión se vuelve a verificar el rol una vez por pestaña; en recargas basta con leer la cuenta.
        const mustRegister = event === 'SIGNED_IN' && !sessionStorage.getItem(flagKey);
        let account = mustRegister ? null : await fetchOwnAccount();
        if (!account) {
            account = await callRegister();
            try { sessionStorage.setItem(flagKey, '1'); } catch (_) { /* modo privado estricto */ }
        }
        if (account.status !== 'active') throw new Denied(account.status);
        currentAccount = account;
        currentUserId = session.user.id;
        renderSignedIn(account);
        emitChange();
    } catch (err) {
        currentAccount = null;
        currentUserId = null;
        if (err instanceof Denied) {
            // Rechazada: se cierra la sesión local y se explica el motivo.
            await supabase.auth.signOut({ scope: 'local' });
            renderSignedOut();
            emitChange();
            showMessage(DENIED_MESSAGES[err.code]);
        } else {
            // Fallo temporal (red, Discord caído...): se conserva la sesión; basta con reintentar.
            console.error('Error al verificar la cuenta:', err);
            renderSignedOut();
            emitChange();
            showMessage('No se pudo verificar tu cuenta. Intenta de nuevo en unos minutos.');
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
    if (event === 'SIGNED_OUT') { setTimeout(() => handleSession(null, event), 0); return; }
    if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') setTimeout(() => handleSession(session, event), 0);
});

setTimeout(cleanAuthParamsFromUrl, 1500);

// Para las próximas fases (otros scripts de la página pueden leer la cuenta y el cliente)
window.frakaAuth = { supabase, getAccount: () => currentAccount, discordAvatarUrl };
