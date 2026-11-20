// Where the image keeps GHOST Protocol's checkout (GP_ROOT, /opt/ghost-protocol).
import { pathToFileURL } from "node:url";
import { join } from "node:path";

export const GP_ROOT = process.env.GP_ROOT || "/opt/ghost-protocol";
export const adapter = (rel) => pathToFileURL(join(GP_ROOT, "adapters/buzz", rel)).href;
