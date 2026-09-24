# Motion design de los 20 estilos de Captions.ai: cada movimiento, y el plan para tenerlo aquí (2026-09-24)

Fuente: los previews oficiales de AI Edit (`.refs/captions-ai/*.mp4`, 1080×1920, 24–30 fps, fuera del repo por copyright). Método: hoja general a 4 fps por video para ubicar eventos, y para cada evento una tira a la velocidad real (24 tiles = 1 s) para contar en cuántos frames ocurre cada cosa; los detalles pequeños se confirmaron en frames a resolución completa. Todo tiempo va en segundos del preview y las duraciones en frames (f) del video; 1 f = 42 ms a 24 fps. `[dudoso]` marca lo que no se pudo confirmar en la tira.

La primera parte describe movimiento por movimiento. La segunda es el plan de implementación en reel-agent (qué primitiva, en qué archivo, en qué orden).

---

## Parte 1. Los movimientos, estilo por estilo

### Prism Pro (13.6 s, 24 fps) — verificado frame a frame

Tomas: presentadora en azotea 0–7.2 s, B-roll de oficina 7.2–9.0 s, presentadora 9.0–11.2 s, B-roll de casa en tarjeta 11.2–13.6 s.

Línea de tiempo:
- 0.00–0.20 s — cámara: el video abre con un **desenfoque de zoom radial** (estelas desde el centro) que se resuelve en ~5 f.
- 0.00 s — caption "The" ya en pantalla arriba a la izquierda (blanca, ligera).
- 0.17–0.33 s — "Biggest" entra en ~4 f: fundido de gris a blanco, sin desplazamiento apreciable (≤ 4 px [dudoso]).
- 0.46–0.70 s — palabra clave "Mistake" (bold itálica, 1.5×, degradado): entra **fantasma** (≈40 % de opacidad, más oscura) y en ~6 f sube a 100 % mientras un **brillo recorre el degradado de izquierda a derecha**; escala casi fija (0.95→1 [dudoso]). Se queda.
- 1.00 s — la página anterior sale por **corte seco** (≤ 1 f) y "First-Time" aparece sola arriba a la derecha, grande, en degradado dorado-oliva: es la misma rampa metálica pero la palabra muestra otro tramo (el degradado cruza el bloque entero en diagonal, no cada palabra).
- 1.50–1.70 s — "Homebuyers" entra debajo, alineada a la derecha, fundido de 4–5 f.
- 2.9–3.1 s — **focus pull**: el metraje se desenfoca (≈20 px) en ~4 f; "Only" aparece sola, enorme (≈200 px), entra con el brillo; el desenfoque se mantiene toda la página ("On" entra debajo sin cambio) y sigue en la siguiente ("The Price").
- 6.3–7.2 s — página "What You Should / Really Be Paying / Attention To" construida palabra a palabra sobre la presentadora; "Attention" (clave) entra fantasma + brillo.
- 8.96–9.13 s — **whip de salida**: el B-roll recibe un desenfoque direccional diagonal (~60°, hacia arriba-derecha) que crece durante 4 f; el caption sigue nítido 2 f y luego corta.
- 9.13–9.42 s — **whip de entrada**: la presentadora llega desenfocada y a ≈1.3×, y en ~6 f se asienta a 1.0 y nítida. La nueva página ("The Building") ya está desde el primer frame, con "Building" fantasma.
- 11.2 s — el B-roll de la casa entra como **tarjeta cuadrada** sobre el fondo desenfocado (la presentadora desenfocada detrás); la tarjeta llega con un ligero escalado [dudoso] y se queda; el caption baja a la esquina inferior izquierda.

Movimientos:
- **Palabra normal** (caption): fundido 4 f (~170 ms), ease-out, sin pop. Sincronía: en su onset. Se queda hasta el corte de página.
- **Palabra clave**: opacidad 0.4→1 en 6 f (~250 ms) + brillo que barre el degradado (el punto claro se mueve de izquierda a derecha en esos 6 f), escala fija. Tipografía: bold itálica 1.5×; héroe (tier 2) ≈ 3×.
- **Página**: entra con su primera palabra (sin animación de bloque); sale por corte cuando empieza la siguiente; posición cambia por página (arriba-izq, arriba-der, abajo-izq, abajo-centro) y la alineación sigue a la posición.
- **Focus pull**: blur del metraje 0→≈20 px en 4 f, se mantiene mientras dure la página héroe (y la siguiente si es continuación), vuelve en ~5 f.
- **Whip entre tomas**: 4 f de salida (blur direccional creciente, sin desplazamiento apreciable) + 6 f de entrada (blur decreciente, escala 1.3→1.0); el caption de la toma saliente se mantiene 2 f sobre el blur.
- **Apertura**: zoom blur radial 5 f al primer frame del video.
- **Tarjeta de B-roll**: cuadrada, centrada, esquinas rectas, sombra suave, sobre el fondo desenfocado; se queda estática (sin Ken Burns apreciable).

Firma: tipografía ligera que se construye palabra a palabra con una palabra clave metálica que "brilla" al llegar, y el focus pull que aísla la palabra héroe.

Contraste con la pasada independiente del agente sobre el mismo video: coincide en los fundidos de 3–6 f sin escala de las palabras clave, en el whip diagonal (≈11 f en total) y en el aterrizaje largo de la tarjeta; añade que en las claves oliva la banda cromada sigue derivando lentamente mientras la palabra vive [dudoso] y que la página de "Only / The Price" mantiene el desenfoque de 3.05 a 5.33 s.

### Paper II

Duración 8.08 s, 25 fps (202 frames), 1080×1920. Dos tomas: presentadora (t=0.00–6.96) y B-roll de dos personas en un sofá (t=7.04–8.08), unidas por una sola transición de papel de periódico rasgado (t=6.68–7.32). Un frame = 40 ms.

Tiras usadas: `paper-ii-A-titulo.jpg` (0.00–1.00), `B-pagina-kids` (0.80–1.80), `C-titulo-out-stickers` (2.00–3.00), `D-sit-next` (3.30–4.30), `E-stickers-out` (4.10–5.10), `G-small-talk` (5.40–6.40), `F-paper-tear` (6.60–7.60); detalles a resolución alta: `paper-ii-full-labels.jpg`, `full-pill-in`, `full-stickers`, `full-stickers-out`, `full-3.50`.

#### Línea de tiempo
- t=0.00–0.24 s — presentadora sola, sin caption. Todo el cuadro lleva una trama de puntos (halftone) estática, tipo impresión en papel.
- t=0.24–0.32 s — caption "Parallel play": fade-in de la píldora blanca (2 frames), sin escala. "Parallel" oscuro, "play" gris.
- t=0.40–0.56 s — papel azul arrugado con borde rasgado entra por la esquina superior derecha y se asienta cubriendo el ~25 % superior.
- t=0.44–0.52 s — etiqueta negra "PRESENCE": typewriter con la caja creciendo (3 frames).
- t=0.56–0.76 s — etiqueta "WITHOUT PRESSURE": typewriter (6 frames).
- t=0.64 s — karaoke: "play" pasa de gris a oscuro (1 frame).
- t=0.88–0.96 s — cambio de página a "isn't just for kids" (crossfade 2–3 frames). Karaoke: "just" 1.20, "for" 1.40, "kids" 1.52.
- t=2.04–2.12 s — página "It works for"; karaoke "works" ~2.16, "for" ~2.36.
- t=2.28–2.36 s — el papel azul con sus etiquetas sale deslizando hacia arriba (3 frames).
- t=2.44–2.48 s — página "adults too".
- t=2.52–3.00 s — stickers: bolitas de papel arrugado aparecen junto a la cabeza, viajan hacia afuera y se desarrugan en taza rosa (arriba-izq), máquina de escribir (izq) y reloj (der); círculo teal crece detrás de la cabeza (2.68–2.90).
- t=3.42 s — "adults too" sale (corte); sin caption 3.42–3.58.
- t=3.58–3.66 s — página "Sit next to someone"; karaoke "next" ~3.78, "to" ~3.90, "someone" ~4.06.
- t=4.26–4.30 s — página "and just do"; "just" ~4.38, "do" 4.58.
- t=4.50–4.62 s — stickers y círculo se encogen hacia la cabeza y desaparecen (4 frames).
- t=4.62–4.66 s — página "your own thing"; "own" ~4.82, "thing" ~5.30.
- t=5.44–5.48 s — página "No small talk"; "small" ~5.68, "talk" 5.92.
- t=6.28–6.36 s — página "just quiet company"; "quiet" ~6.50, "company" ~6.92.
- t=6.68–6.92 s — periódico rasgado cubre el cuadro desde abajo-izquierda (7 frames).
- t=6.92–7.04 s — cuadro cubierto por dos capas de periódico (3–4 frames).
- t=7.04–7.32 s — el periódico se retira hacia arriba-izquierda y descubre el B-roll del sofá desde abajo-derecha (7 frames).
- t=7.36–7.40 s — la píldora "just quiet company" sale (corte).
- t=7.40–8.08 s — B-roll del sofá sin caption, estático.

#### Movimientos

##### Entrada de caption en píldora (t=0.24–0.32 s; tira A f6–f8; detalle `full-pill-in`)
- Elemento: caption (frase) — píldora blanca de esquinas redondeadas con texto bold oscuro.
- Entrada: fade, 2 frames (80 ms), lineal; sin escala ni deslizamiento (la píldora ya está en su tamaño y posición finales en el primer frame semitransparente).
- Vida: estática, anclada a ~75 % de la altura (~y 1440 px); karaoke por color (ver abajo).
- Salida: sustituida por la página siguiente con crossfade de 2–3 frames (la píldora nueva aparece fantasma mientras la vieja se va); la última página (7.36–7.40) sale por corte.
- Sincronía: con la primera palabra hablada de cada frase.
- Capas: delante de la persona.
- Tipografía: sans geométrica bold (tipo Poppins); palabras no dichas en gris claro, dichas en gris oscuro; ningún cambio de tamaño.

##### Karaoke por color (t=0.64, 1.20, 1.40, 1.52, 2.16, 2.36, 3.78, 3.90, 4.06, 4.38, 4.58, 4.82, 5.30, 5.68, 5.92, 6.50, 6.92 s; tiras B, C, D, E, G)
- Elemento: palabra clave dentro del caption.
- Entrada: cambio de color gris → oscuro en 1 frame, sin escala, sin resaltado de fondo.
- Vida: se queda oscura hasta el cambio de página.
- Salida: con la página.
- Sincronía: con la palabra hablada.
- Capas: sobre la píldora.

##### Papel azul rasgado (título) — entrada (t=0.40–0.56 s; tira A f10–f14)
- Elemento: título / marco (fondo del título).
- Entrada: deslizamiento diagonal desde la esquina superior derecha, ~4 frames (160 ms), ease-out (cubre mucho en f10–f12 y luego se frena); el borde rasgado blanco queda a ~25 % de la altura. Recorrido estimado ~400 px [dudoso].
- Vida: estático (pequeña deriva de 1–2 frames tras asentarse).
- Salida: t=2.28–2.36 s, deslizamiento hacia arriba, 3 frames (120 ms), ease-in; se lleva las dos etiquetas.
- Sincronía: independiente del habla; entra justo después del primer caption.
- Capas: delante de la persona (cubre el pelo).
- Textura: papel azul arrugado con borde rasgado blanco.

##### Etiquetas typewriter "PRESENCE" / "WITHOUT PRESSURE" (t=0.44–0.52 y 0.56–0.76 s; detalle `full-labels`)
- Elemento: título (dos etiquetas).
- Entrada: typewriter con caja: el rectángulo negro nace con el ancho de la primera letra y crece letra a letra; ~2–3 caracteres por frame (60–75 caracteres/s). "PRESENCE" (8 letras) en 3 frames (120 ms); "WITHOUT PRESSURE" (16 letras) en 6 frames (240 ms). Sin easing apreciable (ritmo constante).
- Vida: estáticas, giradas ~-3° y ~+2°, con un filo amarillo-verde en un lado.
- Salida: con el papel (2.28–2.36).
- Sincronía: independiente del habla.
- Capas: sobre el papel azul.
- Tipografía: monoespaciada blanca en mayúsculas con tracking amplio, sobre negro.

##### Stickers que se desarrugan (t=2.52–3.00 s; tira C f13–f24; detalle `full-stickers`)
- Elemento: sticker (×3) + fondo (círculo teal).
- Entrada: cada sticker nace como una bolita de papel arrugado (~80 px) pegada a la cabeza, viaja hacia afuera (~150–250 px) mientras escala ~0.15→1.0 y se desarruga hasta mostrar el objeto (taza rosa, máquina de escribir menta, reloj). Escalonado: izquierda y derecha desde 2.52, taza desde ~2.72. Duración ~10–12 frames (400–480 ms) cada uno, ease-out (los primeros frames recorren más). Círculo teal detrás de la cabeza: escala desde 0 entre 2.68 y ~2.90 (5–6 frames), ease-out.
- Vida: estáticos (sin wiggle visible a 4 fps ni en la tira D).
- Salida: t=4.50–4.62 s, escala inversa hacia la cabeza (se encogen y se acercan a ella), 4 frames (160 ms), ease-in; el círculo se encoge a la vez.
- Sincronía: entran con "adults too" (2.44) y salen antes de "your own thing" (4.62); no coinciden con palabra concreta.
- Capas: círculo teal detrás de la persona (el pelo lo tapa); stickers delante del fondo y a los lados de la cara, sin cruzar el rostro; la taza roza el pelo [dudoso si va delante o detrás del pelo].
- Look: recorte de papel con borde blanco y sombra leve.

##### Transición de periódico rasgado (t=6.68–7.32 s; tira F f2–f18)
- Elemento: transición.
- Entrada: papel de periódico con borde rasgado entra por la esquina inferior izquierda y barre en diagonal hacia arriba-derecha, 7 frames (280 ms), lineal; a f7 (6.88) entra una segunda pieza por arriba-derecha.
- Vida: cuadro cubierto 3–4 frames (6.92–7.04) por dos capas de periódico de texturas distintas.
- Salida: la pieza principal se retira hacia arriba-izquierda y descubre el B-roll desde abajo-derecha, 7 frames (7.04–7.32, 280 ms), lineal. Total ≈ 16 frames (640 ms).
- Sincronía: con el corte de toma; la píldora "just quiet company" permanece fija encima toda la transición.
- Capas: por encima de ambas tomas, por debajo del caption.

#### Transiciones entre tomas
- t=6.68–7.32 s: papel rasgado (periódico), 16 frames, dirección de cobertura abajo-izq → arriba-der y de descubrimiento arriba-izq → abajo-der; sin escala en ninguna de las dos tomas.

#### Cámara
- Ninguno: sin punch-in ni zoom en la presentadora (encuadre idéntico a t=1.0, 2.4 y 5.0). B-roll del sofá estático (7.40–8.08) [dudoso: si hay zoom, es < 2 %].

#### Firma del estilo
Collage de papel: título en papel azul rasgado con etiquetas typewriter, stickers recortados que llegan como bolitas de papel y se desarrugan, y una transición de periódico rasgado. Los captions son píldoras tranquilas con karaoke solo de color.

### Prime

Duración 11.04 s, 24 fps (265 frames), 1080×1920. Cinco segmentos: presentador (t=0.00–3.06), tarjeta de B-roll de montaña (t=3.31–4.77), presentador (t=5.18–8.78), tarjeta de título "GROWTH" (t=8.99–9.98) y presentador (t=10.14–11.04). Cuatro transiciones: spin-blur con flash blanco (3.06–3.31), spin-blur con flash blanco (4.77–5.18), desenfoque + título deslizante (8.78–9.16) y desenfoque cruzado (9.98–10.14). Un frame = 41.7 ms.

Tiras usadas: `prime-A-blurin-frame.jpg` (0.00–1.00), `B-progress-means` (0.90–1.90), `C-pushing-harder` (2.10–3.10), `D-to-broll` (2.85–3.85), `E-spin-noticing` (4.60–5.60), `F-panels` (5.80–6.80), `G-growth` (8.70–9.70), `H-back-starts` (9.90–10.90); detalles: `prime-full-0.30.jpg`, `full-3.60`, `full-6.30`, `full-9.40`.

#### Línea de tiempo
- t=0.00–0.25 s — presentador entra con blur-in gaussiano (fuerte → nítido en ~6 frames).
- t=0.125–0.17 s — caption "We're" fade-in (2 frames); "taught" gris → blanco ~0.42.
- t=0.21–0.29 s — marco neón cian se dibuja alrededor de la cabeza (3 frames), inclinado ~10°.
- t=0.50 s — "that"; t=0.67 — "that progress".
- t=0.67–0.96 s — título "Progress" (script cursiva cian con glow) se revela de izquierda a derecha (8 frames).
- t=0.67–2.14 s — marco neón muestra una segunda línea que sigue a la primera (estela) y oscila de rotación.
- t=0.96–2.10 s — el título crece de forma continua (~1.0 → 1.3×) y desborda el cuadro por ambos lados.
- t=1.15–1.19 s — "means" en énfasis (bold, ~1.4× el tamaño del caption), fade 2 frames.
- t=1.48 s — "doing"; t=1.86 — "doing more,".
- t=2.10–2.31 s — título "Progress" se desvanece (6 frames).
- t=2.18 s — marco neón desaparece (corte) [dudoso: fade ≤ 2 frames].
- t=2.31–2.39 s — "pushing" en script cursiva cian, fade 2–3 frames.
- t=2.68 s — hueco sin caption (1 frame); t=2.72–2.77 — "harder." fade 2 frames.
- t=3.06–3.31 s — spin-blur (desenfoque rotacional centrado en la cara) con flash blanco en 3.14–3.23; el B-roll entra ya girando dentro de una tarjeta.
- t=3.31 s — "But"; 3.39 "But what"; 3.52 "if"; 3.68 "if it's"; 3.77 "about".
- t=3.475–~4.70 s — un trazo de luz cian recorre el borde de la tarjeta.
- t=4.25 s — "slowing" (cian cursiva); t=4.50 — "down".
- t=4.77–5.18 s — spin-blur de vuelta al presentador (10–11 frames) con pico blanco 4.81–4.98; "and" aparece a 4.85 en pleno remolino y "noticing" a 5.02.
- t=5.56–5.60 s — "more?" (bold blanco).
- t=5.84–6.10 s — carrusel de 3 paneles aparece en la mitad inferior: el central por fade, los laterales se expanden desde él.
- t=6.14 s — "That"; t=6.35 — "That shift".
- t=6.55–6.59 s — el carrusel avanza un paso con motion blur horizontal (2 frames).
- t=7.25 s — "self-judgment" (cian cursiva); t≈8.00 — los paneles desaparecen [dudoso, visto a 4 fps].
- t=8.25 s — "self-compassion".
- t=8.78–8.95 s — presentador se desenfoca y oscurece (5 frames).
- t=8.91–9.16 s — "GROWTH" cian entra desde la derecha con motion blur horizontal (6 frames) sobre un fondo teal oscuro con "GROWTH" en outline repetido en perspectiva.
- t=9.12 s — caption anterior sale; 9.16 "is"; 9.32 "is what"; 9.53 "real"; ~9.75 "real growth".
- t=9.16–9.98 s — "GROWTH" deriva lentamente de escala (crece) [dudoso].
- t=9.98–10.14 s — desenfoque cruzado al presentador (5 frames); 10.02 "starts"; 10.31 "starts to"; 10.40 "look"; 10.61 "like.".
- t=10.65–11.04 s — hold.

#### Movimientos

##### Blur-in de apertura (t=0.00–0.25 s; tira A f0–f5)
- Elemento: cámara / fondo (toda la toma).
- Entrada: blur-in gaussiano, ~6 frames (250 ms), ease-out (el desenfoque baja rápido y remata suave); desenfoque estimado ~25 px → 0; sin escala apreciable.
- Vida: nítido.
- Salida: no aplica.
- Sincronía: independiente.

##### Caption base (t=0.125 s en adelante; tiras A–H)
- Elemento: caption (frase corta, 1–3 palabras).
- Entrada: fade 2 frames (~80 ms) con fantasma gris; sin escala ni deslizamiento. Cada página sustituye a la anterior (corte + fade de la nueva).
- Vida: estático, anclado a ~72 % de la altura; palabra siguiente en gris hasta que se dice (karaoke por color, 1 frame).
- Salida: corte al cambiar de página.
- Sincronía: con la palabra hablada.
- Capas: delante de todo (persona, tarjetas, transiciones).
- Tipografía: sans grotesk bold blanca; las palabras clave alternan a una cursiva script cian con glow ("pushing", "harder.", "slowing", "down", "noticing", "self-judgment", "self-compassion", "real", "real growth") con el mismo fade de 2–3 frames; "means" es la única palabra que sube de tamaño (~1.4×).

##### Marco neón (t=0.21–2.18 s; tira A f5–f7, B; detalle `full-0.30`)
- Elemento: marco.
- Entrada: se dibuja/aparece en 3 frames (125 ms) ya inclinado ~10° en sentido horario, tamaño ~80 % del ancho, centrado en la cabeza. [dudoso si es dibujo de trazo o fade: a 180 px se ve el trazo parcial en f5.]
- Vida: rota lentamente unos grados a un lado y a otro (oscilación) y desde 0.67 muestra una segunda línea desfasada que la sigue (estela rotacional); sin escala apreciable.
- Salida: t=2.18 s, desaparece de un frame a otro (corte) [dudoso: fade ≤ 2 frames].
- Sincronía: independiente del habla; su vida coincide con el título "Progress".
- Capas: delante de la persona (la línea pasa por encima del pelo).
- Look: línea cian fina (~3 px) con glow.

##### Título "Progress" (t=0.67–2.31 s; tiras A f16–f23, B, C f0–f5)
- Elemento: título.
- Entrada: revelado de izquierda a derecha (wipe/máscara: aparecen letras parciales "Pr", "Pro", "Prog", "Progre", "Progres", "Progress"), 8 frames (330 ms), ritmo constante.
- Vida: crece de forma continua ~1.0 → 1.3× durante ~1.2 s (deriva lineal) hasta desbordar el cuadro por izquierda y derecha; posición arriba (~y 70 px).
- Salida: t=2.10–2.31 s, fade-out 6 frames (250 ms) mientras sigue creciendo.
- Sincronía: entra con la palabra "progress" del caption (0.67).
- Capas: delante de la persona.
- Tipografía: script cursiva cian con glow, muy grande (altura de x ~120 px).

##### Trazo de luz en el borde de la tarjeta (t=3.475–~4.70 s; tira D f15–f23, E f0–f3; detalle `full-3.60`)
- Elemento: marco (borde de la tarjeta de B-roll).
- Entrada: segmentos de línea cian aparecen en la esquina superior izquierda (f15) y recorren el perímetro.
- Vida: el segmento viaja por los bordes (arriba → izquierda → derecha…) a ~1 lado por 3–4 frames [dudoso el recorrido exacto], con glow.
- Salida: se va con la tarjeta en el spin-blur (4.77).
- Sincronía: independiente.
- Capas: sobre la tarjeta.

##### Tarjeta de B-roll (t=3.31–4.77 s; detalle `full-3.60`)
- Elemento: B-roll en tarjeta (inset ~80 % de ancho y ~80 % de alto, esquinas rectas, fondo gris carbón con viñeta).
- Entrada: llega ya dentro del spin-blur (sin animación propia).
- Vida: estática; el B-roll no muestra zoom apreciable.
- Salida: dentro del spin-blur (4.77–4.98).
- Capas: los captions van dentro de la tarjeta, alineados a la izquierda en el tercio inferior.

##### Carrusel de 3 paneles (t=5.84–~8.00 s; tira F; detalle `full-6.30`)
- Elemento: B-roll (tres paneles verticales en la mitad inferior).
- Entrada: el panel central aparece por fade semitransparente (5.84–5.93, 3 frames, sin escala); los paneles laterales se expanden desde los bordes del central hacia afuera (5.93–6.10, 4–5 frames, ease-out) hasta quedar recortados por los bordes del cuadro. Los laterales están foreshortened (parecen girados en 3D hacia el espectador).
- Vida: el contenido de cada panel es vídeo en movimiento; a t=6.55–6.59 el carrusel avanza un paso con motion blur horizontal (2 frames, ~80 ms) y el contenido cambia (el retrato pasa al centro).
- Salida: t≈8.00 s, desaparece [dudoso: fade, visto solo a 4 fps].
- Sincronía: entra con "more?" (5.60) y avanza con "That shift".
- Capas: delante del cuerpo, debajo de la cara; el caption va encima de los paneles.

##### Tarjeta de título "GROWTH" (t=8.78–10.14 s; tiras G, H; detalle `full-9.40`)
- Elemento: título + fondo.
- Entrada: el presentador se desenfoca y oscurece 5 frames (8.78–8.95, desenfoque ~0 → 30 px); la palabra "GROWTH" (cian sólido, bold, ocupa todo el ancho) entra desde la derecha con motion blur horizontal fuerte, 6 frames (8.91–9.16, 250 ms), ease-out (recorre ~600 px en los primeros 3 frames y se asienta en los 3 siguientes). El fondo teal oscuro con "GROWTH" en outline repetido en filas en perspectiva aparece a la vez (8.99) [dudoso si también se desliza].
- Vida: la palabra crece muy lentamente (deriva de escala ~1.0 → 1.05) [dudoso]; el fondo parece estático.
- Salida: t=9.98–10.14 s, desenfoque cruzado con la toma del presentador (5 frames): la palabra se desenfoca y se funde mientras el presentador aparece desenfocado y se aclara.
- Sincronía: con "real growth"; los captions "is", "is what", "real" siguen su ritmo durante la tarjeta.
- Capas: tarjeta a pantalla completa; caption encima.

