# Assets decorativos: búsqueda por API + generación con OpenAI (2026-09-24)

Para imitar los estilos de Captions.ai hacen falta stickers, doodles, iconos, emoji, texturas y chrome de UI. Decisión del usuario: **no dibujamos nada a mano ni usamos modelos de SVG**. Todo se **busca** en APIs con licencia clara o se **genera** con la API de imágenes de OpenAI, y luego se anima por código. Cada usuario trae sus propias keys (como con Pexels).

## Recomendación

| Necesidad | Fuente | Licencia | Cómo |
|---|---|---|---|
| Iconos, emoji 2D/3D, hand-drawn | **Iconify API** (`api.iconify.design`) | Por set; filtrar en cliente a MIT/Apache/ISC/CC0 (+ CC-BY con crédito) | `/search?query=` → `/{prefix}/{name}.svg`. Sin key, sin límite documentado, se puede cachear y hasta autohospedar (Apache-2.0). Sets clave: `fluent-emoji` (3D-look, MIT), `fluent-emoji-flat` (MIT), `noto` (Apache), `twemoji` (CC-BY), `streamline-freehand(-color)` (hand-drawn, CC-BY), `lucide` (ISC), `ph`/`tabler`/`hugeicons` (MIT). Excluir `openmoji` (CC-BY-SA) y cualquier NC |
| Emoji 3D como PNG | **Fluent Emoji** (Microsoft, MIT) vía jsDelivr | MIT | `cdn.jsdelivr.net/gh/microsoft/fluentui-emoji@main/assets/<Nombre>/3D/<nombre>_3d.png`; se puede empaquetar un subconjunto en el repo |
| Ilustraciones/stickers CC | **Openverse API** (`api.openverse.org/v1/images/`) | Por ítem; filtrar `license=cc0,pdm,by` y `license_type=commercial,modification` | Sin key: 20/min, 200/día; registrado más. Devuelve `attribution` listo. `extension=svg` funciona (Wikimedia) |
| Ilustraciones doodle | **Open Doodles** (CC0) | CC0 | ~50 escenas; se pueden empaquetar |
| Stickers animados | Giphy Stickers API | Requiere "Powered by GIPHY", **no cachear** sin aprobación, key de producción por solicitud | Solo si se acepta el logo; Tenor ya no acepta clientes nuevos (ene 2026) |
| **Cualquier cosa que no exista**: sticker específico, doodle en un estilo, textura, chrome de UI | **OpenAI Images API** | El cliente **es dueño del output**, uso comercial permitido, sin atribución; llevan marca C2PA/SynthID | `POST /v1/images/generations` con `background: "transparent"`, `output_format: "png"`; modelos actuales `gpt-image-2.5-flare` (rápido) / `-sunburst` (edición), `gpt-image-1.5` (~$0.009–0.13 por imagen 1024² según calidad), `gpt-image-1-mini` (~$0.005–0.036) |
| Fondo transparente cuando el modelo no lo da | **rembg** con `-m birefnet-general` (MIT) o `u2net`/`isnet` (Apache) | **Ojo:** el modelo por defecto de rembg ahora es BRIA RMBG-2.0 (**CC BY-NC**, de pago comercial). `@imgly/background-removal` es AGPL. remove.bg gratis es no comercial |
| Texturas de papel/cartón/cinta | **ambientCG** (CC0, API `api/v2/full_json?q=paper`) y 3dtextures.me (CC0) | CC0 | Se puede empaquetar un pack pequeño (Paper001–006, Cardboard001–004, CardboardSet001 con tape/torn) |
| Grano, halftone, cuadrícula, pizarra | **Procedural** (CSS/SVG/canvas) o generadas con OpenAI | — | No hay fuente CC0 buena; el ruido y los puntos son triviales por código |
| Fotos de fondo | Pexels / Pixabay (ya en el proyecto) | Pexels: crédito + enlace; Pixabay: cachear 24 h, no hotlink permanente | Solo en tiempo de edición, nunca empaquetadas |
| Fuentes | **Google Fonts** (OFL/Apache/UFL) vía `@remotion/google-fonts`; Developer API para buscar por categoría (`category=handwriting|display|serif|monospace`) | OFL: se pueden empaquetar con el texto de la licencia | Ya hay catálogo en `src/fonts.ts` |

