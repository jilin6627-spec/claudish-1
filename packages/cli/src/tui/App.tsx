/** @jsxImportSource @opentui/react */
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useCallback, useMemo, useState } from "react";
import {
  loadConfig,
  removeApiKey,
  removeEndpoint,
  saveConfig,
  setApiKey,
  setEndpoint,
} from "../profile-config.js";
import { clearBuffer, getBufferStats } from "../stats-buffer.js";
import { PROVIDERS, ProviderDef, maskKey } from "./providers.js";
import { C } from "./theme.js";

const VERSION = "v5.16";

type Tab = "providers" | "routing" | "privacy";
type Mode = "browse" | "input_key" | "input_endpoint" | "add_routing_pattern" | "add_routing_chain";

function bytesHuman(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

export function App() {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();

  const [config, setConfig] = useState(() => loadConfig());
  const [bufStats, setBufStats] = useState(() => getBufferStats());
  const [providerIndex, setProviderIndex] = useState(0);
  const [activeTab, setActiveTab] = useState<Tab>("providers");
  const [mode, setMode] = useState<Mode>("browse");
  const [inputValue, setInputValue] = useState("");
  const [routingPattern, setRoutingPattern] = useState("");
  const [routingChain, setRoutingChain] = useState("");
  const [chainSelected, setChainSelected] = useState<Set<string>>(new Set());
  const [chainOrder, setChainOrder] = useState<string[]>([]);
  const [chainCursor, setChainCursor] = useState(0);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // Chain selector uses same PROVIDERS list for consistent naming
  const CHAIN_PROVIDERS = PROVIDERS;

  const quit = useCallback(() => renderer.destroy(), [renderer]);

  // Sort: configured providers first, then unconfigured (preserving original order within groups)
  const displayProviders = useMemo(() => {
    return [...PROVIDERS].sort((a, b) => {
      const aHasKey = !!(config.apiKeys?.[a.apiKeyEnvVar] || process.env[a.apiKeyEnvVar]);
      const bHasKey = !!(config.apiKeys?.[b.apiKeyEnvVar] || process.env[b.apiKeyEnvVar]);
      if (aHasKey === bHasKey) return PROVIDERS.indexOf(a) - PROVIDERS.indexOf(b);
      return aHasKey ? -1 : 1;
    });
  }, [config]);

  const selectedProvider = displayProviders[providerIndex]!;
  const refreshConfig = useCallback(() => {
    setConfig(loadConfig());
    setBufStats(getBufferStats());
  }, []);

  const hasCfgKey = !!config.apiKeys?.[selectedProvider.apiKeyEnvVar];
  const hasEnvKey = !!process.env[selectedProvider.apiKeyEnvVar];
  const hasKey = hasCfgKey || hasEnvKey;
  const cfgKeyMask = maskKey(config.apiKeys?.[selectedProvider.apiKeyEnvVar]);
  const envKeyMask = maskKey(process.env[selectedProvider.apiKeyEnvVar]);
  const keySrc = hasEnvKey && hasCfgKey ? "e+c" : hasEnvKey ? "env" : hasCfgKey ? "cfg" : "";
  const activeEndpoint =
    (selectedProvider.endpointEnvVar
      ? config.endpoints?.[selectedProvider.endpointEnvVar] ||
        process.env[selectedProvider.endpointEnvVar]
      : undefined) ||
    selectedProvider.defaultEndpoint ||
    "";

  const telemetryEnabled =
    process.env.CLAUDISH_TELEMETRY !== "0" &&
    process.env.CLAUDISH_TELEMETRY !== "false" &&
    config.telemetry?.enabled === true;

  const statsEnabled = process.env.CLAUDISH_STATS !== "0" && process.env.CLAUDISH_STATS !== "false";

  const ruleEntries = Object.entries(config.routing ?? {});
  const profileName = config.defaultProfile || "default";

  const readyCount = PROVIDERS.filter(
    (p) => !!(config.apiKeys?.[p.apiKeyEnvVar] || process.env[p.apiKeyEnvVar])
  ).length;

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") return quit();

    // Input modes
    if (mode === "input_key" || mode === "input_endpoint") {
      if (key.name === "return" || key.name === "enter") {
        const val = inputValue.trim();
        if (!val) {
          setStatusMsg("Aborted (empty).");
          setMode("browse");
          return;
        }
        if (mode === "input_key") {
          setApiKey(selectedProvider.apiKeyEnvVar, val);
          process.env[selectedProvider.apiKeyEnvVar] = val;
          setStatusMsg(`Key saved for ${selectedProvider.displayName}.`);
        } else {
          if (selectedProvider.endpointEnvVar) {
            setEndpoint(selectedProvider.endpointEnvVar, val);
            process.env[selectedProvider.endpointEnvVar] = val;
          }
          setStatusMsg("Endpoint saved.");
        }
        refreshConfig();
        setInputValue("");
        setMode("browse");
      } else if (key.name === "escape") {
        setInputValue("");
        setMode("browse");
      }
      return;
    }

    if (mode === "add_routing_pattern") {
      if (key.name === "return" || key.name === "enter") {
        if (routingPattern.trim()) {
          setChainSelected(new Set());
          setChainCursor(0);
          setChainOrder([]);
          setMode("add_routing_chain");
        }
      } else if (key.name === "escape") {
        setRoutingPattern("");
        setMode("browse");
      } else if (key.name === "backspace" || key.name === "delete") {
        setRoutingPattern((p) => p.slice(0, -1));
      } else if (key.raw && key.raw.length === 1 && !key.ctrl && !key.meta) {
        setRoutingPattern((p) => p + key.raw);
      }
      return;
    }

    if (mode === "add_routing_chain") {
      if (key.name === "up" || key.name === "k") {
        setChainCursor((i) => Math.max(0, i - 1));
      } else if (key.name === "down" || key.name === "j") {
        setChainCursor((i) => Math.min(CHAIN_PROVIDERS.length - 1, i + 1));
      } else if (key.name === "space" || key.raw === " ") {
        // Toggle: add to end or remove
        const provName = CHAIN_PROVIDERS[chainCursor].name;
        setChainSelected((prev) => {
          const next = new Set(prev);
          if (next.has(provName)) {
            next.delete(provName);
            setChainOrder((o) => o.filter((p) => p !== provName));
          } else {
            next.add(provName);
            setChainOrder((o) => [...o, provName]);
          }
          return next;
        });
      } else if (key.raw && key.raw >= "1" && key.raw <= "9") {
        // Number key: move current provider to that position in chain
        const provName = CHAIN_PROVIDERS[chainCursor].name;
        const targetPos = parseInt(key.raw, 10) - 1; // 0-indexed
        setChainSelected((prev) => {
          const next = new Set(prev);
          next.add(provName);
          return next;
        });
        setChainOrder((prev) => {
          const without = prev.filter((p) => p !== provName);
          const insertAt = Math.min(targetPos, without.length);
          without.splice(insertAt, 0, provName);
          return without;
        });
      } else if (key.name === "return" || key.name === "enter") {
        const pat = routingPattern.trim();
        if (pat && chainOrder.length) {
          const cfg = loadConfig();
          if (!cfg.routing) cfg.routing = {};
          cfg.routing[pat] = chainOrder;
          saveConfig(cfg);
          refreshConfig();
          setStatusMsg(`Rule added: ${pat} → ${chainOrder.join(", ")}`);
        }
        setRoutingPattern("");
        setRoutingChain("");
        setChainSelected(new Set());
        setChainOrder([]);
        setChainCursor(0);
        setMode("browse");
      } else if (key.name === "escape") {
        setChainSelected(new Set());
        setChainOrder([]);
        setChainCursor(0);
        setMode("add_routing_pattern");
      }
      return;
    }

    // Browse mode
    if (key.name === "q") return quit();

    if (key.name === "tab") {
      const tabs: Tab[] = ["providers", "routing", "privacy"];
      const idx = tabs.indexOf(activeTab);
      setActiveTab(tabs[(idx + 1) % tabs.length]!);
      setStatusMsg(null);
      return;
    }

    // Number keys switch tabs directly
    if (key.name === "1") {
      setActiveTab("providers");
      setStatusMsg(null);
      return;
    }
    if (key.name === "2") {
      setActiveTab("routing");
      setStatusMsg(null);
      return;
    }
    if (key.name === "3") {
      setActiveTab("privacy");
      setStatusMsg(null);
      return;
    }

    if (activeTab === "providers") {
      if (key.name === "up" || key.name === "k") {
        setProviderIndex((i) => Math.max(0, i - 1));
        setStatusMsg(null);
      } else if (key.name === "down" || key.name === "j") {
        setProviderIndex((i) => Math.min(displayProviders.length - 1, i + 1));
        setStatusMsg(null);
      } else if (key.name === "s") {
        setInputValue("");
        setStatusMsg(null);
        setMode("input_key");
      } else if (key.name === "e") {
        if (selectedProvider.endpointEnvVar) {
          setInputValue(activeEndpoint);
          setStatusMsg(null);
          setMode("input_endpoint");
        } else {
          setStatusMsg("This provider has no custom endpoint.");
        }
      } else if (key.name === "x") {
        if (hasCfgKey) {
          removeApiKey(selectedProvider.apiKeyEnvVar);
          if (selectedProvider.endpointEnvVar) {
            removeEndpoint(selectedProvider.endpointEnvVar);
          }
          refreshConfig();
          setStatusMsg(`Key removed for ${selectedProvider.displayName}.`);
        } else {
          setStatusMsg("No stored key to remove.");
        }
      }
    } else if (activeTab === "routing") {
      if (key.name === "a") {
        setRoutingPattern("");
        setRoutingChain("");
        setStatusMsg(null);
        setMode("add_routing_pattern");
      } else if (key.name === "d") {
        // delete selected rule — select by index
        if (ruleEntries.length > 0) {
          const [pat] = ruleEntries[Math.min(providerIndex, ruleEntries.length - 1)]!;
          const cfg = loadConfig();
          if (cfg.routing) {
            delete cfg.routing[pat];
            saveConfig(cfg);
            refreshConfig();
            setStatusMsg(`Rule deleted: '${pat}'.`);
          }
        } else {
          setStatusMsg("No routing rules to delete.");
        }
      } else if (key.name === "up" || key.name === "k") {
        setProviderIndex((i) => Math.max(0, i - 1));
      } else if (key.name === "down" || key.name === "j") {
        setProviderIndex((i) => Math.min(Math.max(0, ruleEntries.length - 1), i + 1));
      }
    } else if (activeTab === "privacy") {
      if (key.name === "t") {
        const cfg = loadConfig();
        const next = !telemetryEnabled;
        cfg.telemetry = {
          ...(cfg.telemetry ?? {}),
          enabled: next,
          askedAt: cfg.telemetry?.askedAt ?? new Date().toISOString(),
        };
        saveConfig(cfg);
        refreshConfig();
        setStatusMsg(`Telemetry ${next ? "enabled" : "disabled"}.`);
      } else if (key.name === "u") {
        const cfg = loadConfig();
        const statsKey = "CLAUDISH_STATS";
        // Toggle via config (env cannot be persisted, use telemetry-like flag)
        const next = !statsEnabled;
        if (!cfg.telemetry)
          cfg.telemetry = { enabled: telemetryEnabled, askedAt: new Date().toISOString() };
        (cfg as Record<string, unknown>).statsEnabled = next;
        saveConfig(cfg);
        refreshConfig();
        setStatusMsg(`Usage stats ${next ? "enabled" : "disabled"}.`);
        void statsKey; // used for env check
      } else if (key.name === "c") {
        clearBuffer();
        setBufStats(getBufferStats());
        setStatusMsg("Stats buffer cleared.");
      }
    }
  });

  if (height < 15 || width < 60) {
    return (
      <box width="100%" height="100%" padding={1} backgroundColor={C.bg}>
        <text>
          <span fg={C.red} bold>
            Terminal too small ({width}x{height}). Resize to at least 60x15.
          </span>
        </text>
      </box>
    );
  }

  const isInputMode = mode === "input_key" || mode === "input_endpoint";
  const isRoutingInput = mode === "add_routing_pattern" || mode === "add_routing_chain";

  // ── Layout math ───────────────────────────────────────────────────────────
  // header(1) + tab-bar(3) + content(flex) + detail(fixed) + footer(1)
  const HEADER_H = 1;
  const TABS_H = 3;
  const FOOTER_H = 1;
  const DETAIL_H = 7;
  const contentH = Math.max(4, height - HEADER_H - TABS_H - DETAIL_H - FOOTER_H - 1);

  // ── Render helpers ────────────────────────────────────────────────────────
  function TabBar() {
    const tabs: Array<{ label: string; value: Tab; num: string }> = [
      { label: "Providers", value: "providers", num: "1" },
      { label: "Routing", value: "routing", num: "2" },
      { label: "Privacy", value: "privacy", num: "3" },
    ];

    return (
      <box height={TABS_H} flexDirection="column" backgroundColor={C.bg}>
        {/* Tab buttons row — use box-level backgroundColor for unmistakable tab highlighting */}
        <box height={1} flexDirection="row">
          <box width={1} height={1} backgroundColor={C.bg} />
          {tabs.map((t, i) => {
            const active = activeTab === t.value;
            return (
              <box key={t.value} flexDirection="row" height={1}>
                {i > 0 && <box width={2} height={1} backgroundColor={C.bg} />}
                <box
                  height={1}
                  backgroundColor={active ? C.tabActiveBg : C.tabInactiveBg}
                  paddingX={1}
                >
                  <text>
                    <span fg={active ? C.tabActiveFg : C.tabInactiveFg} bold>
                      {`${t.num}. ${t.label}`}
                    </span>
                  </text>
                </box>
              </box>
            );
          })}
          {statusMsg && (
            <box height={1} backgroundColor={C.bg} paddingX={1}>
              <text>
                <span fg={C.dim}>{"─  "}</span>
                <span
                  fg={
                    statusMsg.startsWith("Key saved") ||
                    statusMsg.startsWith("Rule added") ||
                    statusMsg.startsWith("Endpoint") ||
                    statusMsg.startsWith("Telemetry") ||
                    statusMsg.startsWith("Usage") ||
                    statusMsg.startsWith("Stats buffer")
                      ? C.green
                      : C.yellow
                  }
                  bold
                >
                  {statusMsg}
                </span>
              </text>
            </box>
          )}
        </box>
        {/* Separator line */}
        <box height={1} paddingX={1}>
          <text>
            <span fg={C.tabActiveBg}>{"─".repeat(Math.max(0, width - 2))}</span>
          </text>
        </box>
        {/* Spacer */}
        <box height={1} />
      </box>
    );
  }

  // ── Providers tab ─────────────────────────────────────────────────────────
  function ProvidersContent() {
    const listH = contentH - 2; // inner height of box
    let separatorRendered = false;

    const getRow = (p: ProviderDef, idx: number) => {
      const isReady = !!(config.apiKeys?.[p.apiKeyEnvVar] || process.env[p.apiKeyEnvVar]);
      const selected = idx === providerIndex;
      const cfgMask = maskKey(config.apiKeys?.[p.apiKeyEnvVar]);
      const envMask = maskKey(process.env[p.apiKeyEnvVar]);
      const hasCfg = cfgMask !== "────────";
      const hasEnv = envMask !== "────────";
      const keyDisplay = isReady ? (hasCfg ? cfgMask : envMask) : "────────";
      const src = hasEnv && hasCfg ? "e+c" : hasEnv ? "env" : hasCfg ? "cfg" : "";
      const namePad = p.displayName.padEnd(14).substring(0, 14);
      const isFirstUnready = !isReady && !separatorRendered;
      if (isFirstUnready) separatorRendered = true;

      return (
        <box key={p.name} flexDirection="column">
          {isFirstUnready && (
            <box height={1} paddingX={1}>
              <text>
                <span fg={C.dim}>
                  {"─ not configured "}
                  {"─".repeat(Math.max(0, width - 22))}
                </span>
              </text>
            </box>
          )}
          <box height={1} flexDirection="row" backgroundColor={selected ? C.bgHighlight : C.bg}>
            <text>
              <span fg={isReady ? C.green : C.dim}>{isReady ? "●" : "○"}</span>
              <span>{"  "}</span>
              <span fg={selected ? C.white : isReady ? C.fgMuted : C.dim} bold={selected}>
                {namePad}
              </span>
              <span fg={C.dim}>{"  "}</span>
              {isReady ? (
                <span fg={C.green} bold>
                  {"ready  "}
                </span>
              ) : (
                <span fg={C.dim}>{"not set"}</span>
              )}
              <span fg={C.dim}>{"  "}</span>
              <span fg={isReady ? C.cyan : C.dim}>{keyDisplay}</span>
              {src ? <span fg={C.dim}>{` (${src})`}</span> : null}
              <span fg={C.dim}>{"  "}</span>
              <span fg={selected ? C.white : C.dim}>{p.description}</span>
            </text>
          </box>
        </box>
      );
    };

    return (
      <box
        height={contentH}
        border
        borderStyle="single"
        borderColor={!isInputMode ? C.blue : C.dim}
        backgroundColor={C.bg}
        flexDirection="column"
        paddingX={1}
      >
        {/* Column header */}
        <text>
          <span fg={C.dim}>{"   "}</span>
          <span fg={C.blue} bold>
            {"PROVIDER        "}
          </span>
          <span fg={C.blue} bold>
            {"STATUS    "}
          </span>
          <span fg={C.blue} bold>
            {"KEY         "}
          </span>
          <span fg={C.blue} bold>
            DESCRIPTION
          </span>
        </text>
        {displayProviders.slice(0, listH).map(getRow)}
      </box>
    );
  }

  function ProviderDetail() {
    const displayKey = hasCfgKey ? cfgKeyMask : hasEnvKey ? envKeyMask : "────────";

    if (isInputMode) {
      return (
        <box
          height={DETAIL_H}
          border
          borderStyle="single"
          borderColor={C.focusBorder}
          title={` Set ${mode === "input_key" ? "API Key" : "Endpoint"} — ${selectedProvider.displayName} `}
          backgroundColor={C.bg}
          flexDirection="column"
          paddingX={1}
        >
          <text>
            <span fg={C.green} bold>
              Enter{" "}
            </span>
            <span fg={C.fgMuted}>to save · </span>
            <span fg={C.red} bold>
              Esc{" "}
            </span>
            <span fg={C.fgMuted}>to cancel</span>
          </text>
          <box flexDirection="row">
            <text>
              <span fg={C.green} bold>
                &gt;{" "}
              </span>
            </text>
            <input
              value={inputValue}
              onChange={setInputValue}
              focused={true}
              width={width - 8}
              backgroundColor={C.bgHighlight}
              textColor={C.white}
            />
          </box>
        </box>
      );
    }

    return (
      <box
        height={DETAIL_H}
        border
        borderStyle="single"
        borderColor={C.dim}
        title={` ${selectedProvider.displayName} `}
        backgroundColor={C.bgAlt}
        flexDirection="column"
        paddingX={1}
      >
        <box flexDirection="row">
          <text>
            <span fg={C.blue} bold>
              Status:{" "}
            </span>
            {hasKey ? (
              <span fg={C.green} bold>
                ● Ready
              </span>
            ) : (
              <span fg={C.fgMuted}>○ Not configured</span>
            )}
            <span fg={C.dim}>{"    "}</span>
            <span fg={C.blue} bold>
              Key:{" "}
            </span>
            <span fg={C.green}>{displayKey}</span>
            {keySrc && <span fg={C.fgMuted}> (source: {keySrc})</span>}
          </text>
        </box>
        {selectedProvider.endpointEnvVar && (
          <text>
            <span fg={C.blue} bold>
              URL:{" "}
            </span>
            <span fg={C.cyan}>
              {activeEndpoint || selectedProvider.defaultEndpoint || "default"}
            </span>
          </text>
        )}
        <text>
          <span fg={C.blue} bold>
            Desc:{" "}
          </span>
          <span fg={C.white}>{selectedProvider.description}</span>
        </text>
        {selectedProvider.keyUrl && (
          <text>
            <span fg={C.blue} bold>
              Get Key:{" "}
            </span>
            <span fg={C.cyan}>{selectedProvider.keyUrl}</span>
          </text>
        )}
      </box>
    );
  }

  // ── Routing tab ───────────────────────────────────────────────────────────

  // Format a chain as inline text: "kimi → openrouter"
  function chainStr(chain: string[]): string {
    return chain.join(" → ");
  }

  function RoutingContent() {
    const innerH = contentH - 2;

    return (
      <box
        height={contentH}
        border
        borderStyle="single"
        borderColor={C.blue}
        backgroundColor={C.bg}
        flexDirection="column"
        paddingX={1}
      >
        {/* Default chain — bordered subsection */}
        <text>
          <span fg={C.blue} bold>{" Default fallback chain:"}</span>
        </text>
        <text>
          <span fg={C.dim}>{" "}</span>
          <span fg={C.cyan}>{"LiteLLM"}</span>
          <span fg={C.dim}>{" → "}</span>
          <span fg={C.cyan}>{"Zen Go"}</span>
          <span fg={C.dim}>{" → "}</span>
          <span fg={C.cyan}>{"Subscription"}</span>
          <span fg={C.dim}>{" → "}</span>
          <span fg={C.cyan}>{"Provider Direct"}</span>
          <span fg={C.dim}>{" → "}</span>
          <span fg={C.cyan}>{"OpenRouter"}</span>
        </text>
        <text>
          <span fg={C.dim}>{" ─".repeat(Math.max(1, Math.floor((width - 6) / 2)))}</span>
        </text>
        {/* Custom rules header */}
        <text>
          <span fg={C.blue} bold>{" Custom rules:"}</span>
          <span fg={C.fgMuted}>{"  (override default for matching models)"}</span>
        </text>
        {/* Custom rules or empty state */}
        {ruleEntries.length === 0 && !isRoutingInput && (
          <text>
            <span fg={C.fgMuted}>{" None configured. Press "}</span>
            <span fg={C.green} bold>a</span>
            <span fg={C.fgMuted}>{" to add."}</span>
          </text>
        )}
        {ruleEntries.length > 0 && (
          <>
            <text>
              <span fg={C.blue} bold>
                {"PATTERN         "}
              </span>
              <span fg={C.blue} bold>
                {"CHAIN"}
              </span>
            </text>
            {ruleEntries.slice(0, Math.max(0, innerH - 3)).map(([pat, chain], idx) => {
              const sel = idx === providerIndex;
              return (
                <box
                  key={pat}
                  height={1}
                  flexDirection="row"
                  backgroundColor={sel ? C.bgHighlight : C.bg}
                >
                  <text>
                    <span fg={sel ? C.white : C.fgMuted} bold={sel}>
                      {pat.padEnd(16).substring(0, 16)}
                    </span>
                    <span fg={C.dim}>{"  "}</span>
                    <span fg={sel ? C.cyan : C.fgMuted}>{chainStr(chain)}</span>
                  </text>
                </box>
              );
            })}
          </>
        )}

        {/* Input fields */}
        {mode === "add_routing_pattern" && (
          <box flexDirection="column">
            <text>
              <span fg={C.blue} bold>{"Pattern "}</span>
              <span fg={C.dim}>{"(e.g. kimi-*, gpt-4o):"}</span>
            </text>
            <text>
              <span fg={C.green} bold>{"> "}</span>
              <span fg={C.white}>{routingPattern}</span>
              <span fg={C.cyan}>{"█"}</span>
            </text>
            <text>
              <span fg={C.green} bold>
                Enter{" "}
              </span>
              <span fg={C.fgMuted}>to continue · </span>
              <span fg={C.red} bold>
                Esc{" "}
              </span>
              <span fg={C.fgMuted}>to cancel</span>
            </text>
          </box>
        )}
        {mode === "add_routing_chain" && (
          <box flexDirection="column">
            <text>
              <span fg={C.blue} bold>{"Select providers for "}</span>
              <span fg={C.white} bold>{routingPattern}</span>
              <span fg={C.dim}>{" (Space=toggle, 1-9=set position, Enter=save)"}</span>
            </text>
            {chainOrder.length > 0 && (
              <text>
                <span fg={C.fgMuted}>{"  Chain: "}</span>
                <span fg={C.cyan}>{chainOrder.join(" → ")}</span>
              </text>
            )}
            {CHAIN_PROVIDERS.map((prov, idx) => {
              const isCursor = idx === chainCursor;
              const isOn = chainSelected.has(prov.name);
              const pos = isOn ? chainOrder.indexOf(prov.name) + 1 : 0;
              const hasKey = !!(config.apiKeys?.[prov.apiKeyEnvVar] || process.env[prov.apiKeyEnvVar]);
              const label = prov.displayName.padEnd(18).substring(0, 18);
              return (
                <box key={prov.name} height={1} backgroundColor={isCursor ? C.bgHighlight : C.bg}>
                  <text>
                    {isOn ? (
                      <span fg={C.green} bold>{` [${pos}] `}</span>
                    ) : (
                      <span fg={C.dim}>{" [ ] "}</span>
                    )}
                    <span fg={isCursor ? C.white : hasKey ? C.fgMuted : C.dim} bold={isCursor}>{label}</span>
                    {hasKey ? (
                      <span fg={C.green}>{" ●"}</span>
                    ) : (
                      <span fg={C.dim}>{" ○ no key"}</span>
                    )}
                  </text>
                </box>
              );
            })}
          </box>
        )}
      </box>
    );
  }

  function RoutingDetail() {
    return (
      <box
        height={DETAIL_H}
        border
        borderStyle="single"
        borderColor={C.dim}
        title=" Examples "
        backgroundColor={C.bgAlt}
        flexDirection="column"
        paddingX={1}
      >
        <text>
          <span fg={C.fgMuted}>{"  kimi-*      "}</span>
          <span fg={C.dim}>{" → "}</span>
          <span fg={C.cyan}>{"kimi, openrouter"}</span>
        </text>
        <text>
          <span fg={C.fgMuted}>{"  gpt-*       "}</span>
          <span fg={C.dim}>{" → "}</span>
          <span fg={C.cyan}>{"oai, litellm"}</span>
        </text>
        <text>
          <span fg={C.fgMuted}>{"  gemini-*    "}</span>
          <span fg={C.dim}>{" → "}</span>
          <span fg={C.cyan}>{"google, zen, openrouter"}</span>
        </text>
        <text>
          <span fg={C.fgMuted}>{"  deepseek-*  "}</span>
          <span fg={C.dim}>{" → "}</span>
          <span fg={C.cyan}>{"zen, openrouter"}</span>
        </text>
        <text>
          <span fg={C.dim}>{"  Glob pattern (* = any). Chain tried left to right. "}</span>
          <span fg={C.cyan} bold>{ruleEntries.length}</span>
          <span fg={C.fgMuted}>{" custom rule"}{ruleEntries.length !== 1 ? "s" : ""}</span>
        </text>
      </box>
    );
  }

  // ── Privacy tab ───────────────────────────────────────────────────────────
  function PrivacyContent() {
    const halfW = Math.floor((width - 4) / 2);
    const cardH = Math.max(7, contentH - 1);

    return (
      <box height={contentH} flexDirection="row" backgroundColor={C.bg} paddingX={1}>
        {/* Telemetry card */}
        <box
          width={halfW}
          height={cardH}
          border
          borderStyle="single"
          borderColor={activeTab === "privacy" ? C.blue : C.dim}
          title=" Telemetry "
          backgroundColor={C.bg}
          flexDirection="column"
          paddingX={1}
        >
          <text>
            <span fg={C.blue} bold>
              Status:{" "}
            </span>
            {telemetryEnabled ? (
              <span fg={C.green} bold>
                ● Enabled
              </span>
            ) : (
              <span fg={C.fgMuted}>○ Disabled</span>
            )}
          </text>
          <text> </text>
          <text>
            <span fg={C.fgMuted}>Collects anonymized platform info and</span>
          </text>
          <text>
            <span fg={C.fgMuted}>sanitized error types to improve claudish.</span>
          </text>
          <text> </text>
          <text>
            <span fg={C.white} bold>
              Never sends keys, prompts, or paths.
            </span>
          </text>
          <text> </text>
          <text>
            <span fg={C.dim}>Press [</span>
            <span fg={C.green} bold>
              t
            </span>
            <span fg={C.dim}>] to toggle.</span>
          </text>
        </box>

        {/* Usage stats card */}
        <box
          width={width - 4 - halfW}
          height={cardH}
          border
          borderStyle="single"
          borderColor={activeTab === "privacy" ? C.blue : C.dim}
          title=" Usage Stats "
          backgroundColor={C.bg}
          flexDirection="column"
          paddingX={1}
        >
          <text>
            <span fg={C.blue} bold>
              Status:{" "}
            </span>
            {statsEnabled ? (
              <span fg={C.green} bold>
                ● Enabled
              </span>
            ) : (
              <span fg={C.fgMuted}>○ Disabled</span>
            )}
          </text>
          <text>
            <span fg={C.blue} bold>
              Buffer:{" "}
            </span>
            <span fg={C.white} bold>
              {bufStats.events}
            </span>
            <span fg={C.fgMuted}> events (</span>
            <span fg={C.yellow}>{bytesHuman(bufStats.bytes)}</span>
            <span fg={C.fgMuted}>)</span>
          </text>
          <text> </text>
          <text>
            <span fg={C.fgMuted}>Collects local, anonymous stats on model</span>
          </text>
          <text>
            <span fg={C.fgMuted}>usage, latency, and token counts.</span>
          </text>
          <text> </text>
          <text>
            <span fg={C.dim}>Press [</span>
            <span fg={C.green} bold>
              u
            </span>
            <span fg={C.dim}>] to toggle, [</span>
            <span fg={C.red} bold>
              c
            </span>
            <span fg={C.dim}>] to clear buffer.</span>
          </text>
        </box>
      </box>
    );
  }

  function PrivacyDetail() {
    return (
      <box
        height={DETAIL_H}
        border
        borderStyle="single"
        borderColor={C.dim}
        title=" Your Privacy "
        backgroundColor={C.bgAlt}
        flexDirection="column"
        paddingX={1}
      >
        <text>
          <span fg={C.fgMuted}>
            Telemetry and usage stats are always opt-in and never send personally identifiable data.
          </span>
        </text>
        <text>
          <span fg={C.fgMuted}>
            All data is anonymized before transmission. You can disable either independently.
          </span>
        </text>
      </box>
    );
  }

  // ── Footer hotkeys ────────────────────────────────────────────────────────
  function Footer() {
    let keys: Array<[string, string, string]>;
    if (activeTab === "providers") {
      keys = [
        [C.blue, "↑↓", "navigate"],
        [C.green, "s", "set key"],
        [C.green, "e", "endpoint"],
        [C.red, "x", "remove"],
        [C.blue, "Tab", "section"],
        [C.dim, "q", "quit"],
      ];
    } else if (activeTab === "routing") {
      keys = [
        [C.blue, "↑↓", "navigate"],
        [C.green, "a", "add rule"],
        [C.red, "d", "delete"],
        [C.blue, "Tab", "section"],
        [C.dim, "q", "quit"],
      ];
    } else {
      keys = [
        [C.green, "t", "telemetry"],
        [C.green, "u", "stats"],
        [C.red, "c", "clear"],
        [C.blue, "Tab", "section"],
        [C.dim, "q", "quit"],
      ];
    }

    return (
      <box height={FOOTER_H} flexDirection="row" paddingX={1} backgroundColor={C.bgAlt}>
        <text>
          {keys.map(([color, key, label], i) => (
            <span key={i}>
              {i > 0 && <span fg={C.dim}>{" │ "}</span>}
              <span fg={color as string} bold>
                {key}
              </span>
              <span fg={C.fgMuted}> {label}</span>
            </span>
          ))}
        </text>
      </box>
    );
  }

  // ── Main render ───────────────────────────────────────────────────────────
  return (
    <box width={width} height={height} flexDirection="column" backgroundColor={C.bg}>
      {/* Header */}
      <box height={HEADER_H} flexDirection="row" backgroundColor={C.bgAlt} paddingX={1}>
        <text>
          <span fg={C.white} bold>
            claudish
          </span>
          <span fg={C.dim}> ─ </span>
          <span fg={C.blue} bold>
            {VERSION}
          </span>
          <span fg={C.dim}> ─ </span>
          <span fg={C.orange} bold>
            ★ {profileName}
          </span>
          <span fg={C.dim}> ─ </span>
          <span fg={C.green} bold>
            {readyCount}
          </span>
          <span fg={C.fgMuted}> providers configured</span>
          <span fg={C.dim}>
            {"─".repeat(Math.max(1, width - 38 - profileName.length - VERSION.length))}
          </span>
        </text>
      </box>

      {/* Tab bar */}
      <TabBar />

      {/* Content + detail */}
      {activeTab === "providers" && (
        <>
          <ProvidersContent />
          <ProviderDetail />
        </>
      )}
      {activeTab === "routing" && (
        <>
          <RoutingContent />
          <RoutingDetail />
        </>
      )}
      {activeTab === "privacy" && (
        <>
          <PrivacyContent />
          <PrivacyDetail />
        </>
      )}

      {/* Footer */}
      <Footer />
    </box>
  );
}
