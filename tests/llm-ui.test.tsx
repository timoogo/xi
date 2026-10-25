import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentLLMPanel, AgentLLMSummary, ModelTestOutcome } from "../src/components/llm/agent-llm-panel";
import { formatBytes, toChoice } from "../src/components/llm/format";
import { InstanceCard, ModelTable } from "../src/components/llm/instance-card";
import { LLMDraftPicker, llmDraftSummary } from "../src/components/llm/llm-draft-picker";
import { keyFromName, LLMSettings, RemovalPanel } from "../src/components/llm/llm-settings";
import { OptionsFields } from "../src/components/llm/options-fields";
import { INHERIT_LLM, INHERIT_LLM_DRAFT, mergeInferenceOptions, type AgentLLMView, type LLMInstance, type ModelInfo } from "../src/lib/llm/types";

const model = (name: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({ name, sizeBytes: null, family: null, parameterSize: null, quantization: null, contextLength: null, modifiedAt: null, ...extra });
const instance = (extra: Partial<LLMInstance> = {}): LLMInstance => ({
  id: "11111111-1111-4111-8111-111111111111", owner: "alice", type: "ollama", name: "Ollama — Pi", key: "pi", baseUrl: "http://192.168.1.10:11434",
  enabled: true, defaultModel: "qwen3:1.7b", options: {}, revision: "22222222-2222-4222-8222-222222222222", createdAt: "2026-10-01T10:00:00.000Z", updatedAt: "2026-10-01T10:00:00.000Z",
  status: { state: "unknown" }, models: null, modelsAt: null, ...extra,
});
const env = { configured: false, api: null, defaultModel: null, error: null };
const resolved = (extra: Partial<Extract<AgentLLMView["resolution"], { ok: true }>["value"]> = {}): AgentLLMView["resolution"] => ({ ok: true, value: { instanceSource: "global", modelSource: "instance", instance: { id: instance().id, key: "pi", name: "Ollama — Pi", type: "ollama" }, model: "qwen3:1.7b", options: mergeInferenceOptions(), ...extra } });

test("instance card: connection state in words, models table without invented metadata", () => {
  const ok = renderToStaticMarkup(<InstanceCard instance={instance({ status: { state: "ok", checkedAt: "2026-10-24T08:00:00.000Z", version: "0.12.1", latencyMs: 42 }, models: [model("qwen3:1.7b", { sizeBytes: 1_359_000_000, family: "qwen3", parameterSize: "2.0B", quantization: "Q4_K_M" }), model("mystery")], modelsAt: "2026-10-24T08:00:00.000Z" })} isDefault busy={false} onAction={() => {}} />);
  assert.match(ok, /Connecté \(Ollama 0\.12\.1\) · 42 ms/);
  assert.match(ok, /Par défaut/);
  assert.match(ok, /Activée/);
  assert.match(ok, /2 installé\(s\)/);
  for (const label of ["Tester la connexion", "Actualiser les modèles", "Modifier", "Désactiver", "Supprimer"]) assert.match(ok, new RegExp(label));
  assert.match(ok, /aria-label="Actualiser les modèles de Ollama — Pi"/);
  assert.match(ok, /1,4 Go/);
  // The unknown model's metadata stays "—": five dashes (size, family, parameters, quantization, context).
  const row = ok.slice(ok.indexOf(">mystery<"));
  assert.equal((row.match(/>—</g) ?? []).length, 5);
  assert.doesNotMatch(ok, /Utiliser par défaut/);

  const failing = renderToStaticMarkup(<InstanceCard instance={instance({ enabled: false, status: { state: "error", checkedAt: "2026-10-24T08:00:00.000Z", code: "unreachable", message: "Connexion refusée." } })} isDefault={false} busy={false} onAction={() => {}} />);
  assert.match(failing, /Serveur injoignable : Connexion refusée\./);
  assert.match(failing, /Désactivée/);
  assert.match(failing, /Réactiver/);
  assert.match(failing, /Pas encore découverts/);
});

test("model table and sizes", () => {
  assert.match(renderToStaticMarkup(<ModelTable models={[]} caption="x" />), /Aucun modèle installé/);
  const html = renderToStaticMarkup(<ModelTable models={[model("a", { contextLength: 32_768 })]} caption="Modèles" />);
  assert.match(html, /<caption class="sr-only">Modèles<\/caption>/);
  assert.match(html, /scope="col"/);
  assert.match(html, /32 768 tokens|32 768 tokens/);
  assert.equal(formatBytes(null), "—");
  assert.equal(formatBytes(512), "512 o");
  assert.equal(keyFromName("Ollama — Mac mini"), "ollama-mac-mini");
});

test("settings: empty state, environment line without URL, labelled form controls", () => {
  const html = renderToStaticMarkup(<LLMSettings initial={{ instances: [], settings: { defaultInstanceId: null, revision: null }, environment: { configured: true, api: "ollama", defaultModel: "qwen3:8b", error: null } }} />);
  assert.match(html, /Intelligence artificielle/);
  assert.match(html, /Aucune instance configurée/);
  assert.match(html, /Serveur de l’installation/);
  assert.match(html, /Utilisé tant que vous n’avez choisi aucune instance par défaut/);
  assert.match(html, /<label for="[^"]+"[^>]*>Instance par défaut<\/label>/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /Ajouter une instance Ollama/);
});

test("removal: dependencies listed and an explicit choice required", () => {
  const target = instance();
  const html = renderToStaticMarkup(<RemovalPanel removal={{ instance: target, reassignTo: "", dependencies: { isDefault: true, agents: [{ id: "a", handle: "astronoxi", name: "Astronoxi", reason: "explicit" }] } }}
    instances={[instance({ id: "33333333-3333-4333-8333-333333333333", name: "Mac mini" })]} busy={false} onChange={() => {}} onConfirm={() => {}} onCancel={() => {}} />);
  assert.match(html, /role="alertdialog"/);
  assert.match(html, /Astronoxi \(@astronoxi\) — instance choisie explicitement/);
  assert.match(html, /Réassigner à « Mac mini »/);
  assert.match(html, /héritage de la configuration globale/);
  assert.match(html, /erreur de configuration/);
  assert.match(html, /disabled=""[^>]*>Confirmer la suppression/);
});

test("agent panel: inherited, overridden and broken configurations", () => {
  const inherited = renderToStaticMarkup(<AgentLLMSummary view={{ settings: { config: INHERIT_LLM, revision: null, valid: true, legacy: false }, resolution: resolved() }} />);
  assert.match(inherited, /Ollama — Pi/);
  assert.match(inherited, /qwen3:1\.7b/);
  assert.match(inherited, /héritée/);
  assert.match(inherited, /modèle par défaut de l’instance/);

  const model = renderToStaticMarkup(<AgentLLMSummary view={{ settings: { config: { ...INHERIT_LLM, model: "qwen3:8b" }, revision: null, valid: true, legacy: false }, resolution: resolved({ model: "qwen3:8b", modelSource: "agent" }) }} />);
  assert.match(model, /modèle spécifique/);
  const other = renderToStaticMarkup(<AgentLLMSummary view={{ settings: { config: { ...INHERIT_LLM, instanceId: instance().id }, revision: null, valid: true, legacy: false }, resolution: resolved({ instanceSource: "agent" }) }} />);
  assert.match(other, /instance spécifique/);
  assert.match(other, /propre au ΞAgent/);

  const broken = renderToStaticMarkup(<AgentLLMSummary view={{ settings: { config: { ...INHERIT_LLM, instanceId: instance().id }, revision: null, valid: true, legacy: false }, resolution: { ok: false, code: "instance-missing", message: "L’instance choisie a été supprimée." } }} />);
  assert.match(broken, /role="alert"/);
  assert.match(broken, /Problème de configuration : Instance supprimée/);
  assert.match(broken, /sans basculer vers un autre serveur/);

  // No automatic inference: the test is a button, and is disabled while the configuration is broken.
  const panel = renderToStaticMarkup(<AgentLLMPanel agentId="x" initial={{ settings: { config: INHERIT_LLM, revision: null, valid: true, legacy: false }, resolution: { ok: false, code: "not-configured", message: "Aucune instance." } }} instances={[]} defaultInstanceId={null} environment={env} />);
  assert.match(panel, /disabled=""[^>]*>Tester le modèle/);
  assert.match(panel, />Modifier</);
});

test("model test outcome: success and failure stated in words", () => {
  assert.match(renderToStaticMarkup(<ModelTestOutcome result={{ ok: true, latencyMs: 812, model: "qwen3:1.7b", instance: "Pi", reply: "OK" }} />), /Test réussi[\s\S]*812 ms[\s\S]*rien n’a été publié ni modifié/);
  assert.match(renderToStaticMarkup(<ModelTestOutcome result={{ ok: false, latencyMs: null, code: "model-missing", message: "qwen3:8b absent." }} />), /Échec du test[\s\S]*Modèle non installé : qwen3:8b absent\./);
});

test("creation picker: unresolved YAML instance asks for an explicit choice", () => {
  const instances = [toChoice(instance({ models: [model("qwen3:1.7b")] }))];
  const html = renderToStaticMarkup(<LLMDraftPicker value={{ ...INHERIT_LLM_DRAFT, unresolvedKey: "mac-mini" }} onChange={() => {}} instances={instances} defaultInstanceId={instances[0].id} />);
  assert.match(html, /Instance « mac-mini » introuvable sur cette installation/);
  assert.match(html, /Configuration globale \(Ollama — Pi\)/);
  assert.match(html, /<legend[^>]*>Intelligence artificielle<\/legend>/);
  assert.equal(llmDraftSummary(INHERIT_LLM_DRAFT, instances), "IA héritée");
  assert.equal(llmDraftSummary({ ...INHERIT_LLM_DRAFT, instanceId: instances[0].id, model: "qwen3:8b" }, instances), "Ollama — Pi · qwen3:8b");
  assert.doesNotMatch(html, /192\.168/);
});

test("advanced options: folded, empty fields inherit with the inherited value shown", () => {
  const html = renderToStaticMarkup(<OptionsFields value={{ temperature: 0.2 }} onChange={() => {}} inherited={mergeInferenceOptions({ timeoutMs: 60_000 })} />);
  assert.match(html, /<details/);
  assert.match(html, /\(1 personnalisé\)/);
  assert.match(html, /value="0\.2"/);
  assert.match(html, /placeholder="hérité : 60"/);
  assert.match(html, /placeholder="modèle"/);
  assert.equal((html.match(/<label for=/g) ?? []).length, 4);
});
