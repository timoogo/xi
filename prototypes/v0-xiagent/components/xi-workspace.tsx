'use client'

import { useState } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  FileText,
  Gauge,
  History,
  Menu,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Rss,
  Waypoints,
} from 'lucide-react'
import { Button } from '@/components/ui/button'

const news = [
  { title: 'Solar Cells Inspected on NASA’s NEO Surveyor', meta: '2 articles · 1 éditeur · 1 confirmation', time: 'il y a 34 min', tone: 'green' },
  { title: 'Tinga’s Tale', meta: '1 article · 1 éditeur · 1 confirmation', time: 'il y a 1 h', tone: 'blue' },
  { title: 'NASA’s Perseverance Offers Clues to Protect Crews From Mars Dust', meta: '1 article · 1 éditeur · 1 confirmation', time: 'il y a 2 h', tone: 'amber' },
]

const candidates = [
  { title: 'NASA SEES Interns Tackle Real-World Challenges in Lunar Exploration', status: 'En attente de l’inférence locale', reason: 'Serveur Ollama injoignable', priority: 'À vérifier' },
  { title: 'NASA Invites Media to 2026 von Braun Space Exploration Symposium', status: 'Retenu · fenêtre nocturne · sujet astronomie', reason: 'Prêt à être rédigé', priority: 'Prêt' },
]

function SectionLabel({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return <div className="mb-3 flex items-center justify-between"><h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{children}</h2>{action}</div>
}

function StatusDot({ tone = 'green' }: { tone?: 'green' | 'amber' | 'red' | 'blue' }) {
  return <span className={`inline-block size-2 rounded-full ${tone === 'green' ? 'bg-emerald-400' : tone === 'amber' ? 'bg-amber-400' : tone === 'red' ? 'bg-red-400' : 'bg-sky-400'}`} aria-hidden="true" />
}

function AgentView({ onSource }: { onSource: () => void }) {
  const [paused, setPaused] = useState(false)
  const [showDraft, setShowDraft] = useState(false)
  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 pt-6 sm:px-8">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Button variant="ghost" size="icon" aria-label="Retour"><ArrowLeft /></Button>
          <div><div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground"><Bot data-icon="inline-start" /> ΞAgent</div><h1 className="text-2xl font-semibold tracking-tight">Astronoxi</h1><p className="mt-1 text-sm text-muted-foreground">Veille spatiale autonome</p></div>
        </div>
        <Button variant="outline" size="icon" aria-label="Plus d'options"><MoreHorizontal /></Button>
      </header>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.45fr)_minmax(300px,0.8fr)]">
        <main className="min-w-0">
          <section className="rounded-2xl border border-border/80 bg-card/70 p-5 shadow-sm sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div><div className="mb-2 flex items-center gap-2 text-sm text-emerald-300"><StatusDot /> {paused ? 'En pause' : 'Actif · veille automatique'}</div><h2 className="text-xl font-medium">Votre agent travaille pour vous.</h2><p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">Dernière collecte il y a 34 min. 3 sujets sont prêts à être suivis.</p></div>
              <Button variant={paused ? 'default' : 'outline'} onClick={() => setPaused(!paused)}>{paused ? <Play data-icon="inline-start" /> : <Pause data-icon="inline-start" />}{paused ? 'Reprendre' : 'Mettre en pause'}</Button>
            </div>
            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              {[['10', 'sources suivies', Rss], ['3', 'sujets détectés', Radio], ['1', 'action requise', AlertTriangle]].map(([value, label, Icon], i) => <div key={label as string} className="rounded-xl border border-border/70 bg-background/50 p-4"><Icon className={`mb-3 ${i === 2 ? 'text-amber-300' : 'text-muted-foreground'}`} /><div className="text-2xl font-semibold">{value}</div><div className="text-xs text-muted-foreground">{label as string}</div></div>)}
            </div>
          </section>

          <section className="mt-8"><SectionLabel action={<Button variant="ghost" size="sm">Voir tout <ChevronRight data-icon="inline-end" /></Button>}>À faire maintenant</SectionLabel><div className="rounded-xl border border-amber-400/30 bg-amber-400/5 p-4"><div className="flex gap-3"><AlertTriangle className="mt-0.5 shrink-0 text-amber-300" /><div className="min-w-0 flex-1"><p className="font-medium">Une vérification est bloquée</p><p className="mt-1 text-sm leading-5 text-muted-foreground">Le moteur local Ollama ne répond pas. Les sujets restent en attente, sans publication automatique.</p><div className="mt-4 flex flex-wrap gap-2"><Button size="sm"><RefreshCw data-icon="inline-start" /> Relancer l&apos;analyse</Button><Button variant="ghost" size="sm">Voir le diagnostic</Button></div></div></div></div></section>

          <section className="mt-8"><SectionLabel action={<Button variant="ghost" size="sm">Tout voir <ChevronRight data-icon="inline-end" /></Button>}>Dernières actualités</SectionLabel><div className="overflow-hidden rounded-xl border border-border/80">{news.map((item) => <button key={item.title} className="flex w-full items-start gap-3 border-b border-border/70 p-4 text-left last:border-0 hover:bg-accent/40"><StatusDot tone={item.tone as 'green' | 'amber' | 'blue'} /><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{item.title}</span><span className="mt-1 block text-xs text-muted-foreground">{item.meta} · {item.time}</span></span><ChevronRight className="shrink-0 text-muted-foreground" /></button>)}</div></section>

          <section className="mt-8"><SectionLabel action={<Button variant="ghost" size="sm">Voir les brouillons <ChevronRight data-icon="inline-end" /></Button>}>Publications</SectionLabel><div className="rounded-xl border border-border/80 p-4"><div className="flex items-center gap-3"><FileText className="text-muted-foreground" /><div className="flex-1"><p className="text-sm font-medium">NASA, USDA Sign Agreement Advancing Earth Science</p><p className="mt-1 text-xs text-muted-foreground">Brouillon approuvé · publication prévue demain à 03:00</p></div><Button variant="ghost" size="icon" aria-label="Ouvrir le brouillon" onClick={() => setShowDraft(!showDraft)}><ChevronDown className={showDraft ? 'rotate-180 transition-transform' : 'transition-transform'} /></Button></div>{showDraft && <div className="mt-4 rounded-lg bg-muted/50 p-4 text-sm leading-6 text-muted-foreground">L&apos;accord entre la NASA et l&apos;USDA vise à moderniser les données agricoles et à améliorer la compétitivité américaine.</div>}</div></section>
        </main>

        <aside className="flex flex-col gap-5">
          <section className="rounded-2xl border border-border/80 bg-card/50 p-5"><SectionLabel>Raccourcis</SectionLabel><div className="grid gap-2"><Button variant="outline" className="justify-start" onClick={onSource}><Waypoints data-icon="inline-start" /> Gérer les sources <ChevronRight className="ml-auto" /></Button><Button variant="outline" className="justify-start"><Sparkles data-icon="inline-start" /> Générer une publication <ChevronRight className="ml-auto" /></Button><Button variant="outline" className="justify-start"><Settings2 data-icon="inline-start" /> Configuration <ChevronRight className="ml-auto" /></Button></div></section>
          <section className="rounded-2xl border border-border/80 bg-card/50 p-5"><SectionLabel>Activité récente</SectionLabel><div className="flex flex-col gap-4">{[['Collecte NASA terminée', 'il y a 34 min', Check], ['Sujet regroupé', 'il y a 1 h', Activity], ['Publication planifiée', 'hier à 22:17', Clock3]].map(([label, time, Icon]) => <div key={label as string} className="flex gap-3"><div className="mt-0.5 rounded-full bg-muted p-1.5"><Icon className="size-3.5 text-muted-foreground" /></div><div><p className="text-sm">{label as string}</p><p className="text-xs text-muted-foreground">{time as string}</p></div></div>)}</div><Button variant="ghost" size="sm" className="mt-5 w-full">Ouvrir l&apos;historique <History data-icon="inline-end" /></Button></section>
        </aside>
      </div>
    </div>
  )
}

