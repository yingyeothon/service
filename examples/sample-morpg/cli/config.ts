/* Client configuration: flags > environment > env file (`--config`). Pure given `readFile`. */

/** The three channel ids the client needs; the smoke's state file carries more, which is ignored. */
export interface StateFile {
  authChannelId: string;
  lobbyChannelId: string;
  qChannelId: string;
}

export interface Config {
  apiBase: string;
  gatewayWsUrl: string;
  authBase?: string;
  debugKeyFile?: string;
  token?: string;
  user: string;
  state: StateFile;
}

export interface LoadConfigOptions {
  argv: string[];
  env: Record<string, string | undefined>;
  readFile: (path: string) => string;
}

const FLAGS: Record<string, string> = {
  "--config": "config",
  "--api": "MORPG_API_BASE",
  "--gw": "MORPG_GATEWAY_WS_URL",
  "--auth": "MORPG_AUTH_BASE",
  "--state": "MORPG_STATE_FILE",
  "--debug-key-file": "MORPG_DEBUG_KEY_FILE",
  "--token": "MORPG_TOKEN",
  "--user": "MORPG_USER",
};

export const USAGE = `usage: pnpm play -- [--config <env-file>] [--user <name>] [--token <jwt>]
       [--api <url>] [--gw <wss-url>] [--auth <url>] [--state <state.json>] [--debug-key-file <path>]
env file keys: MORPG_API_BASE MORPG_GATEWAY_WS_URL MORPG_STATE_FILE MORPG_AUTH_BASE
               MORPG_DEBUG_KEY_FILE MORPG_TOKEN MORPG_USER`;

export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    // `pnpm play -- --user x` hands the `--` through (pnpm >= 10).
    if (a === "--") continue;
    const eq = a.indexOf("=");
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const key = FLAGS[flag];
    if (!key) throw new Error(`unknown argument ${a}\n${USAGE}`);
    const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (value === undefined) throw new Error(`${flag} needs a value\n${USAGE}`);
    out[key] = value;
  }
  return out;
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const value = line.slice(eq + 1).trim();
    out[line.slice(0, eq).trim()] = value.replace(/^"(.*)"$/, "$1");
  }
  return out;
}

function parseState(text: string, path: string): StateFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`state file ${path} is not JSON`);
  }
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >;
  const pick = (k: keyof StateFile): string => {
    const v = o[k];
    if (typeof v !== "string" || v === "")
      throw new Error(`state file ${path} lacks ${k}`);
    return v;
  };
  return {
    authChannelId: pick("authChannelId"),
    lobbyChannelId: pick("lobbyChannelId"),
    qChannelId: pick("qChannelId"),
  };
}

export function loadConfig({ argv, env, readFile }: LoadConfigOptions): Config {
  const flags = parseArgs(argv);
  const file = flags.config ? parseEnvFile(read(readFile, flags.config)) : {};
  const get = (k: string): string | undefined =>
    flags[k] ?? env[k] ?? file[k] ?? undefined;
  const need = (k: string): string => {
    const v = get(k);
    if (!v) throw new Error(`missing ${k}\n${USAGE}`);
    return v;
  };
  const statePath = need("MORPG_STATE_FILE");
  const token = get("MORPG_TOKEN");
  const authBase = get("MORPG_AUTH_BASE");
  const debugKeyFile = get("MORPG_DEBUG_KEY_FILE");
  if (!token && !(authBase && debugKeyFile))
    throw new Error(
      `missing MORPG_TOKEN, or MORPG_AUTH_BASE + MORPG_DEBUG_KEY_FILE for a dev debug token\n${USAGE}`,
    );
  return {
    apiBase: need("MORPG_API_BASE").replace(/\/+$/, ""),
    gatewayWsUrl: need("MORPG_GATEWAY_WS_URL").replace(/\/+$/, ""),
    authBase: authBase?.replace(/\/+$/, ""),
    debugKeyFile,
    token,
    user: get("MORPG_USER") ?? env.USER ?? "player",
    state: parseState(read(readFile, statePath), statePath),
  };
}

function read(readFile: (p: string) => string, path: string): string {
  try {
    return readFile(path);
  } catch {
    throw new Error(`cannot read ${path}`);
  }
}
