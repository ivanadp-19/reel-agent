# Retomas: cómo las quitan los demás, y cómo lo hacemos (2026-09-24)

Motivo: en el material VIBEM 02 la presentadora lee cada línea en voz baja para memorizarla y después la dice a cámara; `find_cut_candidates` tomó la lectura como la toma buena. Antes de corregirlo, qué hacen los productos que sí resuelven esto.

## Lo que hacen los demás

- **Descript, "Remove Retakes"** (acción de IA, 2025): detecta frases regrabadas y marca las tomas *anteriores* para quitar; se queda con la *última*. Maneja subfrases y arranques en falso ("both a—" se va, "both alike" se queda). Reseñas: falla cuando una frase se repite a propósito. [Changelog](https://feedback.descript.com/changelog/new-ai-action-remove-retakes) · [Producto](https://www.descript.com/ai/remove-retakes)
- **TimeBolt**: busca repeticiones de palabras y frases en las retomas y "selecciona el último corte como la mejor toma"; combina cortes por forma de onda con transcripción. Publica una comparativa donde en un clip lleno de retomas deja 43 palabras basura frente a 378 de Descript. [Auto Remove Bad Takes](https://www.timebolt.io/blog/auto-remove-bad-takes) · [Comparativa](https://www.timebolt.io/blog/timebolt-vs-gling-vs-descript-who-removes-bad-takes-better-in-scripted-video)
- **Gling**: quita silencios y "malas tomas" a partir de la transcripción, mismo criterio (la última). [Gling](https://www.gling.ai/save-time)
- **Captions AI Edit**: quita pausas y muletillas; la documentación no dice cómo elige entre tomas; exige un solo hablante y vídeo sin editar. [AI Edit](https://captions.ai/help/docs/project/ai-edit)
- **Submagic**: `removeBadTakes` ("detecta y quita malas tomas y silencio con IA") sin explicar el criterio. [API](https://docs.submagic.co/api-reference/create-project)
- Riverside y Wisecut no documentan detección de retomas (TimeBolt lo dice en su comparativa).

Conclusión: el sector trabaja sobre la transcripción, busca repeticiones a nivel de frase y aplica un solo prior: **la última toma es la buena**. Nadie usa el volumen ni la identidad de voz para esto.

## Lo que fallaba en el nuestro

Sobre `g02-hook`, `g02-body` y `g02-close` (medido con `.captions-tmp/takes.mjs` y `cands.mjs`):

1. **Los intentos eran respiraciones, no frases.** Un intento terminaba en cada pausa > 700 ms, así que la toma buena dicha con una pausa ("Tu propia cava, [1.9 s] Un salón de eventos privados y un sky bar.") quedaba en dos trozos, y la lectura en voz baja dicha de corrido era el intento más largo.
2. **Si ninguna toma "terminaba" en punto, ganaba la más larga**: la lectura.
3. **La similitud aceptaba contención**: "tu propia cava" (3 palabras) casaba con "¿Cuántos edificios en Mérida te dan tu propia cava?" porque las 3 están dentro, y el detector proponía cortar el arranque de la toma buena como "falso arranque" de la primera frase del gancho.
4. **El habla de dirección en español no estaba** ("te lo repito", "vamos a grabar a cuadro", "no leí", "dos veces").
5. Ni el volumen ni la diarización lo resuelven: la lectura en voz baja va de 3 a 10 dB por debajo según la línea (a veces bajo el umbral de 6 dB), y pyannote parte a la propia presentadora en varias voces cuando cambia de registro (4 "hablantes" en el gancho).

## Lo que cambió (`src/cuts.ts`)

- **Intentos = frases**: un tramo que hace pausa sin terminar la frase continúa en el siguiente (misma voz, pausa ≤ 2.5 s, ninguno es habla de dirección).
- **Gana la última**: la última toma completa cercana a la más larga; si no hay, la última que dice la mayor parte; si no, la última. Nunca la más larga por serlo.
- **Falso arranque solo como prefijo**: un intento anterior de ≥ 2 palabras, más corto, cuyas palabras abren el intento posterior; una frase contenida en una frase anterior no es retoma.
- **Dirección en español e inglés**: repito, vamos a grabar, a cuadro, no leí, dos veces, desde el principio, la última; from the top, take two, rolling. Hasta 10 palabras.

Queda fuera: una frase de la lectura que la presentadora *no* vuelve a decir ("Todo eso es tuyo en Montalban 326." en el gancho) no tiene contraparte y sobrevive; el agente la ve entre `[pause]` y la corta si quiere. Y una frase repetida a propósito se detecta como retoma (mismo límite que Descript).