## Descartados y por qué
- **unDraw, Storyset, Blush/Doodle Ipsum, texturelabs, Lost and Taken**: prohíben redistribuir o compilar; solo en tiempo de edición y con crédito (Storyset). No aportan lo que Iconify + Openverse + OpenAI ya cubren.
- **Noun Project**: API de pago ($25/mes mínimo), URLs temporales, glifos monocromos (no stickers).
- **Freepik/Magnific**: tiene `icon_type=sticker` y `style=hand-drawn` (el mejor fit de pago), pero créditos + ToS truncados; opcional más adelante.
- **IconScout**: prohíbe cachear y exige aprobación escrita para apps integradas.
- **SVG Repo**: sin API, 429 a todo.
- **Google Imagen**: apagado; Gemini image no documenta transparencia.
- **Modelos de SVG (Recraft, etc.)**: fuera por decisión del usuario.
- **OpenMoji** (CC BY-SA): el share-alike podría contaminar el video.

## Diseño de la herramienta para el agente

```
search_asset({query, kind: 'icon'|'emoji'|'sticker'|'illustration'|'texture', style?: 'flat'|'3d'|'hand-drawn'|'outline', limit})
  → [{id, src (URL o ruta local), format: 'svg'|'png', source, license, attribution?, preview}]
  - icon/emoji → Iconify (filtro de licencia en cliente; emoji 3D → Fluent PNG)
  - sticker/illustration → Openverse (cc0/by, commercial+modification) + Open Doodles local
  - texture → pack local CC0 (ambientCG) o procedural

generate_asset({prompt, kind: 'sticker'|'doodle'|'texture'|'ui', size?, transparent: true})
  → {src: 'assets/gen/<hash>.png', cost}
  - OpenAI Images con background transparent + output png; prompt envuelto por kind
    ("die-cut sticker, thick white border, flat vector style, isolated on transparent background")
  - fallback rembg birefnet-general si el modelo no devuelve alfa
  - caché por hash de prompt; el usuario paga con su OPENAI_API_KEY

add_graphic({template: 'sticker', props: {src, anim: 'pop'|'wiggle'|'float'|'spin', size, x, y, rotate}})
```

Atribución: `search_asset` devuelve `attribution` cuando la licencia lo pide (CC-BY, Pexels, Pixabay); el proyecto guarda la lista y el render puede añadirla como créditos al final o en la descripción.

## Animar PNG/SVG sin dibujar movimiento
Transformaciones en Remotion: `pop` (spring de escala), `wiggle` (rotación ±3° senoidal), `float` (traslación vertical lenta), `spin`, `bounce`, con entrada/salida por fade. Para SVG con trazos (doodles), `stroke-dashoffset` animado dibuja el trazo. Lottie vía `@remotion/lottie` cuando el asset sea Lottie.

## Riesgos
- rembg por defecto = modelo NC: fijar el modelo por nombre en el código.
- Iconify público sin SLA: cachear localmente (permitido) y ofrecer autohospedaje.
- Openverse anónimo: 200/día; registrar app para más.
- Imágenes generadas: marca C2PA/SynthID (no se puede quitar), declarar uso de IA si la plataforma lo exige.
- Sets CC-BY (twemoji, streamline): guardar y mostrar la atribución.

## Notas de la investigación de animación
- Remotion ya trae todo lo necesario: `spring`, `interpolate` + `Easing`, `@remotion/noise` (wiggle), `@remotion/paths` (`evolvePath` = draw-on por `stroke-dashoffset`), `@remotion/shapes`; `paths`/`noise`/`shapes` son MIT.
- Ningún servicio mainstream de video generativo (Runway, Pika, Luma, Kling, Veo) entrega alfa por API; Sora API cerró. Los "stickers animados por IA" no valen la pena: se animan PNG/SVG por código.
