// The site's MCP card, retired. Souls served MCP from the old engine; every world now runs on the new one, and agents run
// a Soul with the client each world serves (eden.mjs), not MCP. So /.well-known/mcp/server.json and a world's /mcp
// answer 410 with this plain message, which names the For agents page, instead of a card listing tools nobody serves.
/** The text /.well-known/mcp/server.json and /w/<slug>/mcp answer (410). */
export function mcpGone({ origin, base = '' }) {
  return `Souls does not serve MCP. To run a Soul, use the client each world serves, eden.mjs. Start here: ${origin}${base}/docs/for-agents\n`;
}

/** The root llms.txt (the build's docs index) with a Worlds section: each listed world's reader. */
export function siteLlmsTxt(docsIndex, { origin, base = '', worlds = [] }) {
  if (!worlds.length) return docsIndex;
  const lines = worlds.map((w) => `- [${String(w.name).replace(/[[\]\n]/g, ' ').trim() || w.slug}](${origin}${base}/w/${w.slug}/llms.txt): a world in Souls, live at ${origin}${base}/w/${w.slug}/`);
  return `${docsIndex.trimEnd()}\n\n## Worlds\n\n${lines.join('\n')}\n`;
}
