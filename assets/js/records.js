// Records (fase 3): enviar un record y ver mis envíos. Módulo ES.
// Abre con window.frakaRecords.openSubmit() / window.frakaRecords.openMine().
// Toda la validación real (rol, tope de 4, duplicados) vive en el servidor; aquí solo se guía al usuario.
// También exporta utilidades que usa el panel de Mods (mod-panel.js).
import { h, fmtDate, fmtRemaining, errorText, openModal, badge } from './fp-ui.js';

const LIST_LABELS = { main: 'Lista', rising: 'Rising' };
const STATUS_LABELS = {
    pending: ['Pendiente', 'pending'],
    in_review: ['En revisión', 'pending'],
    approved: ['Aprobado · pendiente de publicar', 'confirmed'],
    rejected: ['Rechazado', 'rejected'],
    cancelled: ['Cancelado', 'cancelled'],
    expired: ['Caducado', 'expired'],
};
const HTTPS_RE = /^https:\/\/[^\s]+$/;
const PREFILL_KEY = 'fraka_modlist_prefill';

// ── Utilidades compartidas ───────────────────────────────────────────────

export function statusBadge(status) {
    const [text, kind] = STATUS_LABELS[status] || [status, ''];
    return badge(text, kind);
}

export function listLabel(list) { return LIST_LABELS[list] || list; }

// Bloque JSON de un record, con el formato de los archivos de nivel.
export function recordSnippet(rec) {
    return JSON.stringify({ user: rec.user_name, link: rec.link, percent: rec.percent, hz: rec.hz }, null, 4);
}

export function levelPath(rec) {
    return (rec.list === 'rising' ? 'data-rising/' : 'data-lvl/') + rec.level_file + '.json';
}

// Archivo de nivel completo (para un nivel nuevo), con las claves en el orden de damage.json.
export function levelFileObject(rec) {
    const d = rec.level_data || {};
    return {
        id: d.id, name: d.name, author: d.author, creators: d.creators,
        verifier: d.verifier || rec.user_name, verification: d.verification,
        percentToQualify: d.percentToQualify, password: d.password,
        records: [{ user: rec.user_name, link: rec.link, percent: rec.percent, hz: rec.hz }],
    };
}

export async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (_) {
        try {
            const ta = h('textarea', { style: 'position:fixed;left:-9999px;top:0;' });
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            const okCopy = document.execCommand('copy');
            ta.remove();
            return okCopy;
        } catch (_e) { return false; }
    }
}

