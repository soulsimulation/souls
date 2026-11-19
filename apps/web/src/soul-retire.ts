/** #3375: retiring a Soul, asked once, the same from its card and from the Advanced tools. */
type Call = (path: string, body?: unknown, method?: string) => Promise<{ status: number }>;
export const retireQuestion = (name: string) => `Retire ${name} for good? ${name} leaves every world and cannot come back.`;
export async function retireSoul(api: Call, soul: { id: string; name: string }, ask: (question: string) => boolean = q => confirm(q)): Promise<boolean> {
  if (!ask(retireQuestion(soul.name))) return false;
  return (await api(`/v1/souls/${encodeURIComponent(soul.id)}`, undefined, 'DELETE')).status === 200;
}
