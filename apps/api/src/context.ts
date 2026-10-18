import type { Auth } from "./auth.js";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import type { EventBus } from "./events/bus.js";
import type { JobRunner } from "./jobs/runner.js";
import type { ProviderService } from "./services/providers.js";
import type { DeriveTexts } from "./services/scripts.js";
import type { AssetUrlSigner } from "./storage/signing.js";
import type { StorageService } from "./storage/types.js";

/** Dependencies shared by all route modules. */
export interface AppContext {
  config: Config;
  db: Db;
  storage: StorageService;
  signer: AssetUrlSigner;
  bus: EventBus;
  runner: JobRunner;
  auth: Auth;
  providers: ProviderService;
  deriveTexts: DeriveTexts;
}