// Abre #frk-mod-list con los datos del nivel ya rellenados. `win` es una pestaña abierta antes
// (para que el bloqueador de ventanas no la frene); si no hay, intenta abrir una.
export function openGeneratorFor(rec, win) {
    const payload = { v: 1, at: Date.now(), filename: rec.level_file, data: levelFileObject(rec) };
    let stored = false;
    try { localStorage.setItem(PREFILL_KEY, JSON.stringify(payload)); stored = true; } catch (_) { /* sin almacenamiento */ }
    if (!stored) { if (win && !win.closed) win.close(); return false; }
    const url = window.location.href.split(/[?#]/)[0] + '#frk-mod-list';
    if (win && !win.closed) { win.location.href = url; return true; }
    const w = window.open(url, '_blank');
    return !!w;
}

function levelsFor(list) {
    const data = window.frakaData && window.frakaData.getLevels && window.frakaData.getLevels();
    const arr = data && data[list];
    if (!Array.isArray(arr)) return [];
    return arr
        .map((lvl) => ({
            stem: String(lvl._file || '').split('/').pop().replace(/\.json$/i, ''),
            name: lvl.name, id: lvl.id, rank: lvl.rank, records: lvl.records || [],
        }))
        .filter((l) => l.stem)
        .sort((a, b) => (a.rank || 0) - (b.rank || 0));
}

function hasRecordIn(level, userName) {
    const fp = window.FrakaProfiles;
    if (!fp || !level) return false;
    return (level.records || []).some((r) => fp.sameName(r.user, userName));
}

// ── Formulario de envío ──────────────────────────────────────────────────

function field(label, input, hint) {
    return h('div', { class: 'fp-field' },
        h('label', { class: 'fp-label', text: label }),
        input,
        hint ? h('div', { class: 'fp-muted fp-small', text: hint }) : null);
}

function radio(name, value, text, { disabled = false, note = '' } = {}) {
    const input = h('input', { type: 'radio', name, value, disabled });
    const label = h('label', { class: 'fp-radio' + (disabled ? ' fp-radio--off' : '') }, input, h('span', { text }));
    if (note) label.title = note;
    return { input, label };
}

async function openSubmit() {
    const auth = window.frakaAuth;
    const acc = auth && auth.getAccount();
    if (!acc) return;
    const m = openModal('Enviar record', { wide: true });
    m.body.replaceChildren(h('p', { class: 'fp-muted', text: 'Cargando…' }));

    async function render() {
        let info;
        try {
            info = await auth.callProfiles('my_records');
        } catch (e) {
            m.body.replaceChildren(h('div', { class: 'fp-error', text: errorText(e) }));
            return;
        }
        buildForm(info);
    }

    function buildForm(info) {
        const used = info.active.length;
        const full = used >= info.max;
        const submitName = info.submit_name || '';
        const canMain = acc.role === 'vip' || acc.role === 'mod';

        const head = h('div', { class: 'fp-card fp-card--soft' },
            h('div', { class: 'fp-card__title' }, 'Envíos activos: ' + used + ' / ' + info.max + ' ',
                h('button', { type: 'button', class: 'btn btn--secondary', text: 'Ver mis envíos', onclick: () => openMine() })),
            full ? h('div', { class: 'fp-error', text: 'Llegaste al límite. Podrás enviar otro cuando un Mod resuelva alguno o si cancelas uno pendiente.' }) : null,
            h('div', { class: 'fp-muted', text: 'Se registrará a nombre de: ' + (submitName ? '#' + submitName : '(tu nombre se asigna al enviar)') }));

        const listR = { main: radio('fr-list', 'main', 'Lista', { disabled: !canMain, note: 'Solo VIP y Mod pueden enviar a la lista principal' }), rising: radio('fr-list', 'rising', 'Rising') };
        const kindR = { existing: radio('fr-kind', 'existing', 'Sí, el nivel ya está en la lista'), new: radio('fr-kind', 'new', 'No, es un nivel nuevo') };

        const listBox = h('div', { class: 'fp-card' },
            h('div', { class: 'fp-card__title', text: '¿A qué lista va? (obligatorio)' }),
            h('div', { class: 'fp-radios' }, listR.main.label, listR.rising.label),
            !canMain ? h('div', { class: 'fp-muted fp-small', text: 'Con tu rol solo puedes enviar a Rising.' }) : null);
        const kindBox = h('div', { class: 'fp-card' },
            h('div', { class: 'fp-card__title', text: '¿El nivel existe en esa lista? (obligatorio)' }),
            h('div', { class: 'fp-radios' }, kindR.existing.label, kindR.new.label));

        const dyn = h('div', { class: 'fp-dyn' });
        const err = h('div', { class: 'fp-error', hidden: true });
        const send = h('button', { type: 'button', class: 'btn btn--primary', text: 'Enviar record', disabled: true });

        const state = { read: () => null };
        const chosen = (r) => { const el = Object.values(r).find((x) => x.input.checked); return el ? el.input.value : ''; };

        function refresh() {
            err.hidden = true;
            const list = chosen(listR);
            const kind = chosen(kindR);
            send.disabled = full || !list || !kind;
            dyn.replaceChildren();
            state.read = () => null;
            if (!list || !kind) {
                if (!list || !kind) dyn.append(h('p', { class: 'fp-muted', text: 'Elige una lista y si el nivel existe para continuar.' }));
                return;
            }
            if (kind === 'existing') buildExisting(list); else buildNew(list);
        }
        Object.values(listR).concat(Object.values(kindR)).forEach((r) => r.input.addEventListener('change', refresh));

        function buildExisting(list) {
            const levels = levelsFor(list);
            if (!levels.length) {
                dyn.append(h('div', { class: 'fp-error', text: 'Aún no se cargaron los niveles. Cierra esto y vuelve a intentarlo en unos segundos.' }));
                state.read = () => ({ error: 'No hay niveles cargados.' });
                return;
            }
            const select = h('select', { class: 'fp-input', 'aria-label': 'Nivel' },
                h('option', { value: '', text: 'Elige el nivel…' }),
                levels.map((l) => h('option', { value: l.stem, text: '#' + l.rank + ' ' + l.name })));
            const percent = h('input', { class: 'fp-input', type: 'number', inputmode: 'numeric', min: '1', max: '100', placeholder: '100' });
            const hz = h('input', { class: 'fp-input', type: 'number', inputmode: 'numeric', min: '30', max: '1000', placeholder: '60' });
            const link = h('input', { class: 'fp-input', type: 'url', maxlength: '300', placeholder: 'https://www.youtube.com/watch?v=…' });
            const note = h('textarea', { class: 'fp-input', rows: '2', maxlength: '300', placeholder: 'Nota opcional para el Mod' });
            const warn = h('div', { class: 'fp-muted fp-small', hidden: true });
            select.addEventListener('change', () => {
                const lvl = levels.find((l) => l.stem === select.value);
                warn.hidden = !(lvl && hasRecordIn(lvl, submitName));
                warn.textContent = 'Aviso: parece que ya tienes un record en este nivel. Puedes enviarlo igualmente (por ejemplo, si mejoraste).';
            });
            dyn.append(field('Nivel', select), warn,
                h('div', { class: 'fp-grid2' }, field('Porcentaje', percent), field('Hz (FPS)', hz)),
                field('Enlace del video (https)', link), field('Nota (opcional)', note));
            state.read = () => {
                const p = Number(percent.value); const z = Number(hz.value);
                if (!select.value) return { error: 'Elige el nivel.' };
                if (!Number.isInteger(p) || p < 1 || p > 100) return { error: 'El porcentaje debe ser un número entero de 1 a 100.' };
                if (!Number.isInteger(z) || z < 30 || z > 1000) return { error: 'Los hz deben ser un número entero de 30 a 1000.' };
                if (!HTTPS_RE.test(link.value.trim())) return { error: 'El enlace debe empezar por https://' };
                return { payload: { list, kind: 'existing', level_file: select.value, link: link.value.trim(), percent: p, hz: z, note: note.value.trim() || undefined } };
            };
        }

        function buildNew(list) {
            const levels = levelsFor(list);
            const filename = h('input', { class: 'fp-input', type: 'text', maxlength: '80', placeholder: 'damage' });
            const lid = h('input', { class: 'fp-input', type: 'text', inputmode: 'numeric', maxlength: '12', placeholder: '84324862' });
            const lname = h('input', { class: 'fp-input', type: 'text', maxlength: '100', placeholder: 'Damage' });
            const author = h('input', { class: 'fp-input', type: 'text', maxlength: '100' });
            const verification = h('input', { class: 'fp-input', type: 'url', maxlength: '300', placeholder: 'https://www.youtube.com/watch?v=…' });
            const qualify = h('input', { class: 'fp-input', type: 'text', readonly: true, value: '100' });
            const password = h('input', { class: 'fp-input', type: 'text', maxlength: '100', placeholder: 'Free To Copy' });
            const percent = h('input', { class: 'fp-input', type: 'number', inputmode: 'numeric', min: '1', max: '100', placeholder: '100' });
            const hz = h('input', { class: 'fp-input', type: 'number', inputmode: 'numeric', min: '30', max: '1000', placeholder: '60' });
            const note = h('textarea', { class: 'fp-input', rows: '2', maxlength: '300', placeholder: 'Nota opcional para el Mod' });
            const verifier = h('input', { class: 'fp-input', type: 'text', readonly: true, value: submitName || '(se asigna al enviar)' });

            const creatorsBox = h('div', { class: 'fp-creators' });
            function addCreator(value = '') {
                const input = h('input', { class: 'fp-input fp-creator', type: 'text', maxlength: '150', placeholder: 'Creator' });
                input.value = value;
                const rm = h('button', { type: 'button', class: 'btn btn--secondary', text: '×', 'aria-label': 'Quitar creator' });
                const row = h('div', { class: 'fp-creator-row' }, input, rm);
                rm.addEventListener('click', () => { if (creatorsBox.children.length > 1) row.remove(); });
                creatorsBox.append(row);
            }
            addCreator();

            dyn.append(
                h('p', { class: 'fp-muted', text: 'Tú quedas como verificador del nivel. Estos datos son los del generador de JSON; un Mod los revisará.' }),
                field('Nombre del archivo (sin .json)', filename, 'Ej.: damage'),
                h('div', { class: 'fp-grid2' }, field('ID del nivel', lid), field('Nombre del nivel', lname)),
                h('div', { class: 'fp-grid2' }, field('Autor', author), field('Verificador (automático)', verifier)),
                field('Creators', h('div', { class: 'fp-creators-wrap' }, creatorsBox,
                    h('button', { type: 'button', class: 'btn btn--secondary', text: '+ Añadir creator', onclick: () => addCreator() }))),
                field('Enlace de verificación (https)', verification, 'También será el enlace de tu record.'),
                h('div', { class: 'fp-grid2' }, field('% para calificar', qualify, 'Fijo en 100.'), field('Contraseña', password)),
                h('div', { class: 'fp-grid2' }, field('Tu porcentaje', percent), field('Hz (FPS)', hz)),
                field('Nota (opcional)', note));

            state.read = () => {
                const stem = filename.value.trim().replace(/\.json$/i, '');
                if (!stem || stem.length > 80 || /[\\/]/.test(stem)) return { error: 'El nombre del archivo no es válido (sin barras).' };
                if (levels.some((l) => l.stem.toLowerCase() === stem.toLowerCase())) return { error: 'Ya existe un archivo con ese nombre en esa lista. Si el nivel existe, elige "Sí, el nivel ya está".' };
                if (!/^[0-9]{1,12}$/.test(lid.value.trim())) return { error: 'El ID debe ser un número.' };
                if (levels.some((l) => String(l.id) === lid.value.trim())) return { error: 'Ya existe un nivel con ese ID en esa lista.' };
                if (!lname.value.trim()) return { error: 'Falta el nombre del nivel.' };
                if (!author.value.trim()) return { error: 'Falta el autor.' };
                const creators = Array.from(creatorsBox.querySelectorAll('.fp-creator')).map((i) => i.value.trim()).filter(Boolean);
                if (!creators.length) return { error: 'Añade al menos un creator.' };
                if (!HTTPS_RE.test(verification.value.trim())) return { error: 'El enlace de verificación debe empezar por https://' };
                const q = 100; const p = Number(percent.value); const z = Number(hz.value);
                if (!Number.isInteger(p) || p < 1 || p > 100) return { error: 'Tu porcentaje debe ser un entero de 1 a 100.' };
                if (!Number.isInteger(z) || z < 30 || z > 1000) return { error: 'Los hz deben ser un entero de 30 a 1000.' };
                return {
                    payload: {
                        list, kind: 'new', level_file: stem, percent: p, hz: z, note: note.value.trim() || undefined,
                        link: verification.value.trim(),
                        level_data: {
                            id: lid.value.trim(), name: lname.value.trim(), author: author.value.trim(), creators,
                            verification: verification.value.trim(), percentToQualify: String(q), password: password.value.trim(),
                        },
                    },
                };
            };
        }

        send.addEventListener('click', async () => {
            err.hidden = true;
            const res = state.read();
            if (!res) return;
            if (res.error) { err.hidden = false; err.textContent = res.error; return; }
            send.disabled = true;
            try {
                await auth.callProfiles('submit_record', res.payload);
                auth.showMessage('Record enviado. Un Mod lo revisará.');
                await render();
            } catch (e) {
                err.hidden = false; err.textContent = errorText(e); send.disabled = false;
            }
        });

        m.body.replaceChildren(head, listBox, kindBox, dyn, err, h('div', { class: 'fp-actions' }, send));
        refresh();
    }

    await render();
}

// ── Mis envíos ───────────────────────────────────────────────────────────

function recordCard(r, { onCancel } = {}) {
    const closed = r.status !== 'pending' && r.status !== 'in_review';
    const card = h('div', { class: 'fp-card' },
        h('div', { class: 'fp-card__title' }, r.level_file, ' ', badge(listLabel(r.list)), r.kind === 'new' ? badge('Nivel nuevo') : null, statusBadge(r.status)),
        h('div', { class: 'fp-muted', text: r.percent + '% · ' + r.hz + ' Hz · enviado ' + fmtDate(r.created_at) }),
        HTTPS_RE.test(r.link || '') ? h('a', { class: 'fp-link', href: r.link, target: '_blank', rel: 'noopener noreferrer', text: 'Ver video' }) : null,
        r.note ? h('blockquote', { class: 'fp-quote', text: r.note }) : null);
    if (r.status === 'pending') card.append(h('div', { class: 'fp-muted fp-small', text: 'Caduca en ' + fmtRemaining(r.expires_at) + '.' }));
    if (r.status === 'in_review') card.append(h('div', { class: 'fp-muted fp-small', text: 'Un Mod lo está revisando ahora.' }));
    if (r.status === 'approved') card.append(h('div', { class: 'fp-muted fp-small', text: 'Aprobado. Aparecerá en la web cuando un Mod suba el archivo.' }));
    if (closed && r.review_note) card.append(h('div', { class: 'fp-muted fp-small', text: (r.status === 'rejected' ? 'Motivo: ' : 'Nota del Mod: ') + r.review_note }));
    if (closed && r.reviewed_at) card.append(h('div', { class: 'fp-muted fp-small', text: fmtDate(r.reviewed_at) }));
    if (r.status === 'pending' && onCancel) {
        card.append(h('div', { class: 'fp-actions' }, h('button', { type: 'button', class: 'btn btn--secondary', text: 'Cancelar envío', onclick: () => onCancel(r) })));
    }
    return card;
}

async function openMine() {
    const auth = window.frakaAuth;
    if (!auth || !auth.getAccount()) return;
    const m = openModal('Mis envíos', { wide: true });

    async function render() {
        m.body.replaceChildren(h('p', { class: 'fp-muted', text: 'Cargando…' }));
        let info;
        try {
            info = await auth.callProfiles('my_records');
        } catch (e) {
            m.body.replaceChildren(h('div', { class: 'fp-error', text: errorText(e) }));
            return;
        }
        if (window.frakaNotify) {
            const stamps = info.closed.filter((r) => (r.status === 'approved' || r.status === 'rejected') && r.reviewed_at).map((r) => r.reviewed_at);
            const last = stamps.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a), stamps[0]);
            if (last) window.frakaNotify.markSeen('mine', last);
        }
        const onCancel = async (r) => {
            try {
                await auth.callProfiles('cancel_record', { record_id: r.id });
                auth.showMessage('Envío cancelado.');
                await render();
            } catch (e) {
                auth.showMessage(errorText(e));
                await render();
            }
        };
        const pending = h('div', { class: 'fp-col' },
            h('div', { class: 'fp-card__title', text: 'Pendientes (' + info.active.length + '/' + info.max + ')' }),
            info.active.length ? info.active.map((r) => recordCard(r, { onCancel })) : h('p', { class: 'fp-muted', text: 'No tienes envíos pendientes.' }));
        const reviewed = h('div', { class: 'fp-col' },
            h('div', { class: 'fp-card__title', text: 'Revisados' }),
            info.closed.length ? info.closed.map((r) => recordCard(r)) : h('p', { class: 'fp-muted', text: 'Todavía no hay envíos revisados.' }));
        m.body.replaceChildren(
            h('div', { class: 'fp-actions fp-actions--left' },
                h('button', { type: 'button', class: 'btn btn--primary', text: 'Enviar un record', onclick: () => openSubmit() })),
            h('div', { class: 'fp-grid2 fp-grid2--top' }, pending, reviewed));
    }
    await render();
}

window.frakaRecords = { openSubmit, openMine };