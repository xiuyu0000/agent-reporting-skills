import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const schemaPaths = [
  "skills/deliver-dual-audience-report/references/review-document.schema.json",
  "skills/deliver-dual-audience-report/references/review-packet.schema.json",
  "skills/deliver-dual-audience-report/references/review-state.schema.json",
];

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

const ids = [];
for (const schemaPath of schemaPaths) {
  const schema = JSON.parse(await readFile(resolve(schemaPath), "utf8"));
  if (!ajv.validateSchema(schema)) {
    console.error(`${schemaPath}: invalid Draft 2020-12 schema`);
    console.error(ajv.errorsText(ajv.errors, { separator: "\n" }));
    process.exit(3);
  }
  ajv.compile(schema);
  ids.push(schema.$id);
}

console.log(JSON.stringify({ status: "passed", schemas: ids }));
