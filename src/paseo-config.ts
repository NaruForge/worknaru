import { BUILTIN_PROVIDER_IDS, hashDaemonPassword, loadConfig, type PaseoDaemonConfig } from '@getpaseo/server';
import { join } from 'node:path';

export const PASEO_VERSION = '0.8.0-beta.1';
export const TEST_SELECTION = { model: 'gpt-5.6-luna', effort: 'low' } as const;
export const CODEX_OPTIONS = {
  approval_policy: 'on-request', sandbox_mode: 'workspace-write',
  sandbox_workspace_write: { network_access: false },
  web_search: 'disabled', features: { multi_agent_v2: false },
} as const;
export type RuntimeInit = { paseoHome: string; codexHome: string; codexPath: string; password: string };

export function privatePaseoConfig(init: RuntimeInit): PaseoDaemonConfig {
  const base = loadConfig(init.paseoHome, { env: {}, cli: { listen: '127.0.0.1:0',
    relayEnabled: false, mcpEnabled: false, mcpInjectIntoAgents: false, webUiEnabled: false } });
  const speechOff = { provider: 'local', explicit: true, enabled: false } as const;
  return { ...base,
    configReload: undefined, daemonVersion: PASEO_VERSION, desktopManaged: false,
    listen: '127.0.0.1:0', paseoHome: init.paseoHome,
    corsAllowedOrigins: [], hostnames: ['127.0.0.1'],
    auth: { password: hashDaemonPassword(init.password) }, relayEnabled: false, relayEnabledMutable: false,
    serviceProxy: { publicBaseUrl: null, standaloneListen: null }, webUi: { enabled: false, distDir: null },
    mcpEnabled: false, mcpInjectIntoAgents: false, browserToolsEnabled: false,
    pluginsEnabled: false, plugins: {}, enableTerminalAgentHooks: false,
    terminalProfiles: [], agentProfiles: [], appendSystemPrompt: undefined, skillSelection: undefined,
    autoArchiveAfterMerge: false, staticDir: join(init.paseoHome, 'static'),
    voiceLlmProvider: null, voiceLlmProviderExplicit: true, voiceLlmModel: null, openai: undefined,
    speech: { providers: { dictationStt: speechOff, voiceTurnDetection: speechOff, voiceStt: speechOff, voiceTts: speechOff } },
    agentClients: {}, agentProviderSettings: { codex: {
      command: { mode: 'replace', argv: [init.codexPath] }, env: { CODEX_HOME: init.codexHome },
    } },
    providerOverrides: Object.fromEntries(BUILTIN_PROVIDER_IDS.map(id => [id, id === 'codex'
      ? { enabled: true, command: [init.codexPath], env: { CODEX_HOME: init.codexHome }, paseoTools: { enabled: false } }
      : { enabled: false }])),
  };
}
