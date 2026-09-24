# Referencias de estilo (2026-09-23)

Cuatro reels que el usuario marcó como "esto es lo que queremos". Los cuatro son de **bienes raíces**: un presentador recorre la propiedad hablando a cámara, intercalado con B-roll propio de la propiedad. Los analicé por muestreo de frames (cada 2–4 s) y aquí solo describo el estilo; los frames no se guardan (son contenido con copyright).

| # | Reel | Idioma | Duración |
|---|---|---|---|
| R1 | instagram.com/reel/DXIDQvuD6eI (marketingmoveshomes, Lake Nona FL) | en-US | 70 s |
| R2 | instagram.com/reel/DWP0SB-FFeH (vecore.mx, desarrollo "Caudalia") | es-MX | 33 s |
| R3 | instagram.com/reel/DXX3EPYkTUG (arturo.garcia.flores, departamento) | es-MX | 47 s |
| R4 | instagram.com/reel/DZGibv3pqZW (jcmoralesbr, Temozón, Mérida) | es-MX | 72 s |

## Lo que tienen en común

### 1. Estructura
Los cuatro siguen la misma secuencia:
1. **Hook de 0 a 3 s:** un titular gigante.
2. **Capítulos o lista:** "Number two… Number five" en R1, "CAPÍTULO 11" en R4.
3. **Recorrido:** cada espacio con su etiqueta.
4. **Cierre:** logo o CTA sobre una toma aérea oscurecida (R1, R2).

El presentador camina hacia la cámara, grabado con gimbal o con gran angular.

### 2. Texto en tres niveles, que son lo que de verdad los hace "premium"

| Nivel | Qué es | Ejemplos | Detalles |
|---|---|---|---|
| **A. Titular / hook** | Tipografía cinética enorme, 2 a 4 líneas apiladas de **tamaños distintos**, en el tercio superior | R1 "This / is what / $10M / just under", R2 "SI ESTÁS / TODAVÍA", R3 "ESTE / DEPARTAMENTO / NO ES / PARA TODOS" | Las palabras aparecen de una en una con **blur-in** (de desenfocadas a nítidas) o pop. Van en blanco con una o dos palabras en **color de acento** (amarillo, morado, azul eléctrico) y sombra suave. En R3 el texto está **DETRÁS del presentador** (matte de segmentación): la persona tapa las letras. En R2 los números van semitransparentes o en gradiente ("DE **24**", "+75%") |
| **B. Etiquetas y datos** | 1–2 palabras que nombran un espacio o un dato, a veces en **dos tonos** (línea 1 blanca, línea 2 amarilla) | "Mérida / Yucatán", "Doble / lavabo", "Bar / gimnasio", "104 m²", "DESDE 81 m²", "+75% VENDIDO", "ALTA DEMANDA", "PRINCIPAL", "Number two", "CAPÍTULO 11" | En R4 alguna etiqueta está **anclada en 3D a la pared** ("HABITACIÓN SECUNDARIA", con motion tracking) |
| **C. Captions** | **Minimalistas.** Nada de estilo Hormozi | 3 variantes: (1) **una palabra a la vez**, blanca, centrada a media altura, sin caja (R1 delgada en minúsculas; R4 más gruesa); (2) **frase corta en caja oscura redondeada** abajo (R2); (3) **mayúsculas diminutas con mucho tracking** (R3) | Lo premium aquí es la contención: los captions no compiten con los titulares |

### 3. Transiciones y movimiento
- **Whip pan con desenfoque direccional** y **zoom blur** entre tomas de B-roll (R1, R2), con speed ramps.
- **Split-screen 2×2** tipo collage de interiores (R4).
- **Tarjeta que se aleja**: el clip escala dentro del frame (R1).
- **Punch-in** (zoom de golpe) sobre el presentador (R2).

### 4. B-roll
- Es **material propio** de la propiedad: interiores con gimbal, drone de la zona y fachada. **No es stock.** Pexels no sirve para este nicho, salvo quizá tomas genéricas de la ciudad.
- El B-roll se corresponde con lo que se dice: "cocina" → toma de la cocina, "rooftop" → toma del rooftop.

### 5. Color
Look limpio y luminoso:
- Blancos neutros a cálidos.
- Interiores high-key.
- Cielos azules con buena saturación.
- Aéreas en golden hour.

El video de prueba del usuario (`pruebaeditoria.mp4`) sale **plano y lavado**, así que necesita llevarse a este look.

### 6. Tipografías (equivalentes OFL)
| Estilo | Fuentes |
|---|---|
| Titulares geométricos extra-bold (R1, R2, R4) | Montserrat ExtraBold/Black, Poppins Bold |
| Titulares condensados (R3) | Anton, Oswald, Bebas Neue |
| Captions | Montserrat Regular/Medium o Inter |

## Qué implica para reel-agent

1. **Presets de captions: empezar con 3, no con 8.** `palabra` (una palabra centrada), `caja` (frase en caja oscura) y `tracked` (mayúsculas pequeñas espaciadas). El estilo Hormozi baja de prioridad.
2. **Lo premium está en los titulares y las etiquetas (niveles A y B).** Son templates de motion graphics con props tipadas:
   - `hook-stack`: líneas apiladas de tamaños mixtos, reveal por palabra con blur-in o pop, colores de acento.
   - `label-2tone`: etiqueta en dos tonos.
   - `stat`: número grande semitransparente con una palabra.
   - `chapter`: "Capítulo N" / "Número N".
   - `location-tag`: ciudad y colonia.
   - `price` / `desde`: precio o superficie inicial.
   - `end-card`: logo + CTA de WhatsApp sobre una aérea oscurecida.
3. **Texto detrás de la persona.** Hace falta un matte del presentador:
   - Opciones de licencia limpia: MediaPipe Selfie Segmentation (Apache-2.0), BiRefNet (MIT), SAM 2 (Apache-2.0). **No** usar RobustVideoMatting (GPL-3.0).
   - Se precalcula como video con alfa. En Remotion se compone por capas: fondo → texto → persona recortada.
4. **Librería de transiciones:** whip blur, zoom blur, speed ramp, split 2×2, card zoom-out y punch-in.
5. **El B-roll sale de la biblioteca del usuario, no de Pexels:**
   - El agente etiqueta cada asset mirando su contact sheet (cocina, recámara, baño, rooftop, drone-fachada, amenidad…).
   - Luego los empareja con las menciones del transcript.
   - Pexels queda solo como respaldo.
   - En `pruebaeditoria.mp4`, el tramo negro de 7.2 s a 40.1 s es el hueco para ese B-roll y sus etiquetas.
6. **Brand kit por cliente:** logo, colores de acento y fuentes. Todos los templates lo leen.
7. **Look de color por defecto: "real estate limpio".** Exposición y balance automáticos para material plano, más una LUT luminosa.
8. **Después (fase 4+):** etiquetas ancladas en 3D a la pared, que requieren tracking planar con OpenCV.
