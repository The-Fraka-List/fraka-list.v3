-- GENERADO por tools/extract-names.js · 33 jugadores
-- Ejecutar DESPUÉS de 01_schema.sql, en Supabase → SQL Editor.
-- Es seguro repetirlo: lo que ya existe no se duplica ni se modifica.
do $$
declare r record; pid uuid; l text;
begin
  for r in
    select * from jsonb_to_recordset($seed$[{"n":"Aku","l":["main"]},{"n":"AleezCourtz","l":["main"]},{"n":"Ares","l":["main"]},{"n":"AssassinDarkEXE","l":["main","rising"]},{"n":"Benja_dark","l":["main"]},{"n":"DGalindo","l":["main"]},{"n":"Dirinrex","l":["main","rising"]},{"n":"Eduh","l":["main"]},{"n":"el_d0c1","l":["main","rising"]},{"n":"elmatigeims","l":["main","rising"]},{"n":"Elnico_gdxd","l":["rising"]},{"n":"Enzo","l":["main"]},{"n":"Fabygamer","l":["main"]},{"n":"Fiumba_47","l":["main"]},{"n":"Flame986","l":["main"]},{"n":"Gilberto_Dash","l":["main","rising"]},{"n":"Hanky","l":["rising"]},{"n":"Hanky_rawr","l":["main"]},{"n":"Juniorlock","l":["main"]},{"n":"Kepta_bb","l":["main"]},{"n":"MegaHackV8","l":["rising"]},{"n":"Mei","l":["rising"]},{"n":"NotSparture","l":["main","rising"]},{"n":"PersonTruzt","l":["rising"]},{"n":"PlayLino","l":["main"]},{"n":"S3b4s506_","l":["main"]},{"n":"Serrod11","l":["main"]},{"n":"Shiku","l":["main","rising"]},{"n":"TheGlaiCat","l":["main"]},{"n":"Toxic","l":["main"]},{"n":"Vlack","l":["main"]},{"n":"Xqvier","l":["main"]},{"n":"xReizer","l":["main"]}]$seed$::jsonb) as x(n text, l text[])
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
