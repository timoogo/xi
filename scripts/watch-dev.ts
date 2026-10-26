import { spawn, type ChildProcess } from "node:child_process";

const INTERVAL_MS = 60_000;

let stopping = false;
let child: ChildProcess | null = null;
let wakeUp: (() => void) | null = null;

function stop(signal: NodeJS.Signals): void {
  if (stopping) return;

  stopping = true;
  child?.kill(signal);
  wakeUp?.();
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

function runTick(): Promise<void> {
  return new Promise((resolve) => {
    const worker = spawn(
      "pnpm",
      ["exec", "tsx", "scripts/watch-worker.ts", "tick"],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          XI_WATCH_AUTOPUBLISH: "true",
          XI_WATCH_AUTOPUBLISH_PUBLIC: "false",
        },
      },
    );

    child = worker;

    worker.once("error", (error: Error) => {
      console.error("[watch] Erreur :", error);
    });

    worker.once("close", (code: number | null) => {
      if (code !== 0 && !stopping) {
        console.error(`[watch] Tick terminé avec le code ${code}`);
      }

      child = null;
      resolve();
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (stopping) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      wakeUp = null;
      resolve();
    }, ms);

    wakeUp = () => {
      clearTimeout(timer);
      wakeUp = null;
      resolve();
    };
  });
}

async function main(): Promise<void> {
  console.log("[watch] Veille autonome démarrée");

  while (!stopping) {
    await runTick();

    if (!stopping) {
      await sleep(INTERVAL_MS);
    }
  }

  console.log("[watch] Veille autonome arrêtée");
}

void main().catch((error: unknown) => {
  console.error("[watch] Erreur fatale :", error);
  process.exitCode = 1;
});