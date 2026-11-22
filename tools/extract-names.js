#!/usr/bin/env node
/*
 * Fraka List v3 · Fase 2 · Bloque 1
 * Lee los JSON de niveles, saca todos los nombres de records[].user y genera:
 *   1) tools/out/names-report.md        informe para REVISAR (variantes, duplicados, rarezas)
 *   2) supabase/sql/02_seed_names.sql   SQL que siembra personas y perfiles
 *
 * Uso (desde la raíz del repo, con Node 18 o superior):
 *   node tools/extract-names.js
 *   node tools/extract-names.js --root ruta/al/repo
 *
 * No necesita instalar nada ni conectarse a internet. No modifica los JSON.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

// ---- CONFIGURACIÓN: qué carpeta alimenta qué lista -----------------------
const SOURCES = [
  { dir: 'data-lvl',    list: 'main'   },
  { dir: 'fdm-arch',    list: 'main'   },   // ← revisa: ¿fdm-arch es de la lista principal (legacy)?
  { dir: 'data-rising', list: 'rising' },
];
const SKIP_FILES = new Set(['_list.json']);
const MAX_NAME = 40;                        // mismo límite que la base de datos
// --------------------------------------------------------------------------

const argRoot = process.argv.indexOf('--root');
const ROOT = path.resolve(argRoot > -1 ? process.argv[argRoot + 1] : process.cwd());

// Normalización idéntica a public.normalize_name() de 01_schema.sql:
// NFKC + minúsculas + quitar TODO espacio (incluye nbsp e invisibles).
const ch = (c) => String.fromCodePoint(c);
const EXTRA = [[0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200d], [0x2028, 0x2029],
               [0x202f, 0x202f], [0x205f, 0x205f], [0x2060, 0x2060], [0x3000, 0x3000], [0xfeff, 0xfeff]];
const WS = new RegExp('[\\s' + EXTRA.map(([a, b]) => (a === b ? ch(a) : ch(a) + '-' + ch(b))).join('') + ']+', 'g');
const BOM = new RegExp('^' + ch(0xfeff));
const normalize = (s) => s.normalize('NFKC').toLowerCase().replace(WS, '');
const display = (s) => s.trim().replace(/\s+/g, ' ');           // forma "bonita" para record_name

function walk(dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (e.isFile() && e.name.toLowerCase().endsWith('.json') && !SKIP_FILES.has(e.name)) out.push(p);
  }
  return out;
}

function collect(node, found, bad) {
  if (Array.isArray(node)) { node.forEach((n) => collect(n, found, bad)); return; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'records' && Array.isArray(v)) {
        for (const r of v) {
          if (r && typeof r === 'object' && typeof r.user === 'string') found.push(r.user);
          else bad.count++;
        }
      }
      collect(v, found, bad);
    }
  }
}

const entries = [];            // { raw, list, file }
const fileStats = [];          // { file, list, records, bad, error }
const notes = [];

for (const src of SOURCES) {
  const dir = path.join(ROOT, src.dir);
  if (!fs.existsSync(dir)) { notes.push(`Carpeta no encontrada (se omite): ${src.dir}`); continue; }
  for (const file of walk(dir)) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8').replace(BOM, '')); }
    catch (e) { fileStats.push({ file: rel, list: src.list, records: 0, bad: 0, error: e.message }); continue; }
    const found = [], bad = { count: 0 };
    collect(data, found, bad);
    found.forEach((raw) => entries.push({ raw, list: src.list, file: rel }));
    fileStats.push({ file: rel, list: src.list, records: found.length, bad: bad.count, error: null });
  }
}

// ---- agrupar por nombre normalizado -------------------------------------
const groups = new Map();      // key → { variants: Map(trimmed→count), rawSeen:Set, lists:Set, files:Set, total }
const empties = [];
for (const e of entries) {
  const key = normalize(e.raw);
  if (!key) { empties.push(e); continue; }
  let g = groups.get(key);
  if (!g) { g = { variants: new Map(), rawSeen: new Set(), lists: new Set(), files: new Set(), total: 0 }; groups.set(key, g); }
  const d = display(e.raw);
  g.variants.set(d, (g.variants.get(d) || 0) + 1);
  g.rawSeen.add(e.raw);
  g.lists.add(e.list);
  g.files.add(e.file);
  g.total++;
}

// Escritura preferida: la más frecuente; si empatan, la que empieza en mayúscula y
// sigue en minúscula ("Kepta"), luego cualquiera con mayúsculas y minúsculas mezcladas,
// y por último orden alfabético simple.
const properCase = (s) => /^\p{Lu}[^\p{Lu}]*$/u.test(s);
const mixedCase = (s) => s !== s.toLowerCase() && s !== s.toUpperCase();
function canonical(g) {
  return [...g.variants.entries()].sort((a, b) =>
    b[1] - a[1] || (properCase(b[0]) - properCase(a[0])) || (mixedCase(b[0]) - mixedCase(a[0])) ||
    (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0][0];
}

const people = [...groups.entries()].map(([key, g]) => ({ key, g, name: canonical(g), lists: [...g.lists].sort() }))
  .sort((a, b) => a.key.localeCompare(b.key));

const tooLong = people.filter((p) => p.name.length > MAX_NAME);
const seedPeople = people.filter((p) => p.name.length <= MAX_NAME);

// ---- avisos ---------------------------------------------------------------
const variants = people.filter((p) => p.g.rawSeen.size > 1);
const bothLists = people.filter((p) => p.lists.length > 1);
const oddChars = people.filter((p) => /[#/\\?%<>"']/.test(p.name));
const stripKey = (k) => k.replace(/[_\-.]/g, '');
const loose = new Map();
for (const p of people) { const s = stripKey(p.key); (loose.get(s) || loose.set(s, []).get(s)).push(p); }
const lookAlike = [...loose.values()].filter((arr) => arr.length > 1);
const noRecords = fileStats.filter((f) => !f.error && f.records === 0);
const broken = fileStats.filter((f) => f.error);
const badRecords = fileStats.filter((f) => f.bad > 0);

// ---- informe ------------------------------------------------------------
const L = [];
L.push('# Informe de nombres (Fraka List v3)');
L.push('');
L.push(`- Archivos JSON leídos: ${fileStats.length}`);
for (const s of SOURCES) L.push(`  - ${s.dir} → lista "${s.list}": ${fileStats.filter((f) => f.file.startsWith(s.dir + '/')).length} archivos`);
L.push(`- Records con nombre: ${entries.length}`);
L.push(`- Jugadores distintos (nombre normalizado): ${people.length}`);
L.push(`  - solo en la lista principal: ${people.filter((p) => p.lists.join() === 'main').length}`);
L.push(`  - solo en Rising: ${people.filter((p) => p.lists.join() === 'rising').length}`);
L.push(`  - en ambas listas: ${bothLists.length}`);
for (const n of notes) L.push(`- AVISO: ${n}`);
L.push('');

const section = (title, items, fmt, help) => {
  L.push(`## ${title} (${items.length})`);
  if (help) L.push(help);
  L.push('');
  if (!items.length) L.push('Ninguno.');
  else items.forEach((i) => L.push(fmt(i)));
  L.push('');
};

section('1. Variantes del mismo nombre (arreglar en los JSON)', variants,
  (p) => `- \`${p.key}\` → se sembrará como **${p.name}**. Variantes encontradas: ` +
    [...p.g.rawSeen].map((r) => JSON.stringify(r) + ' ×' + entries.filter((e) => e.raw === r && normalize(e.raw) === p.key).length).join(', '),
  'Se tratan como la misma persona, pero conviene unificar la escritura en los archivos. La forma que se siembra es la más frecuente.');

section('2. Nombres presentes en las DOS listas (se tratarán como la misma persona)', bothLists,
  (p) => `- **${p.name}** (${[...p.g.files].join(', ')})`,
  'Con nombre global, un mismo nombre en main y Rising es una sola persona. Si alguno fuera una persona distinta, avísame.');

section('3. Nombres que podrían ser la misma persona (revisar a mano)', lookAlike,
  (arr) => '- ' + arr.map((p) => `**${p.name}** (${p.lists.join('+')}, ${p.g.total} records)`).join('  ≟  '),
  'Son iguales si se quitan guiones bajos, guiones y puntos. NO se unen solos: si son la misma persona, un Mod añadirá el alias.');

section('4. Caracteres que pueden dar problemas en el router o la URL', oddChars,
  (p) => `- **${p.name}** (${[...p.g.files].join(', ')})`,
  'El router usa #player/<Nombre>; se pasará siempre con encodeURIComponent, pero mejor evitar # / ? % en los nombres.');

section(`5. Nombres demasiado largos (más de ${MAX_NAME}) · NO se siembran`, tooLong,
  (p) => `- ${JSON.stringify(p.name)} (${[...p.g.files].join(', ')})`);

section('6. Records con "user" vacío o en blanco · se ignoran', empties,
  (e) => `- ${e.file}: ${JSON.stringify(e.raw)}`);

section('7. Archivos que no se pudieron leer', broken, (f) => `- ${f.file}: ${f.error}`);
section('8. Archivos sin ningún record con "user" (¿otra estructura?)', noRecords, (f) => `- ${f.file} (${f.list})`,
  'Pueden ser normales (nivel sin records). Si alguno debería tener records, avísame para ajustar el script.');
section('9. Records sin campo "user" de texto', badRecords, (f) => `- ${f.file}: ${f.bad} records`);

L.push('## 10. Lista completa (nombre · listas · records)');
L.push('');
L.push('| Nombre | Clave | Listas | Records |');
L.push('|---|---|---|---|');
for (const p of people) L.push(`| ${p.name.replace(/\|/g, '\\|')} | ${p.key.replace(/\|/g, '\\|')} | ${p.lists.join('+')} | ${p.g.total} |`);
L.push('');

const outDir = path.join(ROOT, 'tools', 'out');
fs.mkdirSync(outDir, { recursive: true });
const reportPath = path.join(outDir, 'names-report.md');
fs.writeFileSync(reportPath, L.join('\n'), 'utf8');

// ---- SQL de siembra -----------------------------------------------------
const json = JSON.stringify(seedPeople.map((p) => ({ n: p.name, l: p.lists })));
if (json.includes('$seed$')) { console.error('Un nombre contiene "$seed$"; no se puede generar el SQL.'); process.exit(1); }
const sql = `-- GENERADO por tools/extract-names.js · ${seedPeople.length} jugadores
-- Ejecutar DESPUÉS de 01_schema.sql, en Supabase → SQL Editor.
-- Es seguro repetirlo: lo que ya existe no se duplica ni se modifica.
do $$
declare r record; pid uuid; l text;
begin
  for r in
    select * from jsonb_to_recordset($seed$${json}$seed$::jsonb) as x(n text, l text[])
  loop
    insert into public.persons (record_name, origin) values (r.n, 'static')
    on conflict (name_key) do nothing;
    select id into pid from public.persons where name_key = public.normalize_name(r.n);
    if pid is null then
      raise notice 'No se pudo sembrar "%" (choca con un alias)', r.n;
      continue;
    end if;
    foreach l in array r.l loop
      insert into public.profiles (person_id, list, source) values (pid, l, 'static')
      on conflict (person_id, list) do nothing;
    end loop;
  end loop;
end $$;

-- Comprobación: debe mostrar el número de jugadores sembrados
select count(*) as personas, count(*) filter (where origin = 'static') as estaticas from public.persons;
`;
const sqlDir = path.join(ROOT, 'supabase', 'sql');
fs.mkdirSync(sqlDir, { recursive: true });
const sqlPath = path.join(sqlDir, '02_seed_names.sql');
fs.writeFileSync(sqlPath, sql, 'utf8');

// ---- resumen en consola ---------------------------------------------------
console.log(`Archivos leídos: ${fileStats.length} · records: ${entries.length} · jugadores distintos: ${people.length}`);
console.log(`Avisos → variantes: ${variants.length} · en ambas listas: ${bothLists.length} · parecidos: ${lookAlike.length} · caracteres raros: ${oddChars.length} · demasiado largos: ${tooLong.length} · archivos sin records: ${noRecords.length} · archivos rotos: ${broken.length}`);
for (const n of notes) console.log('AVISO:', n);
console.log('Informe :', path.relative(ROOT, reportPath));
console.log('SQL     :', path.relative(ROOT, sqlPath));
