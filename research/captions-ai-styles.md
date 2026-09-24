# Captions.ai — los 20 estilos de AI Edit (análisis, 2026-09-24)

Fuente: los previews oficiales de cada estilo (`.refs/captions-ai/*.mp4`, fuera del repo por copyright). Los analicé por contact sheet (2 fps). Objetivo: entender qué hace cada uno y qué **primitivas** necesita reel-agent para imitarlos.

## Resumen: lo que tienen todos en común

1. **Los captions se construyen palabra a palabra y se quedan** ("build-up"): "The Biggest" → "The Biggest *Mistake*". No son páginas fijas que aparecen enteras. En algunos, las palabras por venir se muestran en gris (karaoke). Nuestro pager hoy genera páginas fijas: hace falta un modo `reveal: 'build'`.
2. **Una o dos palabras clave por frase reciben un tratamiento** (tier): bold, itálica, otra fuente (script/serif itálica), color, píldora sólida, bloque marcador, tamaño mayor. El énfasis es *el* recurso de todos los estilos.
3. **Un título grande al inicio** (la palabra o frase tema), a veces detrás de la persona, a veces repetida en mosaico.
4. **Layouts de tarjeta**: la persona metida en un marco (rectángulo redondeado, arco, círculo, "iPhone"), split arriba/abajo con B-roll, fondo de color de marca.
5. **Transiciones con blur** (whip, zoom radial, desenfoque) y variantes por estilo (glitch, mosaico, slices, light leak, papel rasgado).
6. **Texturas y decoración** que dan la personalidad: stickers, garabatos, papel, grano, halftone, cuadrícula, pizarra, UI de cámara/SO.
7. **Paleta de marca fija** por estilo (un color de acento, a veces un fondo sólido).

## Ficha por estilo

