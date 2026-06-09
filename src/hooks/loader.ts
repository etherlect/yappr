import { registerHooks } from "./registry.js";
import { log } from "../log.js";
import { listHooks, importConfigModule } from "../config-loader.js";
import type { AgentHooks } from "./types.js";

export async function loadHooks(): Promise<void> {
  for (const { name, modulePath } of await listHooks()) {
    try {
      const mod = await importConfigModule(modulePath);
      if (mod.hooks && typeof mod.hooks === "object") {
        registerHooks(mod.hooks as AgentHooks);
        log.info({ file: name }, `hook loaded: ${name}`);
      }
    } catch (err: any) {
      log.error({ file: name, err: err.message }, `hook load failed: ${name}`);
    }
  }
}
