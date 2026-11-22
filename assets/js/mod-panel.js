// Panel de Mods (fase 2). Módulo ES. Abre con window.frakaModPanel.open().
// Es solo una vista: cada acción la valida la Edge Function (rol Mod comprobado en vivo con Discord).
import { h, fmtDate, fmtRemaining, errorText, openModal, ask, badge } from './fp-ui.js';

const LIST_LABELS = { main: 'Lista', rising: 'Rising' };
const ACTION_LABELS = {
    person_created: 'Persona creada', claim_requested: 'Petición enviada', claim_approved: 'Petición aprobada',
    claim_rejected: 'Petición rechazada', claim_cancelled: 'Petición cancelada', claim_confirmed: 'Vinculación confirmada',
    unlink: 'Desvinculado', renamed: 'Renombrado', alias_added: 'Alias añadido',
};

function who(a) {
    if (!a) return '—';
    return (a.display_name || a.username || '?') + (a.username ? ' (@' + a.username + ')' : '');
}

function countRecords(nameKey, lists) {
    // Cuenta records en los JSON ya cargados por main.js (solo informativo para el Mod).
    const data = window.frakaData && window.frakaData.getLevels && window.frakaData.getLevels();
    const fp = window.FrakaProfiles;
    if (!data || !fp) return null;
    let n = 0;
    for (const [list, levels] of Object.entries(data)) {
        if (lists && !lists.includes(list)) continue;
        for (const lvl of levels || []) {
            for (const rec of (lvl && lvl.records) || []) {
                if (fp.normalize(fp.canonicalName(rec.user)) === nameKey) n++;
            }
        }
    }
    return n;
}

