/** #3375: retiring a Soul, asked once, the same from its card and from the Advanced tools. */
type Call = (path: string, body?: unknown, method?: string) => Promise<{ status: number }>;
export const retireQuestion = (name: string) => `Retire ${name} for good? ${name} leaves every world and cannot come back.`;
/** `byDirectory`: on a world the new engine runs, its retire (owner-mailbox.ts `v2Retire`); the old route is refused there. */
export async function retireSoul(api: Call, soul: { id: string; name: string }, ask: (question: string) => boolean = q => confirm(q), byDirectory: ((soulId: string) => Promise<boolean>) | null = null): Promise<boolean> {
  if (!ask(retireQuestion(soul.name))) return false;
  if (byDirectory) return byDirectory(soul.id);
  return (await api(`/v1/souls/${encodeURIComponent(soul.id)}`, undefined, 'DELETE')).status === 200;
}
