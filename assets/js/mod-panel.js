// Panel de Mods (fase 2). Módulo ES. Abre con window.frakaModPanel.open().
// Es solo una vista: cada acción la valida la Edge Function (rol Mod comprobado en vivo con Discord).
import { h, fmtDate, fmtRemaining, errorText, openModal, ask, badge } from './fp-ui.js';
import { recordSnippet, levelPath, openGeneratorFor, levelFileObject, copyText, statusBadge, listLabel } from './records.js';

const LIST_LABELS = { main: 'Lista', rising: 'Rising' };
const ACTION_LABELS = {
    person_created: 'Persona creada', claim_requested: 'Petición enviada', claim_approved: 'Petición aprobada',
    claim_rejected: 'Petición rechazada', claim_cancelled: 'Petición cancelada', claim_confirmed: 'Vinculación confirmada',
    unlink: 'Desvinculado', renamed: 'Renombrado', alias_added: 'Alias añadido',
    record_submitted: 'Record enviado', record_cancelled: 'Envío cancelado',
    record_approved: 'Record aprobado', record_rejected: 'Record rechazado',
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

    const tabs = { requests: 'Peticiones', records: 'Records', people: 'Personas', audit: 'Historial' };
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
            else if (current === 'records') await renderRecords();
            else if (current === 'people') await renderPeople();
            else await renderAudit();
        } catch (e) {
            content.replaceChildren(h('div', { class: 'fp-error', text: errorText(e) }));
        }
    }

    async function renderRequests() {
        const { requests } = await call('mod_requests'); if (current !== 'requests') return;
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

    // ── Records (fase 3) ─────────────────────────────────────────────────────
    let showClosed = false;

    function setRecordsBadge(n) {
        const btn = nav.querySelector('[data-tab="records"]');
        if (btn) btn.textContent = 'Records' + (n > 0 ? ' (' + n + ')' : '');
    }

    function levelInfo(r) {
        const data = window.frakaData && window.frakaData.getLevels && window.frakaData.getLevels();
        const arr = (data && data[r.list]) || [];
        const stem = (lvl) => String(lvl._file || '').split('/').pop().replace(/\.json$/i, '');
        return {
            loaded: arr.length > 0,
            byFile: arr.find((l) => stem(l).toLowerCase() === String(r.level_file).toLowerCase()) || null,
            byId: r.kind === 'new' && r.level_data ? arr.find((l) => String(l.id) === String(r.level_data.id)) || null : null,
        };
    }

    function snippetBox(r) {
        const code = h('pre', { class: 'fp-code', text: recordSnippet(r) });
        const status = h('span', { class: 'fp-muted fp-small' });
        const btn = h('button', {
            type: 'button', class: 'btn btn--secondary', text: 'Copiar bloque',
            onclick: async () => { status.textContent = (await copyText(recordSnippet(r))) ? 'Copiado.' : 'No se pudo copiar, selecciónalo a mano.'; },
        });
        return h('div', { class: 'fp-card fp-card--soft' },
            h('div', { class: 'fp-muted', text: 'Añade este bloque al final de "records" en ' + levelPath(r) + ' (con una coma tras el bloque anterior):' }),
            code, h('div', { class: 'fp-actions fp-actions--left' }, btn, status));
    }

    function showApprovedModal(r) {
        const mm = openModal('Record aprobado');
        mm.body.append(
            h('p', { class: 'fp-muted', text: 'Aprobado no significa publicado: no aparecerá en la web hasta que subas el archivo al repo.' }),
            snippetBox(r));
    }

    function newLevelBox(r, win) {
        const d = r.level_data || {};
        const status = h('span', { class: 'fp-muted fp-small' });
        const open = () => {
            const w = window.open('about:blank', '_blank');
            if (!openGeneratorFor(r, w)) status.textContent = 'No se pudo abrir el generador. Usa "Copiar JSON del nivel".';
        };
        return h('div', { class: 'fp-card fp-card--soft' },
            h('div', { class: 'fp-muted', text: 'Archivo: ' + levelPath(r) + ' (y añadirlo a _list.json en el puesto que corresponda).' }),
            h('div', { class: 'fp-actions fp-actions--left' },
                h('button', { type: 'button', class: 'btn btn--secondary', text: 'Abrir en el generador', onclick: open }),
                h('button', {
                    type: 'button', class: 'btn btn--secondary', text: 'Copiar JSON del nivel',
                    onclick: async () => { status.textContent = (await copyText(JSON.stringify(levelFileObject(r), null, 4))) ? 'Copiado.' : 'No se pudo copiar.'; },
                }), status));
    }

    function recordDetails(r) {
        const info = levelInfo(r);
        const nodes = [];
        if (r.kind === 'existing') {
            nodes.push(h('div', { class: 'fp-muted', text: 'Record: ' + r.percent + '% · ' + r.hz + ' Hz' }));
            if (info.loaded && !info.byFile) nodes.push(h('div', { class: 'fp-error', text: 'Ese nivel no existe en ' + listLabel(r.list) + ': revisa el nombre de archivo.' }));
            const fp = window.FrakaProfiles;
            if (info.byFile && fp && (info.byFile.records || []).some((x) => fp.sameName(x.user, r.user_name))) {
                nodes.push(h('div', { class: 'fp-muted fp-small', text: 'Aviso: esta persona ya tiene un record en ese nivel.' }));
            }
        } else {
            const d = r.level_data || {};
            nodes.push(h('div', { class: 'fp-muted', text: 'Nivel nuevo: ' + d.name + ' · ID ' + d.id + ' · autor ' + d.author }));
            nodes.push(h('div', { class: 'fp-muted', text: 'Creators: ' + (d.creators || []).join(', ') + ' · verificador: ' + d.verifier }));
            nodes.push(h('div', { class: 'fp-muted', text: '% para calificar: ' + d.percentToQualify + ' · contraseña: ' + (d.password || '—') + ' · record: ' + r.percent + '% · ' + r.hz + ' Hz' }));
            if (info.byId) nodes.push(h('div', { class: 'fp-error', text: 'Ya existe un nivel con ese ID en ' + listLabel(r.list) + ': ' + info.byId.name + '.' }));
            if (info.byFile) nodes.push(h('div', { class: 'fp-error', text: 'Ya existe un archivo con ese nombre en ' + listLabel(r.list) + '.' }));
        }
        if (/^https:\/\/\S+$/.test(r.link || '')) nodes.push(h('a', { class: 'fp-link', href: r.link, target: '_blank', rel: 'noopener noreferrer', text: r.kind === 'new' ? 'Ver video de verificación' : 'Ver video del record' }));
        if (r.note) nodes.push(h('blockquote', { class: 'fp-quote', text: r.note }));
        return nodes;
    }

    async function renderRecords() {
        const data = await call('mod_records', { include_closed: showClosed }); if (current !== 'records') return;
        setRecordsBadge(data.pending_count);
        const toggle = h('input', { type: 'checkbox', checked: showClosed || null });
        toggle.addEventListener('change', () => { showClosed = toggle.checked; load(); });
        const toolbar = h('label', { class: 'fp-radio' }, toggle, h('span', { text: 'Mostrar resueltos' }));
        if (!data.records.length) {
            content.replaceChildren(toolbar, h('p', { class: 'fp-muted', text: showClosed ? 'No hay envíos.' : 'No hay envíos por revisar.' }));
            return;
        }
        const guardedReload = (fn) => guarded(async () => { await fn(); await load(); });

        content.replaceChildren(toolbar, ...data.records.map((r) => {
            const open = r.status === 'pending' || r.status === 'in_review';
            const card = h('div', { class: 'fp-card' },
                h('div', { class: 'fp-card__title' }, r.level_file, ' ', badge(listLabel(r.list)),
                    badge(r.kind === 'new' ? 'Nivel nuevo' : 'Record nuevo'), statusBadge(r.status),
                    r.mine ? badge('Tuyo') : null, r.self_review ? badge('Autoaprobado') : null),
                h('div', { class: 'fp-muted', text: 'Envía: ' + who(r.submitter) + ' · rol ' + ((r.submitter && r.submitter.role) || '?') + ' · se registrará como #' + r.user_name }),
                h('div', { class: 'fp-muted fp-small', text: 'Enviado ' + fmtDate(r.created_at) + (open ? ' · caduca en ' + fmtRemaining(r.expires_at) : '') }),
                r.review_note ? h('div', { class: 'fp-muted fp-small', text: 'Nota de revisión: ' + r.review_note }) : null);

            if (r.status === 'pending') {
                card.append(h('div', { class: 'fp-actions' }, h('button', {
                    type: 'button', class: 'btn btn--primary', text: 'Revisar',
                    onclick: () => guardedReload(() => call('start_record_review', { record_id: r.id })),
                })));
            } else if (r.status === 'in_review' && !r.locked_by_me) {
                card.append(h('div', { class: 'fp-muted fp-small', text: 'Otro Mod lo está revisando ahora (bloqueo hasta ' + fmtDate(r.review_expires_at) + ').' }));
            } else if (r.status === 'in_review' && r.locked_by_me) {
                card.append(...recordDetails(r));
                if (r.kind === 'existing') card.append(snippetBox(r));
                if (r.mine) card.append(h('div', { class: 'fp-muted fp-small', text: 'Es tu propio envío: si lo apruebas queda marcado como autoaprobado.' }));
                card.append(h('div', { class: 'fp-muted fp-small', text: 'Lo tienes bloqueado para los demás Mods hasta ' + fmtDate(r.review_expires_at) + '.' }));
                card.append(h('div', { class: 'fp-actions' },
                    h('button', {
                        type: 'button', class: 'btn btn--secondary', text: 'Soltar',
                        onclick: () => guardedReload(() => call('release_record_review', { record_id: r.id })),
                    }),
                    h('button', {
                        type: 'button', class: 'btn btn--secondary', text: 'Rechazar',
                        onclick: () => guarded(async () => {
                            const note = await ask('Rechazar envío', { label: 'Motivo del rechazo (lo verá el usuario)', required: true, confirmText: 'Rechazar' });
                            if (note === null) return;
                            await call('finish_record_review', { record_id: r.id, approve: false, note });
                            auth.showMessage('Envío rechazado.');
                            await load();
                        }),
                    }),
                    h('button', {
                        type: 'button', class: 'btn btn--primary', text: 'Aprobar',
                        onclick: () => guarded(async () => {
                            // La pestaña del generador se abre YA (dentro del clic) para que el navegador no la bloquee.
                            const win = r.kind === 'new' ? window.open('about:blank', '_blank') : null;
                            try {
                                await call('finish_record_review', { record_id: r.id, approve: true });
                            } catch (e) {
                                if (win) win.close();
                                throw e;
                            }
                            auth.showMessage('Aprobado. Recuerda: no está publicado hasta que subas el archivo.');
                            if (r.kind === 'new') {
                                if (!openGeneratorFor(r, win)) auth.showMessage('Aprobado, pero no se pudo abrir el generador. Ábrelo desde la pestaña Records con "Mostrar resueltos".');
                            } else {
                                showApprovedModal(r);
                            }
                            await load();
                        }),
                    })));
            } else if (r.status === 'approved') {
                card.append(...recordDetails(r));
                card.append(r.kind === 'new' ? newLevelBox(r) : snippetBox(r));
            }
            return card;
        }));
    }

    async function renderPeople() {
        const { people } = await call('mod_people'); if (current !== 'people') return;
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
        const { log } = await call('mod_audit', { limit: 100 }); if (current !== 'audit') return;
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
    // Contador de pendientes en la pestaña Records desde el principio (si falla, se ignora)
    call('mod_records').then((d) => setRecordsBadge(d.pending_count)).catch(() => {});
}

window.frakaModPanel = { open };