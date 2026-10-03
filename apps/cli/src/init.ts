import { join } from "node:path";
import {
  ConfigExistsError, DEFAULT_PROXY_BASE_URL, pickModel, pickServer,
  renderHostInstructions, runDoctor, runSmokeTest, summarizeChoice, writeInitConfig,
} from "@tinystrap/core";
import type { InitTomlValues, PromptIO, SmokeResult } from "@tinystrap/core";
import { LocalDiscovery, describeAttempts } from "@tinystrap/discovery";
import type { Discovery } from "@tinystrap/discovery";
import { HttpProvider, startProxy as realStartProxy } from "@tinystrap/proxy";
import type { Provider } from "@tinystrap/proxy";
import { createToolRegistry } from "@tinystrap/policy";
import { parseInitFlags, type ExitCode } from "./flags.js";

export type InitDeps = {
  // The caller owns the terminal: `main.ts` supplies the real one, a test supplies
  // a recorder. runInit never touches process.stdin itself.
  io: PromptIO;
  discovery?: Discovery;
  startProxy?: typeof realStartProxy;
  provider?: (baseUrl: string) => Provider;
  resolveProfile?: (modelId: string) => string | undefined;
  smoke?: typeof runSmokeTest;
  instructions?: typeof renderHostInstructions;
};

export type InitOutcome = { code: ExitCode; output: string };

// The whole command, in order: discover, confirm, write one file, doctor, smoke,
// print host setup. It returns an exit code instead of calling process.exit, so
// every branch is testable, and it never writes anything but tinystrap.toml.
export async function runInit(argv: readonly string[], deps: InitDeps): Promise<InitOutcome> {
  const lines: string[] = [];
  // Everything the command shows is recorded as it is printed, so the returned
  // output is what the terminal showed - the prompts' error lines included.
  const io: PromptIO = {
    isTty: deps.io.isTty,
    out: (l) => { lines.push(l); deps.io.out(l); },
    err: (l) => { lines.push(l); deps.io.err(l); },
    ask: (q) => deps.io.ask(q),
  };
  const done = (code: ExitCode): InitOutcome => ({ code, output: lines.join("\n") });

  const parsed = parseInitFlags(argv);
  if (!parsed.ok) { io.err(parsed.message); return done(2); }
  const flags = parsed.flags;
  const dir = flags.dir ?? process.cwd();

  // --url is the ONLY way a non-loopback address is ever probed; otherwise the
  // fixed loopback sweep runs. LocalDiscovery derives probeSource from its targets,
  // so the report stays honest either way.
  const discovery = deps.discovery
    ?? new LocalDiscovery(flags.url !== undefined ? { targets: [flags.url] } : {});

  let discovered;
  try {
    discovered = await discovery.probe();
  } catch (err) {
    io.err(`discovery failed: ${(err as Error).message}`);
    return done(1);
  }

  if (discovered.servers.length === 0) {
    // Spec section 14: say exactly what was probed and what came back.
    io.err("no model server answered. "
      + `${describeAttempts(discovered.attempts ?? [])}. `
      + "Start your model server, or re-run with --url <server-url>.");
    return done(3);
  }

  // Confirmation needs a terminal, unless the operator has already said yes.
  if (!flags.yes && !io.isTty) {
    io.err("tinystrap init needs a terminal to confirm the model. "
      + "Re-run with --yes to accept what was discovered, or pass --model and --url.");
    return done(2);
  }

  const server = await pickServer(io, discovered.servers);
  if (server === null) { io.err("no server chosen; nothing was written."); return done(2); }

  const model = await pickModel(io, server, flags.model);
  if (model === null) { io.err("no model chosen; nothing was written."); return done(2); }

  const contextLength = server.models.find((m) => m.id === model)?.contextLength;
  summarizeChoice(io, server, model, contextLength);

  const values: InitTomlValues = {
    baseUrl: server.baseUrl, model, kind: server.kind, contextLength,
  };
  const configPath = join(dir, "tinystrap.toml");
  let path: string;
  try {
    path = writeInitConfig({ projectRoot: dir, values, force: flags.force }).path;
  } catch (err) {
    if (err instanceof ConfigExistsError) { io.err(err.message); return done(4); }
    io.err(`could not write ${configPath}: ${(err as Error).message}`);
    return done(1);
  }
  io.out(`wrote ${path}`);

  // The config now exists, so doctor resolves from it, not from discovery alone.
  io.out("");
  io.out(await runDoctor(dir, discovery, undefined,
    deps.resolveProfile !== undefined ? { resolveProfile: deps.resolveProfile } : undefined));

  let code: ExitCode = 0;
  if (flags.smoke) {
    io.out("");
    // An injected smoke test stands in for the whole proxy leg, so a unit test
    // never opens a socket; the real leg starts a proxy in front of the server
    // that was just discovered and closes it again.
    const result = deps.smoke
      ? await deps.smoke({ proxyBaseUrl: DEFAULT_PROXY_BASE_URL, model })
      : await smokeThroughProxy(deps, server.baseUrl, model);
    if (result.ok) {
      io.out(`smoke test ok: ${result.detail}`);
    } else {
      // The config stays: a failed smoke is a report, not a reason to roll back.
      io.err(`smoke test failed: ${result.detail}`);
      io.err("The config was written; see the setup notes below.");
      code = 5;
    }
  }

  // Print-only. Nothing outside `dir` was created or edited: host setup is text
  // the operator pastes, never a file this command writes.
  io.out((deps.instructions ?? renderHostInstructions)({ model, configPath: path }));
  return done(code);
}

async function smokeThroughProxy(
  deps: InitDeps, serverBaseUrl: string, model: string,
): Promise<SmokeResult> {
  const start = deps.startProxy ?? realStartProxy;
  const makeProvider = deps.provider ?? ((baseUrl: string) => new HttpProvider({ baseUrl }));
  // The smoke proxy has no task workspace, so it runs with an allow-all preflight
  // and guidance off: this checks the tool-call path end to end, not the policy
  // engine, which `tinystrap doctor` is for.
  const proxy = await start({
    provider: makeProvider(serverBaseUrl),
    registry: createToolRegistry(),
    preflight: () => ({ effect: "allow" as const }),
    features: { guidance: false },
    taskId: "init-smoke",
  });
  try {
    return await runSmokeTest({ proxyBaseUrl: proxy.url, model });
  } finally {
    await proxy.close();
  }
}
