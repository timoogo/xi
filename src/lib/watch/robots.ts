/**
 * robots.txt (RFC 9309): the groups naming our product token apply, otherwise `*`.
 * The longest matching rule wins; on a tie, Allow wins. `*` and a final `$` are supported.
 * Crawl-delay is not in the RFC but is honoured as a minimum interval between requests.
 */
export const ROBOTS_TOKEN = "xiwatch";

type Rule = { allow: boolean; pattern: string };
export type RobotsPolicy = { rules: Rule[]; crawlDelayMs: number | null };

export function parseRobots(text: string, token = ROBOTS_TOKEN): RobotsPolicy {
  const groups: { agents: string[]; rules: Rule[]; crawlDelayMs: number | null }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const match = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const field = match[1].toLowerCase();
    const value = match[2].trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [], crawlDelayMs: null }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if ((field === "allow" || field === "disallow") && value) current.rules.push({ allow: field === "allow", pattern: value });
    else if (field === "crawl-delay" && /^\d+(\.\d+)?$/.test(value)) current.crawlDelayMs = Math.min(Number(value) * 1000, 86_400_000);
  }
  const named = groups.filter(group => group.agents.some(agent => agent !== "*" && token.startsWith(agent)));
  const applicable = named.length ? named : groups.filter(group => group.agents.includes("*"));
  const delays = applicable.map(group => group.crawlDelayMs).filter((delay): delay is number => delay !== null);
  return { rules: applicable.flatMap(group => group.rules), crawlDelayMs: delays.length ? Math.max(...delays) : null };
}

function matches(pattern: string, path: string) {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const regex = body.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${regex}${anchored ? "$" : ""}`).test(path);
}

/** `pathAndQuery`: the request target, e.g. "/flux/rss.xml?x=1". */
export function robotsAllows(policy: RobotsPolicy, pathAndQuery: string) {
  let best: Rule | null = null;
  for (const rule of policy.rules) {
    if (!matches(rule.pattern, pathAndQuery)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) best = rule;
  }
  return best?.allow ?? true;
}