| Estilo | Vibe | Captions | Énfasis | Título / gráficos | Layouts | Transiciones / efectos | Firma |
|---|---|---|---|---|---|---|---|
| **Prism Pro** | Cinematográfico, real estate | Sans ligera (Inter), build-up, posición flotante (arriba izq/der, abajo) | **Bold itálica** con tinte duotono teal/metálico y más grande | "Real / estate" pesos mixtos | Tarjeta cuadrada de B-roll sobre fondo desenfocado | **Desenfoque del fondo** cuando cae una palabra clave ("Only", "The Price"); whip/zoom blur a B-roll | El "focus pull": la persona se desenfoca y la palabra queda nítida |
| **Paper II** | Collage de papel, educativo | Poppins bold en **caja blanca redondeada**, texto negro; karaoke (lo no dicho en gris) | Bold + gris→negro | Cabecera de papel azul rasgado con etiquetas de cinta (label maker, mono) | — | Wipe de periódico rasgado; B-roll duotono/posterizado | Stickers recortados (taza, máquina de escribir, reloj) que "brotan" alrededor de la cabeza |
| **Prime** | Oscuro, motivacional | Poppins/Montserrat bold blanco, 1–3 palabras abajo | **Script/serif itálica en cian** ("harder.", "self-compassion") | Palabra gigante en script cian; **muro de palabra repetida** ("GROWTH" mosaico, una rellena) | Tira de 3 paneles verticales de B-roll; marco de neón cian | Zoom blur radial; marco cian que se dibuja | Texto detrás de la cabeza + neón |
| **Elevate** | Editorial, cálido | **Serif** (Instrument/Playfair) blanca, frase | *Serif itálica* | Título en script caligráfico + píldora "a short film" + subtítulo; asteriscos ✳, líneas finas, créditos en esquinas | B-roll como panel inferior | Glow suave, grano | Layout de revista |
| **Impact II** | Hype, MrBeast | **Condensada mayúscula** (Bebas/Anton) cian o blanca, 1–3 palabras | Palabra grande blanca; outline ("TIME") | Tarjetas negras con **cuadrícula** y palabra cian | — | **Glitch RGB split**, zoom blur, shake, blur final | Energía + glitch |
| **Sketch** | Cuaderno, doodle | **Manuscrita** (Caveat/Gochi Hand) blanca, 2 líneas, build-up; luego en **barra de marcador oscuro** | Bold sans dentro del texto | "MIND MAP" con **elipse garabateada** animada alrededor | **PiP circular** de la persona sobre B-roll | — | Trazos a mano que se dibujan |
| **Lens** | Fotógrafo, cámara | **Monospace** mayúscula en **barra negra** (etiqueta), alineada a la izquierda | — | "Aperture" naranja grande; **visor de cámara** (marco redondeado, esquinas, datos EXIF "1/125 f5.4 ISO 200"); texto vertical repetido en los bordes ("APERTURE & FOCUS") | **Dos paneles** (persona arriba, B-roll abajo) sobre azul marino | **Light leak** cálido, desenfoque | UI de cámara |
| **Vista** | Editorial inmobiliario, claro | **Serif** blanca con sombra, build-up, karaoke gris | — | "REALTY" condensada gigante arriba (detrás); "PENTHOUSE" negra sobre gris claro | Persona en tarjeta sobre B-roll; layout gris con PiP pequeño | **Máscaras geométricas**: bloques que suben (skyline), triángulos diagonales, mármol | Formas geométricas como transición |
| **Pop** | Gen-Z, Memphis | Píldora blanca, texto itálico con bold | Bold | "PROJECT" en **burbuja starburst** con sombra dura; marco de arco | **Polaroid** de B-roll; fondos rosa/cuadrícula/halftone | Stickers que brotan (estrellas, rayos, flores, flechas) con contorno negro grueso | Collage de stickers estilo cómic |
| **Orbit** | Limpio, azul de marca | **Píldora azul** con **serif** blanca | *Itálica* | "FRIENDS" condensada gigante deslizándose; tarjetas azul sólido con texto condensado en líneas escalonadas (gris/blanco) | B-roll dentro de **círculo**; círculos de contorno como decoración | Wipe circular | Círculos + azul |
| **Y2K** | Web 2000s | Sans amarilla (Arial), build-up | — | "Summer" script; **collage de celulares viejos** con la cara en las pantallas; **ventanas Mac OS clásico** en cascada con cursor | Ventanas apiladas como B-roll | **Disolución en mosaico** (cuadros blancos), estelas de ventanas | Nostalgia de escritorio |
| **Form** | Deportivo (Nike) | Sans ligera blanca abajo | **Bold itálica** | "RESULTS" amarillo condensado itálico; **mosaico de palabra repetida** desvanecido detrás | B-roll cuadrado sobre naranja; final gris con muro de texto | **Slices verticales** de la persona; grano/polvo | Naranja + slices |
| **Bloom** | Skincare, cálido | Sans ligera, build-up, con **bold** | Bold | "MOISTURIZE" (wide sans) + "Routine" script; etiqueta small caps; línea fina | **Arco** alrededor de la persona; tarjeta arco sobre gris; producto en **máscara píldora** | Frost/blur suave | Arco + terracota |
| **Chalk** | Pizarra, doodle | **Tiza/marcador** manuscrita blanca, palabras clave en **amarillo** o en tag oscuro | Color amarillo, tag | "YOUTH" repetido con textura de tiza; fotos con **borde garabateado** amarillo; caras sonrientes dibujadas; papel crema con fotos pegadas con cinta | Pizarra gris como fondo de B-roll | **Contorno amarillo dibujado alrededor de la persona** (rotoscopia garabateada); marcador amarillo detrás de palabras | Contorno de la persona a mano |
| **Linen** | Moda, lookbook | **Serif itálica** pequeña en **caja durazno** | — | "WEAR" serif burdeos + "your style" itálica; "Just dropped" serif grande | **Split diagonal** (bloques beige/salvia con borde inclinado), persona en esquina | Crossfade con blur | Diagonales + paleta beige/salvia/burdeos |
| **Evo** | Fintech, iOS | Sans ligera, build-up | **Bold itálica**; píldora **glass** oscura | "THE KEYS TO INVESTING" bold itálica en la tarjeta | Persona en **tarjeta redondeada con borde glass / gradiente**; dos tarjetas apiladas sobre **gradiente azul/rosa** | **Frosted glass** blur | Estética iOS |
| **Focus** | Suizo, azul | Sans blanca | **Bloque sólido** (marcador): palabra con fondo blanco y texto negro, o fondo azul | "FOLLOWERS" condensada sobre banda azul | **Marcos azules gruesos**, bandas letterbox, split arriba/abajo | Bloques azules que se deslizan | Highlight en bloque + azul |
| **Lift** | SaaS B2B | Sans blanca, build-up | **Píldora menta** (texto oscuro) | "Your Team" / "Faster Decisions" **serif** sobre **blob menta** o panel verde oscuro | Panel angular verde oscuro abajo; blob/polígono orgánico | — | Serif + menta + formas orgánicas |
| **Stack** | Tech review, rojo | Sans blanca (o negra sobre gris) | **Píldora roja** | "TECHNOLOGY" condensada gris con **relleno progresivo** rojo; **letras gigantes recortadas** ("TECH", "NO") fuera de cuadro; iconos geométricos en esquinas | Rojo full-bleed con la persona recortada; marcos rojos | — | Tipografía sobredimensionada + rojo |
| **Align** | Documental (Ken Burns) | **Monospace** mayúscula en **caja blanca** con texto negro, junto al medio | — | "COMPUTERS" + subtítulo; **etiquetas de capítulo en versalitas espaciadas** ("R E V O L U T I O N") | **Lienzo blanco con tarjetas de foto** en cuadrícula (persona como retrato, B-roll como fotos), collages | Tarjetas que entran (slide/scale) | Museo / archivo |

