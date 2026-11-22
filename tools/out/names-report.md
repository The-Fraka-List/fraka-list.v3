# Informe de nombres (Fraka List v3)

- Archivos JSON leídos: 234
  - data-lvl → lista "main": 195 archivos
  - fdm-arch → lista "main": 4 archivos
  - data-rising → lista "rising": 35 archivos
- Records con nombre: 455
- Jugadores distintos (nombre normalizado): 33
  - solo en la lista principal: 21
  - solo en Rising: 5
  - en ambas listas: 7

## 1. Variantes del mismo nombre (arreglar en los JSON) (1)
Se tratan como la misma persona, pero conviene unificar la escritura en los archivos. La forma que se siembra es la más frecuente.

- `aleezcourtz` → se sembrará como **AleezCourtz**. Variantes encontradas: "AleezCourtz" ×42, "AleezCourtz " ×2

## 2. Nombres presentes en las DOS listas (se tratarán como la misma persona) (7)
Con nombre global, un mismo nombre en main y Rising es una sola persona. Si alguno fuera una persona distinta, avísame.

- **AssassinDarkEXE** (data-lvl/Acu.json, data-lvl/Cataclysm.json, data-rising/Crazy_II.json, data-rising/Penumbra.json, data-rising/Ultimo_Universo.json)
- **Dirinrex** (data-lvl/Prismatic.json, data-rising/Acropolis.json, data-rising/buh.json, data-rising/Gumshot.json, data-rising/MikuMikuMikuMiku.json, data-rising/Multition.json, data-rising/Tendo.json)
- **el_d0c1** (data-lvl/Acu.json, data-lvl/Aftermath.json, data-lvl/Agen_Wida.json, data-lvl/Auditory_breaker.json, data-lvl/Azurite_(Sillow).json, data-lvl/Bloodbath.json, data-lvl/Brutal.json, data-lvl/Cataclysm.json, data-lvl/Cybernetic_Crescent.json, data-lvl/Niwa.json, data-lvl/PanaSonic.json, data-lvl/Phobos.json, data-lvl/Red_World.json, data-lvl/Sakupen_hell.json, data-lvl/Sigma_Interface.json, data-lvl/The_Flawless.json, data-lvl/The_Ultimate_Phase.json, data-lvl/Through_The_Decay.json, data-lvl/xo.json, data-rising/8o.json, data-rising/Night_Terrors.json, data-rising/Thanatophobia.json)
- **elmatigeims** (data-lvl/1330X.json, data-lvl/9Blue.json, data-lvl/Advanced_AirStream.json, data-lvl/Aftermath.json, data-lvl/Black_Flag.json, data-lvl/Carcano.json, data-lvl/Cat_Planet.json, data-lvl/Congregation.json, data-lvl/DMG_CTRL.json, data-lvl/Down_Bass.json, data-lvl/eon.json, data-lvl/GLISTEN.json, data-lvl/Hyper_Paradox.json, data-lvl/KINGSLAYER.json, data-lvl/Manic_Machine.json, data-lvl/Maybe_Possibly_Thing.json, data-lvl/MELTDOWN.json, data-lvl/mizureta.json, data-lvl/Moment.json, data-lvl/Ouroboros_Startpos_2.json, data-lvl/Quantum_Processing.json, data-lvl/RIVERS_OF_NAZARETH.json, data-lvl/Tesseract.json, data-lvl/ZOOOOOOOOOOOOOOOOOOM.json, data-rising/Acropolis.json)
- **Gilberto_Dash** (data-lvl/Acu.json, data-lvl/cerebral hemorrhage.json, data-lvl/Interstellar Entropy.json, data-lvl/Light_Travel.json, data-lvl/lost_love.json, data-lvl/Maybe_Possibly_Thing.json, data-lvl/Misty_Mountains.json, data-lvl/Mystic Bounds.json, data-lvl/Snowfall_Storm.json, data-rising/10.json, data-rising/1929.json, data-rising/buh.json, data-rising/damage.json, data-rising/Gregory.json, data-rising/interestelar_infant.json, data-rising/leyak.json, data-rising/lmao.json, data-rising/magma_bound.json, data-rising/SFW.json)
- **NotSparture** (data-lvl/9Blue.json, data-lvl/Crowd_Control.json, data-lvl/GLISTEN.json, data-lvl/Liz.json, data-lvl/LOOSE_ENDS.json, data-lvl/Niwa.json, data-lvl/Precipitance.json, data-lvl/RIVERS_OF_NAZARETH.json, data-lvl/ROW.json, data-lvl/Without_U.json, data-rising/leyak.json)
- **Shiku** (data-lvl/Athanatos.json, data-lvl/Bloodbath.json, data-lvl/Cataclysm.json, data-lvl/Retention.json, data-lvl/The_Flawless.json, data-lvl/The_Ultimate_Phase.json, data-rising/Colorful_Overnight.json, data-rising/Exploring_Space.json, data-rising/ICE_Carbon_Diablo_X.json, data-rising/Necropolis.json, data-rising/Rebellion.json, data-rising/Supersonic.json, data-rising/Ultrasonic.json, data-rising/Ultraviolet.json, data-rising/Windy_landscape.json)

