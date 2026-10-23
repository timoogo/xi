/** Shared by the final preview and writer: the test label cannot be removed by editing. */
export function labelTestMessage(body: string, index: number, total: number) {
  const label = `**Contenu de test fictif — ${index + 1}/${total}**\n\n`;
  return body.startsWith(label) ? body : label + body;
}

export const testPublicationSummary = (total: number) => `Contenu de test fictif — ${total === 1 ? "post" : `thread de ${total} messages`}`;
