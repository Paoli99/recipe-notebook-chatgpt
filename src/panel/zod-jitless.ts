// Imported first so it runs before the Apps SDK evaluates any zod schema:
// the host's CSP blocks eval, so zod must not probe for it.
import { config } from "zod";

config({ jitless: true });