async function open() {
    const auth = window.frakaAuth;
    const acc = auth && auth.getAccount();
    if (!acc || acc.role !== 'mod') return;
    const call = (action, body) => auth.callProfiles(action, body);
    const m = openModal('Panel de Mods', { wide: true });

    const tabs = { requests: 'Peticiones', people: 'Personas', audit: 'Historial' };
    const nav = h('div', { class: 'fp-tabs', role: 'tablist' });
    const content = h('div', { class: 'fp-tabcontent' });
    m.body.append(nav, content);
    let current = 'requests';

    function setTab(name) {
        current = name;
        nav.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
        load();
    }
    Object.entries(tabs).forEach(([k, label]) => {
        nav.appendChild(h('button', { type: 'button', class: 'fp-tab', 'data-tab': k, role: 'tab', text: label, onclick: () => setTab(k) }));
    });

    async function guarded(fn) {
        try { await fn(); } catch (e) {
            auth.showMessage(errorText(e));
        }
    }

    async function load() {
        content.replaceChildren(h('p', { class: 'fp-muted', text: 'Cargando…' }));
        try {
            if (current === 'requests') await renderRequests();
            else if (current === 'people') await renderPeople();
            else await renderAudit();
        } catch (e) {
            content.replaceChildren(h('div', { class: 'fp-error', text: errorText(e) }));
        }
    }

    async function renderRequests() {
        const { requests } = await call('mod_requests');
        if (!requests.length) { content.replaceChildren(h('p', { class: 'fp-muted', text: 'No hay peticiones abiertas.' })); return; }
        content.replaceChildren(...requests.map((r) => {
            const t = r.target || {};
            const n = countRecords(t.name_key, t.lists);
            const isPending = r.status === 'pending';
            const card = h('div', { class: 'fp-card' },
                h('div', { class: 'fp-card__title' }, '#' + t.record_name, ' ', badge(isPending ? 'Pendiente' : 'Aprobada, esperando al usuario', r.status)),
                h('div', { class: 'fp-muted', text: 'Pide: ' + who(r.requester) + ' · rol ' + (r.requester && r.requester.role) }),
                h('div', { class: 'fp-muted', text: 'Listas del perfil: ' + (t.lists || []).map((l) => LIST_LABELS[l] || l).join(' + ') + (n === null ? '' : ' · ' + n + ' records') }),
                h('div', { class: 'fp-muted', text: 'Enviada ' + fmtDate(r.created_at) + ' · ' + (isPending ? 'caduca en ' + fmtRemaining(r.expires_at) : 'confirmación en ' + fmtRemaining(r.approval_expires_at)) }),
                r.message ? h('blockquote', { class: 'fp-quote', text: r.message }) : null);
            if (isPending) {
                const decide = (approve) => guarded(async () => {
                    const note = await ask(approve ? 'Aprobar petición' : 'Rechazar petición', {
                        label: approve ? 'Nota (opcional)' : 'Motivo del rechazo', required: !approve,
                        confirmText: approve ? 'Aprobar' : 'Rechazar',
                    });
                    if (note === null) return;
                    await call('review_claim', { request_id: r.id, approve, note: note || undefined });
                    auth.showMessage(approve ? 'Aprobada: el usuario tiene 30 min para confirmar.' : 'Petición rechazada.');
                    await load();
                });
                card.append(h('div', { class: 'fp-actions' },
                    h('button', { type: 'button', class: 'btn btn--secondary', text: 'Rechazar', onclick: () => decide(false) }),
                    h('button', { type: 'button', class: 'btn btn--primary', text: 'Aprobar', onclick: () => decide(true) })));
                card.append(h('div', { class: 'fp-muted fp-small', text: 'No puedes resolver tu propia petición (el servidor lo impide).' }));
            }
            return card;
        }));
    }

    async function renderPeople() {
        const { people } = await call('mod_people');
        const search = h('input', { type: 'search', class: 'fp-input', placeholder: 'Buscar por nombre, alias o @usuario…', 'aria-label': 'Buscar' });
        const list = h('div', { class: 'fp-list' });
        const norm = (s) => (window.FrakaProfiles ? window.FrakaProfiles.normalize(s) : String(s || '').toLowerCase());

        function row(p) {
            const acct = p.account;
            const handlers = [];
            if (p.origin === 'static' && p.claimed) {
                handlers.push(h('button', {
                    type: 'button', class: 'btn btn--secondary', text: 'Desvincular',
                    onclick: () => guarded(async () => {
                        const reason = await ask('Desvincular #' + p.record_name, { label: 'Motivo (opcional)', confirmText: 'Desvincular' });
                        if (reason === null) return;
                        await call('unlink', { person_id: p.id, reason: reason || undefined });
                        auth.showMessage('Perfil desvinculado. Los records no se tocan.');
                        await load();
                    }),
                }));
            }
            handlers.push(h('button', {
                type: 'button', class: 'btn btn--secondary', text: 'Renombrar',
                onclick: () => guarded(async () => {
                    const nn = await ask('Renombrar #' + p.record_name, { label: 'Nuevo nombre (el actual pasa a ser alias)', required: true, confirmText: 'Renombrar', maxLength: 40 });
                    if (!nn) return;
                    await call('rename', { person_id: p.id, new_name: nn });
                    auth.showMessage('Renombrado.');
                    if (window.FrakaProfiles) window.FrakaProfiles.reload();
                    await load();
                }),
            }));
            handlers.push(h('button', {
                type: 'button', class: 'btn btn--secondary', text: 'Añadir alias',
                onclick: () => guarded(async () => {
                    const al = await ask('Alias para #' + p.record_name, { label: 'Alias (así aparece en los JSON)', required: true, confirmText: 'Añadir', maxLength: 40 });
                    if (!al) return;
                    await call('add_alias', { person_id: p.id, alias: al });
                    auth.showMessage('Alias añadido.');
                    if (window.FrakaProfiles) window.FrakaProfiles.reload();
                    await load();
                }),
            }));
            return h('div', { class: 'fp-card' },
                h('div', { class: 'fp-card__title' }, '#' + p.record_name, ' ',
                    badge(p.origin === 'static' ? 'Estático' : 'Cuenta', p.origin),
                    p.claimed ? badge('Vinculado', 'confirmed') : null,
                    acct && acct.status !== 'active' ? badge(acct.status, 'rejected') : null),
                h('div', { class: 'fp-muted', text: (p.lists || []).map((l) => LIST_LABELS[l] || l).join(' + ') + (acct ? ' · ' + who(acct) + ' · rol ' + acct.role : ' · sin cuenta') }),
                p.aliases && p.aliases.length ? h('div', { class: 'fp-chips' }, p.aliases.map((a) => h('span', { class: 'fp-chip', text: a }))) : null,
                h('div', { class: 'fp-actions' }, handlers));
        }

        function draw() {
            const q = norm(search.value);
            const shown = people.filter((p) => !q
                || norm(p.record_name).includes(q)
                || (p.aliases || []).some((a) => norm(a).includes(q))
                || (p.account && (norm(p.account.username).includes(q) || norm(p.account.display_name).includes(q))));
            list.replaceChildren(...(shown.length ? shown.slice(0, 100).map(row) : [h('p', { class: 'fp-muted', text: 'Sin resultados.' })]));
        }
        search.addEventListener('input', draw);
        content.replaceChildren(search, list);
        draw();
    }

    async function renderAudit() {
        const { log } = await call('mod_audit', { limit: 100 });
        if (!log.length) { content.replaceChildren(h('p', { class: 'fp-muted', text: 'Sin actividad registrada.' })); return; }
        content.replaceChildren(h('div', { class: 'fp-list' }, log.map((e) => {
            const d = e.details && typeof e.details === 'object' ? e.details : {};
            const detail = Object.entries(d).map(([k, v]) => k + ': ' + (typeof v === 'object' ? JSON.stringify(v) : v)).join(' · ');
            return h('div', { class: 'fp-card fp-card--soft' },
                h('div', { class: 'fp-card__title', text: ACTION_LABELS[e.action] || e.action }),
                h('div', { class: 'fp-muted fp-small', text: fmtDate(e.at) + ' · actor ' + (e.actor_discord_id || 'sistema') }),
                detail ? h('div', { class: 'fp-muted fp-small', text: detail }) : null);
        })));
    }

    setTab('requests');
}

window.frakaModPanel = { open };
