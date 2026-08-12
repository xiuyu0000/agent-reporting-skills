import { runValidateCommand } from "../../../src/cli/validate.js";
import { approvalTemplateBytes } from "./helpers.js";

const arguments_ = process.env.DAR_VALIDATE_TEST_THROW === undefined
  ? process.argv.slice(2)
  : new Proxy([] as string[], {
      get() {
        throw new Error(process.env.DAR_VALIDATE_TEST_THROW);
      },
    });
const outcome = await runValidateCommand(arguments_, {
  approvalTemplateBytes: approvalTemplateBytes(),
});
process.stdout.write(`${JSON.stringify(outcome.result)}\n`);
process.exitCode = outcome.exitCode;