## Las primitivas que cubren los 20

Esto es el "vocabulario" a implementar. Un **style pack** = preset de captions + templates de título + layout/marcos + transiciones + paleta + texturas.

### A. Motor de captions (extender `captionPresets.ts` y `CaptionTrack.tsx`)
- `reveal: 'page' | 'build'` — build-up: cada palabra aparece en su onset y se queda; la página crece. Karaoke opcional (`upcoming: 'hidden' | 'dim'`).
- **Tratamientos de énfasis** por tier (combinables): `weight`, `italic`, `font` (cambiar a script/serif/hand), `color`, `scale`, `pill` (fondo sólido redondeado), `block` (fondo rectangular tipo marcador), `underline` (trazo).
- **Contenedor de página**: `none`, `pill` (blanca/oscura/marca), `bar` (etiqueta rectangular), `glass` (blur + borde), `tag` por palabra.
- **Fuentes** (todas OFL): geométricas (Inter, Poppins, Montserrat), condensadas (Bebas Neue, Anton, Oswald), serif (Playfair Display, Instrument Serif, Libre Caslon), script (Pinyon Script, Great Vibes, Dancing Script), manuscrita/tiza (Caveat, Gochi Hand, Permanent Marker, Patrick Hand), mono (Courier Prime, Space Mono, JetBrains Mono), wide (Unbounded, Syne).
- **Posición**: abajo fijo, medio, flotante (varía por página, alineación izq/der) — Prism.

### B. Títulos y tipografía cinética (extender `graphicTemplates.ts`)
- `hook-stack` (hecho), `label-2tone` (hecho), `stat` (hecho), `chapter` (hecho).
- `big-word`: palabra gigante arriba, opcionalmente **detrás de la persona** (requiere matte).
- `word-wall`: palabra repetida en mosaico (outline, una rellena) — Prime, Form, Chalk.
- `fill-title`: título con relleno progresivo — Stack.
- `oversized`: letras gigantes recortadas fuera de cuadro — Stack.
- `script-title`: script + píldora + subtítulo — Elevate, Bloom, Y2K.
- `chapter-caps`: versalitas espaciadas — Align.
- `kinetic-card`: tarjeta de color sólido con líneas escalonadas — Orbit, Impact II (con cuadrícula).
- `starburst`: burbuja cómic — Pop.