#### Transiciones entre tomas
- t=3.06–3.31 s: spin-blur (desenfoque rotacional centrado en la cara) con flash blanco, 6 frames; sin dirección lineal (giro), sin escala apreciable; el caption "harder." permanece encima y cambia a "But" en el primer frame nítido.
- t=4.77–5.18 s: spin-blur con flash blanco, 10–11 frames; los colores de la toma entrante aparecen dentro del remolino desde 4.93 (fundido dentro del giro); "and" y "noticing" entran durante la transición.
- t=8.78–9.16 s: desenfoque gaussiano + oscurecimiento del presentador (5 frames) y llegada del título con motion blur horizontal desde la derecha (6 frames).
- t=9.98–10.14 s: desenfoque cruzado (blur + crossfade), 5 frames, sin dirección ni escala.

#### Cámara
- t=0.00–0.25 s: blur-in de apertura (ver arriba).
- t=0.25–3.06 s: zoom lento de entrada muy suave (~5 % en 3 s) [dudoso: la cabeza ocupa algo más de cuadro en 2.9 que en 0.4, pero el sujeto también se mueve].
- Sin shake ni focus pull adicionales.

#### Firma del estilo
Neón cian sobre fondo cálido: marco de luz que oscila con estela, título en script cursiva que se revela y crece, y transiciones de spin-blur con flash blanco. Palabras clave en cursiva cian con glow; los B-roll viven en tarjetas y carruseles con bordes de luz.

### Elevate

Duración 9.04 s, 24 fps (217 frames), 1080×1920. Una sola toma de la presentadora de principio a fin (sin cortes). El B-roll aparece como pantalla partida en la mitad inferior (t=2.67–6.00). Un frame = 41.7 ms.

Tiras usadas: `elevate-A-titulo.jpg` (0.00–1.00), `B-pagina-20yo` (0.80–1.80), `C-titulo-out-self` (2.00–3.00), `D-card-up` (2.80–3.80), `E-card-out-stop` (5.30–6.30), `F-perfection` (6.30–7.30), `G-momentum-final` (8.05–9.04); detalles: `elevate-full-1.20.jpg`, `full-4.00`, `full-caption-in`.

#### Línea de tiempo
- t=0.00–0.08 s — presentadora, sin elementos.
- t=0.083 s — caption "If I could go back" (serif blanca) y una línea fina horizontal (~70 % del ancho, y≈1780 px) aparecen a la vez (corte, ≤1 frame de fade).
- t=0.125 s — estrella ✳ blanca pequeña aparece en el centro del cuadro (corte).
- t=0.33–0.625 s — título "Momentum" (script blanca) se revela de izquierda a derecha con desenfoque que se aclara (8 frames); a la vez aparecen la etiqueta ovalada "a short film" sobre la M, el subtítulo serif "advice I wish / I knew at 20" a la derecha de la estrella (blur-in 0.46–0.58) y la cabecera "creator … presents" arriba [dudoso el frame exacto de la cabecera; es diminuta].
- t=1.01 s — página "and tell my 20-year-old" ("my 20-year-old" en cursiva), corte.
- t=2.125–2.29 s — título, etiqueta, subtítulo y cabecera se van con desenfoque de derecha a izquierda (5 frames); la estrella y la línea inferior desaparecen con ellos [dudoso la línea].
- t=2.125 s — página "self just one" ("self" cursiva), fade 1 frame.
- t=2.67–3.30 s — tarjeta de B-roll (montaña con persona de brazos alzados) sube desde el borde inferior hasta ocupar exactamente la mitad inferior (15 frames); la estrella ✳ viaja centrada en su borde superior.
- t=3.01 s — "thing," (corte), colocada sobre el B-roll; t=3.55 sale; t=3.76–3.80 "it'd be this." (fade 1–2 frames).
- t≈5.00 s — "it'd be this." sale [visto a 4 fps].
- t=5.47–6.00 s — la tarjeta baja y sale por el borde inferior (13 frames), estrella incluida.
- t=5.51–5.55 s — "Stop chasing" (fade 2 frames).
- t=6.43–6.47 s — "perfection and" ("perfection" cursiva), fade 1–2 frames.
- t≈7.50 s — "start building" (cursiva) [visto a 4 fps].
- t=8.14 s — hueco de 1 frame; t=8.18 — "momentum." (corte).
- t=8.95–9.04 s — comienza un fundido a negro por la esquina inferior derecha [dudoso, 2 frames].

#### Movimientos

##### Caption serif (t=0.083 s y cada página; tiras A, B, C, E, F, G; detalle `full-caption-in`)
- Elemento: caption (frase).
- Entrada: corte o fade de 1–2 frames (≤80 ms) con fantasma muy breve; sin escala, sin deslizamiento. Las páginas se sustituyen entre sí (1.01, 2.125, 3.01, 3.76, 5.51, 6.43, ~7.50, 8.18).
- Vida: estático, centrado, a ~y 1320 px (69 %) mientras no hay tarjeta; cuando la tarjeta está en pantalla el caption queda sobre el B-roll en la misma altura.
- Salida: corte (3.55, ~5.00, 8.14) o sustitución.
- Sincronía: con la palabra hablada.
- Capas: delante de la persona y del B-roll.
- Tipografía: serif editorial blanca (tipo Times condensada); las palabras clave van en cursiva de la misma familia ("my 20-year-old", "self", "perfection", "start building") sin cambio de tamaño ni color.

##### Título "Momentum" (t=0.33–0.625 s in; 2.125–2.29 s out; tira A f8–f15, C f3–f7; detalle `full-1.20`)
- Elemento: título (composición de póster: cabecera "creator / presents", "Momentum" en script, etiqueta ovalada "a short film", estrella ✳ y subtítulo "advice I wish / I knew at 20").
- Entrada: revelado de izquierda a derecha con desenfoque ("M" → "Mo" → "Mom" … "Momentum"), cada letra aparece desenfocada (~10 px) y se aclara; 8 frames (300 ms), ritmo constante; el subtítulo hace blur-in 3 frames (0.46–0.58). Sin desplazamiento ni escala.
- Vida: estático (1.0–2.1 s sin cambios en la tira B).
- Salida: t=2.125–2.29 s, revelado inverso: se desenfoca y se borra de derecha a izquierda, 5 frames (200 ms), ligeramente más rápido que la entrada.
- Sincronía: independiente del habla (entra durante "If I could go back").
- Capas: delante de la persona, centrado a la altura de la boca (~y 850 px).
- Tipografía: script caligráfica blanca con trazo fino; subtítulo serif pequeño; cabecera serif diminuta.

##### Estrella ✳ (t=0.125–2.2 s y 2.67–6.00 s; tiras A, C, D, E; detalle `full-4.00`)
- Elemento: sticker (ornamento de 8 puntas, blanco, ~60 px).
- Entrada: corte (0.125) en el centro exacto del cuadro; reaparece a 2.67 en el borde inferior, ya montada en el borde superior de la tarjeta.
- Vida: estática en la primera fase; en la segunda viaja solidaria con la tarjeta (sube 2.67–3.30, baja 5.47–6.00), siempre centrada sobre la costura del split.
- Salida: se va con el título (~2.2) y con la tarjeta (6.00).
- Sincronía: independiente.
- Capas: delante de todo.

##### Línea fina inferior (t=0.083–~2.2 s; tira A, B; detalle `full-1.20`)
- Elemento: marco (línea horizontal de ~70 % del ancho a y≈1780 px, 1–2 px, blanca al ~50 %).
- Entrada: corte con el primer caption.
- Vida: estática.
- Salida: desaparece con el título [dudoso: no se ve en la tira C a partir de f8].
- Capas: delante de la persona.

##### Tarjeta de B-roll en split inferior — entrada (t=2.67–3.30 s; tiras C f16–f23, D f0–f15; detalle `full-4.00`)
- Elemento: B-roll (mitad inferior, de borde a borde, costura horizontal dura en y=960 px).
- Entrada: deslizamiento desde abajo, 15 frames (625 ms), ease-out marcado: recorre ~65 % de los 960 px en los primeros 7 frames y se asienta en los 8 siguientes. Sin escala; la estrella viaja en el borde superior.
- Vida: estática; el B-roll no muestra zoom apreciable [dudoso: < 3 %].
- Salida: t=5.47–6.00 s, deslizamiento hacia abajo, 13 frames (540 ms); avanza rápido al principio (~25 px/frame a 180 px de ancho) y se frena al final [dudoso: ease-out en una salida].
- Sincronía: entra tras "self just one" y sale con "Stop chasing"; no coincide con palabra concreta.
- Capas: la tarjeta tapa la mitad inferior de la persona; captions encima del B-roll.

#### Transiciones entre tomas
- Ninguna: no hay cortes de toma. El único cambio de contenido es el split de B-roll (deslizamiento vertical, sin desenfoque ni escala).

#### Cámara
- Ninguno: sin punch-in, zoom ni desenfoque en la toma de la presentadora (encuadre idéntico en las tiras A–G). Fundido a negro al final (8.95–9.04) [dudoso].

#### Firma del estilo
Póster de cine minimalista: título script que se revela y se borra con desenfoque letra a letra, cabecera "presents", estrella ✳ como ornamento y línea fina; captions serif con cursiva para la palabra clave y un split inferior que sube y baja con ease-out. Nada de karaoke, nada de neón.

### Impact II

Duración 10.96 s, 24 fps (263 frames), 1080×1920. Tres segmentos: presentador (t=0.04–7.35), tarjeta de rejilla negra (t=7.39–9.06) y presentador (t=9.14–10.96). Dos transiciones: desenfoque + aberración cromática + flash blanco (7.26–7.55) y disolución de la rejilla a gris + blur-in (9.02–9.35). Un frame = 41.7 ms.

Tiras usadas: `impact-ii-A-zoomin-balance.jpg` (0.00–1.00), `B-sacrifice` (1.30–2.30), `C-broll-money` (2.60–3.60), `D-but-make-time` (4.10–5.10), `E-marathon` (6.30–7.30), `F-to-grid` (7.05–8.05), `G-a-sprint` (8.10–9.10), `H-grid-to-act` (9.10–10.10); tiras cortas: `impact-ii-X-zoomout.jpg` (2.25–2.67), `X-band-in` (2.66–2.83), `X-time-punch` (4.40–5.00 a 8 fps).

#### Línea de tiempo
- t=0.00 s — negro.
- t=0.04–0.33 s — fade desde negro + zoom-out (~1.4× → 1.05×) + desenfoque gaussiano que se aclara + aberración cromática RGB (8 frames); el zoom sigue frenando hasta ~0.55.
- t=0.167–0.25 s — "IT'S ABOUT" (cian pequeño, condensada mayúscula) entra con blur + separación RGB (3 frames).
- t=0.58–0.67 s — "BALANCE" (blanco, grande) entra con blur-in (3 frames); "IT'S ABOUT" sale por corte.
- t≈1.25 s — "BALANCE" sale (corte) [visto a 4 fps].
- t=1.34–1.38 s — "NOT JUST SACRIFICE" (cian) entra con blur + RGB (2 frames).
- t=1.67–1.92 s — pulso glitch: desenfoque sube y baja con aberración RGB en el pico (6 frames), con leve punch-in ~5 % [dudoso].
- t=2.25–2.62 s — zoom-out suave ~1.15× → 1.0× (10 frames).
- t=2.54–2.85 s — B-roll de maletín con dinero sube desde el borde inferior hasta cubrir ~45 % del cuadro (7–8 frames).
- t=2.73 s — "NOT JUST SACRIFICE" sale (corte).
- t=3.02–3.10 s — "YOU NEED TO GRIND" (cian) entra con blur + RGB, colocado en la costura entre persona y B-roll.
- t=3.56 y ≈4.00 s — parpadeo de franja cromática en el borde inferior del B-roll [dudoso].
- t=4.14 s — caption sale; t=4.31–4.39 — "BUT MAKE" (cian) blur + RGB.
- t=4.56–4.77 s — el B-roll baja y sale por el borde inferior con motion blur (5 frames).
- t=4.60–4.75 s — punch-in ~1.12× en el presentador (3–4 frames).
- t=4.68–4.72 s — "TIME" (blanco, grande) blur-in (2 frames); t=5.02 sale.
- t=5.06–5.14 s — "FOR YOURSELF" (cian) blur + RGB.
- t=6.47–6.55 s — "LIFE'S A MARATHON" (cian) blur + RGB (3 frames).
- t=7.26–7.35 s — presentador se desenfoca con separación RGB (3 frames).
- t=7.39 s — frame blanco (flash) con "MARATHON" cian centrado y más grande.
- t=7.43–7.55 s — la rejilla aparece: líneas verticales desenfocadas sobre gris que se afilan mientras el fondo va a negro (4 frames).
- t=7.80 s — "MARATHON" sale; t=7.84–7.93 "NOT"; t=7.97–8.05 "A"; t=8.10–8.18 "SPRINT" (cada palabra sola, centrada, blur + RGB); t=8.81 "SPRINT" sale.
- t=9.02–9.10 s — la rejilla se disuelve: líneas se desenfocan, fondo negro → gris claro (3 frames).
- t=9.14–9.35 s — presentador entra con blur-in (6 frames) y leve zoom-out [dudoso]; t=9.22–9.27 "ACT" (blanco, grande) blur-in.
- t=9.68 s — "ACT" sale; t=9.72–9.77 "ACCORDINGLY" (cian) blur + RGB; t≈10.75 sale; fin 10.96.

#### Movimientos

##### Apertura con zoom-out, blur y aberración cromática (t=0.04–0.55 s; tira A f1–f13)
- Elemento: cámara / fondo (toda la toma).
- Entrada: desde negro (1 frame), la toma llega a escala ~1.4× muy desenfocada (~30 px) y con separación RGB; escala, desenfoque y aberración bajan a la vez en 8 frames (0.04–0.33, 330 ms), ease-out fuerte; el zoom termina de asentarse (1.05 → 1.0) hasta ~0.55 (otros 5 frames).
- Vida: nítido.
- Salida: no aplica.
- Sincronía: independiente; el primer caption entra a mitad del zoom.

##### Caption pequeño cian (t=0.167, 1.34, 3.02, 4.31, 5.06, 6.47, 7.84, 7.97, 8.10, 9.72 s; tiras A–H)
- Elemento: caption (frase corta en mayúsculas condensadas, cian).
- Entrada: blur-in con separación RGB: en el primer frame aparece morado/violeta y desenfocado, en el segundo azul-cian y casi nítido, en el tercero cian nítido; 2–3 frames (80–125 ms), sin escala ni deslizamiento.
- Vida: estático, centrado, a ~y 1380 px (72 %); sin karaoke por color ni por palabra (la frase entera aparece de golpe).
- Salida: corte (1 frame), normalmente con 2–5 frames de hueco antes de la siguiente frase.
- Sincronía: con la primera palabra hablada de la frase.
- Capas: delante de la persona y del B-roll.
- Tipografía: sans condensada bold en mayúsculas (tipo Impact/Bebas), cian (#4FE0FF aprox.), con sombra.

##### Palabra de impacto blanca "BALANCE" / "TIME" / "ACT" (t=0.58–1.25, 4.68–5.02, 9.22–9.68 s; tiras A f14–f16, D f14–f21, H f3–f13)
- Elemento: palabra clave.
- Entrada: blur-in (desenfoque ~15 px → 0, opacidad 0 → 1) en 2–3 frames (80–125 ms), sin escala; con "TIME" y "ACT" coincide un punch-in de cámara (ver Cámara).
- Vida: estática; ~2× el tamaño del caption cian, blanca.
- Salida: corte.
- Sincronía: con la palabra hablada.
- Capas: delante de todo.

##### Pulso glitch (t=1.67–1.92 s; tira B f9–f15)
- Elemento: cámara (toda la toma, no el caption).
- Entrada: desenfoque gaussiano sube en 3 frames (0 → ~20 px) con separación RGB en el pico (f11–f12), y baja en 3 frames; total 6 frames (250 ms), ease-in-out; leve punch-in ~5 % [dudoso].
- Vida: no aplica.
- Salida: vuelve a nítido.
- Sincronía: independiente de palabra (cae en mitad de "NOT JUST SACRIFICE"), funciona como acento de ritmo.
- Capas: solo el vídeo; el caption queda nítido encima.

##### Banda de B-roll (maletín con dinero) — entrada (t=2.54–2.85 s; tira X-band-in, C f3–f8)
- Elemento: B-roll (banda horizontal en el ~45 % inferior).
- Entrada: deslizamiento desde el borde inferior, 7–8 frames (~300 ms), ease-out (recorre ~2/3 del trayecto en los primeros 3 frames); sin escala. El borde superior es recto, pero el fondo oscuro del B-roll se confunde con la chaqueta del presentador [dudoso si el borde lleva pluma].
- Vida: estática; ~3.56 y ~4.00 s aparece un parpadeo de aberración cromática en su borde inferior (1–2 frames) [dudoso].
- Salida: t=4.56–4.77 s, deslizamiento hacia abajo con motion blur vertical, 5 frames (210 ms), ease-in.
- Sincronía: entra al final del zoom-out y sale con "TIME".
- Capas: delante del cuerpo del presentador; el caption "YOU NEED TO GRIND" se apoya en la costura.

##### Tarjeta de rejilla con palabras sueltas (t=7.39–9.10 s; tiras F, G)
- Elemento: fondo + palabras clave.
- Entrada: tras el flash blanco (1 frame, 7.39), las líneas verticales de la rejilla aparecen desenfocadas horizontalmente sobre gris y se afilan mientras el fondo cae a negro, 4 frames (7.43–7.55); las horizontales llegan con ellas.
- Vida: rejilla de líneas finas gris-blancas con ligera ondulación (warp) y deriva casi imperceptible [dudoso]; las palabras "MARATHON" (heredada, más grande, 7.39–7.80), "NOT" (7.84–7.93), "A" (7.97–8.05), "SPRINT" (8.10–8.81) aparecen una a una centradas con el mismo blur + RGB de 2–3 frames y salen por corte; el centro queda vacío 8.81–9.02.
- Salida: t=9.02–9.10 s, las líneas se desenfocan y el fondo sube a gris claro (3 frames), y de ahí blur-in al presentador.
- Sincronía: con las palabras habladas.
- Capas: tarjeta a pantalla completa.

#### Transiciones entre tomas
- t=7.26–7.55 s: presentador → rejilla: desenfoque gaussiano + separación RGB creciente 3 frames (7.26–7.35), flash blanco 1 frame (7.39), rejilla que se enfoca desde blur horizontal 4 frames (7.43–7.55). Total 8 frames (330 ms). Sin dirección ni escala en el presentador; "MARATHON" cruza la transición cambiando de caption pequeño a palabra grande centrada.
- t=9.02–9.35 s: rejilla → presentador: disolución a gris claro con desenfoque de las líneas 3 frames (9.02–9.10) y blur-in del presentador 6 frames (9.14–9.35), con leve zoom-out (~1.08× → 1.0) [dudoso]. Total ~9 frames (375 ms).

#### Cámara
- t=0.04–0.55 s: zoom-out de apertura ~1.4× → 1.0× con desenfoque y aberración cromática, ease-out.
- t=1.67–1.92 s: pulso de desenfoque + RGB con leve punch-in (~5 %) [dudoso].
- t=2.25–2.62 s: zoom-out suave ~1.15× → 1.0×, 10 frames, ease lineal-suave, sin desenfoque.
- t=4.60–4.75 s: punch-in ~1.12×, 3–4 frames, ease-out, coincide con "TIME" y la salida de la banda.
- t=9.14–9.35 s: blur-in con leve zoom-out [dudoso].
- Sin shake.

#### Firma del estilo
Todo entra con desenfoque + separación RGB: captions cian condensados que llegan morados y se vuelven cian en 2–3 frames, palabras de impacto blancas al doble de tamaño acompañadas de punch-in, y una tarjeta de rejilla negra con flash blanco en la que las palabras aparecen de una en una.

### Sketch

Duración 9.71 s (233 frames), 24 fps. Tres tomas / dos cortes: toma A (presentador, 0.00–5.00), toma B (B-roll: mapa mental en papel con bolígrafos, 5.00–9.00, con inserto circular del presentador desde 5.83), toma A de nuevo (9.00–9.71). Cortes secos en t=5.00 (frame 120) y t=9.00 (frame 216).

Fuentes: hoja general a 4 fps (`sketch-overview.jpg`), tiras de 1 s (`sketch-01…08`), recortes a resolución completa (`sketch-z-*`).

#### Línea de tiempo
- `t=0.00–0.08 s — vídeo`: presentador sin gráficos.
- `t=0.08–0.42 s — título "MIND MAP"`: se revela de derecha a izquierda por una máscara de borde irregular (marcador), en 4 saltos: "AP" (0.08) → "MAP" (0.17) → "IND MAP" (0.29) → "MIND MAP" (0.42). 8–9 frames.
- `t=0.17 s — caption "struggling"`: aparece de golpe (fuente manuscrita blanca tipo rotulador, centrada bajo el título).
- `t=0.25–0.46 s — elipse`: trazo doble beige dibujado alrededor del título (trim path), 5–6 frames.
- `t=0.46 / 0.58 / 0.88 s — caption`: se añaden "to", "organize", "your" (instantáneo, ≤1 frame cada una).
- `t=1.00 s — cambio de página`: "thoughts?" (fade-in ≤2 frames [dudoso]); segunda línea "start" 1.72, "with" 1.88, "a" 2.08, "mind" 2.21.
- `t=2.25–2.50 s — título + elipse salen`: borrado de izquierda a derecha en 3 saltos ("IND MAP" 2.25 → "MAP" 2.38 → nada 2.50), 7 frames.
- `t=2.50 s — página "thoughts? / start with a mind" desaparece` (corte, 1 frame); `t=2.54–2.63 s` "map," aparece con fade-in de ~3 frames.
- `t=2.96–3.17 s — banda de marcador`: banda oscura de bordes rugosos se dibuja detrás del bloque de caption en 6 frames; "but" aparece en la segunda línea en 3.00.
- `t=3.38 s — "don't"`; `t≈3.9 s — "overthink"` [dudoso ±0.1 s, entre tiras]; `t≈4.5 s — página "it."` (con banda, hoja general).
- `t=4.80–4.92 s — banda sin texto` [dudoso]; `t=4.96 s — "The"` en sans bold blanca, 1 frame antes del corte.
- `t=5.00 s — CORTE SECO a B-roll` (papel). Estilo de caption cambia a sans bold blanca centrada con sombra. "The best" 5.00, "way" 5.17, "to" 5.33; página "begin" 5.46.
- `t=5.80 s — "is"` (segunda línea); `t=5.83–6.08 s — inserto circular` del presentador escala de 0 a 1 arriba-centro, 6 frames; `t=6.13 s — "simple:"`.
- `t≈7.0–7.5 s — página "write / your main"` (hoja general: "write" 7.25, "your main" 7.5); `t=7.88 s — página "idea"` (fade 1–2 frames); `t=8.63 s — "dead"`.
- `t=9.00 s — CORTE SECO al presentador`; el caption "idea dead" se mantiene; `t=9.17 s — "center."`; fin 9.71.

#### Movimientos

##### Entrada del título "MIND MAP" (t=0.08–0.42)
- Elemento: título
- Entrada: revelado por máscara irregular (borde de rotulador, con textura de trazo en el borde) de derecha a izquierda, en 4 pasos discretos (no continuo): 8–9 frames (~350 ms). Las letras no se mueven ni escalan; solo se destapan. Curva: escalonada (saltos cada ~2–3 frames).
- Vida: estático hasta la salida (comprobado 0.5/1.0/1.5/2.0 s, sin deriva ni escala).
- Salida: t=2.25–2.50, borrado de izquierda a derecha con la misma máscara en 3 pasos, 7 frames (~290 ms). La elipse se borra con él.
- Sincronía: independiente de la palabra; arranca con el vídeo.
- Capas: delante del presentador, centrado a ~52 % de la altura (sobre boca/pecho).
- Tipografía: sans muy pesada (tipo Archivo Black), blanca, ~140 px de altura de mayúscula, ligera sombra oscura.

##### Elipse dibujada (t=0.25–0.46)
- Elemento: marco (garabato) del título
- Entrada: trazo dibujado (trim path) de línea doble fina beige, arranca abajo-izquierda y rodea el título; 5–6 frames (~230 ms), lineal [dudoso].
- Vida: estática.
- Salida: se borra con el título (2.25–2.50, de izquierda a derecha).
- Sincronía: encadenada al título (empieza 4 frames después del primer trozo revelado).
- Capas: sobre el vídeo, detrás del texto del título.

##### Caption manuscrito, construcción palabra a palabra (t=0.17–4.92)
- Elemento: caption (frase)
- Entrada: cada palabra aparece de golpe (≤1 frame) en su posición final; la línea completa está centrada y se rellena de izquierda a derecha ("start" → "start with" → "start with a mind").
- Vida: estático; dos líneas máximo.
- Salida: cambio de página = la página anterior desaparece en 1 frame y la primera palabra de la nueva entra con fade de 2–3 frames (1.00 s, 2.54 s).
- Sincronía: con la palabra hablada.
- Capas: delante del presentador, ~70 % de la altura.
- Tipografía: manuscrita tipo rotulador, blanca, sin caja.

##### Banda de marcador (t=2.96–3.17)
- Elemento: caption (resaltado de frase "map, / but don't overthink it.")
- Entrada: rectángulo oscuro (~#2b2b2b, ~85 % opacidad) de bordes rugosos y textura de trazo, dibujado como dos pasadas: línea 1 de izquierda a derecha (2.96–3.08), línea 2 de derecha a izquierda (3.00–3.13); completo en 3.17. 6 frames (~250 ms), ease-out ligero.
- Vida: estática, detrás del texto, ancho completo del bloque.
- Salida: se mantiene hasta el corte de 5.00 (hoja general: sigue en 4.5); en 4.80–4.92 la banda está sin texto [dudoso si el texto "it." sale antes que la banda].
- Sincronía: se dispara al llegar la segunda línea ("but"), t=3.00.
- Capas: sobre el vídeo, bajo el texto.

##### Cambio de estilo de caption a sans bold (t=4.96)
- Elemento: caption (frase)
- Entrada: "The" aparece en sans bold blanca con sombra 1 frame antes del corte; desde 5.00 todas las páginas usan este estilo hasta el final. Palabras instantáneas; página nueva con fade de 1–2 frames ("idea" 7.88 sale tenue 1 frame).
- Vida: estático, centrado ~68 % de altura.
- Salida: cambio de página por corte.
- Sincronía: con la palabra.
- Capas: sobre B-roll y luego sobre el presentador.
- Tipografía: sans bold (tipo Inter/Helvetica Bold) blanca con sombra suave; no se observa tratamiento especial de palabra clave (todas las palabras iguales) [dudoso].

##### Inserto circular del presentador (t=5.83–6.08)
- Elemento: marco (B-roll con inserto)
- Entrada: escala desde ~0 (punto en 5.83) → 0.15 (5.88) → 0.4 (5.92) → 0.7 (5.96) → 0.95 (6.00) → ~1.05 (6.04) → 1.0 (6.08): 6 frames (~250 ms), ease-out con sobrepaso ligero [dudoso].
- Vida: estático; diámetro ~470 px (≈43 % del ancho), centro ≈ (540, 480), arriba-centro; sin borde visible [dudoso].
- Salida: desaparece con el corte seco de 9.00.
- Sincronía: con "is" / "simple" (segunda línea de "begin is simple:").
- Capas: encima del B-roll, detrás de nada.

#### Transiciones entre tomas
- t=5.00 (frame 120): corte seco A→B; sin desenfoque, sin escala. El caption "The" ya estaba 1 frame antes.
- t=9.00 (frame 216): corte seco B→A; el caption "idea dead" persiste sin reiniciarse; el inserto circular desaparece con el corte.

#### Cámara
Ninguno: sin zoom en la toma A (comprobado 0.3/1.1/1.9 y 0.6 vs 4.7 s), sin zoom en el B-roll (5.2 vs 8.9 s), sin shake ni desenfoque.

#### Firma del estilo
Todo "a mano": el título se destapa y se borra con una máscara rugosa de rotulador y una elipse trazada en vivo; los captions manuscritos reciben una banda de marcador oscuro que se pinta en dos pasadas. Sin transiciones animadas: cortes secos y un inserto circular que escala desde cero.

### Lens

Duración 10.04 s (241 frames), 24 fps. Una sola toma del presentador (sin cortes secos) más un B-roll (cámara analógica sobre mesa) que entra y sale dentro de un layout dividido (3.63–7.17). Los cambios de plano son transiciones de layout, no cortes.

Fuentes: `lens-overview.jpg`, tiras `lens-01…08`, recortes `lens-z-*`.

#### Línea de tiempo
- `t=0.00–0.04 s — fondo`: azul marino (~#2E3A5C) con grano/polvo, vacío.
- `t=0.08–0.33 s — vídeo`: escala desde ~0 en el centro hasta ~0.88 (0.02 → 0.35 → 0.6 → 0.75 → 0.85 → 0.88), 6 frames; desenfocado de 0.13 a 0.46 y nítido en 0.50 (focus pull).
- `t=0.25 s — marco`: aparecen con el vídeo el borde redondeado fino, las esquinas de visor amarillo/naranja y una cajita de enfoque en el centro; caption "STOP" (barra negra de ancho fijo, mono blanca mayúsculas). Light leak cálido arriba 0.25–0.33; destello rosa/naranja horizontal abajo-izquierda 0.375–0.46.
- `t=0.42–1.21 s — título "Aperture"`: typewriter, una letra cada ~3 frames, cada letra con fade de ~2 frames (A 0.46, p 0.54, e 0.67, r 0.79, t 0.88, u 1.00, r 1.13, e 1.21). ~19 frames.
- `t=0.50 s — "STOP SHOOTING"`; `t≈0.67 s — HUD` "1/125  f5.6  ISO 200" en mono rosa pequeña al pie del marco [dudoso ±2 frames]; `t=0.75 — página "IN"`; `0.92 — "IN AUTO."`; `1.25 — página "IT'S"`; `~1.5 — "IT'S KILLING"`; `~2.0 — "YOUR PHOTOS."` (hoja general).
- `t=2.63 s — caption en blanco (1 página vacía)`; `t=2.71–2.96 s — título sale`: se borra letra a letra desde la izquierda, 1 letra/frame, 7 frames; `t=2.79 — "SWITCH"`.
- `t=2.92–2.96 s — inset salta a pantalla completa`: escala 0.88→1.0 en 2 frames; marco, esquinas y HUD desaparecen con él.
- `t=3.04 — "SWITCH TO"`; `3.25 — "SWITCH TO APERTURE"`; `3.54 — blanco`.
- `t=3.58 s — "PRIORITY,"` reaparece más arriba (y≈49 %); `t=3.63–3.79 s — B-roll sube desde abajo` con borde desenfocado (4–5 frames), flash de light leak cálido con pico en 3.75; `t=3.83–3.92 s — ambos paneles se encogen` en cajas redondeadas con márgenes azul marino y tiras de texto vertical "APERTURE & FOCUS -" a ambos lados (3 frames); `3.96 — destello rosa abajo-derecha`.
- `t=3.96–6.71 s — layout dividido estable`; captions: 4.21 blanco, 4.26 "DROP", 4.54 "DROP TO", 4.79 "DROP TO F", 4.96 "DROP TO F 1.8", ~5.75 "LET", ~6.0 "LET THAT", ~6.25 "LET THAT BACKGROUND" (hoja general). Tiras laterales desplazándose hacia abajo (~40 px cada 6 frames).
- `t=6.58 — blanco`; `6.63 — "MELT"`; `t=6.71–6.92 s — flash de light leak + paneles se expanden a ancho completo (6.79–6.83)`; `6.88 — "MELT AWAY."`; `t=6.92–7.17 s — el B-roll inferior "se derrite" hacia abajo` (banda azul difusa que retrocede, 6 frames); `7.17 — presentador a pantalla completa`.
- `t=7.29 — blanco`; `7.47 — "TRUST"`; `t=7.63 s — esquinas de visor gris-azul + cajita central + HUD` aparecen y arranca el desenfoque; `7.71 — "TRUST ME,"`; desenfoque máximo ≈8.1; `8.13 — "YOUR"`; `~8.3 — "YOUR PORTRAITS"`; `t=8.33–8.45 s — enfoque vuelve nítido` (3 frames); `8.5 — "ARE ABOUT"`; `8.75 — "ARE ABOUT TO"`; `9.0 — "…LOOK"`; `9.25 — "WAY"`; `9.5 — "WAY MORE"`; `9.9 — "WAY MORE PRO"`; fin 10.04.

#### Movimientos

##### Apertura: el vídeo escala desde el centro (t=0.08–0.33)
- Elemento: cámara / marco
- Entrada: escala desde ~0.02 a 0.88 en 6 frames (~250 ms), ease-out fuerte (los tres primeros frames cubren el 70 % del recorrido); simultáneamente desenfoque de foco (~20 px estimados) que se resuelve entre 0.13 y 0.50 (9 frames). Fondo azul marino con polvo visible alrededor del inset.
- Vida: inset fijo a 0.88 con marco redondeado fino blanco, esquinas de visor y HUD; light leaks intermitentes (ver abajo).
- Salida: t=2.92–2.96, salto a 1.0 en 2 frames (~80 ms); marco y HUD desaparecen en el mismo salto.
- Sincronía: independiente (arranque del vídeo).
- Capas: vídeo dentro del marco; título y caption encima.

##### Light leaks (t=0.25–0.33, 0.375–0.46, 3.71–3.79, 3.96, 6.71–6.92)
- Elemento: fondo / transición
- Entrada: manchas cálidas (amarillo-naranja) o rosas, aditivas, que aparecen en 1–2 frames y se desvanecen en 3–5 frames; en 0.375–0.46 es un destello horizontal rosa/naranja abajo-izquierda; en 3.75 y 6.88 es un flash casi a pantalla completa que enmascara el cambio de layout.
- Vida: 3–5 frames cada uno.
- Salida: fade.
- Sincronía: con la apertura y con las dos transiciones de layout.
- Capas: encima de todo (vídeo, marco, captions).

##### Título "Aperture" (t=0.42–1.21 entrada, 2.71–2.96 salida)
- Elemento: título
- Entrada: typewriter; cada letra hace fade-in de ~2 frames y la siguiente empieza ~3 frames después (cadencia ~125 ms/letra); palabra completa en ~19 frames (~800 ms). Sin movimiento de posición.
- Vida: estático (comprobado 1.0/1.8/2.6).
- Salida: borrado desde la izquierda, 1 letra por frame ("perture" 2.71 → "e" 2.92 → nada 2.96), 7 frames (~290 ms), más rápido que la entrada; la última "e" sigue visible sobre el vídeo ya expandido.
- Sincronía: independiente de la palabra (empieza durante "STOP SHOOTING").
- Capas: sobre el vídeo, arriba-izquierda dentro del marco.
- Tipografía: sans redondeada bold, naranja (~#F2A33A), ~90 px.

##### Caption en barra negra (todo el vídeo)
- Elemento: caption (frase)
- Entrada: palabras añadidas de golpe (≤1 frame); barra negra de ancho fijo (~45 % del ancho) con texto mono blanco mayúsculas alineado a la izquierda; a veces hay 1 página vacía de 1–4 frames antes de la nueva (2.63, 3.54, 4.21, 6.58, 7.29).
- Vida: estática.
- Salida: corte.
- Sincronía: con la palabra.
- Capas: sobre el vídeo; y≈70 % a pantalla completa, y≈49 % (entre paneles) en el layout dividido.

##### Entrada del layout dividido (t=3.58–3.96)
- Elemento: marco / B-roll
- Entrada: 1) el caption salta a la mitad superior (3.58); 2) el B-roll sube desde el borde inferior con borde suave desenfocado hasta ~50 % (3.63–3.79, 4–5 frames); 3) flash cálido a pantalla completa (pico 3.75); 4) ambos paneles se encogen a cajas redondeadas con márgenes azul marino y aparecen las tiras verticales de texto (3.83–3.92, 3 frames); 5) destello rosa abajo-derecha (3.96). Total ~9–10 frames (~400 ms), ease-out.
- Vida: paneles fijos; tiras laterales en scroll continuo hacia abajo (~160 px/s, izquierda y derecha en el mismo sentido); polvo/grano en el fondo.
- Salida: t=6.71–7.17: flash cálido/rosa (6.71–6.92), los paneles se expanden a ancho completo en 2 frames (6.79–6.83), y el B-roll inferior se disuelve hacia abajo con banda azul difusa en 6 frames (6.92–7.17). Total ~11 frames (~460 ms).
- Sincronía: entra con "PRIORITY," (fin de "SWITCH TO APERTURE"); sale con "MELT AWAY.".
- Capas: B-roll y presentador en cajas sobre fondo azul marino; caption encima.

