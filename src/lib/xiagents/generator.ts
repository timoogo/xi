import { z } from "zod";

export const manualChoiceSchema = z.object({ seed: z.uuid(), count: z.number().int().min(1).max(10), accountRevision: z.uuid() }).strict();
export type ManualChoice = z.infer<typeof manualChoiceSchema>;
export type GeneratedContent = { summary: string; messages: string[] };

/** Pure local fixture generator. Publication persistence does not depend on this implementation. */
export function generateFixture(choice: ManualChoice): GeneratedContent {
  const places = ["Azur", "Lilas", "Émeraude", "Corail"];
  const place = places[parseInt(choice.seed.slice(0, 8), 16) % places.length];
  const scenario = `l’atelier imaginaire ${place}`;
  const steps = [
    `Bienvenue dans ${scenario}. Ses habitants fictifs préparent un jardin partagé : voici un scénario pour tester Ξ.`,
    "Le groupe imagine trois espaces : un potager, une zone de lecture et un coin de repos. Ces propositions sont entièrement fictives.",
    "Pour comparer les idées, le groupe prépare une liste de besoins : accès, entretien et confort. Aucun résultat réel n’est rapporté.",
    "Une maquette en papier permet de discuter de la place des chemins et des plantations. Il s’agit d’un exercice inventé.",
    "Les participants fictifs proposent de faire tourner les tâches afin que chacun puisse contribuer à son rythme.",
    "Un carnet imaginaire rassemble les questions encore ouvertes et les idées à essayer lors de la prochaine séance.",
    "Le groupe simule une journée de pluie pour réfléchir aux abris et à l’accès au jardin. Ce test n’a pas eu lieu dans le monde réel.",
    "Chaque proposition est relue pour distinguer les hypothèses des décisions imaginaires. Le scénario reste un support de démonstration.",
    "Le groupe prépare une courte présentation de sa maquette et conserve les alternatives dans son carnet fictif.",
    "Fin de l’exercice : le jardin reste imaginaire. Ce fil sert uniquement à vérifier les publications et conversations de Ξ.",
  ];
  return {
    summary: `Contenu de test fictif — ${scenario} · variante ${choice.seed.slice(0, 8)}`,
    messages: Array.from({ length: choice.count }, (_, i) => `**Contenu de test fictif — ${i + 1}/${choice.count}**\n\n${steps[i]}\n\n_Variante ${choice.seed.slice(0, 8)}. Aucun fait d’actualité ni source réelle._`),
  };
}