## 3. Nombres que podrían ser la misma persona (revisar a mano) (0)
Son iguales si se quitan guiones bajos, guiones y puntos. NO se unen solos: si son la misma persona, un Mod añadirá el alias.

Ninguno.

## 4. Caracteres que pueden dar problemas en el router o la URL (0)
El router usa #player/<Nombre>; se pasará siempre con encodeURIComponent, pero mejor evitar # / ? % en los nombres.

Ninguno.

## 5. Nombres demasiado largos (más de 40) · NO se siembran (0)

Ninguno.

## 6. Records con "user" vacío o en blanco · se ignoran (0)

Ninguno.

## 7. Archivos que no se pudieron leer (0)

Ninguno.

## 8. Archivos sin ningún record con "user" (¿otra estructura?) (4)
Pueden ser normales (nivel sin records). Si alguno debería tener records, avísame para ajustar el script.

- fdm-arch/agosto_2026.json (main)
- fdm-arch/julio-2026.json (main)
- fdm-arch/junio-2026.json (main)
- fdm-arch/mayo-2026.json (main)

## 9. Records sin campo "user" de texto (0)

Ninguno.

## 10. Lista completa (nombre · listas · records)

| Nombre | Clave | Listas | Records |
|---|---|---|---|
| Aku | aku | main | 22 |
| AleezCourtz | aleezcourtz | main | 44 |
| Ares | ares | main | 11 |
| AssassinDarkEXE | assassindarkexe | main+rising | 5 |
| Benja_dark | benja_dark | main | 8 |
| DGalindo | dgalindo | main | 4 |
| Dirinrex | dirinrex | main+rising | 7 |
| Eduh | eduh | main | 10 |
| el_d0c1 | el_d0c1 | main+rising | 22 |
| elmatigeims | elmatigeims | main+rising | 25 |
| Elnico_gdxd | elnico_gdxd | rising | 5 |
| Enzo | enzo | main | 8 |
| Fabygamer | fabygamer | main | 5 |
| Fiumba_47 | fiumba_47 | main | 29 |
| Flame986 | flame986 | main | 1 |
| Gilberto_Dash | gilberto_dash | main+rising | 19 |
| Hanky | hanky | rising | 1 |
| Hanky_rawr | hanky_rawr | main | 1 |
| Juniorlock | juniorlock | main | 4 |
| Kepta_bb | kepta_bb | main | 26 |
| MegaHackV8 | megahackv8 | rising | 1 |
| Mei | mei | rising | 2 |
| NotSparture | notsparture | main+rising | 11 |
| PersonTruzt | persontruzt | rising | 1 |
| PlayLino | playlino | main | 9 |
| S3b4s506_ | s3b4s506_ | main | 38 |
| Serrod11 | serrod11 | main | 6 |
| Shiku | shiku | main+rising | 15 |
| TheGlaiCat | theglaicat | main | 39 |
| Toxic | toxic | main | 43 |
| Vlack | vlack | main | 3 |
| Xqvier | xqvier | main | 1 |
| xReizer | xreizer | main | 29 |