##### Tiras laterales "APERTURE & FOCUS -" (t=3.83–6.83)
- Elemento: marco
- Entrada: aparecen con el encogimiento de los paneles (3.83–3.92).
- Vida: texto mono naranja rotado 90°, repetido; desplazamiento continuo hacia abajo ~40 px por 6 frames (~160 px/s), lineal, en ambas tiras.
- Salida: desaparecen con la expansión de los paneles (6.79–6.83).

##### Rack focus final (t=7.63–8.45)
- Elemento: cámara
- Entrada: desenfoque que crece de 0 a máximo (~25 px estimados) entre 7.63 y ~8.1 (11 frames), se mantiene ~5 frames y se resuelve a nítido en 3 frames (8.33–8.45). Al iniciarse (7.63) aparecen esquinas de visor finas gris-azul, cajita de enfoque central y HUD rosa al pie; se quedan hasta el final.
- Vida: nítido de 8.45 a 10.04.
- Sincronía: el desenfoque arranca tras "TRUST" y se resuelve en el cambio a "ARE ABOUT" (8.5).
- Capas: efecto sobre el vídeo; marco y caption nítidos encima.

#### Transiciones entre tomas
No hay cortes secos. Los dos cambios de plano son transiciones de layout: entrada 3.58–3.96 (~10 frames: wipe vertical difuso + flash + encogido a cajas) y salida 6.71–7.17 (~11 frames: flash + expansión + wipe difuso hacia abajo). Sin dirección lateral ni escala más allá de las cajas.

#### Cámara
- Focus pull de apertura: desenfocado 0.13–0.46, nítido en 0.50 (9 frames).
- Rack focus: 7.63–8.45 (desenfoque en 11 frames, resolución en 3).
- Sin zoom (comprobado 1.0/1.8/2.6, 3.1 vs 3.45 y 8.6 vs 9.9), sin shake.

#### Firma del estilo
Lenguaje de visor de cámara: el vídeo vive en un inset con esquinas de enfoque y HUD, light leaks tapan cada cambio, las tiras de "película" con texto se desplazan a los lados, y la cámara desenfoca y enfoca (focus pull) al abrir y al cerrar.

### Vista

Duración 10.00 s (240 frames), 24 fps. Dos tomas del presentador: A, plano cerrado con fondo bokeh (0.00–2.00) y B, plano más abierto con lámparas colgantes (2.04–10.00); un corte seco en t=2.04 (frame 49) [dudoso si es otra toma o la misma reencuadrada: el fondo pasa de desenfocado a nítido]. Un B-roll (salón) dentro de un layout dividido 4.63–7.26. Tarjeta final blanca 7.75–10.00.

Fuentes: `vista-overview.jpg`, tiras `vista-01…08`, recortes `vista-z-*`.

#### Línea de tiempo
- `t=0.00–0.17 s — fondo`: fade desde blanco (velo blanco ~80 % → 0, 4 frames).
- `t=0.04–0.17 s — título "REALTY"`: desliza hacia abajo desde fuera del borde superior hasta quedar pegado a él (4 frames, ~120 px); gris claro ~85 % opacidad, condensada extra-bold, de borde a borde.
- `t=0.04 s — caption "so"` (serif blanca con sombra).
- `t=0.21–2.33 s — bloques grises al pie`: rectángulos que suben desde el borde inferior formando un "skyline" cuyas alturas cambian cada 2–4 frames; atraviesan el corte y se retiran 2.04–2.33.
- Captions: "so I" 0.25, "walked" 0.29, "in" 0.60, página "here" 0.90, "and" 1.25, "I actually" ~1.5–1.75, página "stopped." 1.88.
- `t=1.88–2.10 s — "REALTY" hace fade-out` (5–6 frames), cruzando el corte.
- `t=2.04 s — CORTE SECO` a plano abierto.
- `t=2.75 s — página "Look"`; `t=2.75–3.2 s — mosaico de triángulos` crece desde abajo-derecha hasta cubrir ~35 % inferior; "at this" ~3.0, "island." 3.27; `t=3.9–4.35 s — el mosaico se disuelve` triángulo a triángulo hacia el borde derecho; `4.23 — página "The"`.
- `t=4.63 s — "in"`; `t=4.63–5.13 s — B-roll del salón sube desde abajo con borde escalonado de bloques` (12 frames); el presentador queda en el panel superior reencuadrado más arriba; "the" 4.79; página "mornings" 4.88; "is" ~5.2; "unreal," 5.46.
- `t=6.42 — página "and"`; `6.67 — "honestly,"`; `t=6.97–7.26 s — el layout sale con wipe de bloques hacia abajo` (7 frames); encuadre del presentador vuelve al normal ~7.08; `7.08 — página "I"`; `7.13 — "could"`; `7.33 — "just"`; `7.63 — "live"`.
- `t=7.58–7.71 s — bloques grises llenan desde abajo-derecha`; `t=7.71–7.83 s — el vídeo se encoge hacia arriba-centro (~0.7) y se lava a blanco (~50 %)`; `7.75 — página "in"`; `t=7.88–8.06 s — "PENTHOUSE" fade-in gris→negro` (5 frames, con ligera subida [dudoso]); "this" 7.88; `8.06–8.10 — caption vacío`; `8.14–8.25 — "kitchen" fade-in` (3 frames, gris→negro).
- `t=9.42 — página "come"`, `9.54 "see"`, `9.67 "the"`, `9.79 "rest"`: cada palabra con fade gris→negro de 3 frames; `t=9.79–9.96 s — "PENTHOUSE" fade-out` (5 frames); fin 10.00.

#### Movimientos

##### Apertura: fade desde blanco + título "REALTY" (t=0.00–0.17)
- Elemento: fondo + título
- Entrada: velo blanco que se disuelve en 4 frames (~170 ms); el título entra deslizando hacia abajo desde arriba del cuadro (~120 px, 4 frames, ease-out) hasta tocar el borde superior [dudoso si además hay máscara en el borde: las letras se ven recortadas por el borde mientras bajan].
- Vida: estático (comprobado 0.5/1.0/1.5), ~85 % de opacidad sobre el vídeo.
- Salida: fade-out 1.88–2.10 (5–6 frames), atraviesa el corte de 2.04.
- Sincronía: independiente de la palabra; la salida coincide con el corte.
- Capas: delante del presentador, pegado al borde superior, de borde a borde.
- Tipografía: sans condensada extra-bold (tipo Anton/Bebas), gris claro/blanco translúcido, ~230 px.

##### Skyline de bloques (t=0.21–2.33)
- Elemento: transición / fondo (bloques)
- Entrada: rectángulos gris claro (~#D9D9D9) que suben desde el borde inferior, 4–6 columnas de anchos distintos, hasta ~30 % de la altura (0.21–0.5).
- Vida: las alturas cambian a saltos cada 2–4 frames (como un ecualizador), sin easing visible.
- Salida: tras el corte (2.04) se encogen hacia el borde inferior y desaparecen en 2.33 (7 frames).
- Sincronía: acompañan la página de apertura y puentean el corte.
- Capas: delante del vídeo, detrás del caption.

##### Caption serif con fade por palabra (todo el vídeo)
- Elemento: caption (frase)
- Entrada: cada palabra hace fade-in de 2–3 frames (~100 ms) de ~30 % a 100 % ("walked" 0.29–0.33, "unreal," 5.46–5.54); en la tarjeta final el fade va de gris claro a negro (3 frames: "kitchen" 8.14–8.25, "come/see/the/rest" 9.42–9.88).
- Vida: estático; una línea centrada.
- Salida: cambio de página = la página anterior desaparece en 1 frame y la primera palabra nueva hace su fade; a veces 1–2 frames vacíos (8.06–8.10, 9.38).
- Sincronía: con la palabra hablada.
- Capas: sobre el vídeo (blanca con sombra) y sobre la tarjeta (negra); y≈68 %, fijo también en el layout dividido.
- Tipografía: serif (tipo Georgia/Playfair) regular; sin palabra clave destacada.

##### Mosaico de triángulos (t=2.75–4.35)
- Elemento: transición (decorativa, sin cambio de plano)
- Entrada: triángulos rectángulos semitransparentes (oscuros y claros) sobre una cuadrícula de ~6 columnas (~180 px), que se van encendiendo desde abajo-derecha hacia la izquierda y arriba durante ~11 frames (2.75–3.2) hasta cubrir el ~35 % inferior; además un parche pequeño en la esquina superior izquierda (3.9–4.15) [dudoso].
- Vida: la opacidad de triángulos individuales varía frame a frame (parpadeo suave).
- Salida: se apagan uno a uno hacia el borde derecho, ~10 frames (3.9–4.35).
- Sincronía: entra con la página "Look" (2.75) y sale con la página "The" (4.23).
- Capas: delante del vídeo, detrás del caption.

##### Entrada del layout dividido (t=4.63–5.13)
- Elemento: marco / B-roll
- Entrada: el B-roll del salón sube desde el borde inferior con un borde superior escalonado de bloques (wipe de píxeles), 12 frames (~500 ms), hasta ~45 % de la altura; el panel del presentador queda reencuadrado hacia arriba (la cabeza pasa de y≈36 % a y≈25 %) con salto en ~4.8 [dudoso: 1–2 frames].
- Vida: la frontera de bloques sigue cambiando cada 1–2 frames mientras dura el layout; sin zoom en los paneles (5.3 vs 6.9).
- Salida: 6.97–7.26, wipe de bloques hacia abajo (7 frames); el encuadre vuelve al normal en 1–2 frames (~7.08); quedan bloques residuales en la esquina inferior derecha hasta 7.26.
- Sincronía: entra en "in the" (4.63), sale con "and honestly," → "I could" (7.08).
- Capas: B-roll debajo, presentador arriba, caption sobre la frontera.

##### Tarjeta final "PENTHOUSE" (t=7.58–10.00)
- Elemento: título + fondo
- Entrada: 1) bloques grises llenan desde abajo-derecha (7.58–7.71, 4 frames); 2) el vídeo se encoge hacia arriba-centro (escala ~1.0→0.7, 3 frames, ease) y se lava a blanco ~80 % (7.71–7.83); 3) "PENTHOUSE" hace fade-in de gris a negro en 5 frames (7.88–8.06) con subida de ~100 px [dudoso]; 4) el caption pasa a serif negra.
- Vida: estático; el vídeo lavado sigue reproduciéndose al fondo.
- Salida: "PENTHOUSE" fade-out 5 frames (9.79–9.96); el vídeo termina lavado.
- Sincronía: entra en "live" / "in" (7.63–7.75).
- Capas: título encima del vídeo lavado; caption debajo del título.
- Tipografía: sans condensada bold negra, ~110 px, centrada.

#### Transiciones entre tomas
- t=2.04 (frame 49): corte seco A→B, puenteado por el fade-out del título (1.88–2.10) y por el skyline de bloques (que sigue 7 frames tras el corte). Sin dirección, sin escala.
- Los otros cambios (layout 4.63 y 6.97, tarjeta 7.58) son wipes de bloques (píxel/escalera), 7–12 frames, verticales.

#### Cámara
Ninguno: sin zoom ni shake (comprobado 0.2/1.0/1.8, 2.15 vs 2.7, 5.3 vs 6.9). El desplazamiento del presentador en el layout es un reencuadre del panel, no un zoom.

#### Firma del estilo
Wipes de bloques rectangulares tipo píxel (skyline al pie, frontera escalonada del layout, relleno de la tarjeta) y un mosaico de triángulos que se enciende y apaga, todo en gris claro; captions serif que aparecen palabra a palabra con fade y una tarjeta final lavada a blanco.

### Pop

Duración 10.04 s (241 frames), 24 fps. Una sola toma del presentador (sin cortes secos) más un B-roll (foto cenital de la chaqueta) que entra y sale como tarjeta 5.29–7.39. Cuatro "escenas" de gráficos: kit de stickers (0.10–2.46), arco rosa (2.50–5.04), tarjeta de B-roll (5.17–7.42), tarjeta final starburst (7.68–10.04).

Fuentes: `pop-overview.jpg`, tiras `pop-01…08`, recortes `pop-z-*`.

#### Línea de tiempo
- `t=0.00–0.08 s — vídeo`: presentador sin gráficos.
- `t=0.10–0.39 s — stickers entran escalonados`: estrella rosa izq. y punto amarillo arriba (0.10), flor rosa izq., rayo amarillo der., flor rosa abajo-centro (0.14), ráfaga roja abajo-der. (0.22), flecha verde abajo-izq. (0.26), estrella amarilla izq. y flor rosa arriba-der. (0.35); borde de puntos halftone y festón rosa inferior (~0.30). Cada uno escala 0→1 en ~3 frames.
- `t=0.125–0.25 s — etiqueta "PROJECT"`: barra rosa crece horizontalmente desde su centro (ancho 0.3→1.0, 4 frames); `0.21–0.29 — texto "PROJECT" escala 0.4→1.0` (3 frames). Queda inclinada ~-3°.
- `t=0.18 s — caption "this jacket cost"` (píldora blanca con borde negro y sombra dura; "jacket cost" en bold).
- `t=1.14 s — página "me $8 at the thrift"` (cambio instantáneo; "$8" y "thrift" en bold).
- `t=2.25–2.46 s — todo sale`: stickers y etiqueta escalan a 0 (5–6 frames, ease-in); la etiqueta se encoge desplazándose hacia arriba-derecha.
- `t=2.46–2.50 s — vídeo limpio`.
- `t=2.50–2.71 s — arco rosa`: el marco rosa con ventana en arco se cierra desde los bordes (5 frames), el vídeo escala a ~0.9 dentro; banda inferior a cuadros; stickers escalonados 2.50–2.85 (flor rosa abajo-der. 2.50, flor roja arriba-izq. 2.58, estrella amarilla 2.63, píldora verde arriba-der. y píldora roja izq. 2.67, flecha verde abajo-izq. 2.71–2.85, segunda estrella 2.79, píldora azul 2.85).
- `t=2.72 — página "store,"`; `3.31 — "and it's honestly"`; `4.54 — "the best thing"` ("best" bold).
- `t=4.58–4.79 s — la flecha verde vuela hacia el caption y se encoge hasta desaparecer` (5 frames); `4.71 — píldora roja sale`.
- `t=4.83–5.04 s — arco sale`: el vídeo vuelve a escala 1.0 mientras el rosa se retira a los bordes (4 frames); stickers a 0 (2–3 frames cada uno).
- `t=5.17–5.25 s — el vídeo se encoge a tarjeta` (escala 1→0.85, borde negro, sombras desplazadas morada y rosa, sobre papel cuadriculado); `t=5.17–5.33 s — la tarjeta del B-roll cae desde arriba-izquierda` girando de ~-15° a 0° (4–5 frames) y aterriza centrada; estrellas amarillas 5.33–5.42.
- `t=5.46 — "in my closet right"` ("closet" bold); `~6.5 — "now."`; `~7.0 — "let me show you"` (hoja general).
- `t=7.21–7.42 s — la tarjeta del presentador cae desde arriba` (~-8° → 0°, 5 frames) tapando la del B-roll; `t=7.42–7.50 s — escala a pantalla completa` [dudoso].
- `t=7.50 — "a few of my favorite"` ("favorite" bold).
- `t=7.68–7.79 s — el vídeo se encoge` (1→0.75, 3–4 frames) y desaparece en 7.83; píldora azul 7.72.
- `t=7.83–7.92 s — starburst rosa aterriza`: escala ~1.15→0.85 (3 frames); `7.88 — píldora roja der.`; `t=7.96–8.04 s — "PROJECT" escala 0.6→1.0 dentro` (3 frames); decoraciones escalonadas: punto amarillo 7.96, contorno de rayo amarillo arriba-izq. 7.97–8.10, zigzag rosa der. 8.02, puntos azules 8.06, zigzag verde abajo-izq. 8.10–8.18, flor azul abajo-der. 8.18.
- `t=8.47 — "ways i've been"`; `~9.25 — "wearing it lately"` ("wearing" bold); fin 10.04.

