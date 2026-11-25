// Source files resolve packages from the repo root, so point its node_modules at ours.
import * as fs from "node:fs";

const link = new URL("../node_modules", import.meta.url);
if (!fs.existsSync(link)) fs.symlinkSync("standalone/node_modules", link, "dir");