function SourceView({ onBack }: { onBack: () => void }) {
  const [advanced, setAdvanced] = useState(false)
  const [active, setActive] = useState(true)
  return <div className="mx-auto max-w-6xl px-4 pb-16 pt-6 sm:px-8">
    <header className="mb-8 flex items-start justify-between gap-4"><div className="flex items-start gap-3"><Button variant="ghost" size="icon" onClick={onBack} aria-label="Retour"><ArrowLeft /></Button><div><div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground"><Rss data-icon="inline-start" /> Source</div><h1 className="text-2xl font-semibold tracking-tight">NASA</h1><p className="mt-1 text-sm text-muted-foreground">nasa.gov · flux RSS/Atom</p></div></div><Button variant="outline" size="icon" aria-label="Plus d'options"><MoreHorizontal /></Button></header>
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(280px,0.7fr)]">
      <main className="min-w-0 flex flex-col gap-5">
        <section className="rounded-2xl border border-border/80 bg-card/70 p-5 sm:p-6"><div className="flex flex-wrap items-center justify-between gap-4"><div><div className="mb-2 flex items-center gap-2 text-sm text-emerald-300"><StatusDot /> Active</div><h2 className="text-xl font-medium">Cette source est fiable et surveillée.</h2><p className="mt-1 text-sm text-muted-foreground">Dernière collecte réussie il y a 34 min · prochaine dans 26 min.</p></div><Button variant="outline" onClick={() => setActive(!active)}>{active ? 'Désactiver la collecte' : 'Réactiver la collecte'}</Button></div><div className="mt-6 grid gap-3 sm:grid-cols-3">{[['Élevée', 'fiabilité', ShieldCheck], ['Toutes les 60 min', 'fréquence', Clock3], ['10', 'articles suivis', FileText]].map(([value, label, Icon]) => <div key={label as string} className="rounded-xl border border-border/70 bg-background/50 p-4"><Icon className="mb-3 text-muted-foreground" /><div className="text-lg font-semibold">{value as string}</div><div className="text-xs text-muted-foreground">{label as string}</div></div>)}</div></section>
        <section className="rounded-2xl border border-border/80 bg-card/50 p-5"><SectionLabel action={<Button variant="ghost" size="sm">Tout voir <ChevronRight data-icon="inline-end" /></Button>}>Derniers articles collectés</SectionLabel><div className="flex flex-col gap-1">{news.concat([{ title: 'NASA Invites Media to 2026 von Braun Space Exploration Symposium', meta: '1 article · collecté avec succès', time: 'il y a 3 h', tone: 'blue' as const }]).map((item) => <button key={item.title} className="flex items-start gap-3 rounded-lg p-3 text-left hover:bg-accent/40"><StatusDot tone={item.tone as 'green' | 'amber' | 'blue'} /><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{item.title}</span><span className="mt-1 block text-xs text-muted-foreground">{item.meta} · {item.time}</span></span><ChevronRight className="shrink-0 text-muted-foreground" /></button>)}</div></section>
        <section className="rounded-2xl border border-border/80 bg-card/50"><button className="flex w-full items-center gap-3 p-5 text-left" onClick={() => setAdvanced(!advanced)}><Settings2 className="text-muted-foreground" /><span className="flex-1"><span className="block font-medium">Réglages avancés</span><span className="mt-1 block text-xs text-muted-foreground">Provenance, topics, fréquence et diagnostics techniques</span></span><ChevronDown className={advanced ? 'rotate-180 transition-transform' : 'transition-transform'} /></button>{advanced && <div className="grid gap-5 border-t border-border/70 p-5 sm:grid-cols-2"><div><p className="text-xs text-muted-foreground">Adresse du flux</p><p className="mt-1 text-sm">https://www.nasa.gov/feed/</p></div><div><p className="text-xs text-muted-foreground">Agent responsable</p><p className="mt-1 text-sm">@astronoxi</p></div><div><p className="text-xs text-muted-foreground">Topics</p><p className="mt-1 text-sm">#astronomie · #politique</p></div><div><p className="text-xs text-muted-foreground">Dernier diagnostic</p><p className="mt-1 flex items-center gap-2 text-sm text-emerald-300"><StatusDot /> Aucun problème</p></div></div>}</section>
      </main>
      <aside className="flex flex-col gap-5"><section className="rounded-2xl border border-border/80 bg-card/50 p-5"><SectionLabel>En bref</SectionLabel><div className="flex flex-col gap-4 text-sm"><div className="flex items-center gap-3"><ShieldCheck className="text-emerald-300" /><span className="flex-1">Source vérifiée</span><Check className="text-muted-foreground" /></div><div className="flex items-center gap-3"><Gauge className="text-sky-300" /><span className="flex-1">Réponse moyenne</span><span className="text-muted-foreground">99 ms</span></div><div className="flex items-center gap-3"><Bot className="text-muted-foreground" /><span className="flex-1">Utilisée par</span><span className="text-muted-foreground">1 agent</span></div></div></section><section className="rounded-2xl border border-border/80 bg-card/50 p-5"><SectionLabel>Actions</SectionLabel><Button variant="outline" className="w-full justify-start"><Plus data-icon="inline-start" /> Ajouter à un agent</Button><Button variant="ghost" className="mt-2 w-full justify-start text-destructive"><AlertTriangle data-icon="inline-start" /> Supprimer la source</Button></section></aside>
    </div>
  </div>
}

export default function XiWorkspace() {
  const [view, setView] = useState<'agent' | 'source'>('agent')
  return <div className="min-h-screen bg-background text-foreground"><nav className="border-b border-border/70 bg-background/90"><div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-8"><div className="flex items-center gap-3"><div className="flex size-8 items-center justify-center rounded-lg bg-foreground text-background"><span className="text-sm font-bold">Ξ</span></div><span className="font-semibold tracking-tight">Astronoxi</span></div><div className="hidden items-center gap-1 rounded-lg bg-muted/50 p-1 sm:flex"><button onClick={() => setView('agent')} className={`rounded-md px-3 py-1.5 text-xs font-medium ${view === 'agent' ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}>Vue agent</button><button onClick={() => setView('source')} className={`rounded-md px-3 py-1.5 text-xs font-medium ${view === 'source' ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}>Vue source</button></div><Button variant="ghost" size="icon" className="sm:hidden" aria-label="Ouvrir le menu"><Menu /></Button></div></nav>{view === 'agent' ? <AgentView onSource={() => setView('source')} /> : <SourceView onBack={() => setView('agent')} />}</div>
}