#### Movimientos

##### Etiqueta "PROJECT" (t=0.125–0.29 entrada, 2.22–2.42 salida)
- Elemento: título (etiqueta)
- Entrada: la barra rosa crece en anchura desde su centro (scale-x 0.3→0.6→0.8→1.0, 4 frames, ~170 ms, ease-out); el texto escala dentro 0.4→0.8→1.0 (3 frames) empezando 2 frames después. Reposo con inclinación ~-3° y sombra dura negra.
- Vida: estática (comprobado 0.4/1.2/2.0).
- Salida: escala a 0 en 5 frames (2.22–2.42) mientras se desplaza a la esquina superior derecha; el texto se encoge antes que la barra [dudoso].
- Sincronía: independiente (arranca con el vídeo).
- Capas: encima del vídeo, arriba-izquierda.
- Tipografía: sans display bold blanca sobre rosa (~#E9A6D9), ~110 px.

##### Stickers (kit 1: t=0.10–0.39 / 2.25–2.46; kit 2: 2.50–2.85 / 4.58–5.04; tarjeta: 5.33–5.42; final: 7.88–8.18)
- Elemento: sticker
- Entrada: cada sticker escala 0→1 en ~3 frames (~125 ms), ease-out; sobrepaso ligero en la ráfaga roja (0.22–0.30) [dudoso]; escalonados 1–2 frames entre sí en orden aleatorio por el marco.
- Vida: estáticos; sin wiggle, rotación ni pulso (comprobado 1.0–2.17 s a 12 fps, tamaño constante). Excepción: la flecha verde del arco vuela hacia el caption encogiéndose (4.58–4.79, 5 frames).
- Salida: escala a 0 en ~5 frames (2.25–2.46: la ráfaga roja 1.0→0.85→0.6→0.35→0.15→0), ease-in, sin anticipación.
- Sincronía: independiente de la palabra; ligados a la entrada/salida de cada escena de gráficos.
- Capas: delante del vídeo y del marco; detrás del caption.

##### Caption en píldora (t=0.18–10.04)
- Elemento: caption (frase) con palabras clave
- Entrada: cambio de página instantáneo (1 frame): la píldora se redimensiona al ancho del texto sin animación (comprobado 1.08–1.29, 4 frames); sin bounce.
- Vida: estática, centrada a y≈68 %.
- Salida: corte.
- Sincronía: con la palabra hablada (páginas de 3–5 palabras).
- Capas: encima de todo.
- Tipografía: sans redondeada (tipo Nunito) negra sobre píldora blanca con borde negro y sombra dura desplazada; palabras clave en bold ("jacket cost", "$8", "thrift", "best", "closet", "favorite", "wearing"), mismo tamaño.

##### Arco rosa (t=2.50–2.71 entrada, 4.83–5.04 salida)
- Elemento: marco
- Entrada: el marco rosa (halftone de puntos) con ventana en forma de arco se cierra desde los cuatro bordes hasta su tamaño final en 5 frames (~210 ms), ease-out; el vídeo escala ~1.0→0.9 al mismo tiempo; contorno negro del arco más un segundo arco fino desplazado; banda inferior a cuadros morado/rosa.
- Vida: estático.
- Salida: inverso, 4 frames (4.83–5.00): el vídeo vuelve a 1.0 y el rosa retrocede a los bordes; restos en las esquinas hasta 5.04.
- Sincronía: entra con la página "store," (2.72), sale antes de "the best thing" → tarjeta.
- Capas: rosa delante del vídeo; stickers y caption encima.

##### Tarjeta de B-roll (t=5.17–5.33 entrada, 7.21–7.42 salida)
- Elemento: B-roll / marco / transición
- Entrada: 1) el vídeo del presentador se encoge a una tarjeta con borde negro y dos sombras desplazadas (morada izq., rosa der.) sobre papel cuadriculado (5.17–5.25, 3 frames); 2) la foto de la chaqueta cae desde fuera del borde superior izquierdo, rotando de ~-15° a 0° y desplazándose hacia el centro (5.17–5.33, 4–5 frames, ease-out), y aterriza encima; 3) estrellas amarillas escalan 5.33–5.42.
- Vida: estática (5.5 vs 7.1 sin cambios).
- Salida: la tarjeta del presentador cae desde arriba con el mismo mecanismo (~-8° → 0°, 5 frames, 7.21–7.42) tapando la foto; después escala a pantalla completa en ~2 frames (7.42–7.50) [dudoso].
- Sincronía: entra en "the best thing" → "in my closet"; sale con "let me show you" → "a few of my favorite".
- Capas: la tarjeta que cae siempre encima; el caption encima de ambas.

##### Tarjeta final starburst "PROJECT" (t=7.68–8.18)
- Elemento: título / fondo
- Entrada: el vídeo se encoge 1→0.75 en 3–4 frames y desaparece (7.68–7.83); el starburst rosa de 12 puntas aterriza escalando de ~1.15 a 0.85 en 3 frames (7.83–7.92, ease-out, efecto sello); "PROJECT" (sans display negra) escala 0.6→1.0 dentro en 3 frames (7.96–8.04); las decoraciones (contorno de rayo amarillo, zigzags rosa y verde, flor azul, puntos) entran escalonadas entre 7.96 y 8.18, cada una ~3 frames.
- Vida: estático hasta el final; el caption sigue debajo.
- Salida: ninguna (fin del vídeo).
- Sincronía: entra en "a few of my favorite".
- Capas: papel cuadriculado al fondo, decoraciones, starburst, texto; caption encima.

#### Transiciones entre tomas
No hay cortes secos. El B-roll entra (5.17–5.33) y sale (7.21–7.42) mediante "caída de tarjeta": la tarjeta nueva entra desde arriba con rotación (-15°/-8° → 0°) y aterriza sobre la anterior, 4–5 frames, sin desenfoque; el vídeo de base se encoge a ~0.85 (entrada) o vuelve a 1.0 (salida).

#### Cámara
Ninguno: sin zoom ni shake (comprobado 0.4/1.2/2.0, 0.5 vs 2.1, 5.5 vs 7.1). Los cambios de escala del vídeo son de layout (encoger a tarjeta / dentro del arco), no de cámara.

#### Firma del estilo
Todo aparece con pop de escala 0→1 en ~3 frames y escalonado (stickers, etiqueta, decoraciones) y se va encogiéndose a cero; los cambios de plano son tarjetas que caen girando y aterrizan; el starburst final llega como un sello (escala grande→normal). Nada se mueve mientras está en pantalla.

### Orbit

Duración 12.00 s (288 frames), 24 fps. Una sola toma del presentador (sin cortes secos; el cambio de escala inicial es un punch-in digital) más un B-roll (dos mujeres caminando por la calle) dentro de un círculo 4.26–6.55 y una tarjeta azul de texto 7.51–10.86. Todos los cambios de plano son wipes circulares.

Fuentes: `orbit-overview.jpg`, tiras `orbit-01…08`, recortes `orbit-z-*`.

#### Línea de tiempo
- `t=0.00 s — vídeo`: presentador; caption "making real friends" (píldora azul, serif blanca, "friends" en itálica).
- `t=0.33–0.67 s — punch-in`: la cámara acerca de ~1.0× a ~1.4× en 8 frames.
- `t=0.46–0.63 s — título "FRIENDS"`: desliza hacia abajo desde fuera del borde superior (5 frames, ~230 px); blanco roto, grotesca condensada extra-bold, de borde a borde.
- `t=0.97–1.04 s — página "as an adult feels"` (blur-in 3 frames); `~1.9 — "weirdly hard"`; `~2.75 — "right?"`; `3.04 — vacío`; `3.08–3.17 — "honestly"` (blur-in).
- `t=3.25–3.38 s — "FRIENDS" sale deslizando hacia arriba` (3–4 frames); `t=3.29–3.50 s — zoom-out` a ~1.15× (5–6 frames) [dudoso el valor final].
- `t=3.46–3.54 s — página "it's not just"` (blur cruzado); `~4.0 — "you"`.
- `t=4.18–4.35 s — disco gris claro entra desde la esquina inferior derecha` (4 frames); `t=4.26–4.72 s — B-roll revelado por círculo que crece desde el centro-izquierda` (~11 frames) hasta ~1000 px de diámetro; anillo azul fino descentrado que orbita despacio alrededor; `4.47–4.56 — "the thing is"` (blur-in).
- `t=5.08–5.17 — "closeness doesn't"` ("closeness" itálica); `5.83–5.92 — "come from hanging"` ("hanging" itálica).
- `t=6.42–6.55 s — el círculo del B-roll se encoge hacia arriba-izquierda hasta 0` (3–4 frames); `6.51–6.60 — "out more often"` (blur-in); `6.55–6.67 — gris vacío` (3 frames); `t=6.67–6.83 s — presentador revelado por círculo que crece desde abajo-izquierda` (4–5 frames).
- `t=7.51–7.85 s — disco azul entra desde la esquina superior derecha` (8 frames) con contornos de círculos blancos que viajan con él y quedan fijos; `7.68–7.80 — "IT COMES" fade-in`; `8.05–8.17 — "FROM CREATING" fade-in`; `8.63–8.76 — "MOMENTS" fade-in`; `~9.0–9.2 — bloque nuevo "THAT ACTUALLY" fade-in` [dudoso ±3 frames, hoja general]; `~9.75–10.0 — "MEAN SOMETHING" fade-in`.
- `t=10.60–10.86 s — el disco azul se retira hacia la esquina inferior izquierda` (7 frames); el texto de la tarjeta desaparece en el primer frame del wipe; `10.60–10.70 — "the kind you both"` (blur-in); `~11.4 — "remember later"` ("remember" itálica); fin 12.00.

#### Movimientos

