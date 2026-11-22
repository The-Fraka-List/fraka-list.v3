// Modal "Vincular perfil" (fase 2). Módulo ES. Abre con window.frakaClaim.open().
// Toda la lógica de permisos vive en la Edge Function; aquí solo se muestra y se piden acciones.
import { h, fmtDate, fmtRemaining, errorText, openModal, badge } from './fp-ui.js';

const ACTIVE = new Set(['pending', 'approved']);
const STATUS_LABELS = {
    pending: 'Pendiente de aprobación', approved: 'Aprobada: falta tu confirmación', rejected: 'Rechazada',
    confirmed: 'Vinculada', cancelled: 'Cancelada', expired: 'Caducada',
};
const LIST_LABELS = { main: 'Lista', rising: 'Rising' };

function listsText(lists) {
    return (lists || []).map((l) => LIST_LABELS[l] || l).join(' + ');
}

async function open() {
    const auth = window.frakaAuth;
    if (!auth || !auth.getAccount()) return;
    const m = openModal('Vincular perfil');
    const body = m.body;
    let timer = null;
    m.onClose = () => { if (timer) clearInterval(timer); };

    async function render() {
        if (timer) { clearInterval(timer); timer = null; }
        body.replaceChildren(h('p', { class: 'fp-muted', text: 'Cargando…' }));
        let me, claimable = [];
        try {
            me = await auth.refreshMe();
            const active = (me.requests || []).find((r) => ACTIVE.has(r.status));
            if (!active) claimable = (await auth.callProfiles('claimable')).profiles || [];
        } catch (err) {
            body.replaceChildren(h('div', { class: 'fp-error', text: errorText(err) }));
            return;
        }
        const nodes = [];

        // Perfil actual
        const person = me.person;
        const info = h('div', { class: 'fp-card' },
            h('div', { class: 'fp-card__title', text: 'Tu nombre en la lista' }),
            h('div', { class: 'fp-big', text: person ? '#' + person.record_name : '—' }),
            person ? h('div', { class: 'fp-muted', text: (person.origin === 'static' ? 'Perfil vinculado' : 'Perfil automático') + (me.lists && me.lists.length ? ' · ' + listsText(me.lists) : '') }) : null,
            me.aliases && me.aliases.length ? h('div', { class: 'fp-chips' }, me.aliases.map((a) => h('span', { class: 'fp-chip', text: a }))) : null);
        nodes.push(info);

        const requests = me.requests || [];
        const active = requests.find((r) => ACTIVE.has(r.status));

        if (active) {
            const card = h('div', { class: 'fp-card' },
                h('div', { class: 'fp-card__title' }, 'Petición activa ', badge(STATUS_LABELS[active.status] || active.status, active.status)),
                h('div', { class: 'fp-big', text: '#' + active.target_record_name }),
                active.message ? h('div', { class: 'fp-muted', text: 'Tu mensaje: ' + active.message }) : null);
            const err = h('div', { class: 'fp-error', hidden: true });
            const actions = h('div', { class: 'fp-actions' });
            const run = async (action, okMsg, reload) => {
                err.hidden = true;
                actions.querySelectorAll('button').forEach((b) => { b.disabled = true; });
                try {
                    await auth.callProfiles(action, { request_id: active.id });
                    auth.showMessage(okMsg);
                    if (reload) { window.location.reload(); return; }
                    await render();
                } catch (e) {
                    err.hidden = false; err.textContent = errorText(e);
                    actions.querySelectorAll('button').forEach((b) => { b.disabled = false; });
                }
            };
            if (active.status === 'pending') {
                const t = h('div', { class: 'fp-muted' });
                const upd = () => { t.textContent = 'Un Mod debe aprobarla. Caduca en ' + fmtRemaining(active.expires_at) + '.'; };
                upd(); timer = setInterval(upd, 30000);
                card.append(t);
            } else {
                const t = h('div', { class: 'fp-muted' });
                const upd = () => { t.textContent = 'Confirma antes de que pasen 30 min desde la aprobación. Tiempo restante: ' + fmtRemaining(active.approval_expires_at) + '.'; };
                upd(); timer = setInterval(upd, 15000);
                card.append(t);
                actions.append(h('button', { type: 'button', class: 'btn btn--primary', text: 'Confirmar vinculación', onclick: () => run('confirm_claim', 'Perfil vinculado.', true) }));
            }
            actions.append(h('button', { type: 'button', class: 'btn btn--secondary', text: 'Cancelar petición', onclick: () => run('cancel_claim', 'Petición cancelada.', false) }));
            card.append(err, actions);
            nodes.push(card);
        } else {
            const last = requests.find((r) => !ACTIVE.has(r.status));
            if (last && (last.status === 'rejected' || last.status === 'expired' || last.status === 'cancelled')) {
                nodes.push(h('div', { class: 'fp-card fp-card--soft' },
                    h('div', { class: 'fp-card__title' }, 'Última petición ', badge(STATUS_LABELS[last.status] || last.status, last.status)),
                    h('div', { class: 'fp-muted', text: '#' + last.target_record_name + (last.created_at ? ' · ' + fmtDate(last.created_at) : '') }),
                    last.review_note ? h('div', { class: 'fp-muted', text: 'Nota del Mod: ' + last.review_note }) : null));
            }
            if (!claimable.length) {
                nodes.push(h('p', { class: 'fp-muted', text: 'No hay perfiles disponibles para vincular con tu rol.' }));
            } else {
                const select = h('select', { class: 'fp-input', 'aria-label': 'Perfil a vincular' },
                    h('option', { value: '', text: 'Elige tu perfil…' }),
                    claimable.map((p) => h('option', { value: p.name_key, text: p.record_name + ' (' + listsText(p.lists) + ')' })));
                const msg = h('textarea', { class: 'fp-input', rows: '2', maxlength: '300', placeholder: 'Mensaje opcional para el Mod (ej. cómo comprobar que eres tú)' });
                const err = h('div', { class: 'fp-error', hidden: true });
                const send = h('button', { type: 'button', class: 'btn btn--primary', text: 'Enviar petición' });
                send.addEventListener('click', async () => {
                    err.hidden = true;
                    if (!select.value) { err.hidden = false; err.textContent = 'Elige un perfil.'; return; }
                    send.disabled = true;
                    try {
                        await auth.callProfiles('request_claim', { name_key: select.value, message: msg.value.trim() || undefined });
                        auth.showMessage('Petición enviada. Un Mod debe aprobarla.');
                        await render();
                    } catch (e) {
                        err.hidden = false; err.textContent = errorText(e); send.disabled = false;
                    }
                });
                nodes.push(h('div', { class: 'fp-card' },
                    h('div', { class: 'fp-card__title', text: 'Pedir un perfil existente' }),
                    h('p', { class: 'fp-muted', text: 'Solo si ya tienes records en la lista con ese nombre. Un Mod distinto lo revisará.' }),
                    select, msg, err, h('div', { class: 'fp-actions' }, send)));
            }
        }
        body.replaceChildren(...nodes);
    }
    await render();
}

window.frakaClaim = { open };
