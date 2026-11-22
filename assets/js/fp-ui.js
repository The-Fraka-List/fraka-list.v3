// Utilidades de interfaz compartidas por claim.js y mod-panel.js (módulo ES).
// Todo el contenido dinámico se inserta con textContent: nunca innerHTML.

export function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
        for (const [k, v] of Object.entries(props)) {
            if (v === null || v === undefined || v === false) continue;
            if (k === 'class') el.className = v;
            else if (k === 'text') el.textContent = v;
            else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
            else if (v === true) el.setAttribute(k, '');
            else el.setAttribute(k, String(v));
        }
    }
    for (const child of children.flat()) {
        if (child === null || child === undefined || child === false) continue;
        el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
}

export function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' });
}

export function fmtRemaining(iso) {
    const ms = new Date(iso).getTime() - Date.now();
    if (!Number.isFinite(ms) || ms <= 0) return 'caducada';
    const min = Math.ceil(ms / 60000);
    if (min < 60) return min + ' min';
    const hrs = Math.floor(min / 60);
    return hrs + ' h ' + (min % 60) + ' min';
}

const ERROR_TEXT = {
    name_taken: 'Ese nombre ya está en uso.',
    active_request_exists: 'Ya tienes una petición activa.',
    role_not_allowed: 'Tu rol no permite vincular ese perfil.',
    self_review: 'No puedes resolver tu propia petición.',
    rate_limited: 'Demasiadas acciones seguidas. Espera un minuto.',
    request_not_found: 'La petición ya no existe o caducó.',
    not_mod: 'Solo los Mods pueden hacer esto.',
    discord_error: 'Discord no respondió. Intenta de nuevo en un momento.',
    network: 'No se pudo conectar. Revisa tu conexión.',
    // records (fase 3)
    limit_reached: 'Ya tienes 4 envíos activos. Espera a que un Mod resuelva alguno o cancela uno pendiente.',
    duplicate_active: 'Ya tienes un envío activo para ese nivel en esa lista.',
    list_not_allowed: 'Tu rol no permite enviar a esa lista.',
    in_review_by_other: 'Otro Mod ya está revisando este envío.',
    not_your_review: 'Abre el envío antes de resolverlo. Puede que otro Mod lo tenga o que el bloqueo caducara.',
    not_pending: 'Este envío ya fue resuelto.',
    not_cancellable: 'Solo se pueden cancelar envíos pendientes.',
    note_required: 'Escribe el motivo del rechazo.',
    submission_not_found: 'El envío ya no existe.',
    invalid_link: 'El enlace debe empezar por https://',
    invalid_percent: 'El porcentaje debe estar entre 1 y 100.',
    invalid_hz: 'Los hz deben estar entre 30 y 1000.',
    invalid_level: 'El nombre del nivel no es válido.',
    invalid_level_data: 'Revisa los datos del nivel nuevo.',
    no_role: 'Ya no tienes un rol autorizado.',
};

export function errorText(err) {
    if (!err) return 'Error desconocido.';
    return ERROR_TEXT[err.code] || err.message || 'Error desconocido.';
}

export function openModal(title, { wide = false } = {}) {
    const overlay = h('div', { class: 'fp-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
    const body = h('div', { class: 'fp-body' });
    const closeBtn = h('button', { type: 'button', class: 'fp-close', 'aria-label': 'Cerrar', text: '×' });
    const modal = h('div', { class: 'fp-modal' + (wide ? ' fp-modal--wide' : '') },
        h('div', { class: 'fp-head' }, h('h2', { class: 'fp-title', text: title }), closeBtn),
        body);
    overlay.appendChild(modal);

    const prevOverflow = document.body.style.overflow;
    function close() {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        document.body.style.overflow = prevOverflow;
        if (api.onClose) api.onClose();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    document.body.appendChild(overlay);
    const api = { overlay, modal, body, close, onClose: null };
    return api;
}

// Pregunta con un cuadro de texto. Devuelve el texto (puede ser '') o null si se cancela.
export function ask(title, { label = '', placeholder = '', required = false, confirmText = 'Aceptar', maxLength = 300 } = {}) {
    return new Promise((resolve) => {
        const m = openModal(title);
        let done = false;
        const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
        const input = h('textarea', { class: 'fp-input', rows: '3', maxlength: String(maxLength), placeholder });
        const err = h('div', { class: 'fp-error', hidden: true });
        const ok = h('button', {
            type: 'button', class: 'btn btn--primary', text: confirmText,
            onclick: () => {
                const v = input.value.trim();
                if (required && !v) { err.hidden = false; err.textContent = 'Este campo es obligatorio.'; return; }
                finish(v);
            },
        });
        const cancel = h('button', { type: 'button', class: 'btn btn--secondary', text: 'Cancelar', onclick: () => finish(null) });
        m.body.append(label ? h('label', { class: 'fp-label', text: label }) : null, input, err, h('div', { class: 'fp-actions' }, cancel, ok));
        m.onClose = () => finish(null);
        input.focus();
    });
}

export function badge(text, kind = '') {
    return h('span', { class: 'fp-badge' + (kind ? ' fp-badge--' + kind : ''), text });
}