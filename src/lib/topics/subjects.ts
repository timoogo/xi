/** Small deterministic vocabulary. Unknown or mixed subjects deliberately keep a flat proposal. */
export const normalizeSubject = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
export function extractSubject(intent: string) {
  return intent.trim().replace(/[’‘]/g, "'")
    .replace(/^(?:je\s+souhaite\s+suivre|je\s+veux\s+me\s+renseigner\s+sur|j'aimerais\s+comprendre|parle[-\s]moi\s+(?:des?\s+|du\s+|d')|je\s+m'int[ée]resse\s+(?:aux|au|à)\s+)\s*/i, "")
    .replace(/^(?:la|le|les|une?|des|du)\s+|^l'\s*/i, "")
    .replace(/[.!?…]+$/, "").trim();
}
export type SubjectDefinition = { tag: string; name: string; scope: string };
const politics: SubjectDefinition = { tag: "politiks", name: "Politique", scope: "Politique, institutions, vie démocratique et actualité politique, tous territoires confondus" };
const regions = [
  { tag: "france", name: "française", plural: "françaises", aliases: ["france", "francaise", "francaises", "francais"] },
  { tag: "allemagne", name: "allemande", plural: "allemandes", aliases: ["allemagne", "allemande", "allemandes", "allemand", "allemands"] },
  { tag: "europe", name: "européenne", plural: "européennes", aliases: ["europe", "europeenne", "europeennes", "europeen", "europeens"] },
];
/** Each returned item is one direct specialization of the previous item. */
export function knownSubject(subject: string): SubjectDefinition[] | null {
  const key = normalizeSubject(subject).replace(/[.]/g, " ").replace(/\s+/g, " ").trim();
  if (/^(politique|politiques|politiks)( mondiale| generale)?$/.test(key)) return [politics];
  for (const region of regions) {
    const regionPattern = `(?:${region.aliases.join("|")})`;
    const political = new RegExp(`^(?:politique|politiques|politiks) (?:en |de |d'|de la )?${regionPattern}$`).test(key);
    const elections = new RegExp(`^(?:elections? (?:en |de |d'|de la )?${regionPattern}|politiks ${region.tag} elections)$`).test(key);
    if (political || elections) {
      const local = { tag: `politiks.${region.tag}`, name: `Politique ${region.name}`, scope: `Politique, institutions et actualité politique ${region.plural}` };
      return elections ? [politics, local, { tag: `${local.tag}.elections`, name: `Élections ${region.plural}`, scope: `Scrutins, campagnes, règles électorales et résultats des élections ${region.plural}` }] : [politics, local];
    }
  }
  return null;
}
