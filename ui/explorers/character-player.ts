import {parseMvl, characterExpressions, composeCharacter} from '../../src/engines/mages/mvl.js';
import {TexturedMeshRenderer} from '../../src/graphics/textured-mesh.js';
/** Inspector adapter; game animation policy and story VM are intentionally separate. */
export async function mountCharacterPlayer(
  parent: HTMLElement,
  geometry: Uint8Array,
  atlas: Uint8Array,
): Promise<() => void> {
  const mvl = parseMvl(geometry),
    expressions = characterExpressions(mvl);
  if (!expressions.length) throw new Error('No character expressions in MVL');
  const panel = document.createElement('section');
  panel.className = 'character-player';
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-label', 'Composed character');
  const controls = document.createElement('div');
  controls.className = 'audio-controls';
  function select(label: string): HTMLSelectElement {
    const wrapper = document.createElement('label');
    wrapper.append(label);
    const s = document.createElement('select');
    s.setAttribute('aria-label', label);
    wrapper.append(s);
    controls.append(wrapper);
    return s;
  }
  const expression = select('Expression'),
    mouth = select('Mouth'),
    eyes = select('Eyes'),
    framing = select('Framing');
  framing.add(new Option('Fit character', 'fit'));
  framing.add(new Option('Original canvas', 'canvas'));
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  panel.append(controls, canvas, status);
  parent.append(panel);
  let renderer: TexturedMeshRenderer | undefined;
  const imageUrl = URL.createObjectURL(new Blob([atlas.slice().buffer], {type: 'image/webp'}));
  try {
    const image = new Image();
    image.src = imageUrl;
    await image.decode();
    renderer = new TexturedMeshRenderer(canvas, image);
    const original = document.createElement('details'),
      summary = document.createElement('summary');
    summary.textContent = 'Texture atlas';
    image.alt = 'Packed character texture atlas';
    original.append(summary, image);
    panel.append(original);
    for (const [i, e] of expressions.entries()) expression.add(new Option(e.base.name, String(i)));
    // Keep framing stable across eye/mouth variants and expression changes.
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const e of expressions)
      for (const m of [e.base, ...e.mouths, ...e.eyes])
        for (const i of m.indices) {
          const p = i * 5;
          minX = Math.min(minX, m.vertices[p]!);
          maxX = Math.max(maxX, m.vertices[p]!);
          minY = Math.min(minY, m.vertices[p + 1]!);
          maxY = Math.max(maxY, m.vertices[p + 1]!);
        }
    function draw(): void {
      try {
        const e = expressions[Number(expression.value)]!,
          meshes = composeCharacter(e, Number(mouth.value), Number(eyes.value));
        const fit = framing.value === 'fit';
        renderer!.draw(
          meshes,
          fit ? maxX - minX + 40 : e.base.width,
          fit ? maxY - minY + 40 : e.base.height,
          fit ? (minX + maxX) / 2 : 0,
          fit ? (minY + maxY) / 2 : 0,
        );
        status.textContent = `${meshes.map((m) => m.name).join(' + ')} · ${meshes.reduce((n, m) => n + m.indices.length / 3, 0).toLocaleString()} triangles · atlas ${image.naturalWidth} × ${image.naturalHeight}`;
      } catch (error) {
        status.textContent = String(error);
      }
    }
    function change(): void {
      const e = expressions[Number(expression.value)]!;
      for (const [s, parts] of [
        [mouth, e.mouths],
        [eyes, e.eyes],
      ] as const) {
        s.replaceChildren();
        s.add(new Option('None (inspect base)', '-1'));
        parts.forEach((m, i) => s.add(new Option(m.name, String(i))));
        s.value = parts.length ? '0' : '-1';
      }
      draw();
    }
    expression.onchange = change;
    mouth.onchange = draw;
    eyes.onchange = draw;
    framing.onchange = draw;
    change();
    return () => {
      renderer?.dispose();
      panel.remove();
    };
  } catch (error) {
    renderer?.dispose();
    panel.remove();
    throw error;
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}