### C. Layouts y marcos (nuevo: `src/layouts.ts`)
- `frame`: rectángulo redondeado / arco / círculo / "iPhone" / glass / borde gradiente / viewfinder (esquinas + EXIF) / polaroid / ventana Mac OS.
- `split`: arriba-abajo con B-roll, dos tarjetas apiladas, PiP (círculo o rect), panel angular/diagonal, letterbox.
- `canvas`: fondo de color de marca, gradiente, papel, cuadrícula, pizarra, halftone; la persona en tarjeta o **recortada** (matte).
- Formas: blob/polígono orgánico, círculos de contorno, bloques.

### D. Transiciones (nuevo: `src/transitions.ts`)
- blur: whip (direccional), zoom radial, desenfoque/frost.
- glitch: RGB split + shake (Impact II).
- geométricas: bloques que suben, triángulos, slices verticales, wipe circular, bloques deslizantes.
- texturizadas: mosaico de píxeles, papel rasgado, light leak, cascada de ventanas.

### E. Decoración y texturas (buscadas o generadas, nunca dibujadas a mano)
- **Stickers, doodles, iconos, emoji**: se **buscan** con una API de assets con licencia clara, o se **generan** como PNG con fondo transparente con la **API de imágenes de OpenAI**, y se animan con transformaciones (pop, wiggle, float). Sin modelos de SVG. Investigación en `research/asset-sourcing.md`.
- **Trazos a mano animados**: los pocos que son geometría pura (elipse, subrayado, tachado) sí se generan por código (`stroke-dashoffset`); todo lo demás se busca o se genera.
- **Texturas** (papel, grano, halftone, tiza, cinta, cuadrícula): buscadas (CC0) o generadas con la API de imágenes.
- UI (visor de cámara, chrome de ventana, cursor): buscadas o generadas.

### F. Color y tratamiento de B-roll
- Paleta por style pack (acento, fondo, texto).
- B-roll: duotono/posterizado (Paper II), monocromo (Align), LUT cálida (Elevate, Bloom).

### G. Requiere matte de la persona (fase 3)
Prime (texto detrás), Chalk (contorno dibujado), Stack (recorte sobre rojo), Vista ("REALTY" detrás), Prism (desenfoque del fondo con la persona nítida sería aún mejor con matte, pero el preview desenfoca todo).

## Qué podemos imitar y cuándo

| Nivel | Estilos | Qué falta |
|---|---|---|
| **A — con captions v2 + templates + layouts + transiciones** (fase 1–2) | Prism Pro, Impact II, Focus, Stack (sin recorte), Lift, Form, Evo, Orbit, Bloom, Linen, Elevate, Vista (sin título detrás) | build-up, tratamientos de énfasis, contenedores, más fuentes, marcos/splits, tarjetas de color, blur/glitch/geométricas |
| **B — además assets y texturas** (fase 2–3) | Paper II, Pop, Chalk (sin contorno), Sketch, Y2K, Lens, Align | herramienta de assets para el agente: búsqueda por API + generación con la API de imágenes de OpenAI + animación de PNGs |
| **C — además matte** (fase 3) | Prime, Chalk completo, Stack completo, Vista completo | segmentación de la persona (MediaPipe/BiRefNet/SAM 2) y composición por capas |

## Cambios al plan

- La **fase 1** crece: captions v2 (`reveal: build`, karaoke, tratamientos de énfasis, contenedores, catálogo de fuentes OFL) y los templates de título B. Los 4 presets actuales se convierten en style packs: `palabra`, `caja`, `tracked`, `prism` + nuevos packs por estilo de Captions.ai (empezar por Prism Pro, Focus, Stack, Lift, Orbit, Impact II, que solo necesitan tipografía y bloques de color).
- La **fase 2** suma layouts/marcos y transiciones (blur, glitch, geométricas), además de color.
- La **fase 3** suma matte, la herramienta de assets (búsqueda por API + generación con OpenAI + animación de PNGs) y los packs B y C.
- El agente elige el **style pack** (o el usuario en el editor) y anota tiers; el pack decide todo lo demás.
