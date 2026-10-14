/**
 * Smoke test for lib/ai/local-configs.ts: settings' "Use local config"
 * finding providers in harness configs (DESIGN.md §6.17).
 *
 *   npx tsx lib/ai/smoke-test-local-configs.ts
 *
 * Builds a fake home folder with one config per harness and checks what
 * comes out: base URLs, default model first, keys resolved the way each
 * harness resolves them, and no key in the public shape.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverLocalProviders, parseJsonc, parseSimpleToml, publicCandidate } from "./local-configs";

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function write(home: string, rel: string, content: string): void {
  const file = path.join(home, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function main(): void {
  console.log("parsers:");
  check(
    "JSONC: comments and trailing commas, // inside strings kept",
    JSON.stringify(parseJsonc('// c\n{ "a": "http://x", /* b */ "b": [1,2,], }')) === '{"a":"http://x","b":[1,2]}'
  );
  const toml = parseSimpleToml(
    'model = "gpt-5" # default\n[model_providers.ollama-remote]\nname = "Remote"\nbase_url = "http://gpu:11434/v1"\n[profiles."fast one"]\nmodel = \'o4-mini\'\n'
  );
  check("TOML: top-level string, comment stripped", toml.model === "gpt-5");
  check(
    "TOML: dotted and quoted table names",
    JSON.stringify(toml.model_providers) === '{"ollama-remote":{"name":"Remote","base_url":"http://gpu:11434/v1"}}' &&
      (toml.profiles as Record<string, Record<string, unknown>>)["fast one"].model === "o4-mini"
  );

  const home = mkdtempSync(path.join(tmpdir(), "gr-local-configs-"));
  try {
    write(
      home,
      ".config/opencode/opencode.jsonc",
      `{
        // default model
        "model": "anthropic/claude-sonnet-4-5",
        "small_model": "ollama/qwen3:8b",
        "provider": {
          "ollama": { "options": { "baseURL": "http://localhost:11434/v1" }, "models": { "qwen3:8b": {}, "llama3.2": {} } },
          "work": { "name": "Work proxy", "options": { "baseURL": "https://llm.work/v1", "apiKey": "{env:WORK_KEY}" }, "models": { "big": {} } },
        },
      }`
    );
    write(
      home,
      ".local/share/opencode/auth.json",
      JSON.stringify({ anthropic: { type: "api", key: "sk-ant-oc" }, "github-copilot": { type: "oauth", refresh: "gho_x" } })
    );
    write(home, ".codex/config.toml", 'model = "gpt-5-codex"\n[profiles.quick]\nmodel = "gpt-5-mini"\n');
    write(home, ".codex/auth.json", JSON.stringify({ OPENAI_API_KEY: "sk-codex" }));
    write(home, ".claude/settings.json", JSON.stringify({ model: "opus", env: { ANTHROPIC_MODEL: "claude-opus-4-1", ANTHROPIC_API_KEY: "sk-ant-cc" } }));
    write(home, ".config/crush/crush.json", JSON.stringify({
      providers: { deepseek: { api_key: "$DEEPSEEK_API_KEY", models: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] } },
      models: { large: { provider: "deepseek", model: "deepseek-reasoner" } },
    }));
    write(home, ".continue/config.yaml", "models:\n  - name: Local\n    provider: ollama\n    model: codellama\n    apiBase: http://localhost:11434\n  - name: GPT\n    provider: openai\n    model: gpt-4o\n    apiKey: ${{ secrets.OPENAI }}\n");
    write(home, ".copilot/settings.json", '// managed\n{ "model": "gpt-5" }');

    const found = discoverLocalProviders({
      home,
      env: { WORK_KEY: "sk-work", DEEPSEEK_API_KEY: "sk-ds", OPENROUTER_API_KEY: "sk-or" },
      platform: "linux",
    });
    const byId = new Map(found.map((c) => [c.id, c]));
    console.log("\ndiscovery:");
    console.log(`  (${found.map((c) => c.id).join(", ")})`);

    const ocAnthropic = byId.get("opencode:anthropic");
    check(
      "OpenCode: default model's provider, key from auth.json",
      ocAnthropic?.baseUrl === "https://api.anthropic.com/v1" &&
        ocAnthropic.defaultModel === "claude-sonnet-4-5" &&
        ocAnthropic.apiKey === "sk-ant-oc" &&
        ocAnthropic.keySource === "~/.local/share/opencode/auth.json"
    );
    const ocOllama = byId.get("opencode:ollama");
    check(
      "OpenCode: custom provider lists its models, small model first",
      JSON.stringify(ocOllama?.models) === '["qwen3:8b","llama3.2"]' && !ocOllama?.apiKey && !publicCandidate(ocOllama!).needsKey
    );
    check("OpenCode: {env:VAR} key resolved", byId.get("opencode:work")?.apiKey === "sk-work" && byId.get("opencode:work")?.name === "Work proxy (OpenCode)");
    const ocCopilot = byId.get("opencode:github-copilot");
    check("OpenCode: OAuth sign-in → needs a key, with a note", Boolean(ocCopilot?.note) && publicCandidate(ocCopilot!).needsKey);

    const cx = byId.get("codex:openai");
    check(
      "Codex: default + profile models, key from auth.json",
      cx?.defaultModel === "gpt-5-codex" && JSON.stringify(cx.models) === '["gpt-5-codex","gpt-5-mini"]' && cx.apiKey === "sk-codex"
    );
    const cc = byId.get("claude-code:anthropic");
    check(
      "Claude Code: env block key, alias model skipped",
      cc?.apiKey === "sk-ant-cc" && JSON.stringify(cc.models) === '["claude-opus-4-1"]'
    );
    const cr = byId.get("crush:deepseek");
    check(
      "Crush: known base URL, $VAR key, large model is the default",
      cr?.baseUrl === "https://api.deepseek.com/v1" && cr.defaultModel === "deepseek-reasoner" && cr.apiKey === "sk-ds"
    );
    const contOllama = found.find((c) => c.harness === "Continue" && c.baseUrl === "http://localhost:11434/v1");
    const contOpenai = found.find((c) => c.harness === "Continue" && c.baseUrl === "https://api.openai.com/v1");
    check("Continue: ollama apiBase gets /v1", contOllama?.defaultModel === "codellama");
    check("Continue: ${{ secrets }} key isn't used as a key", Boolean(contOpenai) && !contOpenai?.apiKey && Boolean(contOpenai?.note));
    check("Copilot CLI: JSONC settings model", byId.get("copilot-cli:github-copilot")?.defaultModel === "gpt-5");
    check("Environment: OPENROUTER_API_KEY", byId.get("environment:openrouter")?.apiKey === "sk-or");

    const pub = publicCandidate(ocAnthropic!);
    check("public shape has no key", !("apiKey" in pub) && pub.hasKey && !pub.needsKey);

    const empty = mkdtempSync(path.join(tmpdir(), "gr-local-configs-empty-"));
    check("empty home → nothing", discoverLocalProviders({ home: empty, env: {}, platform: "linux" }).length === 0);
    rmSync(empty, { recursive: true, force: true });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  if (failures > 0) process.exitCode = 1;
  console.log(failures > 0 ? `\n${failures} failed` : "\nall passed");
}

main();
