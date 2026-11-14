import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDevCommands } from "../src/control-room/dev-commands.js";
import { superviseProcesses } from "../src/control-room/dev-supervisor.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.exitCode = await superviseProcesses({ commands: resolveDevCommands(root) });
