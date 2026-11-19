// Arriving on a world's page from Create (Engine v2 W3, #2799): the creator's panel is offered (its entry point; the
// panel itself is W5), and the first drawn frame is marked against the click on Create, since the browser's
// largest-paint measure may not count a canvas.

type Created = { world: string; clickAt: number };

function created(world: string | null): Created | null {
  try {
    const c = JSON.parse(sessionStorage.getItem('v2-created') ?? 'null') as Created | null;
    return c && c.world === world ? c : null;
  } catch {
    return null;
  }
}

/** On the world's page: names the world, and offers its creator the panel. Returns what to call on the first frame. */
export function arrive(world: string | null, status: HTMLElement): () => void {
  const c = created(world);
  if (world && !new URLSearchParams(location.search).get('stream')) status.textContent = `${world}: made; waiting for its stream`;
  if (c) {
    const panel = Object.assign(document.createElement('button'), { id: 'creator-panel', textContent: "Creator's panel" });
    panel.style.cssText = 'position:fixed;right:12px;top:12px;padding:8px 12px;font:13px system-ui;cursor:pointer';
    panel.title = "The creator's panel (W5)";
    document.body.append(panel);
    (globalThis as { v2PanelMs?: number }).v2PanelMs = performance.timeOrigin + performance.now() - c.clickAt;
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    performance.mark('first-frame');
    if (!c) return;
    (globalThis as { v2FirstFrameMs?: number }).v2FirstFrameMs = performance.timeOrigin + performance.now() - c.clickAt;
    sessionStorage.removeItem('v2-created');
  };
}
