import { runRecordUsageCommand } from "./record-usage.ts";

const result = await runRecordUsageCommand(process.argv.slice(2));
process.stdout.write(`${JSON.stringify(result)}\n`);
