export interface ProviderSpec {
  name: string;
  keywords: string[];
  envKey: string;
  displayName: string;
  litellmPrefix: string;
  skipPrefixes: string[];
  envExtras: Array<[string, string]>;
  isGateway: boolean;
  isLocal: boolean;
  detectByKeyPrefix: string;
  detectByBaseKeyword: string;
  defaultApiBase: string;
  stripModelPrefix: boolean;
  modelOverrides: Array<[string, Record<string, unknown>]>;
  isOauth: boolean;
}

export const PROVIDERS: ProviderSpec[] = [
  {
    name: "custom",
    keywords: [],
    envKey: "OPENAI_API_KEY",
    displayName: "Custom",
    litellmPrefix: "openai",
    skipPrefixes: ["openai/"],
    envExtras: [],
    isGateway: true,
    isLocal: false,
    detectByKeyPrefix: "",
    detectByBaseKeyword: "",
    defaultApiBase: "",
    stripModelPrefix: true,
    modelOverrides: [],
    isOauth: false,
  },
  {
    name: "openrouter",
    keywords: ["openrouter"],
    envKey: "OPENROUTER_API_KEY",
    displayName: "OpenRouter",
    litellmPrefix: "openrouter",
    skipPrefixes: [],
    envExtras: [],
    isGateway: true,
    isLocal: false,
    detectByKeyPrefix: "sk-or-",
    detectByBaseKeyword: "openrouter",
    defaultApiBase: "https://openrouter.ai/api/v1",
    stripModelPrefix: false,
    modelOverrides: [],
    isOauth: false,
  },
  {
    name: "aihubmix",
    keywords: ["aihubmix"],
    envKey: "OPENAI_API_KEY",
    displayName: "AiHubMix",
    litellmPrefix: "openai",
    skipPrefixes: [],
    envExtras: [],
    isGateway: true,
    isLocal: false,
    detectByKeyPrefix: "",
    detectByBaseKeyword: "aihubmix",
    defaultApiBase: "https://aihubmix.com/v1",
    stripModelPrefix: true,
    modelOverrides: [],
    isOauth: false,
  },
  {
    name: "anthropic",
    keywords: ["anthropic", "claude"],
    envKey: "ANTHROPIC_API_KEY",
    displayName: "Anthropic",
    litellmPrefix: "",
    skipPrefixes: [],
    envExtras: [],
    isGateway: false,
    isLocal: false,
    detectByKeyPrefix: "",
    detectByBaseKeyword: "",
    defaultApiBase: "",
    stripModelPrefix: false,
    modelOverrides: [],
    isOauth: false,
  },
  {
    name: "openai",
    keywords: ["openai", "gpt"],
    envKey: "OPENAI_API_KEY",
    displayName: "OpenAI",
    litellmPrefix: "",
    skipPrefixes: [],
    envExtras: [],
    isGateway: false,
    isLocal: false,
    detectByKeyPrefix: "",
    detectByBaseKeyword: "",
    defaultApiBase: "",
    stripModelPrefix: false,
    modelOverrides: [],
    isOauth: false,
  },
  {
    name: "openaiCodex",
    keywords: ["openai-codex", "codex"],
    envKey: "",
    displayName: "OpenAI Codex",
    litellmPrefix: "",
    skipPrefixes: [],
    envExtras: [],
    isGateway: false,
    isLocal: false,
    detectByKeyPrefix: "",
    detectByBaseKeyword: "codex",
    defaultApiBase: "https://chatgpt.com/backend-api",
    stripModelPrefix: false,
    modelOverrides: [],
    isOauth: true,
  },
  {
    name: "deepseek",
    keywords: ["deepseek"],
    envKey: "DEEPSEEK_API_KEY",
    displayName: "DeepSeek",
    litellmPrefix: "deepseek",
    skipPrefixes: ["deepseek/"],
    envExtras: [],
    isGateway: false,
    isLocal: false,
    detectByKeyPrefix: "",
    detectByBaseKeyword: "",
    defaultApiBase: "",
    stripModelPrefix: false,
    modelOverrides: [],
    isOauth: false,
  },
  {
    name: "gemini",
    keywords: ["gemini"],
    envKey: "GEMINI_API_KEY",
    displayName: "Gemini",
    litellmPrefix: "gemini",
    skipPrefixes: ["gemini/"],
    envExtras: [],
    isGateway: false,
    isLocal: false,
    detectByKeyPrefix: "",
    detectByBaseKeyword: "",
    defaultApiBase: "",
    stripModelPrefix: false,
    modelOverrides: [],
    isOauth: false,
  },
  {
    name: "groq",
    keywords: ["groq"],
    envKey: "GROQ_API_KEY",
    displayName: "Groq",
    litellmPrefix: "groq",
    skipPrefixes: ["groq/"],
    envExtras: [],
    isGateway: false,
    isLocal: false,
    detectByKeyPrefix: "",
    detectByBaseKeyword: "",
    defaultApiBase: "",
    stripModelPrefix: false,
    modelOverrides: [],
    isOauth: false,
  },
  {
    name: "zhipu",
    keywords: ["zhipu", "glm"],
    envKey: "ZHIPU_API_KEY",
    displayName: "Zhipu",
    litellmPrefix: "zhipu",
    skipPrefixes: ["zhipu/"],
    envExtras: [["ZHIPUAI_API_KEY", "{api_key}"]],
    isGateway: false,
    isLocal: false,
    detectByKeyPrefix: "",
    detectByBaseKeyword: "",
    defaultApiBase: "",
    stripModelPrefix: false,
    modelOverrides: [],
    isOauth: false,
  },
  {
    name: "dashscope",
    keywords: ["dashscope", "qwen"],
    envKey: "DASHSCOPE_API_KEY",
    displayName: "DashScope",
    litellmPrefix: "dashscope",
    skipPrefixes: ["dashscope/"],
    envExtras: [],
    isGateway: false,
    isLocal: false,
    detectByKeyPrefix: "",
    detectByBaseKeyword: "",
    defaultApiBase: "",
    stripModelPrefix: false,
    modelOverrides: [],
    isOauth: false,
  },
  {
    name: "moonshot",
    keywords: ["moonshot"],
    envKey: "MOONSHOT_API_KEY",
    displayName: "Moonshot",
    litellmPrefix: "moonshot",
    skipPrefixes: ["moonshot/"],
    envExtras: [["MOONSHOT_API_BASE", "{api_base}"]],
    isGateway: false,
    isLocal: false,
    detectByKeyPrefix: "",
    detectByBaseKeyword: "",
    defaultApiBase: "",
    stripModelPrefix: false,
    modelOverrides: [],
    isOauth: false,
  },
  {
    name: "minimax",
    keywords: ["minimax"],
    envKey: "MINIMAX_API_KEY",
    displayName: "MiniMax",
    litellmPrefix: "minimax",
    skipPrefixes: ["minimax/"],
    envExtras: [],
    isGateway: false,
    isLocal: false,
    detectByKeyPrefix: "",
    detectByBaseKeyword: "",
    defaultApiBase: "",
    stripModelPrefix: false,
    modelOverrides: [],
    isOauth: false,
  },
  {
    name: "vllm",
    keywords: ["vllm"],
    envKey: "OPENAI_API_KEY",
    displayName: "vLLM",
    litellmPrefix: "openai",
    skipPrefixes: [],
    envExtras: [],
    isGateway: false,
    isLocal: true,
    detectByKeyPrefix: "",
    detectByBaseKeyword: "",
    defaultApiBase: "http://localhost:8000/v1",
    stripModelPrefix: true,
    modelOverrides: [],
    isOauth: false,
  },
];

export function findByModel(model: string): ProviderSpec | undefined {
  const lower = model.toLowerCase();
  return PROVIDERS.find(
    (s) => !s.isGateway && !s.isLocal && s.keywords.some((kw) => lower.includes(kw)),
  );
}

export function findGateway(options?: {
  providerName?: string;
  apiKey?: string;
  apiBase?: string;
}): ProviderSpec | undefined {
  if (options?.providerName) {
    const spec = PROVIDERS.find((s) => s.name === options.providerName);
    if (spec && (spec.isGateway || spec.isLocal)) return spec;
  }
  for (const spec of PROVIDERS) {
    if (spec.detectByKeyPrefix && options?.apiKey?.startsWith(spec.detectByKeyPrefix)) return spec;
    if (spec.detectByBaseKeyword && options?.apiBase?.includes(spec.detectByBaseKeyword))
      return spec;
  }
  return undefined;
}

export function findByName(name: string): ProviderSpec | undefined {
  return PROVIDERS.find((s) => s.name === name);
}
