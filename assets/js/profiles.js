// Identidad de jugadores (fase 2). Script CLÁSICO: se carga ANTES de main.js.
// Lee los perfiles públicos de Supabase (vistas public_profiles / public_aliases, solo lectura)
// y expone window.FrakaProfiles para que main.js unifique nombres, alias y perfiles reclamados.
// Si Supabase falla o tarda, la página funciona como antes (nombres tal cual vienen del JSON).
(function () {
    'use strict';

    var LOAD_TIMEOUT_MS = 5000;
    var AVATAR_PREFIX = 'https://cdn.discordapp.com/avatars/';

    // Misma normalización que public.normalize_name en SQL: NFKC + minúsculas + quitar TODO espacio.
    // Los caracteres invisibles se construyen con códigos para no depender de escapes en el archivo.
    var SPACE_CODES = [0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x2060, 0x3000, 0xfeff];
    for (var c = 0x2000; c <= 0x200d; c++) SPACE_CODES.push(c);
    var SPACE_RE = new RegExp('[' + SPACE_CODES.map(function (n) { return String.fromCodePoint(n); }).join('') + ']+', 'g');

    function normalize(value) {
        if (value === null || value === undefined) return '';
        return String(value).normalize('NFKC').toLowerCase().replace(SPACE_RE, '');
    }

    var state = {
        loaded: false,
        byKeyList: new Map(),   // 'main|hank' → fila
        byKey: new Map(),       // 'hank' → primera fila (cualquier lista)
        aliases: new Map(),     // alias_key → name_key
    };

    function build(profiles, aliases) {
        var byKeyList = new Map();
        var byKey = new Map();
        var aliasMap = new Map();
        (profiles || []).forEach(function (p) {
            if (!p || !p.name_key || !p.record_name) return;
            var row = {
                list: p.list,
                recordName: String(p.record_name),
                key: String(p.name_key),
                claimed: !!p.claimed,
                visible: p.visible !== false,
                displayName: p.display_name ? String(p.display_name) : null,
                discordUsername: p.discord_username ? String(p.discord_username) : null,
                avatarUrl: typeof p.avatar_url === 'string' && p.avatar_url.indexOf(AVATAR_PREFIX) === 0 ? p.avatar_url : null,
            };
            byKeyList.set(row.list + '|' + row.key, row);
            if (!byKey.has(row.key)) byKey.set(row.key, row);
        });
        (aliases || []).forEach(function (a) {
            if (a && a.alias_key && a.name_key) aliasMap.set(String(a.alias_key), String(a.name_key));
        });
        state.byKeyList = byKeyList;
        state.byKey = byKey;
        state.aliases = aliasMap;
        state.loaded = true;
    }

    function listCode(list) {
        return list === 'rising' ? 'rising' : 'main';
    }

    function resolveKey(raw) {
        var k = normalize(raw);
        if (!k) return '';
        if (state.aliases.has(k)) k = state.aliases.get(k);
        return state.byKey.has(k) ? k : '';
    }

    // Devuelve null si no hay nombre. Para nombres no registrados, comportamiento anterior (texto recortado).
    function identify(raw, list) {
        var trimmed = raw === null || raw === undefined ? '' : String(raw).trim();
        if (!trimmed) return null;
        var key = resolveKey(trimmed);
        if (!key) {
            return {
                key: trimmed, name: trimmed, displayName: trimmed, discordUsername: null, avatarUrl: null,
                claimed: false, hidden: false, known: false, recordName: trimmed,
            };
        }
        var any = state.byKey.get(key);
        var own = list ? state.byKeyList.get(listCode(list) + '|' + key) : null;
        var shown = own && own.claimed ? own : (any.claimed ? any : (own || any));
        var visibleShown = shown.visible;
        return {
            key: 'k:' + key,
            name: any.recordName,
            displayName: shown.claimed && visibleShown && shown.displayName ? shown.displayName : any.recordName,
            discordUsername: shown.claimed && visibleShown ? shown.discordUsername : null,
            avatarUrl: shown.claimed && visibleShown ? shown.avatarUrl : null,
            claimed: !!(shown.claimed && visibleShown),
            hidden: !any.visible || (own ? !own.visible : false), // la visibilidad depende de la cuenta: oculta en ambas listas
            known: true,
            recordName: any.recordName,
        };
    }

    function canonicalName(raw) {
        var id = identify(raw);
        return id ? id.name : '';
    }

    function sameName(a, b) {
        var ia = identify(a), ib = identify(b);
        return !!ia && !!ib && ia.key === ib.key;
    }

    function isHidden(raw, list) {
        var id = identify(raw, list);
        return !!id && id.hidden;
    }

    var api = {
        loaded: false,
        ready: null,
        normalize: normalize,
        identify: identify,
        canonicalName: canonicalName,
        sameName: sameName,
        isHidden: isHidden,
        _build: build,
    };

    function fetchJson(url, headers, signal) {
        return fetch(url, { headers: headers, signal: signal }).then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
        });
    }

    function load() {
        var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, LOAD_TIMEOUT_MS) : null;
        return import('./supabase-config.js').then(function (cfg) {
            var headers = { apikey: cfg.SUPABASE_PUBLISHABLE_KEY };
            var base = cfg.SUPABASE_URL + '/rest/v1/';
            var signal = ctrl ? ctrl.signal : undefined;
            return Promise.all([
                fetchJson(base + 'public_profiles?select=list,record_name,name_key,claimed,visible,display_name,discord_username,avatar_url', headers, signal),
                fetchJson(base + 'public_aliases?select=alias_key,name_key', headers, signal),
            ]);
        }).then(function (res) {
            build(res[0], res[1]);
            api.loaded = true;
        }).catch(function (err) {
            console.warn('Perfiles no disponibles; se usan los nombres tal cual vienen de los JSON.', err);
        }).then(function () {
            if (timer) clearTimeout(timer);
        });
    }

    api.reload = function () {
        api.ready = load();
        return api.ready;
    };
    api.ready = load();

    window.FrakaProfiles = api;
})();