##### Título "FRIENDS" (t=0.46–0.63 entrada, 3.25–3.38 salida)
- Elemento: título
- Entrada: slide desde arriba: en 0.46 solo se ve el 40 % inferior de las letras asomando por el borde, 60 % en 0.50, 80 % en 0.54, 95 % en 0.58, completo en 0.63. 5 frames (~210 ms), ~230 px de recorrido, ease-out (pasos 20/20/15/5 %).
- Vida: estático, pegado al borde superior, de borde a borde.
- Salida: slide hacia arriba, 3–4 frames (~150 ms), ease-in (3.25 leve, 3.29 mitad, 3.33 un tercio, 3.38 nada).
- Sincronía: independiente de la palabra; acoplado al punch-in de cámara (ver Cámara).
- Capas: delante del presentador.
- Tipografía: grotesca condensada extra-bold (tipo Druk), blanco roto (~#EDE9E3), ~230 px.

##### Caption en píldora con blur-in (todo el vídeo)
- Elemento: caption (frase) con palabras clave
- Entrada: 3 frames (~125 ms): frame 1 una mancha desenfocada (~30 px de blur) blanquecina y algo mayor; frame 2 texto legible pero suave y píldora azul claro; frame 3 nítido y azul definitivo. Es blur-in + fade + cambio de color, sin desplazamiento ni escala apreciable.
- Vida: estática, centrada a y≈68 %.
- Salida: al cambiar de página la píldora anterior se difumina 1 frame y la nueva entra con su blur-in (cruce de 2–3 frames: 3.46–3.54, 5.83–5.92); a veces 1 frame vacío antes (3.04).
- Sincronía: con la palabra hablada (páginas de 2–3 palabras).
- Capas: encima de todo, incluido el B-roll circular y la tarjeta.
- Tipografía: serif (tipo Cormorant) blanca sobre píldora azul real (~#2B5BB5) con contorno blanco fino; palabras clave en itálica ("friends", "adult", "hard", "closeness", "hanging", "remember"), mismo tamaño.

##### Transición circular al B-roll (t=4.18–4.72)
- Elemento: transición / B-roll
- Entrada: 1) un disco gris claro (~#E7E7E7) entra desde fuera de la esquina inferior derecha y cubre el cuadro en 4 frames (4.18–4.35), ease-out; 2) desde 4.26 el B-roll aparece dentro de un círculo que crece desde el centro-izquierda hasta ~1000 px de diámetro en ~11 frames (4.26–4.72), ease-out marcado (la mitad del tamaño en los 4 primeros frames). Total ~13 frames (~540 ms).
- Vida: círculo fijo (5.0 vs 6.25 sin cambio de tamaño ni zoom del B-roll); un anillo azul fino, algo mayor que el círculo y descentrado, orbita despacio (su arco visible pasa de abajo-izquierda a abajo-derecha en 1.25 s, ~70°/s) [dudoso el periodo].
- Salida: el círculo se encoge hacia la esquina superior izquierda hasta 0 en 3–4 frames (6.42–6.55, ease-in); fondo gris 3 frames; el presentador vuelve revelado por un círculo que crece desde la esquina inferior izquierda en 4–5 frames (6.67–6.83, ease-out). Total ~10 frames (~420 ms).
- Sincronía: entra en "you" → "the thing is"; sale en "come from hanging" → "out more often".
- Capas: gris al fondo, B-roll en el círculo, anillo encima del gris, caption encima de todo.

##### Tarjeta azul de texto (t=7.51–7.85 entrada, 10.60–10.86 salida)
- Elemento: fondo + título (líneas de texto)
- Entrada: disco azul (~#1F4FA3) que entra desde fuera de la esquina superior derecha y cubre el cuadro en 8 frames (7.51–7.85), ease-out; lleva adheridos contornos de círculos blancos finos (decoración) que se detienen con él y quedan estáticos (comprobado 7.9–9.9).
- Vida: las líneas de texto entran una a una con fade de azul claro a blanco en 4 frames (~170 ms), sin desplazamiento: "IT COMES" 7.68, "FROM CREATING" 8.05, "MOMENTS" 8.63; el bloque se sustituye por "THAT ACTUALLY" ~9.0 (fade 4 frames) y "MEAN SOMETHING" ~9.75 [dudoso ±3 frames]. Texto centrado, grotesca condensada bold, blanco roto.
- Salida: el disco se retira hacia la esquina inferior izquierda en 7 frames (10.60–10.86), ease-in; el texto desaparece de golpe en el primer frame del wipe.
- Sincronía: entra en "out more often" → "IT COMES"; sale con "the kind you both".
- Capas: tarjeta delante del vídeo; caption (píldora) encima de la tarjeta al salir.

#### Transiciones entre tomas
No hay cortes secos. Cuatro wipes circulares: 4.18–4.35 disco gris desde abajo-derecha (4 frames); 4.26–4.72 círculo del B-roll creciendo desde centro-izquierda (11 frames, escala 0→1); 6.42–6.55 círculo del B-roll encogiendo a arriba-izquierda (3–4 frames) + 6.67–6.83 círculo del presentador creciendo desde abajo-izquierda (4–5 frames); 7.51–7.85 disco azul desde arriba-derecha (8 frames); 10.60–10.86 disco azul retirándose a abajo-izquierda (7 frames). Sin desenfoque direccional.

#### Cámara
- Punch-in digital 0.33–0.67: ~1.0× → ~1.4× en 8 frames (~330 ms), ease-in-out; empieza 3 frames antes de que el título entre y termina 1 frame después de que se asiente.
- Zoom-out 3.29–3.50: de ~1.4× a ~1.15× en 5–6 frames, ease-out, acoplado a la salida del título [dudoso el valor final; comparado con t=0 la cara queda algo mayor].
- Sin zoom en el B-roll ni en la tarjeta (5.0 vs 6.25, 7.0 vs 7.45, 11.0 vs 11.9); sin shake ni desenfoque de foco.

#### Firma del estilo
Círculos: cada cambio de plano es un disco que entra o se retira por una esquina, el B-roll vive dentro de un círculo con un anillo fino que lo orbita, y las píldoras de caption entran con blur-in. El título de apertura baja desde el borde superior acoplado a un punch-in de cámara.

### Y2K

Duración 10.04 s (241 frames), 24 fps, 1080×1920. Fondo de estilo crema (#F4F5D2 aprox.). Una sola grabación de la presentadora; no hay cortes de metraje sino cambios de *layout*:

- t=0.08–2.96 — collage de móviles antiguos (la presentadora se ve dentro de las pantallas) → zoom a través de un iPhone → presentadora a cuadro completo.
- t=3.00–3.88 — barrido radial que sustituye a la presentadora por fondo crema + ventana de B-roll (noria).
- t=4.96–5.63 — la ventana sale, barrido radial que devuelve a la presentadora.
- t=5.79–6.46 — mosaico → layout de dos ventanas (presentadora arriba, B-roll tótem abajo).
- t=9.17–9.83 — las ventanas salen + mosaico → presentadora a cuadro completo.
- f240 (t=10.00) — frame negro final.

#### Línea de tiempo
- t=0.00–0.08 s — fondo: crema vacío (2 frames).
- t=0.08–0.50 s — collage: los móviles se ensamblan por pasos (ver movimiento 1).
- t=0.50–0.71 s — título "Summer" (script itálica amarilla) entra sobre los móviles inferiores.
- t=0.67 s — caption "nobody" (f16); "talks" f23 (0.96); "about" ~f30 (1.25); "the" f33 (1.38); "art" f35 (1.46).
- t=1.79 s — cambio de página: "installations" (f43); "at" ~f57 (2.38); "coachella," f61 (2.54).
- t=2.25–2.96 s — zoom a través del iPhone (f54–71): el collage crece hasta que la pantalla del móvil llena el cuadro.
- t=3.00–3.88 s — barrido radial 1 (f72–93), de las 12 en sentido horario: crema sustituye a la persona.
- t=3.08–3.50 s — ventana B-roll (noria) entra desde la derecha con estela de copias (f74–84); las copias se recogen f87–95.
- t=3.17 s — página "but" (f76); "they" f80 (3.33); "are" f85 (3.54); "everything" f95 (3.96).
- t=4.96–5.21 s — la ventana sale hacia la izquierda dejando 5 copias (f119–125).
- t=5.08–5.63 s — barrido radial 2 (f122–135) revela a la persona.
- t=5.17 s — página "giant" (f124); "sculptures," f131 (5.46); "surreal" ~f163 (6.79); "vibes" ~7.25.
- t=5.79–6.46 s — mosaico de cuadrados crema (f139–155).
- t=6.04–6.67 s — layout 2: ventana B-roll (tótem) entra desde la izquierda con estela; ventana de la persona entra desde arriba-derecha con estela; se asientan ~f158–160.
- t=7.67 s — página "perfect" (f184); "for" f193 (8.04); "a" f196 (8.17); "fit" f198 (8.25); "pic" f203 (8.46); "that looks" ~f214 (8.9).
- t=9.17–9.42 s — las dos ventanas salen con estela en escalera (f220–226); página "like" (f220); "a fever" f226 (9.42); "dream" f235 (9.79).
- t=9.38–9.83 s — mosaico 2 (f224–236) revela a la persona.
- t=9.96 s — frame negro (f240).

#### Movimientos

##### Ensamblado del collage de móviles (t=0.08–0.50)
- Elemento: fondo / marco (collage de ~15 móviles con la presentadora en las pantallas)
- Entrada: por pasos discretos, cada 2 frames (12 fps efectivos: f4=f5, f6=f7, f8=f9…). 5 pasos entre f2 y f12 (t=0.08–0.50, 10 frames, 420 ms). En cada paso aparece un grupo nuevo de móviles y el conjunto se desplaza ~80–170 px hacia abajo hasta asentarse. Sin easing (stop-motion). [dudoso] la dirección exacta de cada grupo; no es un zoom (el tamaño de los móviles no cambia).
- Vida: estático (t=0.50–2.25); las pantallas reproducen el vídeo de la presentadora.
- Salida: por el zoom a través del iPhone (t=2.25–2.96); los móviles salen del cuadro al escalar.
- Sincronía: independiente (antes de la primera palabra).
- Capas: es el fondo; la caption va encima.

##### Título "Summer" (t=0.50–0.71)
- Elemento: título
- Entrada: fade-in con un ligero estiramiento horizontal que se aprieta (~1.15× → 1.0 en anchura) [dudoso: podría ser desenfoque de movimiento horizontal]; 6 frames (f12–17, 250 ms), ease-out suave. Sin desplazamiento vertical.
- Vida: estático, pegado a la capa del collage (se mueve con ella).
- Salida: sale del cuadro arrastrado por el zoom del collage (t=2.25–2.6, f54–60).
- Sincronía: independiente de la voz.
- Capas: sobre los móviles inferiores, debajo de la caption.
- Tipografía: script itálica amarilla (#EEFF3A aprox.), ~120 px.

##### Captions palabra a palabra (primera en t=0.67)
- Elemento: caption (frase)
- Entrada: cada palabra aparece con un fade de ~2 frames (80 ms) (medido en "talks" f23 tenue → f24 sólido; "everything" f95 → f96). Sin desplazamiento, sin escala. La frase se acumula palabra a palabra en 1–2 líneas.
- Vida: estático; no hay tratamiento de palabra clave (todas iguales, mismo tamaño y color).
- Salida: cambio de página en seco (f42 "…about the art" → f43 "installations"), sin hueco; la nueva página empieza con su primera palabra en fade.
- Sincronía: con la palabra hablada.
- Capas: delante de todo. Posición: arriba (y≈330 px) en las tomas 1–2; en el layout 1 abajo-izquierda sobre la ventana (y≈1100); en el layout 2 centrada sobre la ventana de B-roll (y≈820).
- Tipografía: sans bold amarilla (#F0FF00 aprox.), ~52 px, sin contorno ni fondo.

##### Zoom a través del iPhone (t=2.25–2.96)
- Elemento: cámara / transición
- Entrada: escala del collage 1× → ~5× centrada en el iPhone con la cara (f54–71, 17 frames, 700 ms); el móvil, inclinado ~−25°, gira hasta 0° mientras crece; en f66 (t=2.75) la pantalla llena el cuadro y quedan los bordes negros del bisel, que salen por los lados hasta f71. Ease-in (arranca lento, acelera) [dudoso].
- Vida: —
- Salida: termina en la presentadora a cuadro completo (f71).
- Sincronía: independiente (ocurre en mitad de "installations at coachella").
- Capas: la caption queda fija en pantalla (no escala con el collage).

##### Barrido radial 1 (t=3.00–3.88)
- Elemento: transición
- Entrada: cuña que nace en las 12 en punto con pivote en el centro del cuadro y gira en sentido horario hasta cubrir 360°; f72–93, 21 frames (875 ms); velocidad aproximadamente lineal.
- Vida: mientras gira, la ventana de B-roll ya entra por la derecha (f74).
- Salida: termina con el fondo crema completo (f93).
- Sincronía: independiente de la palabra; coincide con la nueva página "but".
- Capas: el crema va por encima de la persona; la ventana por encima del crema.

##### Ventana B-roll (noria) entra con estela (t=3.08–3.96)
- Elemento: marco / B-roll (ventana con cromo estilo Mac OS clásico: barra gris con botones rojo/amarillo/verde y un cursor flecha en la barra)
- Entrada: slide desde fuera del borde derecho hasta el centro, f74–84 (10 frames, 420 ms), ease-out. Deja 4 copias "eco" desfasadas ~40 px hacia abajo-derecha (estela tipo arrastre de ventana). Las copias se recogen una a una entre f87 y f95 (t=3.63–3.96).
- Vida: estática hasta t=4.96.
- Salida: slide hacia la izquierda fuera de cuadro, f119–125 (6 frames, 250 ms), dejando 5 copias eco a su derecha que se quedan hasta que el barrido radial 2 las borra.
- Sincronía: entra con "but"; sale justo antes de "giant".
- Capas: sobre el fondo crema; la caption encima de la ventana.

##### Barrido radial 2 (t=5.08–5.63)
- Elemento: transición
- Entrada: cuña con pivote en el centro que arranca hacia las 2–3 en punto [dudoso el punto de arranque] y gira en sentido horario hasta cerrarse en las 12; f122–135, 13 frames (540 ms).
- Vida: revela a la presentadora a cuadro completo sobre el crema y las copias de la ventana.
- Salida: termina en f135 (persona a cuadro completo).
- Sincronía: coincide con "giant sculptures,".
- Capas: la persona sustituye al crema.

##### Mosaico 1 (t=5.79–6.46)
- Elemento: transición
- Entrada: cuadrados color crema que crecen desde puntos, en rejilla de ~6 columnas [dudoso], f139–147 (8 frames, 330 ms) hasta llenar cada celda; 1–2 frames de hold; luego encogen hasta desaparecer f148–155 (8 frames). Crecimiento aproximadamente lineal.
- Vida: mientras encogen ya se ve debajo el layout 2 entrando.
- Salida: los cuadrados desaparecen en f155.
- Sincronía: independiente (la caption "giant sculptures," se mantiene en su sitio durante toda la transición).
- Capas: los cuadrados van por encima de todo salvo la caption.

##### Layout 2: dos ventanas entran con estela (t=6.04–6.67)
- Elemento: marco / B-roll (ventana tótem abajo, ventana con la presentadora arriba, una ventanita tipo tira de miniaturas a la derecha)
- Entrada: la ventana de B-roll entra desde el borde izquierdo hacia el centro (f145–158) con copias eco a su izquierda; la ventana de la presentadora entra desde arriba-derecha (f147–156) con copias eco en escalera; ease-out. Las copias se recogen hacia f160 (t=6.67).
- Vida: estático (t=6.67–9.17); sin deriva, sin zoom.
- Salida: t=9.17–9.42 (f220–226): la ventana de B-roll sale hacia arriba-derecha y la de la persona hacia la derecha, dejando estelas en escalera (copias desfasadas en diagonal); 7 frames.
- Sincronía: entra con "surreal", sale con "like".
- Capas: sobre crema; caption sobre la ventana de B-roll.

##### Mosaico 2 (t=9.38–9.83)
- Elemento: transición
- Entrada: igual que el mosaico 1: cuadrados crema crecen f224–230, encogen f231–236 (12–13 frames en total, algo más rápido que el primero); debajo aparece la presentadora a cuadro completo.
- Salida: f236; después "like a fever dream" hasta f239 y frame negro en f240.
- Sincronía: solapa con la salida de las ventanas.

#### Transiciones entre tomas
- t=2.25–2.96 — zoom a través de la pantalla del móvil (escala ~5× + rotación −25°→0°), 17 frames.
- t=3.00–3.88 — barrido radial (clock wipe) horario desde las 12, pivote central, 21 frames, sin escala.
- t=5.08–5.63 — barrido radial horario (arranca hacia las 2–3, cierra en las 12) [dudoso], 13 frames.
- t=5.79–6.46 — mosaico de cuadrados crema (crecen 8 frames, encogen 8 frames), sin dirección.
- t=9.38–9.83 — mosaico, ~12 frames.
- Ventanas: entran/salen con slide + estela de copias (6–10 frames).

#### Cámara
- Zoom de la capa del collage (t=2.25–2.96, 17 frames, 1×→~5× con rotación). Ningún punch-in, zoom lento ni shake sobre el metraje real. Sin desenfoques.

#### Firma del estilo
Ventanas de sistema operativo retro que se arrastran dejando una estela de copias, barridos radiales tipo reloj y mosaicos de píxeles crema; collage de móviles a 12 fps efectivos con un título script que se "aprieta" al entrar. Las captions son mínimas: amarillo bold, palabra a palabra, sin palabra clave.

### Form

Duración 11.96 s (287 frames), 24 fps, 1080×1920. Paleta: naranja (#D9502E aprox.), amarillo título, blanco. Cortes / cambios de toma:

- t=0.00–7.88 — presentador en gimnasio (una sola grabación): cuadro completo 0–4.46, layout dividido 4.46–7.33, cuadro completo 7.33–7.88.
- t=7.88–9.63 — B-roll zapatillas en pista a cuadro completo (entra con disolución de partículas f189–195).
- t=9.63–9.92 — presentador (entra con partículas f230–233).
- t=9.92–11.92 — fondo blanco con patrón "RESULTS" (entra con partículas f238–244); f287 (t=11.96) frame negro.

#### Línea de tiempo
- t=0.00 s — título "RESULTS" (amarillo, bold itálica, arriba-izquierda) y persianas naranjas ya presentes en f0.
- t=0.17 s — caption "what's up," (f4; "up," en bold itálica mayor).
- t=0.33–0.75 s — el título se desmonta letra a letra desde la S (f8–18).
- t=0.50–0.75 s — las persianas se ensanchan hasta cubrir el cuadro (f12–17); "team?" (f12).
- t=0.75–0.96 s — las barras se retiran (f18–21) y el presentador reaparece con desenfoque de movimiento horizontal que se resuelve en f19–23.
- t=1.08 s — "quick truth bomb" (f26, todo bold itálica).
- t=1.75 s — "for you today." (f42); t=1.79–1.92 s aparecen 2–3 líneas verticales naranjas finas en los bordes (f43–46), que se quedan.
- t=2.50 s — "motivation is" (f60); t=3.21 s "overrated." (f77); t≈3.75 s "the guys who actually".
- t=4.46–4.79 s — layout dividido entra (f107–115): la persona se encoge con márgenes naranjas, el B-roll cuadrado sube desde abajo.
- t=4.83 s — "get results aren't" (f116); t≈5.75 "more motivated"; t≈6.25 "than you."; t≈6.75 "they just show".
- t=7.21–7.42 s — layout dividido sale (f173–178); "up on the days" (f173).
- t=7.88–8.13 s — disolución en partículas de izquierda a derecha hacia el B-roll (f189–195); "they don't feel" (f189).
- t=8.54 s — "like it." (f205); t≈9.25 s "discipline beats".
- t=9.58–9.71 s — vuelve el presentador con borde de partículas (f230–233).
- t=9.83 s — "hype every single" (f236).
- t=9.92–10.17 s — el fondo blanco con patrón "RESULTS" entra con borde de partículas de izquierda a derecha (f238–244).
- t≈10.9 s — "time."; t=11.50 s — "let's get to work" (f276).
- t=11.96 s — negro (f287).

#### Movimientos

##### Título "RESULTS" (t=0.00–0.75)
- Elemento: título
- Entrada: no visible (ya está completo en f0).
- Vida: estático f0–f7.
- Salida: las letras desaparecen de la última a la primera, cada una escalando a 0 en ~2 frames, con ~1.5 frames entre letras: S f8–10, T f10–12, L f12–13, U f14, S f15–16, E f16–17, R f17–18 (t=0.33–0.75, 11 frames, 460 ms). Lineal.
- Sincronía: coincide con "team?".
- Capas: delante de la persona y de las persianas.
- Tipografía: sans bold itálica amarilla, ~150 px, alineada arriba-izquierda.

##### Persianas naranjas (t=0.00–0.96)
- Elemento: marco / transición (barras verticales naranjas de anchos distintos, la persona se ve por las rendijas)
- Entrada: ya presentes en f0; estáticas f0–f11 (comparado f0/f6/f11).
- Vida: f12–f17 (t=0.50–0.71) las barras se ensanchan hasta cubrir casi todo el cuadro (6 frames).
- Salida: f18–f21 (t=0.75–0.88) se retiran en bloques hacia ambos lados [dudoso el sentido por bloque]; el presentador reaparece con desenfoque de movimiento horizontal (~60 px) que se resuelve en 5 frames (f19–23, t=0.79–0.96).
- Sincronía: con "team?".
- Capas: delante de la persona, debajo del título y de la caption.

##### Líneas verticales finas (t=1.79 → fin)
- Elemento: marco
- Entrada: 2–3 líneas verticales naranjas de ~4 px aparecen en los bordes izquierdo/derecho en f43–46 (t=1.79–1.92), sin animación visible (aparecen en 1–2 frames).
- Vida: estáticas; persisten sobre el B-roll y como margen del layout dividido.
- Salida: ninguna vista (siguen hasta el fondo blanco).

##### Captions por página (primera en t=0.17)
- Elemento: caption (frase)
- Entrada: la página entera aparece a la vez con fade + blur-in de 3 frames (125 ms) (medido en "let's get to work" f276 borroso ~8 px y tenue → f277 → f278 nítido); entre páginas hay 1–3 frames en blanco (f59, f76, f274–275). Sin desplazamiento ni escala.
- Vida: estático.
- Salida: corte (desaparece en 1 frame).
- Sincronía: con la frase hablada.
- Capas: delante de todo. Posición y≈0.72 en cuadro completo; sobre la línea de división (y≈0.68) en el layout dividido.
- Tipografía: sans regular blanca ~48 px; palabras clave en bold itálica ~1.3–1.5× ("up,", "quick truth bomb", "motivation", "overrated.", "get results", "show", "up", "discipline beats", "hype", "get to work"); sobre el fondo blanco final el texto lleva sombra suave.

##### Layout dividido entra (t=4.46–4.79)
- Elemento: marco / B-roll
- Entrada: en f107 el B-roll (zapatillas) asoma por el borde inferior y sube hasta su sitio en ~9 frames (f107–115, 375 ms) con ease-out claro (40 px, 20, 15, 10… por frame a escala 180). El cuadro de la persona se encoge dejando márgenes naranjas de ~120 px en 2–3 frames (f107–109) [dudoso].
- Vida: estático; en la banda naranja inferior hay un patrón de "RESULTS" en contorno que deriva hacia la derecha ~60–80 px/s (comparado f116/f140/f164).
- Salida: f173–178 (t=7.21–7.42, 6 frames): el cuadro de la persona escala a cuadro completo y el B-roll baja fuera de cuadro.
- Sincronía: entra con "get results aren't"; sale con "up on the days".
- Capas: B-roll delante de la banda naranja; caption delante de todo.

##### Disolución en partículas (t=7.88–8.13, 9.58–9.71, 9.92–10.17)
- Elemento: transición
- Entrada: la capa saliente se desintegra en polvo/partículas de izquierda a derecha; la capa entrante aparece por la izquierda. Primera (persona → B-roll): f189–195, 7 frames (290 ms); la capa de la persona parece encogerse hacia la derecha mientras se desintegra [dudoso]. Segunda (B-roll → persona): f230–233, 4 frames (170 ms). Tercera (persona → fondo blanco): f238–244, 7 frames.
- Sincronía: primera con "they don't feel", tercera con "hype every single".
- Capas: las partículas van por encima de ambas capas; la caption por encima de las partículas.

##### Fondo blanco con patrón "RESULTS" (t=9.92–11.92)
- Elemento: fondo
- Entrada: por la disolución en partículas (7 frames).
- Vida: filas de "RESULTS" en gris claro sobre blanco roto; deriva horizontal lenta ~50 px/s (comparado f264/f285) [dudoso el sentido por fila].
- Salida: corte a negro en f287.
- Capas: fondo; caption con sombra encima.

#### Transiciones entre tomas
- t=0.50–0.96 — persianas naranjas que cierran y abren + whip blur horizontal (~10 frames en total, sin escala). Es una transición "sobre sí misma" (misma toma).
- t=4.46–4.79 — cambio a layout dividido: slide del B-roll desde abajo, 9 frames, ease-out.
- t=7.21–7.42 — vuelta a cuadro completo, 6 frames.
- t=7.88–8.13 — disolución en partículas izquierda→derecha, 7 frames.
- t=9.58–9.71 — partículas izquierda→derecha, 4 frames.
- t=9.92–10.17 — partículas izquierda→derecha, 7 frames.
- t=11.96 — corte a negro.

#### Cámara
- Desenfoque de movimiento horizontal en el reveal inicial (t=0.79–0.96, ~60 px → 0 en 5 frames). Ningún punch-in, zoom lento ni shake en el resto.

#### Firma del estilo
Persianas naranjas que cierran con whip blur, título que se desmonta letra a letra desde el final, y disoluciones en partículas (arena) de izquierda a derecha; captions por página con blur-in y palabras clave en bold itálica.

### Bloom

Duración 10.00 s (240 frames), 24 fps, 1080×1920. Una sola toma de la presentadora (fondo terracota), sin cortes de metraje; el B-roll es una foto de producto. Cambios de layout:

- t=0.00–5.79 — cuadro completo con título y arco de contorno.
- t=5.83–7.92 — fondo blanco, persona recortada en una cápsula, tarjeta de producto (sérum) abajo-derecha.
- t=7.92–8.00 — cuadro completo nítido (2–3 frames).
- t=8.04–10.00 — metraje desenfocado, etiqueta "MOISTURIZE" arriba, caption centrada.

#### Línea de tiempo
- t=0.00–0.08 s — persona a cuadro completo, sin gráficos (f0–2).
- t=0.125–0.42 s — título "MOISTURIZE / Routine" baja desde fuera del cuadro y se funde (f3–10); el arco de contorno aparece en fade en el mismo tramo.
- t=0.75 s — "This" (f18); "is" f25 (1.04); "the" ~f28; "serum" (grande) f33 (1.375); "that" f42 (1.75); "keeps" f48 (2.0); "selling" (grande) f54 (2.25).
- t=2.71 s — página "out." (f65) y el título empieza a salir (fade + sube) f65–73; el arco empieza a expandirse.
- t≈3.5 s — el arco ya sólo se ve como curvas arriba y abajo (f84).
- t≈3.6 s — "and" ; t≈3.9 "honestly" (línea 2).
- t=4.125 s — página vacía (f99–101); t=4.25 s "I get" (f102); "it." f108 (4.5).
- t≈5.2–5.6 s — "One" ; "pump" (grande) ~f130 (5.4).
- t=5.83 s — fondo blanco en 1 frame (f140); la cápsula escala hasta su tamaño final f140–147; etiqueta vertical "MOISTURIZE" f142; la tarjeta del producto sube f142–147.
- t≈5.9 s "morning" (grande); t≈6.4 "and"; t≈6.5 "night," (grande).
- t≈6.9 s — "and my" (f166); "dark" (grande) f168 (7.0); "spots" (grande) f176 (7.33); "had" f184 (7.67).
- t=7.71–7.92 s — la cápsula se expande a cuadro completo y la tarjeta se va (f185–190).
- t=8.04 s — la caption salta al centro, aparece "MOISTURIZE" pequeño arriba y una línea corta debajo (f193); el metraje se desenfoca progresivamente f193–200.
- t≈8.1 s "visibly" (grande); t=8.42 s "faded" (grande, f202).
- t≈9.0 s — página "in less" (f216); "than" f222 (9.25); "a" f226; "month" (grande) f229 (9.54).

#### Movimientos

##### Título "MOISTURIZE / Routine" (t=0.125–0.42)
- Elemento: título (dos líneas: "MOISTURIZE" sans marrón oscuro ~110 px; "Routine" script clara debajo)
- Entrada: fade-in + slide hacia abajo desde fuera del borde superior (~180 px), f3–10 (8 frames, 330 ms), ease-out.
- Vida: estático hasta t=2.71.
- Salida: fade-out + slide hacia arriba (inverso de la entrada), f65–73 (9 frames, 375 ms).
- Sincronía: independiente (entra antes de la primera palabra; sale con la página "out.").
- Capas: delante de la persona.

##### Arco de contorno (t=0.125–5.7)
- Elemento: marco (línea fina clara con forma de cápsula/arco: parte superior redondeada, inset ~40 px del borde)
- Entrada: fade-in junto al título, f3–10 (8 frames). Tamaño constante durante la entrada. El metraje no está enmascarado en esta fase (fuera del arco se ve el mismo vídeo).
- Vida: estático hasta t=2.71. Desde f65 (t=2.71) se expande más allá del cuadro durante ~20 frames (hasta ~f84, t=3.5): sólo quedan visibles la curva superior (y≈0.1) y la inferior (y≈0.9); se mantiene así hasta t≈5.2; entre f125 y f136 (t≈5.2–5.67) vuelve a crecer y sale del cuadro [dudoso el detalle de esta segunda expansión].
- Salida: sale del cuadro al expandirse (~f136); en f140 la cápsula reaparece ya como máscara (ver layout).
- Sincronía: la expansión arranca con la página "out.".
- Capas: delante de la persona, detrás de la caption.

##### Captions palabra a palabra (primera en t=0.75)
- Elemento: caption (frase) / palabra clave
- Entrada: cada palabra entra con fade + blur-in de ~3 frames (125 ms) (medido en "serum": f33 tenue y borrosa → f34 → f35 → f36 nítida). Sin desplazamiento ni escala (la palabra ya tiene su tamaño final en el primer frame).
- Vida: estático. Palabras clave en el mismo blanco pero ~1.5× más grandes y con peso mayor ("serum", "selling", "pump", "morning", "night", "dark", "spots", "visibly", "faded", "month"); "month" va en una línea propia alineada a la izquierda.
- Salida: cambio de página en seco (f65) o con hueco de ~3 frames (f99–101).
- Sincronía: con la palabra hablada.
- Capas: delante de todo. Posición: centrada en y≈0.68 (cuadro completo); abajo-izquierda dentro de la cápsula en el layout de producto; centrada en y≈0.5 en el layout desenfocado.
- Tipografía: sans blanca fina ~40 px; clave ~60 px.

##### Layout cápsula + producto entra (t=5.83–6.13)
- Elemento: marco / B-roll (foto del sérum en una tarjeta con esquinas muy redondeadas, ligeramente girada) / fondo
- Entrada: el fondo blanco aparece en 1 frame (f139 → f140) [dudoso: podría ser un fade de 1–2 frames]; en f140 la persona ya está recortada en una cápsula casi del tamaño del cuadro que escala hacia abajo hasta su tamaño final (inset ~90 px por lado, ocupa el 75 % superior) en ~8 frames (f140–147, 330 ms), ease-out. La etiqueta vertical "MOISTURIZE" (girada 90°, borde derecho) aparece en f142. La tarjeta del producto sube desde el borde inferior derecho ~1/3 de la altura en ~6 frames (f142–147), ease-out, solapando la cápsula.
- Vida: estático (t=6.13–7.7); la foto del producto no se mueve.
- Salida: t=7.71–7.92 (f185–190, 6 frames): la cápsula se expande hasta llenar el cuadro (las esquinas redondeadas se ven salir por los bordes) mientras la tarjeta encoge y baja hacia la esquina inferior derecha (f184–189).
- Sincronía: entra con "pump morning"; sale con "had".
- Capas: fondo blanco < cápsula (persona) < tarjeta de producto < caption.

##### Layout desenfocado final (t=8.04–10.00)
- Elemento: fondo / cámara
- Entrada: en f193 (t=8.04) la caption salta de y≈0.7 a y≈0.5 en 1 frame (sin deslizamiento visible) [dudoso]; aparece "MOISTURIZE" pequeño arriba-centro con fade de 2 frames (f193–194) y una línea horizontal corta debajo de la caption (y≈0.72). El metraje se desenfoca progresivamente en ~7 frames (f193–200, 290 ms) hasta un soft-focus fuerte (~25 px estimado) y se aclara ligeramente. El cuadro queda con una banda gris clara arriba (~195 px) [dudoso: bordes redondeados].
- Vida: fondo desenfocado estático (la persona sigue moviéndose detrás, difusa).
- Salida: termina el vídeo (f239).
- Sincronía: entra con "visibly".
- Capas: metraje desenfocado < etiqueta, caption y línea.

#### Transiciones entre tomas
- No hay cortes de metraje. Transiciones de layout: máscara cápsula que escala (8 frames, ease-out) al entrar y se expande (6 frames) al salir; fondo blanco en 1 frame; desenfoque progresivo de 7 frames al final. Sin wipes, sin partículas.

#### Cámara
- Desenfoque progresivo (focus-out) t=8.04–8.33, ~7 frames. No se aprecia punch-in, zoom lento ni shake [dudoso: un zoom muy lento no se detectaría a 180 px].

#### Firma del estilo
Un arco de contorno fino que respira (aparece con el título, se expande fuera del cuadro y vuelve como máscara-cápsula sobre fondo blanco con la tarjeta de producto), captions finas con la palabra clave grande que entra con blur, y un cierre en soft-focus con etiqueta y línea editorial.

### Chalk

Duración 10.04 s (241 frames), 24 fps, 1080×1920. Una toma de la presentadora (exterior, ciudad) reutilizada en tres layouts, más dos B-roll (foto de café en plaza, foto de atardecer). Cambios:

- t=0.00–5.4 — presentadora a cuadro completo (título "YOUTH", captions manuscritas, contorno amarillo desde t=2.5).
- t=5.17–5.83 — transición a pizarra oscura (frotado + fundido).
- t=5.5–7.5 — pizarra: captions manuscritas, garabatos amarillos, foto B-roll con borde garabateado (t=6.0–7.46).
- t=7.5–8.2 — vuelve la presentadora (la pizarra baja).
- t=8.125–10.0 — layout papel crema: vídeo de la presentadora en un marco pequeño inclinado con cinta, B-roll atardecer abajo con borde amarillo, garabatos.

#### Línea de tiempo
- t=0.00–0.17 s — persona sin gráficos (f0–3).
- t=0.17–0.46 s — título "YOUTH" ×3 líneas se escribe de izquierda a derecha (f4–11).
- t=0.75 s — "i don't" (f18); t=0.83 s "take" amarillo (f20) + etiqueta negra (f21); t=0.96 s "photos" (f23, etiqueta después).
- t=1.42 s — "when" en etiqueta (f34); t=1.875 s "travel" amarillo en etiqueta (f45).
- t=2.08–2.33 s — el título se borra de izquierda a derecha (f50–56); las etiquetas negras desaparecen f52–53 y el texto f55–56.
- t=2.50 s — contorno amarillo alrededor de la persona (f60, en 1 frame).
- t=2.71–2.83 s — etiqueta "sit" crece desde un punto (f65–68); "down," f70 (2.92); t≈3.5 "open"; ≈3.75 "notebook"; ≈4.25 "and draw"; ≈4.5 "whatever's"; ≈5.0 "in front of"; ≈5.25 "me.".
- t=5.17–5.33 s — frotado oscuro entra desde arriba-izquierda (f124–128); t=5.375–5.83 fundido a pizarra (f129–140), las captions previas desaparecen en f130.
- t=5.50 s — "the" amarillo (f132); t=5.58–5.79 garabato ondulado se dibuja (f134–139); "quick" f136 (5.67); "and" f140 (5.83); "awning," f145 (6.04).
- t=6.00–6.375 s — foto B-roll se revela de arriba abajo con borde rasgado y borde amarillo dibujado (f144–153).
- t=6.375 s — página "the" (f153); "untouched" f156 (6.5); "coffee" amarillo en etiqueta f167 (6.96).
- t=7.29–7.46 s — la foto cae por el borde inferior (f175–179).
- t=7.50–7.71 s — la pizarra baja y revela a la persona (f180–185).
- t=7.92 s — "it" con rotulador amarillo (f190); t=8.04 "takes" (f193) + subrayado dibujado f193–197.
- t=8.125–8.42 s — layout papel: lavado crema (f195–198), marco pequeño con cinta arriba (f195–201), B-roll atardecer entra desde la derecha (f199–203); "longer" en rotulador f197 (8.21).
- t=8.625–8.71 s — el rotulador de "longer" se apaga (f207–209); t=8.83 s la caption desaparece (f212).
- t=9.08 s — "that's" en rotulador (f218); t=9.29 "why" (f223, el rotulador pasa a "why"); t=9.5 "i" (f228); t=9.54 "do" (f229); t≈9.75 "it.".

#### Movimientos

##### Título "YOUTH" ×3 (t=0.17–0.46)
- Elemento: título (tres filas de "YOUTH" en fuente tiza blanca; la 1.ª por encima de la cabeza, la 2.ª y 3.ª detrás de la persona)
- Entrada: escritura/revelado de izquierda a derecha (las letras aparecen rellenas de tiza en orden Y→O→U→T→H), ~6 frames por fila, con filas escalonadas ~2 frames: fila 1 f4–8, fila 2 f6–9, fila 3 f8–11 (t=0.17–0.46) [dudoso el escalonado exacto]. Sin easing apreciable.
- Vida: estático (t=0.46–2.08).
- Salida: borrado de izquierda a derecha: cada letra pasa a contorno y desaparece, f50–56 (7 frames, 290 ms).
- Sincronía: independiente (entra antes de la primera palabra; sale entre "travel" y la página siguiente).
- Capas: fila 1 delante; filas 2–3 detrás de la persona (recorte de persona).

##### Captions manuscritas con etiquetas (primera en t=0.75)
- Elemento: caption (frase) / palabra clave
- Entrada: cada palabra aparece con fade de ~2 frames (80 ms); las palabras clave van en amarillo (~1.3×) y reciben una etiqueta negra redondeada 1–2 frames después de la palabra ("take" texto f20, etiqueta f21); la etiqueta aparece ya a tamaño completo [dudoso: pop de 1 frame]. Algunas palabras no clave también llevan etiqueta ("photos", "when", "me."). Las palabras están inclinadas ±5° y colocadas de forma dispersa (no centradas); el grupo se recentra ligeramente al añadir palabras [dudoso].
- Vida: estático (sin wiggle apreciable en las palabras).
- Salida: al final de página las etiquetas negras desaparecen primero (f52–53) y el texto 2–3 frames después (f55–56).
- Sincronía: con la palabra hablada.
- Capas: delante de la persona.
- Tipografía: manuscrita tipo rotulador; blanco para el texto, amarillo (#FFE600 aprox.) para claves; etiqueta negra al 85 %.

##### Contorno amarillo de la persona (t=2.50–5.4)
- Elemento: sticker / marco (línea garabateada amarilla siguiendo la silueta: pelo y hombros)
- Entrada: aparece completa en 1 frame (f59 → f60), sin animación de dibujo.
- Vida: "boil": se redibuja cada frame con pequeñas variaciones y sigue el movimiento de la persona (recorte).
- Salida: se va con la transición a pizarra (~f130).
- Sincronía: entra con "sit".
- Capas: detrás de la persona, delante del fondo.

##### Etiqueta "sit" (t=2.71–2.83)
- Elemento: palabra clave
- Entrada: la etiqueta negra crece desde un punto (escala 0→1) en ~3 frames (f65–67), después aparece "sit" en amarillo (f68). Ease-out.
- Vida / Salida: como el resto de captions.

##### Transición a pizarra (t=5.17–5.83)
- Elemento: transición / fondo
- Entrada: una mancha oscura de borde suave (frotado de tiza) entra desde la esquina superior izquierda y cubre la banda superior en 5 frames (f124–128); desde f129 la textura de pizarra (gris carbón) se funde por encima de la persona: crossfade de ~10–12 frames (f129–140); las captions de la página anterior desaparecen en f130; el fantasma de la persona se ve hasta ~f140.
- Sincronía: coincide con el final de "me." y la palabra "the".
- Capas: la pizarra cubre todo; las nuevas captions van encima.

##### Garabato ondulado (t=5.58–5.79)
- Elemento: sticker (línea ondulada amarilla)
- Entrada: se dibuja de izquierda a derecha en ~5 frames (f134–139).
- Vida: boil ligero.
- Salida: desaparece con el cambio de página / la llegada de la foto (~f153).

##### Foto B-roll con borde rasgado (t=6.00–7.46)
- Elemento: B-roll (foto de café en plaza, inclinada ~−5°)
- Entrada: revelado de arriba abajo con borde inferior ondulado/rasgado, ~9 frames (f144–153, 375 ms); a la vez se dibuja un borde garabateado amarillo alrededor en sentido horario (arriba → derecha → abajo → izquierda), en el mismo tramo.
- Vida: estática; el borde amarillo hace boil (se redibuja cada frame).
- Salida: cae por el borde inferior con desenfoque de movimiento vertical, ~5 frames (f175–179, t=7.29–7.46).
- Sincronía: entra con "awning,"; sale antes de "it takes".
- Capas: sobre la pizarra, debajo de las captions.

##### Pizarra sale (t=7.50–7.71)
- Elemento: transición
- Entrada: la pizarra desaparece de arriba abajo (la persona se revela desde el borde superior) en ~6 frames (f180–185, 250 ms) [dudoso: máscara que baja o la capa que se desliza]. Las captions "the untouched coffee" se quedan en su sitio hasta f183 y desaparecen.
- Sincronía: independiente.

##### Rotulador amarillo y subrayado (t=7.92–8.21)
- Elemento: palabra clave / sticker
- Entrada: el cajetín amarillo de rotulador crece detrás de "it" (f190–191) y de "takes" (f193–194) en 2 frames; un subrayado amarillo se dibuja de izquierda a derecha en 5 frames (f193–197); aparecen doodles (marca ✓, nube) dibujados en f195–197.
- Vida: en el layout papel, el rotulador funciona tipo karaoke: sólo la última palabra clave lo lleva; "longer" se apaga en 3 frames (f207–209, amarillo → oliva → gris); "that's" se enciende en 2 frames (f218–219, gris → amarillo) y lo pierde cuando llega "why" (f223).
- Capas: rotulador detrás del texto, delante del papel.

##### Layout papel (t=8.125–8.42)
- Elemento: fondo / marco / B-roll
- Entrada: lavado a papel crema en ~4 frames (f195–198) mientras el vídeo de la persona se reduce a un marco pequeño inclinado (~−5°) arriba-izquierda con una tira de cinta azul-gris en el borde superior (f195–201) [dudoso: escala vs. recorte]; el B-roll atardecer entra desde el borde derecho hasta abajo-centro en ~4 frames (f199–203) con ease-out, con borde de tiza amarilla; doodle de nube abajo-izquierda y carita sonriente a la derecha del marco.
- Vida: estático; los bordes amarillos hacen boil; el vídeo sigue reproduciéndose dentro del marco pequeño.
- Salida: termina el vídeo.
- Sincronía: entra con "longer".
- Capas: papel < B-roll / marco < doodles < caption.

#### Transiciones entre tomas
- t=5.17–5.83 — frotado oscuro desde arriba-izquierda (5 frames) + fundido a pizarra (~11 frames), sin escala.
- t=6.00–6.375 — revelado de la foto de arriba abajo con borde rasgado, 9 frames.
- t=7.29–7.46 — la foto cae hacia abajo con motion blur, 5 frames.
- t=7.50–7.71 — la pizarra se retira de arriba abajo, 6 frames.
- t=8.125–8.42 — lavado a papel (4 frames) + slide del B-roll desde la derecha (4 frames).

#### Cámara
- Ninguna: sin punch-in, zoom ni shake. Sólo el motion blur de la foto al caer (t=7.29–7.46).

#### Firma del estilo
Todo parece dibujado a mano: título de tiza que se escribe y se borra de izquierda a derecha, palabras inclinadas con etiquetas negras y rotulador amarillo que salta a la última palabra clave, y contornos/bordes garabateados amarillos que "hierven" frame a frame; la foto B-roll se revela con borde rasgado y cae fuera del cuadro.

### Linen

Duración 10.04 s (241 frames), 24 fps, 1080×1920. Paleta: beige/crema (#E8E3D1 aprox.), verde grisáceo (#9AA69A aprox.), malva oscuro para los títulos, cajas de caption melocotón. Una toma de la presentadora (interior) y dos B-roll (flat-lay de ropa doblada; perchero). Tomas / layouts:

- t=0.00–3.25 — presentadora a cuadro completo, título "WEAR / your style" (t=0.21–2.67).
- t=3.00–3.46 — transición: panel beige diagonal sube + crossfade al layout 1.
- t=3.46–5.67 — layout 1: B-roll flat-lay cuadrado sobre fondo verde grisáceo, banda beige diagonal con "Just dropped".
- t=5.67–6.00 — transición: crossfade a la persona + el panel beige baja.
- t=6.00–7.0 — presentadora a cuadro completo.
- t=7.00–7.63 — barrido diagonal: el B-roll perchero entra desde arriba-izquierda.
- t=7.63–9.25 — layout 2: B-roll perchero arriba (≈72 %), banda verde grisácea abajo con la persona en el tramo izquierdo.
- t=9.25–9.67 — barrido diagonal inverso: la persona vuelve a cuadro completo (el B-roll se lava a crema mientras sale).
- t=9.67–10.04 — presentadora a cuadro completo.

#### Línea de tiempo
- t=0.00–0.13 s — persona sin gráficos (f0–3).
- t=0.17 s — caption "If your wardrobe" (f4) en caja melocotón, fade de 3 frames.
- t=0.21–0.42 s — título "WEAR" (serif malva) entra con fade + sube ~100 px (f5–10).
- t=0.46–0.54 s — "your style" (itálica serif crema) entra con fade (f11–13).
- t=0.875 s — página "needs a reset," (f21): el texto cambia con crossfade de ~3 frames dentro de la misma caja.
- t≈1.9 s — "watch this." (f45).
- t≈2.17–2.33 s — "WEAR" se funde a nada (f52–56) [dudoso el frame de inicio]; t≈2.5–2.67 s "your style" se funde (f60–64).
- t=3.00–3.33 s — panel beige diagonal sube desde la esquina inferior izquierda (f72–80).
- t=3.17 s — "watch this." desaparece (f76); t=3.21 s "A new collection" (f77) y "Just dropped" (f77–82) entran en fade.
- t=3.25–3.46 s — crossfade de la persona al B-roll flat-lay con fondo verde grisáceo (f78–83).
- t≈4.25 s "just dropped,"; ≈4.75 "and it's full"; ≈5.25 "of effortless".
- t=5.67–5.83 s — crossfade B-roll → persona (f136–140); "Just dropped" se funde (f137–141).
- t=5.79–6.00 s — el panel beige baja fuera de cuadro hacia abajo-derecha (f139–144).
- t=5.92 s — "staples you can" (f142).
- t≈6.7 s — "wear every day.".
- t=7.00–7.63 s — barrido diagonal descendente: el B-roll perchero entra desde arriba-izquierda (f168–183).
- t=7.67 s — "wear every day." desaparece (f184); t=7.875 s "I already found" (f189).
- t=8.50 s — "a few pieces I'm" (f204).
- t=9.25–9.67 s — barrido diagonal ascendente: la persona vuelve a cuadro completo (f222–232); el B-roll se lava a crema durante el barrido.
- t=9.50 s — "obsessed with" (f228).
- t=10.04 s — fin (f240).

#### Movimientos

##### Título "WEAR / your style" (t=0.21–2.67)
- Elemento: título (dos líneas: "WEAR" serif alta en malva oscuro ~170 px; "your style" itálica serif crema ~80 px debajo)
- Entrada: "WEAR" fade-in + slide hacia arriba ~100 px, f5–10 (6 frames, 250 ms), ease-out; "your style" fade-in f11–13 (3 frames) [dudoso si también se desplaza]. Ambas líneas quedan centradas arriba (y≈0.06 y ≈0.13).
- Vida: estático (t=0.54–2.17).
- Salida: fade-out escalonado: "WEAR" f52–56 (5 frames), "your style" f60–64 (5 frames). Sin desplazamiento visible.
- Sincronía: independiente de la voz (sale durante "watch this.").
- Capas: delante de la persona.

##### Captions por página en caja (primera en t=0.17)
- Elemento: caption (frase)
- Entrada: la frase entera aparece a la vez con fade de ~3 frames (125 ms), caja y texto juntos (f4–6). En el cambio de página la caja se mantiene y el texto se cruza en ~3 frames (f20–22 "If your wardrobe" → "needs a reset,"). Sin desplazamiento, sin escala.
- Vida: estático; no hay palabra clave (todas las palabras iguales).
- Salida: fade de 2–3 frames o corte al cambiar de layout (f76, f184).
- Sincronía: con la frase hablada.
- Capas: delante de todo. Posición: y≈0.72 en cuadro completo (persona); y≈0.15 arriba del B-roll en los layouts 1 y 2.
- Tipografía: serif itálica marrón oscuro ~46 px en caja melocotón (#F1D9C6 aprox.) con padding ~20 px, esquinas rectas.

##### Panel beige diagonal + "Just dropped" (t=3.00–6.00)
- Elemento: marco / título
- Entrada: el panel (banda tipo paralelogramo, inclinada ~10°, crema) sube desde la esquina inferior izquierda hasta cubrir el 35 % inferior, f72–80 (8 frames, 330 ms), ease-out. "Just dropped" (serif malva grande, dos líneas, alineado a la izquierda) entra con fade f77–82 (5 frames) sobre el panel, sin desplazamiento.
- Vida: estático (t=3.46–5.67).
- Salida: "Just dropped" se funde f137–141 (5 frames) y el panel baja hacia abajo-derecha fuera de cuadro f139–144 (5–6 frames, ~230 ms), ease-in.
- Sincronía: entra al terminar "watch this."; sale con "staples you can".
- Capas: delante del B-roll y del fondo; el B-roll cuadrado queda por encima del panel donde se solapan.

##### Layout 1: B-roll flat-lay (t=3.25–5.83)
- Elemento: B-roll / fondo
- Entrada: crossfade de la persona (cuadro completo) al conjunto B-roll cuadrado (inset ~70 px, con marco verde claro de ~20 px) sobre fondo verde grisáceo, f78–83 (5 frames, 210 ms). Sin escala ni desplazamiento: la foto ya está en su sitio, sólo se funde.
- Vida: estática.
- Salida: crossfade inverso a la persona, f136–140 (5 frames).
- Sincronía: entra con "A new collection".
- Capas: fondo verde < panel beige < B-roll cuadrado < caption.

##### Barrido diagonal al layout 2 (t=7.00–7.63)
- Elemento: transición / B-roll (perchero)
- Entrada: un borde diagonal inclinado ~20° (más alto a la derecha) baja desde la esquina superior izquierda; por encima entra el B-roll del perchero. El extremo izquierdo del borde va de y=0.1 (f168) a y≈0.95 (f182); el derecho de y=0 (f171) a y≈0.65; ~14 frames (580 ms), casi lineal con frenada al final. Al final queda la banda verde grisácea inferior con la persona en el tramo izquierdo (paralelogramo x 0–0.6, y 0.73–1.0) [dudoso: si el borde de cabecera de los primeros 3 frames es beige o el propio B-roll].
- Vida: layout estático (t=7.63–9.25).
- Salida: barrido inverso f222–232 (10 frames, 420 ms): la región de la persona crece hacia arriba-derecha con la misma inclinación; el B-roll se lava a crema (f226–231) mientras es cubierto; en f232 la persona ocupa todo el cuadro. Ease-in-out.
- Sincronía: entra con "wear every day."; sale con "obsessed with".
- Capas: B-roll < banda verde < persona (dentro de la banda) < caption.

#### Transiciones entre tomas
- t=3.00–3.46 — panel beige diagonal que sube (8 frames) + crossfade persona → B-roll (5 frames); sin escala.
- t=5.67–6.00 — crossfade B-roll → persona (5 frames) + panel beige que baja (5–6 frames).
- t=7.00–7.63 — wipe diagonal descendente (~20°), 14 frames, sin escala.
- t=9.25–9.67 — wipe diagonal ascendente, 10 frames, con lavado a crema del B-roll saliente.

#### Cámara
- Ninguna: sin punch-in, zoom lento, shake ni desenfoques (comparadas las tomas de la persona al inicio y al final).

#### Firma del estilo
Geometría editorial suave: bandas diagonales beige y verde grisáceo que suben, bajan y barren a ~20°, títulos serif que sólo se funden (nunca rebotan) y captions en caja melocotón por página, sin palabra clave.

### Evo

Duración 10.03 s, 30 fps (301 frames). Tomas: una sola toma continua del presentador (no hay cortes secos); un B-roll (mano con teléfono) entra en un layout dividido de t=2.77 a t=7.37 s. Fuentes: `evo-overview.jpg` (4 fps) y tiras a 30 fps `evo-apertura`, `evo-bank`, `evo-losing-split`, `evo-inflation`, `evo-shrinks`, `evo-outline-investing`, `evo-flip`; detalles a resolución completa `evo-z-title`, `evo-z-bank`, `evo-z-flip`.

#### Línea de tiempo
- t=0.00–0.07 s — vídeo: plano limpio a pantalla completa, sin gráficos (2 frames).
- t=0.07–0.33 s — marco: el vídeo se encoge hacia un recuadro de esquinas redondeadas sobre un fondo degradado azul (8–9 frames).
- t=0.10–0.27 s — título "THE KEYS TO INVESTING": blur-in + fade en la parte baja del recuadro (5 frames).
- t=0.30 s — caption "If" aparece arriba dentro de una caja de cristal esmerilado; "Your" 0.43, "Money" (palabra clave) 0.53, "Is" 0.80.
- t=0.90 s — cambio de página: "Sitting"; "In" 1.13; "Your" 1.20.
- t=1.37 s — cambio de página: "Bank" (palabra clave, grande); "Account" 1.53; "It's" 1.83; "Actually" 2.07.
- t=2.43–2.53 s — título: fade out (3–4 frames).
- t=2.47 s — cambio de página: "Losing" (la caja pasa a la mitad del cuadro); "Value" 2.70; "Every" 3.07.
- t=2.50–2.63 s — marco: el vídeo vuelve a escala 1.0 y el fondo azul desaparece (4 frames).
- t=2.60 s — fondo: banda diagonal azul aparece en la esquina superior derecha; t=2.77 la zona inferior se vuelve blanca y aparece una banda rosa abajo a la izquierda.
- t=2.77–3.13 s — B-roll teléfono: pop desde un punto junto a la cabeza hasta ocupar el tile superior (11 frames).
- t=2.97–3.55 s — presentador: pasa a un tile pequeño en la mitad inferior, creciendo desde muy pequeño hasta su tamaño final (~17 frames).
- t=3.30 s — página "Year"; "Because" 3.47; "Of" 3.70; "Inflation." 3.77 (palabra clave).
- t=5.00–6.75 s — páginas "That Means What It Can Buy Slowly" (una palabra cada ~0.25 s, según la hoja general); layout dividido estático.
- t=6.93 s — página "Shrinks" (palabra clave); "Over" 7.23; "Time." 7.43.
- t=7.07–7.37 s — B-roll teléfono: escala a 0 (9 frames).
- t=7.13 s — el vídeo del presentador a pantalla completa aparece detrás; t=7.23–7.50 el tile del presentador (con borde oscuro redondeado) escala a 0 (8 frames); bandas azul y rosa salen 7.23–7.40.
- t=7.77–8.13 s — marco: contorno fino azul→violeta se dibuja desde el borde derecho (11 frames) y sigue creciendo lentamente.
- t=8.40 s — página "Investing" (palabra clave; la caja baja al 72 % de la altura); "Is" 9.00; "How" 9.10; "You" 9.23.
- t=9.40 s — página "Flip" (palabra clave); "That." 9.60.
- t=9.80–9.83 s — contorno: sale del cuadro por expansión.
- t=10.03 s — fin.

#### Movimientos

##### Encogimiento del vídeo dentro del marco azul (t=0.07–0.33)
- Elemento: marco / fondo
- Entrada: el vídeo escala de 1.0 a ~0.85 y queda en un recuadro con esquinas redondeadas y un borde interior azul claro sobre un degradado azul; 8–9 frames (~280 ms); ease-out (los primeros frames mueven más); tira `evo-apertura` f2–f10.
- Vida: estático hasta t=2.50.
- Salida: el vídeo escala de ~0.85 a 1.0 en 4 frames (t=2.50–2.63, ~130 ms), ease-in/out corto; el fondo azul queda tapado por el vídeo. Tira `evo-losing-split` f7–f9.
- Sincronía: con el arranque del vídeo; la salida coincide con la página "Losing".
- Capas: el fondo detrás del vídeo; el vídeo completo (persona incluida) es lo que escala.

##### Título "THE KEYS TO INVESTING" (t=0.10–2.53)
- Elemento: título
- Entrada: blur-in + fade (desenfoque ~15 px→0 estimado, opacidad 0→1), 5 frames (t=0.10–0.27, ~170 ms), ease-out; sin desplazamiento apreciable. Detalle `evo-z-title`.
- Vida: estático, blanco, itálica bold, dos líneas, centrado en la parte baja del recuadro.
- Salida: fade out de 3–4 frames (t=2.43–2.53, ~120 ms), justo antes de que el vídeo vuelva a escala 1.0. Tira `evo-losing-split` f4–f7.
- Sincronía: independiente de la voz; entra con el marco y sale con el cambio de sección.
- Capas: delante de la persona, dentro del recuadro del vídeo.

##### Caja de captions de cristal (t=0.30 en adelante)
- Elemento: caption (frase)
- Entrada: aparece con la primera palabra de la página; la caja redondeada translúcida (blur del vídeo detrás, tipo glassmorphism) ya tiene el ancho de toda la línea final ("Flip" y "Flip That." comparten caja, detalle `evo-z-flip`). Cada palabra nueva entra con un blur-in/fade de ~2 frames (~67 ms): "Money" f16 borroso → f17 nítido en `evo-apertura`; "That." gris translúcido → blanco en 2 frames en `evo-z-flip`.
- Vida: las palabras se acumulan a medida que se dicen; las ya dichas se quedan blancas; sin karaoke de color.
- Salida: corte (la página desaparece en 1 frame y la siguiente aparece con blur-in de 1–2 frames).
- Sincronía: con la palabra hablada.
- Capas: delante de la persona; en el split, centrada entre los dos tiles.
- Posición por sección: arriba del recuadro (t=0.30–2.43, ~12 % de altura), centro del cuadro (t=2.47–8.13, ~47 %), tercio inferior (t=8.40–10.0, ~72 %). El cambio de posición ocurre por corte entre páginas, no por desplazamiento.

##### Palabra clave en la caption (t=0.53 "Money", 1.37 "Bank", 3.77 "Inflation.", 6.93 "Shrinks", 8.40 "Investing", 9.40 "Flip")
- Elemento: palabra clave
- Entrada: blur-in de 1–2 frames (~33–67 ms) en el sitio, sin escala ni desplazamiento visibles; `evo-bank` f8→f9 ("Bank" borroso → nítido), `evo-inflation` f11→f13.
- Vida: estática, bold itálica, ~1.6× el tamaño de las palabras normales, blanca con sombra suave; el resto de la página se escribe en fino y pequeño a su derecha o debajo.
- Salida: corte con la página.
- Sincronía: con la palabra hablada.
- Capas: sobre la caja de cristal.

##### Bandas diagonales del layout dividido (t=2.60–7.40)
- Elemento: fondo
- Entrada: t=2.60 aparece una banda azul inclinada (~45°) en la esquina superior derecha; t=2.77 el fondo bajo se vuelve blanco y aparece una banda rosa inclinada en la esquina inferior izquierda; entran por fade/deslizamiento corto de 3–4 frames [dudoso: a 180 px no se distingue fade de slide]. Tira `evo-losing-split` f9–f15.
- Vida: estáticas.
- Salida: desaparecen en 4–5 frames (t=7.23–7.40): la azul se va a f13 de `evo-shrinks` (7.33), la rosa a f15 (7.40) [dudoso: fade o slide].
- Sincronía: con el cambio de sección.
- Capas: detrás de los dos tiles.

##### Pop del B-roll (teléfono) al tile superior (t=2.77–3.13)
- Elemento: B-roll
- Entrada: escala desde ~0 (un punto a la derecha de la cabeza, f14 de `evo-losing-split`) hasta el tile superior con esquinas redondeadas y un borde azul claro; 11 frames (~370 ms); ease-out sin rebote visible [dudoso: f25 y f29 tienen el mismo tamaño].
- Vida: estático (sin zoom lento apreciable entre t=3.4 y 6.9).
- Salida: escala a 0 hacia su esquina superior izquierda en 9 frames (t=7.07–7.37, ~300 ms), ease-in (acelera). Tira `evo-shrinks` f5–f13.
- Sincronía: entra con "Losing Value", sale con "Shrinks".
- Capas: sobre las bandas; el B-roll no tapa a la persona (ella pasa al tile inferior).

##### Presentador al tile inferior (t=2.97–3.55) y de vuelta a pantalla completa (t=7.13–7.50)
- Elemento: cámara / marco
- Entrada: el vídeo del presentador aparece como un tile pequeño en la mitad inferior a t=2.97 y crece hasta su tamaño final a ~t=3.55 (~17 frames, ~570 ms), ease-out largo; el tile tiene esquinas redondeadas y borde rosa claro. Tiras `evo-losing-split` f20–f29 y `evo-inflation` f0–f5.
- Vida: estático.
- Salida: a t=7.13 el vídeo completo del presentador ya se ve detrás; el tile (mismo vídeo a otra escala, con borde oscuro semitransparente) escala a 0 en 8 frames (t=7.23–7.50, ~270 ms), ease-in. Tira `evo-shrinks` f10–f17.
- Sincronía: con el cambio de sección ("Losing" / "Shrinks").
- Capas: el tile delante del fondo; el vídeo completo detrás de todo.

##### Contorno azul→violeta que se dibuja (t=7.77–9.83)
- Elemento: marco
- Entrada: un trazo fino (degradado azul arriba, violeta/rosa abajo) aparece como línea vertical en el borde derecho (f2 de `evo-outline-investing`, t=7.77), el borde superior se dibuja hacia la izquierda (llega a la esquina izquierda en f9, t=8.00) y el lado izquierdo baja (completo en f13, t=8.13): ~11 frames (~370 ms) de dibujo de línea; mientras se dibuja el rectángulo también escala hacia fuera (el borde superior pasa de y≈19 % a y≈8 % de la altura entre 7.77 y 8.37).
- Vida: sigue expandiéndose lentamente durante toda la sección (borde superior de ~8 % a ~2 % entre t=8.4 y 9.6): zoom-out continuo del contorno.
- Salida: sale del cuadro al seguir expandiéndose (t=9.80–9.83, borde superior cruza el límite). Tira `evo-flip` f24–f25.
- Sincronía: independiente de la voz; arranca tras "Shrinks Over Time."
- Capas: delante de la persona.

#### Transiciones entre tomas
No hay cortes entre tomas del presentador. El cambio de layout a split (t=2.50–3.55) y de vuelta (t=7.07–7.50) hace de transición: escala del vídeo 0.85→1.0 (4 frames), pop del B-roll desde un punto (11 frames), crecimiento del tile del presentador (~17 frames); salida por escala a 0 de los dos tiles (9 y 8 frames). Ningún desenfoque direccional.

#### Cámara
- t=0.07–0.33 y 2.50–2.63: escala del vídeo completo (0.85 y vuelta), no punch-in sobre la persona.
- t=2.97–3.55 / 7.23–7.50: el presentador escala como tile.
- Ningún punch-in, shake ni focus pull.

#### Firma del estilo
Captions en cajas de cristal esmerilado con blur-in por palabra y palabras clave en bold itálica grande; layouts que se montan con escalas (pop desde un punto, vídeo que se encoge en un marco azul) y un contorno fino que se dibuja y se expande lentamente.

### Focus

Duración 9.96 s, 24 fps (239 frames). Tomas: 2 cambios de plano por transición de franjas — presentador → plano de dos personas (t=3.40–4.07, plano nuevo visible desde 3.73) y de vuelta al presentador (t=5.48–6.02, visible desde 5.77) — más un layout dividido con B-roll de teléfono a t=7.21 (el presentador no cambia de toma). Fuentes: `focus-overview.jpg` y tiras a 24 fps `focus-apertura`, `focus-band-exit`, `focus-trans1`, `focus-frame`, `focus-trans2`, `focus-split`, `focus-opportunities`; detalles `focus-z-slide`, `focus-z-page`.

#### Línea de tiempo
- t=0.00–0.46 s — vídeo limpio, sin gráficos.
- t=0.47–0.58 s — banda azul con el título "FOLLOWERS" sube desde el borde inferior (4 frames).
- t=0.63 s — caption "you don't": "you" con caja translúcida 1 frame → caja blanca; la caja se desliza a "don't" 0.71–0.79; "actually" 0.84; caja a "actually" 0.97–1.00.
- t=1.50 s — página "need"; "more" 1.75; "followers" 2.00.
- t=2.71 s — caption desaparece; t=2.71–2.83 la banda baja y sale (4 frames).
- t=2.88 s — página "you" (caja blanca); "just" 3.00 (caja se desliza 3.00–3.04); "need" 3.17.
- t=3.33 s — página "More": 1 frame gris, luego caja AZUL con texto blanco (cambio de color de la caja para el resto del vídeo).
- t=3.40–4.07 s — transición de franjas apiladas hacia arriba: cubren 3.40–3.73, revelan el plano de dos personas 3.73–4.07. "Real" 3.50 (caja 3.61); "Conversations" 3.82 (caja 3.98).
- t=4.57–4.73 s — marco azul grueso: línea izquierda 4.57, marco completo 4.61, el vídeo se encoge un poco hasta 4.73.
- t=4.94 s — caption desaparece; t=5.36 página "Like" (más abajo).
- t=5.48–6.02 s — transición de franjas hacia abajo: el marco se engrosa 5.48–5.52, franjas bajan 5.57–5.73, revelan al presentador desde arriba 5.77–6.02. "Dm" ~5.5; "People" 5.86 (caja 6.02).
- t=6.25–7.17 s — "Be Genuine" (caja en "Genuine").
- t=7.21–7.33 s — split: el B-roll del teléfono sube desde abajo y el presentador se encoge al tile superior (3–4 frames). "Add" 7.25 (gris) → caja 7.29; "Value" 7.46.
- t=7.5–9.75 s — split estático: "That's" ~8.5; "Where" 8.58; página "Opportunities" 8.71 (gris) → caja 8.75; "Actually" 9.29; "Come" ~9.5; "From" ~9.75.
- t=9.96 s — fin.

#### Movimientos

##### Banda de título "FOLLOWERS" (t=0.47–2.83)
- Elemento: título
- Entrada: slide desde abajo; una banda azul plana sube desde el borde inferior hasta ~22 % de altura en 4 frames (t=0.47–0.58, ~170 ms), ease-out; el texto "FOLLOWERS" (bold blanco, centrado) sube con la banda y se ve recortado por su borde superior mientras entra (f5–f7 de `focus-apertura`).
- Vida: estático.
- Salida: slide hacia abajo, 4 frames (t=2.71–2.83, ~170 ms), ease-in; el texto se va con la banda. Tira `focus-band-exit` f5–f8.
- Sincronía: entra ~0.15 s antes de la primera caption, sale al terminar la página "need more followers".
- Capas: delante de la persona, ocupa todo el ancho.

##### Caption con caja que se desliza entre palabras (t=0.63–3.33, estilo blanco)
- Elemento: caption (frase) / palabra clave
- Entrada: la frase entera de la página no aparece de golpe: las palabras aparecen al decirse; la primera palabra entra con una caja gris translúcida que en 1 frame (~40 ms) se vuelve blanca sólida (`focus-z-slide` f16→f17).
- Vida: karaoke por caja: la caja blanca se desliza horizontalmente hasta la palabra que se dice (2 frames de viaje, ~80 ms, t=0.71–0.79 y 0.97–1.00), el texto dentro de la caja se vuelve negro y la palabra anterior vuelve a blanco. Las palabras nuevas aparecen sin animación visible [dudoso: en `focus-z-slide` "actually" parece 1 frame oscura antes de blanca].
- Salida: corte (la página desaparece; hay 1 frame vacío antes de la siguiente en `focus-opportunities` f4 y f18).
- Sincronía: con la palabra hablada.
- Capas: delante de la persona, justo encima de la banda de título.

##### Caption con caja azul (t=3.33 en adelante)
- Elemento: caption (frase) / palabra clave
- Entrada: la página nueva aparece 1 frame en gris translúcido y al siguiente con caja azul (#3B5BFF aprox.) y texto blanco (`focus-z-page` f208→f209, ~40 ms).
- Vida: igual que arriba, la caja se desliza a la palabra hablada (2 frames); palabras pasadas y futuras en blanco.
- Salida: corte.
- Sincronía: con la palabra hablada.
- Capas: delante de la persona, sobre la transición de franjas (la caption sigue visible mientras las franjas cubren el cuadro, `focus-trans1` f3–f8) y, en el split, en la frontera entre los dos tiles.
- Posición: bajo el pecho (~74 %) en el plano del presentador; en "Like" (t=5.36) baja al ~85 %; en el split queda en el centro (~50 %).

##### Marco azul grueso (t=4.57–5.52)
- Elemento: marco
- Entrada: a t=4.57 se ve solo una línea vertical azul en el borde izquierdo; a t=4.61 el marco completo (1 frame de wipe de izquierda a derecha o escala desde el borde [dudoso]); durante 4.61–4.73 (3 frames) el vídeo se encoge un poco dentro del marco (borde ~4 % del ancho).
- Vida: estático.
- Salida: no sale: a t=5.48–5.52 el borde superior se engrosa y se convierte en la primera franja de la transición.
- Sincronía: entra medio segundo después del corte al plano de dos personas.
- Capas: delante de todo, el vídeo queda inset.

##### Split con B-roll de teléfono (t=7.21–7.33)
- Elemento: B-roll / marco
- Entrada: el B-roll sube desde el borde inferior (slide) y ocupa la mitad baja, mientras el vídeo del presentador se encoge hacia el tile superior; los dos tiles quedan separados por márgenes azules; 3–4 frames (t=7.21–7.33, ~150 ms), ease-out rápido (f5 15 %, f6 40 %, f7 casi colocado, f8 fijo en `focus-split`).
- Vida: ambos tiles estáticos (sin zoom lento visible entre 7.5 y 9.75).
- Salida: se queda hasta el final.
- Sincronía: con "Add".
- Capas: fondo azul detrás, caption entre los dos tiles.

#### Transiciones entre tomas
- t=3.40–4.07 (16 frames): franjas horizontales apiladas en tres tonos (azul vivo, azul medio, azul marino) que suben desde el borde inferior; cubren el plano viejo en ~8 frames (3.40–3.73) y, al seguir subiendo, revelan el plano nuevo desde abajo en otros ~8 (3.73–4.07). Dirección: abajo→arriba. Sin escala ni desenfoque; velocidad casi lineal [dudoso: leve ease-in-out].
- t=5.48–6.02 (13 frames): la misma pila de franjas pero de arriba→abajo; el marco azul grueso se engrosa y se funde con las franjas (5.48–5.57), cubren 5.57–5.73, revelan al presentador desde arriba 5.77–6.02. Sin escala.
- t=7.21: no es corte, es el split (ver arriba).

#### Cámara
- Ningún punch-in ni zoom lento; el vídeo solo se encoge levemente al recibir el marco (4.61–4.73) y al pasar a tile (7.21–7.33). Sin shake ni focus pull.

#### Firma del estilo
Caja de resaltado que se desliza de palabra en palabra (karaoke por caja, 2 frames de viaje) y transiciones de franjas apiladas en tres azules que barren verticalmente alternando dirección; título en banda que sube y baja por slide.

### Lift

Duración 10.04 s, 24 fps (241 frames). Tomas: 4 cambios, todos por barrido diagonal poligonal — presentador → B-roll de dashboard (t=3.52–3.77), B-roll → presentador (5.67–5.88), presentador → tarjeta de título "Faster Decisions" (6.81–7.02), tarjeta → presentador (8.90–9.06). Fuentes: `lift-overview.jpg` y tiras a 24 fps `lift-apertura`, `lift-title-exit`, `lift-trans1`, `lift-trans2`, `lift-card`, `lift-card-exit`.

#### Línea de tiempo
- t=0.00–0.46 s — vídeo limpio.
- t=0.47–0.71 s — polígono menta barre desde la esquina inferior derecha hasta la franja superior (6 frames), asienta a 0.75.
- t=0.47 s — caption "What's" (caja menta, 1 frame tenue); "slowing" 0.63 (tenue) → caja 0.79–0.83; "your" 1.04 (2.ª línea); "team" 1.13 → caja 1.17–1.21; "down?" ~1.50.
- t=0.58–0.67 s — título "Your Team" (serif blanca) fade-in dentro del polígono (3 frames).
- t=1.75 s — página "It's"; "not" 2.24 → caja 2.33; "effort," 2.50 → caja 2.62.
- t=2.37–2.62 s — polígono + título salen por arriba (7 frames).
- t=2.95 s — caja de "effort," se apaga; "it's" 3.08 (2.ª línea, caja); "visibility." ~3.25 (caja).
- t=3.52–3.77 s — barrido diagonal desde abajo-derecha: entra el B-roll (dashboard) arriba con un polígono verde oscuro abajo (7 frames).
- t=3.90–4.07 s — caption se apaga (fade 4 frames); t=4.36 página "When" (caja, zona verde inferior).
- t=4.50–5.62 s — "When everyone sees the same" (una palabra cada ~0.25 s).
- t=5.67–5.88 s — barrido diagonal desde abajo-derecha: vuelve el presentador (6 frames); "data," 5.67 → caja 5.71.
- t=6.21 s — "decisions" (tenue) → caja 6.33; "are" ~6.75.
- t=6.81–7.02 s — tarjeta verde oscura barre desde la izquierda (5 frames); título "Faster Decisions" fade-in 6.85–6.90; polígono menta a la derecha; "made" caja 6.90.
- t=7.06 s — "faster" → caja 7.14; "and" ~7.75; "teams" ~8.00; "stay" ~8.25; "aligned" ~8.50.
- t=8.90–9.06 s — el presentador barre desde la derecha, la tarjeta se va a la izquierda (4–5 frames).
- t=8.98 s — "without" (tenue) → caja 9.02; "guesswork" 9.23 → caja 9.35.
- t=10.04 s — fin.

#### Movimientos

##### Polígono menta de cabecera con título "Your Team" (t=0.47–2.62)
- Elemento: marco / título
- Entrada: un polígono menta de bordes facetados entra desde la esquina inferior derecha (f4 de `lift-apertura`, solo una cuña) y sube en diagonal por el lado derecho hasta quedar como franja superior (~25 % de altura) con borde inferior angular; 6 frames (t=0.47–0.71, ~250 ms), ease-out con asentamiento (el borde inferior sube de ~40 % a ~33 % entre f8 y f10). El título "Your Team" (serif, blanco, alineado a la izquierda) hace fade-in en 3 frames (t=0.58–0.67).
- Vida: estático ~1.6 s.
- Salida: polígono y título se deslizan hacia arriba fuera del cuadro en 7 frames (t=2.37–2.62, ~290 ms), ease-in. Tira `lift-title-exit` f4–f10.
- Sincronía: entra con la primera caption ("What's"), sale al terminar la pregunta.
- Capas: delante de la persona (tapa la parte alta del plano).

##### Caption con caja menta que cambia de palabra por fundido (t=0.47 en adelante)
- Elemento: caption (frase) / palabra clave
- Entrada: cada palabra aparece al decirse, primero 1 frame tenue (gris/translúcido) y al siguiente en blanco con caja menta redondeada (~40–80 ms); las palabras se acumulan en hasta dos líneas centradas.
- Vida: la caja no se desliza: la caja de la palabra anterior desaparece y la de la nueva aparece por fundido de ~2 frames (`lift-apertura` f11–f12, `lift-title-exit` f3–f4 y f10–f11). Si no llega palabra nueva, la caja se apaga sola (~0.3 s después, f18 de `lift-title-exit`). Palabras ya dichas quedan en blanco.
- Salida: fade out de ~4 frames (t=3.90–4.07 en `lift-trans1` f12–f16) o corte de página.
- Sincronía: con la palabra hablada.
- Capas: delante de la persona; sobre el barrido durante las transiciones; en la zona verde oscura del layout de B-roll.
- Posición: ~73 % de altura en todos los layouts (no se mueve entre secciones).

##### Layout B-roll + polígono verde oscuro (t=3.52–5.88)
- Elemento: B-roll / fondo
- Entrada: ver transición 1; el B-roll ocupa el ~60 % superior y un polígono verde oscuro con borde angular el ~40 % inferior.
- Vida: B-roll estático (sin zoom lento visible entre 3.8 y 5.6) [dudoso: el dashboard tiene poco detalle para detectar deriva].
- Salida: ver transición 2.
- Sincronía: con el cambio de sección.
- Capas: la caption sobre el verde oscuro.

##### Tarjeta "Faster Decisions" (t=6.81–9.06)
- Elemento: título / fondo
- Entrada: barrido angular desde el borde izquierdo (5 frames, t=6.81–7.02, ~210 ms), ease-out; el título serif hace fade-in en 2 frames (6.85–6.90) y un polígono menta facetado ocupa el lado derecho (asienta ~1–2 frames tras el barrido).
- Vida: estático; captions debajo del título, alineadas a la izquierda.
- Salida: push diagonal: el presentador entra desde la derecha y la tarjeta (título incluido) se desplaza hacia la izquierda, 4–5 frames (t=8.90–9.06, ~190 ms). Tira `lift-card-exit` f7–f11.
- Sincronía: con "made" / "without".
- Capas: fondo pleno, sin persona.

#### Transiciones entre tomas
- t=3.52–3.77 (7 frames): wipe diagonal con máscara poligonal desde la esquina inferior derecha hacia la superior izquierda; el borde del wipe es una banda menta seguida de verde oscuro; sin desenfoque ni escala. Tira `lift-trans1` f3–f9.
- t=5.67–5.88 (6 frames): mismo wipe diagonal desde la esquina inferior derecha; la banda verde oscura hace de borde y el presentador queda a pantalla completa. Tira `lift-trans2` f4–f9.
- t=6.81–7.02 (5 frames): wipe angular de izquierda a derecha que trae la tarjeta verde. Tira `lift-card` f5–f10.
- t=8.90–9.06 (4–5 frames): push angular de derecha a izquierda (la tarjeta se desplaza, no solo se descubre). Tira `lift-card-exit` f7–f11.

#### Cámara
- Ninguno: sin punch-in, zoom, shake ni focus pull en los planos del presentador ni en el B-roll.

#### Firma del estilo
Polígonos menta y verde oscuro de bordes facetados que barren en diagonal para entrar y salir (títulos serif dentro), y captions con caja menta que salta de palabra en palabra por fundido en vez de deslizarse.

### Stack

Duración 10.04 s, 24 fps (241 frames). Tomas: presentador (0–3.61) → B-roll fajos de dinero (3.61–5.46, revelado desde el blanco 3.69–3.81) → presentador recortado sobre fondo rojo (corte 5.46, fondo rojo desde 5.50–5.54) → mismo plano sin fondo rojo (fundido 7.47–7.63) → tarjeta tipográfica blanca (corte 8.13) → presentador (fundido 9.46–9.54). Fuentes: `stack-overview.jpg`, tiras a 24 fps `stack-apertura`, `stack-keyword`, `stack-trans1`, `stack-trans2`, `stack-red-life`, `stack-red-exit`, `stack-card`, `stack-card-exit`; detalles `stack-z-title`, `stack-z-whiteout`.

#### Línea de tiempo
- t=0.00–0.17 s — cámara: blur-in + zoom-out (desenfoque ~40 px→0, escala ~1.2→1.0, 4–5 frames).
- t=0.29 s — marco: el vídeo se encoge a un recuadro de esquinas redondeadas con margen gris claro (2–3 frames).
- t=0.33–0.42 s — título "TECHNOLOGY" cae desde arriba con zoom-out (1.3→1.0, 3 frames), bicolor.
- t=0.63 s — "Everything" blanca → caja roja 0.67; "you" 0.92; "know" 1.02 → caja 1.10; "about" 1.23 → caja 1.31; "buying" 1.39 (grande) → caja 1.48.
- t=1.75 s — página "tech" (caja); "is" 2.00; "dead" 2.25 (caja); "wrong." 2.50.
- t=3.00–3.38 s — sin caption. t=3.40 "Brands" → caja 3.44.
- t=3.61–3.65 s — flash blanco (2 frames al 100 %); el título desaparece por corte; t=3.69–3.81 el B-roll de dinero se revela desde el blanco (4 frames).
- t=3.69 s — "spend" → caja 3.77; "millions" 3.98 → caja 4.10; "convincing" ~4.50; "you" ~4.75; "to" ~5.00; "upgrade" 5.00 → caja 5.13.
- t=5.29–5.42 s — flash blanco (2 frames al 100 % + 2 de fade) sobre el B-roll; "every" 5.33.
- t=5.46 s — corte seco al presentador; t=5.50–5.54 el fondo real se sustituye por rojo (presentador recortado) con letras gigantes en contorno detrás; iconos en las esquinas superiores 5.67–5.75.
- t=5.79 s — "year," caja. t=6.30 "but"; "the" 6.33 (caja); "thirty" 6.51 (grande) → caja 6.59; "option" 6.88 → caja 6.97; "outlasts" 7.30 → caja 7.38.
- t=7.47–7.63 s — fondo rojo, letras e iconos se funden al fondo real (4–5 frames).
- t=7.80 s — página "the" (caja); "three" 7.92 → caja 8.00; "hundred" 8.09 (tenue).
- t=8.13 s — corte a tarjeta blanca: caption oscura centrada; 8.18–8.31 caja de "hundred" fade-in; letras en contorno arriba y letras rojas abajo aparecen 8.22–8.31 y se desplazan.
- t=8.31 s — "dollar" → caja 8.43; "one" 8.64; "almost" 8.89 → caja 8.97.
- t=9.21 s — página "every": gris → rosa 9.25 → caja roja 9.29; "single" 9.42.
- t=9.46–9.54 s — letras gigantes desaparecen por corte; el presentador se funde desde el blanco (3 frames). "single" caja 9.54; "time" 9.71 → caja 9.79.
- t=10.04 s — fin.

#### Movimientos

##### Apertura con blur-in (t=0.00–0.17)
- Elemento: cámara
- Entrada: el primer frame está muy desenfocado (gaussiano, ~40 px estimado a 1080 px de ancho) y ligeramente ampliado (~1.2×); se enfoca y reduce a 1.0 en 4–5 frames (t=0.00–0.17, ~170 ms), ease-out (f0–f2 casi iguales, f3 medio, f4 casi nítido). Tira `stack-apertura` f0–f5.
- Vida: nítido y estático después.
- Salida: no aplica.
- Sincronía: con el inicio.
- Capas: todo el vídeo.

##### Recuadro del vídeo con margen (t=0.29–3.61)
- Elemento: marco
- Entrada: el vídeo escala de 1.0 a ~0.93 y queda en un recuadro de esquinas redondeadas sobre fondo gris claro, dejando la franja superior para el título; 2–3 frames (t=0.29–0.38). Detalle `stack-z-title` f7 (recuadro ya visible antes de que aparezca el título).
- Vida: estático.
- Salida: corte con el flash blanco a 3.61.
- Sincronía: precede al título en 1 frame.
- Capas: el vídeo inset; el título en el margen.

##### Título "TECHNOLOGY" (t=0.33–3.61)
- Elemento: título
- Entrada: cae desde arriba del cuadro con zoom-out: en f8 (t=0.33) está a ~1.3× y recortado por el borde superior (solo la mitad baja de los glifos), en f9 (0.375) a ~1.05× ya entero, en f10 (0.42) a 1.0 en su sitio; 3 frames (~125 ms), ease-out; sin rebote visible. Detalle `stack-z-title`.
- Vida: estático; bold condensada en mayúsculas, dos tonos ("TECH" carbón, "NOLOGY" gris azulado claro), ocupa todo el ancho del margen superior.
- Salida: corte seco en el flash blanco (t=3.61).
- Sincronía: independiente de la voz.
- Capas: en el margen, encima del recuadro del vídeo.

##### Caption con caja roja por palabra (t=0.63 en adelante)
- Elemento: caption (frase) / palabra clave
- Entrada: cada palabra aparece al decirse: 1 frame tenue (rosado/translúcido: la caja roja a baja opacidad detrás [dudoso]), 1 frame blanca sin caja, luego caja roja redondeada con texto blanco (`stack-keyword` f10–f12, ~80–120 ms en total). Las palabras se acumulan en dos líneas alineadas a la izquierda.
- Vida: karaoke por caja: la caja de la palabra anterior desaparece (corte) 1–2 frames antes de que la nueva reciba la suya; las palabras ya dichas quedan blancas (o negras en la tarjeta blanca). Palabras clave ("Everything", "buying", "millions", "upgrade", "thirty", "three", "hundred") en bold ~1.5× más grandes que las de relleno ("you", "know", "is").
- Salida: corte entre páginas (1–2 frames vacíos).
- Sincronía: con la palabra hablada.
- Capas: delante de la persona y del B-roll; en la tarjeta blanca, texto negro entre las dos filas de letras gigantes.
- Posición: ~65 % de altura en los planos; centrada verticalmente (~50 %) en la tarjeta.

##### Fondo rojo con presentador recortado y marquesina de letras (t=5.50–7.63)
- Elemento: fondo / sticker
- Entrada: tras el corte al presentador (5.46), el fondo real se funde a rojo pleno en 2 frames (t=5.50–5.54) y el presentador queda recortado (matte); detrás, letras gigantes en contorno blanco fino a media altura; dos iconos blancos pequeños (tres puntos a la izquierda, doble círculo a la derecha) aparecen en las esquinas superiores en 5.67–5.75 por fade/slide corto [dudoso].
- Vida: las letras en contorno se desplazan horizontalmente de derecha a izquierda de forma continua (marquesina), ~1 letra (~200 px) cada 0.5 s ≈ 17 px/frame [dudoso, estimado con la hoja general: "MC" 5.75, "ALE" 6.5, "ENC" 7.0]; iconos estáticos.
- Salida: fundido de rojo, letras e iconos al fondo real en 4–5 frames (t=7.47–7.63, ~190 ms), lineal. Tira `stack-red-exit` f4–f8.
- Sincronía: entra con "every year," y sale tras "outlasts".
- Capas: letras e iconos detrás de la persona (recortada), delante del rojo.

##### Tarjeta tipográfica blanca (t=8.13–9.54)
- Elemento: título / fondo
- Entrada: corte seco (t=8.13); las letras gigantes en contorno (fila superior) y las letras rojas macizas (fila inferior) hacen fade-in de ~3 frames (8.22–8.31); la caja roja de "hundred" también entra por fade (8.18–8.31).
- Vida: la fila superior de contornos se desplaza hacia la izquierda y la roja inferior hacia la derecha, unos px por frame [dudoso: direcciones estimadas comparando f8–f10 de `stack-card`]; la caption oscura en el centro sigue el karaoke.
- Salida: las letras desaparecen por corte a t=9.46 y el presentador se funde desde el blanco en 3 frames (9.46–9.54, ~125 ms). Tira `stack-card-exit` f11–f13.
- Sincronía: con "the three hundred dollar…".
- Capas: sin persona; la caption entre las dos filas.

#### Transiciones entre tomas
- t=3.61–3.81 (5 frames): flash blanco — 2 frames a blanco puro (3.61–3.65) y 4 frames de fade del blanco al nuevo plano (3.69–3.81); el título y el recuadro desaparecen por corte. Sin dirección ni escala.
- t=5.29–5.54 (7 frames): flash blanco sobre el B-roll (2 frames a 100 %, 2 de fade, el B-roll reaparece a 5.375–5.42), corte seco al presentador a 5.46 y fundido del fondo a rojo en 2 frames (5.50–5.54). Detalle `stack-z-whiteout`.
- t=7.47–7.63 (4–5 frames): crossfade del fondo rojo al fondo real (mismo plano del presentador).
- t=8.13 (1 frame): corte seco a la tarjeta blanca.
- t=9.46–9.54 (3 frames): fade desde blanco al presentador.

#### Cámara
- t=0.00–0.17: blur-in con zoom-out 1.2→1.0 (apertura).
- Ningún punch-in ni zoom lento en el resto; sin shake ni focus pull.

#### Firma del estilo
Tipografía gigante que se mueve (título que cae con zoom-out, marquesinas de letras en contorno y macizas detrás del presentador recortado sobre rojo), flashes blancos como transición y caja roja que salta de palabra en palabra.

### Align

Duración 62.0 s, 30 fps (1860 frames). Tomas: un plano de estudio del presentador (calvo, micrófono) que se alterna con tarjetas blancas y con B-roll en tiles; todos los cambios entre presentador, tarjetas y B-roll son cortes secos o escalas del propio tile sobre fondo blanco, sin barridos ni desenfoques. Cambios de layout (hoja general en tres partes `align-overview-0/1/2.jpg`, 0.25 s por tile): tarjeta de título 0–1.50; presentador 1.50; split presentador+B-roll 6.03–6.37; presentador 12.33–12.47; doble B-roll ~13.25; presentador ~18.25; inset con etiqueta "REVOLUTION" 18.93; presentador ~23.75; doble B-roll 24.87; presentador ~29.00; inset con etiqueta "DESKTOPS" ~29.75; presentador ~32.75; doble B-roll ~33.50; presentador ~36.75; tarjeta blanca "THE 2000S" 37.30; presentador 42.40; inset con etiqueta "POWER" ~49.25; presentador ~53.75; split ~54.50; presentador ~57.75; split ~58.75; presentador ~61.50; fin 62.0. Tiras a 30 fps: `align-apertura`, `align-person-in`, `align-to-split`, `align-to-full`, `align-inset-label`, `align-double-broll`, `align-white-card`, `align-card-out`.

#### Línea de tiempo
Parte 1 (0–21 s)
- t=0.00–0.30 s — tarjeta blanca: título "COMPUTERS" bold centrado arriba, con tracking amplio que se va cerrando (9 frames).
- t=0.10 s — caption "THE TECH IN YOUR" (monoespaciada, centrada) 1 frame gris → negra 0.13.
- t=0.30–0.50 s — subtítulo diminuto "MAINFRAMES TO WEARABLES" se revela por barajado de letras (7 frames).
- t=~1.00 s — página "POCKET".
- t=1.50–1.63 s — presentador entra por escala ~0.9→1.0 (4 frames); la caption pasa a caja blanca con texto negro en el tercio inferior.
- t=1.70 s — caption fuera; 1.90 "IS MORE POWERFUL"; después "THAN WHAT SENT" ~3.25, "HUMANS TO THE" ~4.0, "MOON" ~4.75, "BUT IT ALL STARTED" ~5.75 (esta caja se coloca a media altura).
- t=6.03–6.37 s — presentador se encoge al tile superior; B-roll (sala de mainframes, B/N) entra por corte abajo a 6.37; caption entre los tiles sin caja.
- t=6.5–12.3 s — split: "WITH MASSIVE" ~7.25, "MAINFRAMES FILLING" ~8.0, "ENTIRE ROOMS" ~9.5, "IN THE 1950S" ~10.75.
- t=12.33–12.47 s — split → presentador: el B-roll desaparece (1–2 frames) y el tile del presentador escala a 1.0 (4 frames).
- t=12.53 s — caption fuera; 12.87 "THEN CAME THE" (caja, tercio inferior).
- t=~13.25 s — doble B-roll (Altair azul arriba, Altair sobre mesa abajo): "THEN CAME THE", "BREAKTHROUGH" ~13.75, "THE ALTAIR 8800" ~14.5, "IN 1975" ~16.75.
- t=~18.25 s — presentador; "A BUILD-IT-YOURSELF" ~18.75.
- t=18.93–19.10 s — inset: el vídeo escala a ~0.85 sobre blanco (6 frames); t=19.27–19.53 etiqueta "R E V O L U T I O N" aparece letra a letra arriba (10 frames); "KIT THAT SPARKED" ~20.0.
Parte 2 (21–42 s)
- t=21–23.5 s — inset con etiqueta; "THE PERSONAL" ~21.5, "COMPUTING REVOLUTION" ~22.25.
- t=~23.75 s — presentador a pantalla completa [dudoso: no medido por tira; en la hoja general el cambio ocurre entre 23.5 y 23.75].
- t=24.25 s — página "SUDDENLY" (gris 1 frame → caja).
- t=24.77–24.87 s — el plano del presentador empieza a encogerse (2 frames) y a 24.87 corta en seco al doble B-roll (taller arriba, escritorio abajo); "SUDDENLY" queda entre los tiles sin caja.
- t=25.17 s — caption fuera; 25.40 "VISIONARIES" (gris → negro 25.43); "LIKE JOBS AND" ~27.0 (gris 1 frame); "GATES SAW THE" ~27.25; "FUTURE" ~28.5.
- t=~29.0 s — presentador; "BY THE '80S" ~29.5; ~29.75 inset con etiqueta "DESKTOPS"; "COMPUTERS SHRUNK" ~30.75; "TO DESKTOPS" ~31.75.
- t=~32.75 s — presentador; "THE '90S BROUGHT" ~33.0.
- t=~33.5 s — doble B-roll (ordenador con lámpara de lava arriba, mapa ilustrado abajo): "THE INTERNET" ~33.75, "CONNECTING THESE" ~34.75 (gris 1 frame), "MACHINES GLOBALLY" ~35.75.
- t=~36.75 s — presentador; 37.10 caption fuera.
- t=37.23–37.30 s — el vídeo se encoge 2 frames y corta en seco a tarjeta blanca con "THE 2000S" centrado; etiquetas diminutas "MINIATURIZATION" arriba y abajo se revelan letra a letra ~37.75–38.0.
- t=38.5–41.75 s — tarjeta: "LAPTOPS GOT SMALLER" ~38.75, "WHILE SMARTPHONES" ~40.5, "EMERGED" ~41.5.
Parte 3 (42–62 s)
- t=42.30 s — etiquetas "MINIATURIZATION" desaparecen; 42.40 corte seco al presentador; 42.43 "PUTTING COMPUTING" gris → caja 42.47.
- t=43.25–48.75 s — presentador: "POWER IN OUR POCKETS" ~43.25, "TODAY" ~45.5, "WE WEAR TECHNOLOGY" ~46.5, "ON OUR WRISTS" ~47.75.
- t=~49.0 s — "THAT'S THOUSANDS"; ~49.25–49.5 inset con etiqueta "POWER"; "OF TIMES MORE" ~50.0, "POWERFUL THAN" ~50.75, "THOSE ROOM-SIZED" ~51.5, "MAINFRAMES" ~52.75.
- t=~53.75 s — presentador; "FROM CALCULATION" ~54.0 (caja a media altura).
- t=~54.5 s — split presentador + B-roll (sala de control): "MACHINES TO EXTENSIONS" ~55.25, "OF OURSELVES" ~56.75.
- t=~57.75 s — presentador; "THAT'S THE INCREDIBLE" ~58.25.
- t=~58.75 s — split presentador + B-roll (ordenadores antiguos sobre negro): "70-YEAR JOURNEY" ~59.5, "OF COMPUTING" ~60.75 (gris 1 frame).
- t=~61.5 s — presentador; "OF COMPUTING" con caja; 62.0 fin.

#### Movimientos (los que se repiten se describen una vez, con ejemplos de tiempo)

##### Tarjeta de título de apertura (t=0.00–1.50)
- Elemento: título
- Entrada: "COMPUTERS" ya está en el frame 0 con tracking muy amplio (~15 % más ancho) y las letras se van juntando hasta el tracking normal en ~9 frames (t=0.00–0.30, ~300 ms), ease-out. Tira `align-apertura` f0–f9.
- Vida: estático; a t=0.30–0.50 debajo aparece el subtítulo diminuto y espaciado "MAINFRAMES TO WEARABLES" por barajado: letras aleatorias ("R S W", "I R S O W R S", "MAI R S O W R 0ES"…) que se resuelven en el texto en 7 frames (~230 ms), decodificando de izquierda a derecha.
- Salida: corte seco cuando entra el presentador (t=1.50).
- Sincronía: independiente de la voz.
- Capas: fondo blanco pleno, sin persona.

##### Entrada del presentador por escala (t=1.50–1.63)
- Elemento: cámara / marco
- Entrada: el vídeo aparece de golpe (opaco) a ~0.9 de escala, centrado, con margen blanco, y escala a 1.0 en 4 frames (t=1.50–1.63, ~130 ms), ease-out. Tira `align-person-in` f6–f10.
- Vida: plano fijo.
- Salida: según sección (ver abajo).
- Sincronía: con "POCKET".
- Capas: el vídeo entero.

##### Caption monoespaciada en caja blanca (todo el vídeo)
- Elemento: caption (frase)
- Entrada: cada página entra completa, 1 frame en gris (~33 ms) y al siguiente en negro (sobre blanco) o negro sobre caja blanca (sobre vídeo). Ejemplos: 0.10, 24.25 "SUDDENLY", 25.40 "VISIONARIES", 42.43 "PUTTING COMPUTING", ~60.75 "OF COMPUTING". No hay palabra por palabra ni resaltado.
- Vida: estática; entre páginas puede haber 1–10 frames sin caption (p. ej. 1.70–1.90, 12.53–12.87, 25.17–25.40).
- Salida: corte.
- Sincronía: con la frase hablada (una página por frase corta de 2–3 palabras).
- Capas: delante de la persona; entre los tiles en los splits; centrada en las tarjetas.
- Posición: tercio inferior (~75–78 %) en pantalla completa; a media altura (~50 %) en la página previa a un split ("BUT IT ALL STARTED" 5.75, "FROM CALCULATION" 54.0) y entre los tiles durante el split; dentro del inset a ~70 %; centro en las tarjetas.

##### Pantalla completa → split presentador + B-roll (t=6.03–6.37; también ~54.5 y ~58.75)
- Elemento: marco / B-roll
- Entrada: el vídeo del presentador escala de 1.0 a ~0.55 de ancho anclado arriba-centro sobre fondo blanco en ~10 frames (t=6.03–6.37, ~330 ms), ease-in-out; el B-roll aparece por corte a su tamaño final en el último frame (6.37), debajo, con la caption entre ambos. Tira `align-to-split` f4–f14.
- Vida: tiles estáticos (sin zoom lento visible en el B-roll entre 6.5 y 12.3).
- Salida: ver el siguiente bloque.
- Sincronía: con "BUT IT ALL STARTED".
- Capas: fondo blanco; caption entre tiles, sin caja.

##### Split → pantalla completa (t=12.33–12.47; también ~18.25, ~57.75, ~61.5)
- Elemento: marco
- Entrada: el tile del B-roll se encoge y desaparece en 1–2 frames (12.33–12.37) y el tile del presentador escala a 1.0 en 4 frames (t=12.33–12.47, ~130 ms), ease-out. Tira `align-to-full` f10–f14.
- Vida: plano fijo.
- Salida: no aplica.
- Sincronía: con "IN THE 1950S".
- Capas: el vídeo entero.

##### Pantalla completa → doble B-roll (t=24.77–24.87; también ~13.25 y ~33.5)
- Elemento: B-roll / transición
- Entrada: el plano del presentador se encoge 2 frames (24.77–24.83, escala ~0.95) y a 24.87 corta en seco a dos tiles de B-roll (arriba y abajo) ya colocados, con la caption entre ellos. Tira `align-double-broll` f9–f11.
- Vida: tiles estáticos (sin deriva visible entre 24.9 y 25.5).
- Salida: a pantalla completa del presentador (~29.0) [dudoso: no medido por tira; probablemente la inversa].
- Sincronía: con "SUDDENLY".
- Capas: fondo blanco.

##### Inset con etiqueta letra a letra (t=18.93–19.53; también ~29.75 "DESKTOPS" y ~49.25 "POWER")
- Elemento: marco / título
- Entrada: el vídeo escala de 1.0 a ~0.85 anclado abajo-centro (el margen superior crece más) en 6 frames (t=18.93–19.10, ~200 ms), ease-out; 5 frames después, una etiqueta diminuta en monoespaciada con tracking muy amplio se escribe en el margen superior letra a letra, una por frame: "R", "R E", … "R E V O L U T I O N" (10 frames, t=19.27–19.53, ~330 ms). Tira `align-inset-label` f1–f19.
- Vida: estático ~4 s.
- Salida: vuelve a pantalla completa (~23.75) [dudoso: no medido por tira].
- Sincronía: la etiqueta nombra la sección, independiente de la palabra exacta.
- Capas: etiqueta en el blanco; la caption sigue dentro del inset.

##### Tarjeta blanca "THE 2000S" (t=37.23–42.40)
- Elemento: título / fondo
- Entrada: el vídeo se encoge 2 frames (37.23–37.27) y a 37.30 corta en seco a blanco con la caption "THE 2000S" centrada; ~0.45 s después, las etiquetas "MINIATURIZATION" (arriba y abajo, diminutas y espaciadas) se escriben letra a letra (hoja general: parciales a 37.75, completas a 38.0). Tira `align-white-card` f10–f12.
- Vida: solo cambian las captions.
- Salida: las etiquetas desaparecen por corte a 42.30 (3 frames antes) y a 42.40 corte seco al presentador a escala 1.0. Tira `align-card-out` f3–f6.
- Sincronía: con "THE 2000S" / "PUTTING COMPUTING".
- Capas: sin persona.

#### Transiciones entre tomas
- Tarjeta → presentador (1.50): corte + escala 0.9→1.0 en 4 frames.
- Presentador → split (6.03, ~54.5, ~58.75): escala del tile en ~10 frames + corte del B-roll.
- Split → presentador (12.33, ~18.25, ~57.75, ~61.5): escala 0.55→1.0 en 4 frames.
- Presentador → doble B-roll (24.77, ~13.25, ~33.5) y → tarjeta (37.23): 2 frames de encogimiento y corte seco.
- Tarjeta → presentador (42.40): corte seco.
- Ningún wipe, whip, blur ni escala en el B-roll.

#### Cámara
- Escalas del tile del presentador (0.9→1.0 al entrar; 1.0→0.55 y vuelta en los splits; 1.0→0.85 en los insets). Sin punch-in dentro del plano, sin shake, sin focus pull. B-roll sin Ken Burns visible.

#### Firma del estilo
Editorial sobre blanco: captions monoespaciadas en mayúsculas que cambian por corte con 1 frame en gris, el vídeo que se encoge a tiles por escala (nunca barre) y etiquetas diminutas con tracking amplio que se escriben letra a letra o se decodifican por barajado.

---

## Parte 2. El vocabulario: las primitivas que cubren los 20 estilos y cómo entran en reel-agent

### 2.1 Reglas de tiempo que comparten los 20

Medidas en frames del preview (24 fps salvo Evo y Align a 30); en ms para trasladar a los 30 fps del proyecto.

| Regla | Valor | Dónde se ve |
|---|---|---|
| Una palabra de caption llega en | 1 f (corte) a 4 f (fade), 2–3 f si es blur-in | Prism, Y2K, Evo, Bloom, Impact, Align, Focus |
| Una palabra clave llega en | 3–6 f (125–250 ms), casi nunca con escala | Prism (fantasma+brillo), Bloom (blur), Impact (blur+RGB), Prime (fade) |
| Las páginas salen por | corte seco (≤ 1 f) en 15 de 20; fade 2–4 f en Lift/Paper/Linen; crossfade de texto 3 f en Linen/Paper | todos |
| La caja karaoke viaja en | 2 f (80 ms) si se desliza (Focus); 2 f de fundido si salta (Lift, Stack, Chalk) | Focus, Lift, Stack, Chalk |
| Un título entra en | 3 f (caída con zoom-out, Stack) a 8–9 f (revelado por letra, slide+fade) | Stack, Elevate, Prime, Bloom, Linen, Lift |
| Un título sale en | 4–7 f, más rápido que entra; a menudo por corte o por el mismo camino al revés | Focus, Lift, Elevate, Form |
| Transición entre tomas | 4–16 f: 5–8 f los desenfoques y flashes, 13–21 f las máscaras geométricas | Prism, Stack, Impact, Prime / Focus, Lift, Y2K, Linen |
| Cambio de layout (split, tarjeta, inset) | 4–15 f con ease-out marcado (2/3 del recorrido en el primer tercio) | Elevate 15, Form 9, Impact 7, Focus 4, Align 10, Evo 11 |
| Curva dominante | ease-out; spring con rebote solo en stickers/pops; lineal en wipes, mosaicos y marquesinas | — |
| Capas | los captions nunca se desenfocan con el metraje y sobreviven 1–2 f a la transición; el B-roll casi nunca lleva Ken Burns (solo drift lento de patrones de fondo) | Prism, Focus, Form, Stack |
| Sincronía | palabras y claves con el onset hablado; títulos, marcos y layouts con el inicio de sección (no con una palabra); transiciones con el corte | todos |

### 2.2 Primitivas

Cada fila es una función pura de frame → estado (`src/motion.ts` y `src/transitions.ts`) que un renderer aplica. La columna "hoy" dice si ya existe en `src/`.

**A. Llegadas y salidas de texto (palabras, líneas de título)**

| Primitiva | Parámetros medidos | Estilos | Hoy |
|---|---|---|---|
| `cut` | 1 f; opcional 1 f gris previo | Align, Focus, Prism (palabras sueltas) | sí (`wordIn` no la tiene; el gris lo da `upcoming: dim`) |
| `fade` (+ 6 px de subida) | 2–4 f | Prism, Y2K, Prime, Chalk, Elevate | sí (`fade`) |
| `ghost` + `shine` | opacidad 0.4→1 en 6 f, brillo del degradado que barre de izq. a der. en esos 6 f, sin escala | Prism (palabras clave) | no (hoy: pop de escala) |
| `blur` | 2–3 f desde ~15 px | Evo, Bloom, Form (página entera), Impact (palabra grande) | solo para páginas (`pageIn: blur`), no por palabra |
| `rgb` | blur + separación RGB morado→cian, 2–3 f | Impact II | no |
| `pop` (spring 0.7→1) | 4–6 f | Stack (caja roja), Pop, stickers | sí |
| `drop` | escala 1.3→1 y baja desde fuera, 3 f | Stack (título) | no |
| `slideBlur` | entra desde la derecha con motion blur, 6 f | Prime ("GROWTH") | no |
| `letters` | revelado letra a letra con blur, ~1 f/letra | Elevate, Prime (script), Chalk (tiza) | no |
| `typewriter` | 2–3 chars/f con caja que crece (Paper) o 1 letra/f (Align) | Paper II, Align, Lens | no |
| `shuffle` | letras aleatorias que se resuelven izq→der en 7 f | Align | no |
| `tracking` | letter-spacing 0.7→0.38 em en 9 f | Align, Elevate | sí (`chapter-caps`) |
| `band` | banda de color que sube 4 f recortando el texto | Focus | no |
| `polyWipe` | máscara angular desde la izq., 5 f | Lift (tarjeta) | no |
| salida `cut` / `fade` 2–6 f / `blur` der→izq 5 f / `letters` (última→primera, 1.5 f entre letras) / `slideUp` 7 f / `band` 4 f | — | Form, Elevate, Lift, Focus | solo fade 0.15 s |

**B. Vida del texto**

| Primitiva | Parámetros | Estilos | Hoy |
|---|---|---|---|
| karaoke por color | 1 f gris→color | Paper, Prime, Vista, Chalk | sí (`upcoming: dim` + tiers) |
| karaoke por caja que se desliza | 2 f, ease-out | Focus | no |
| karaoke por caja que salta | fundido 2 f, la caja se apaga sola a los ~0.3 s si no llega palabra | Lift, Stack, Chalk (rotulador) | no |
| `grow` | escala 1.0→1.3 lineal en 1.2 s hasta desbordar | Prime (título script) | no |
| `marquee` | filas de letras en contorno que se desplazan ~17 px/f | Stack | no (word wall estático) |
| `drift` | patrón de palabra repetida a 50–80 px/s | Form, Prime (fondo GROWTH) | no |
| `oscillate` + estela | marco neón ±3° con copia desfasada 4 f | Prime | no |
| `boil` | contorno redibujado cada frame (jitter determinista) | Chalk | no |
| brillo que deriva | banda cromada que cruza la palabra lentamente | Prism (oliva) | no |

**C. Transiciones entre tomas** (`transitions.ts`, hoy: punch, zoom, whip horizontal, card, split)

| Primitiva | Parámetros | Estilos |
|---|---|---|
| `whipDiag` | 4 f de salida (blur direccional 0→18 px a ~60°) + 6 f de entrada (blur 18→0, escala 1.3→1.0); el caption saliente aguanta 2 f | Prism |
| `whipH` + persianas | barras verticales que se ensanchan 6 f y se retiran 4 f, whip horizontal 5 f | Form |
| `spin` + flash | blur rotacional centrado en la cara 6–11 f, blanco al 100 % en el centro | Prime |
| `rgbFlash` | 3 f blur+RGB, 1 f blanco, 4 f de enfoque | Impact II |
| `flash` | 2 f blanco + 4 f de fade | Stack |
| `crossBlur` | 5 f, saliente se desenfoca y funde, entrante llega desenfocada | Prime, Linen (crossfade sin blur) |
| `bands` | 3 franjas apiladas que suben o bajan 13–16 f (8 cubren, 8 revelan), lineal | Focus |
| `polyWipe` | máscara diagonal desde abajo-der. 6–7 f con borde de dos colores | Lift |
| `diagWipe` | borde a ~20° que baja 14 f / sube 10 f, con lavado a crema del saliente | Linen |
| `clock` | barrido radial horario, pivote central, 13–21 f, lineal | Y2K |
| `mosaic` | cuadrados que crecen 8 f y encogen 8 f | Y2K |
| `particles` | disolución izq→der con borde ruidoso 4–7 f | Form |
| `tear` | dos capas de papel de periódico, 7 f cubren, 3 f hold, 7 f descubren | Paper II |
| `rub` + crossfade | mancha de tiza desde arriba-izq. 5 f + fundido 11 f; salida: máscara que baja 6 f | Chalk |
| `blocks` | rectángulos gris claro que suben desde el pie como un skyline con alturas que cambian a saltos cada 2–4 f (puentean un corte 7 f), frontera escalonada de bloques que sube 12 f y baja 7 f para el split, relleno desde abajo-der. 4 f para la tarjeta | Vista |
| `triangles` | mosaico de triángulos semitransparentes sobre rejilla de ~180 px que se encienden desde abajo-der. en 11 f y se apagan uno a uno hacia la der. en 10 f, con parpadeo suave | Vista |
| `disc` | disco de color que entra desde una esquina y cubre el cuadro en 4–8 f (ease-out) o se retira en 7 f (ease-in); el B-roll vive en un círculo que crece desde un punto en 11 f y se encoge a 0 en 3–4 f, con un anillo fino descentrado que orbita ~70°/s | Orbit |
| `lightLeak` | mancha cálida o rosa aditiva que aparece en 1–2 f y se apaga en 3–5 f; a pantalla completa tapa el cambio de layout (pico en el frame central) | Lens |
| `markerMask` | el título se destapa con una máscara de borde rugoso de rotulador de der. a izq. en 4 saltos (8–9 f) y se borra de izq. a der. en 3 saltos (7 f) | Sketch |
| `rub` de tiza | ver Chalk arriba | Chalk |
| `cardDrop` | la tarjeta nueva cae desde arriba girando −15°→0° y aterriza sobre la anterior en 4–5 f, sin blur; el vídeo de base se encoge a 0.85 | Pop |
| `stamp` | escala 1.15→0.85 en 3 f (sello) | Pop (starburst final) |
| `scaleFromCenter` | el vídeo escala 0.02→0.88 en 6 f con focus pull que resuelve en 9 f; salta a 1.0 en 2 f al salir | Lens (apertura) |
| apertura del reel | zoom blur radial 5 f (Prism), blur-in 5–6 f (Prime, Stack con zoom-out 1.2→1), zoom-out 1.4→1 + blur + RGB 8 f (Impact) | Prism, Prime, Stack, Impact |

**D. Layouts y B-roll**

| Primitiva | Parámetros | Estilos | Hoy |
|---|---|---|---|
| `slideUp` split | el B-roll sube desde abajo 7–15 f ease-out; sale `slideDown` 5–13 f, con motion blur vertical en Impact | Elevate, Impact, Form, Focus, Bloom (tarjeta) | fade 0.18 s |
| `popFrom` | escala desde un punto 11 f; sale a 0 en 9 f | Evo | no |
| `frameIn` | el vídeo se encoge a marco redondeado 8–9 f (Evo, Stack), inset 0.85 en 6 f (Align), tile 0.55 en 10 f (Align), cápsula 8 f (Bloom) | Evo, Stack, Align, Bloom | 8 f lineal (`LayoutStage`) |
| `card` (Prism) | tarjeta cuadrada que sube rápido 8 f y sigue subiendo lento 17 f; sale por arriba acelerando 12 f; fondo desenfocado | Prism | no |
| `carousel` | 3 paneles: central por fade 3 f, laterales se expanden 4–5 f; paso con motion blur 2 f | Prime | no |
| `windows` | ventana Mac clásico que entra 10 f dejando 4–5 copias que se recogen en 8 f; salida con estela en escalera | Y2K | no |
| `cutout` | fondo de color que se funde 2 f detrás de la persona recortada, sale 4–5 f | Stack | parcial (canvas + matte, sin fundido) |
| `panel` diagonal | paralelogramo que sube 8 f / baja 5–6 f | Linen, Lift | no |
| foto con borde rasgado | revelado de arriba abajo 9 f + borde amarillo dibujado; cae 5 f con blur | Chalk | no |
| B-roll estático | sin Ken Burns en 19 de 20 | — | sí |

**E. Marcos y trazos dibujados** (SVG `stroke-dashoffset`, geometría pura)

| Primitiva | Parámetros | Estilos |
|---|---|---|
| marco neón | se dibuja 3 f, oscila, estela | Prime |
| segmento de luz en el borde | recorre el perímetro ~3–4 f por lado | Prime |
| rectángulo que se dibuja y se expande | 11 f de trazo, luego escala continua hasta salir | Evo |
| arco/cápsula que respira | fade 8 f, se expande fuera 20 f, vuelve como máscara 8 f | Bloom |
| elipse garabateada (trim path 5–6 f), subrayado 5 f, garabato ondulado 5 f | boil en Chalk; estáticos en Sketch | Sketch, Chalk |
| banda de marcador detrás del caption | se pinta en dos pasadas (izq→der y der→izq) en 6 f | Sketch |
| visor de cámara: marco redondeado, esquinas, cajita de enfoque, HUD, tiras laterales en scroll ~160 px/s | aparecen con el inset en 1–2 f | Lens |
| starburst con decoraciones escalonadas | cada pieza escala 0→1 en 3 f, 1–2 f entre piezas | Pop |
| contorno de la persona | máscara del matte dilatada, boil | Chalk |
| marco azul grueso | 1 f + el vídeo se encoge 3 f | Focus |
| líneas finas de margen / línea editorial / estrella ✳ | aparecen en 1–2 f, estáticas; la estrella viaja con la costura del split | Form, Elevate, Bloom |

**F. Decoración** (`sticker`, hoy: pop / wiggle / float / spin)

| Primitiva | Parámetros | Estilos |
|---|---|---|
| `unfold` | bolita de papel que viaja hacia afuera 10–12 f escalando 0.15→1 y se desarruga; sale al revés en 4 f | Paper II |
| `pop` escalonado | escala 0→1 en 3 f ease-out (sobrepaso ligero solo en algunas piezas), 1–2 f entre stickers, sin wiggle en pantalla; salida escala a 0 en 5 f ease-in | Pop |
| `flyTo` | la flecha vuela hacia el caption encogiéndose 5 f | Pop |
| iconos de esquina | 1–2 f | Stack |
| etiquetas typewriter giradas ±3° | 3–6 f | Paper II |

**G. Cámara**

| Primitiva | Parámetros | Estilos |
|---|---|---|
| focus pull | blur 0→20 px en 4–6 f, vuelve en 5 f; se mantiene toda la página héroe | Prism, Bloom (cierre) |
| punch-in en la palabra de impacto | 1.12× en 3–4 f | Impact II |
| pulso glitch | blur+RGB 6 f sin corte | Impact II |
| zoom-out suave | 1.15→1.0 en 10 f | Impact II |
| punch-in acoplado al título | 1.0→1.4× en 8 f ease-in-out, empieza 3 f antes del título y se deshace a 1.15× en 5–6 f cuando el título sale | Orbit |
| rack focus | blur 0→~25 px en 11 f, hold 5 f, nítido en 3 f | Lens (cierre), Bloom (cierre, 7 f) |
| nada | 13 de 20 estilos no mueven la cámara del presentador | — |

### 2.3 Cómo entra en reel-agent

- **Una librería pura** `src/motion.ts` (`arrive`, `leave`, `shine`, `boxTravel`, `cardLanding`, máscaras) con tests; los renderers solo pintan lo que devuelve.
- **Los packs deciden**: `captionPresets.ts` gana `wordIn`, `keyIn`, `pageOut`, `active: box-slide | box-jump`, `gradientSpan`; `graphicTemplates.ts` gana `reveal`, `out`, `life` con default por pack; `transitions.ts` gana los tipos de C; `Broll.tsx` las entradas de D. Un `src/stylePacks.ts` agrupa preset + defaults + transición + apertura + lienzo por estilo, y `set_caption_style` (alias `set_style`) lo aplica. El agente sigue eligiendo qué y dónde; nunca escribe animación.
- **El agente ve el movimiento**: `motion_proof` (24 frames consecutivos en una hoja) junto a `caption_proof`, y `scripts/motion-compare.mjs` pone nuestra tira debajo de la del preview para el gate visual de cada primitiva.
- **Texturas** (papel, periódico, light leak, tiza) se buscan o generan una vez con `mcp/assets.mjs`; nunca se dibujan a mano. Las geometrías (arcos, elipses, marcos) sí son código.
- **Orden**: Fase 0 `motion_proof` → Fase 1 Prism al 100 % (fantasma+brillo, karaoke por caja, whip diagonal, apertura, tarjeta) → Fase 2 transiciones → Fase 3 títulos y trazos → Fase 4 layouts, carrusel, ventanas, stickers, contorno → Fase 5 los 20 packs y el gate. Tareas, archivos, código y tests: `docs/superpowers/plans/2026-09-24-captions-ai-motion.md`.
