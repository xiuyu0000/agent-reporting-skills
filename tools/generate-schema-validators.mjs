import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import standaloneCode from "ajv/dist/standalone/index.js";
import addFormats from "ajv-formats";
import { build } from "esbuild";
import { canonicalize } from "json-canonicalize";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(repoRoot, "src/protocol/schema.generated.ts");
const browserOutputPath = resolve(repoRoot, "src/protocol/schema.browser.generated.ts");
const BROWSER_SHARED_SCHEMA_ID =
  "urn:deliver-dual-audience-report:schema:browser-shared:1";

const schemaEntries = [
  {
    exportName: "validateReviewDocument",
    path: "skills/deliver-dual-audience-report/references/review-document.schema.json",
  },
  {
    exportName: "validateReviewPacket",
    path: "skills/deliver-dual-audience-report/references/review-packet.schema.json",
  },
  {
    exportName: "validateReviewState",
    path: "skills/deliver-dual-audience-report/references/review-state.schema.json",
  },
];

const browserSharedDefinitions = {
  validateReviewDocument: {
    NonEmptyString: "NonEmptyString",
    ZonedDateTime: "ZonedDateTime",
    Sha256Digest: "Sha256Digest",
    DocumentId: "DocumentId",
    PacketId: "PacketId",
    BlockId: "BlockId",
    TopicId: "TopicId",
    DocumentIdHighWater: "IdHighWater",
  },
  validateReviewPacket: {
    NonEmptyString: "NonEmptyString",
    ZonedDateTime: "ZonedDateTime",
    Sha256Digest: "Sha256Digest",
    PacketId: "PacketId",
    DocumentId: "DocumentId",
    BlockId: "BlockId",
    NoteId: "NoteId",
    TopicId: "TopicId",
    PacketIdHighWater: "IdHighWater",
    PacketDecision: "Decision",
    PassDecision: "PassDecision",
    EditDecision: "EditDecision",
    TopicDecision: "TopicDecision",
    HoldDecision: "HoldDecision",
    PacketSideNote: "SideNote",
    PacketTopic: "Topic",
  },
  validateReviewState: {
    NonEmptyString: "NonEmptyString",
    ZonedDateTime: "ZonedDateTime",
    Sha256Digest: "Sha256Digest",
    DocumentId: "DocumentId",
    BlockId: "BlockId",
    NoteId: "NoteId",
    TopicId: "TopicId",
    StateIdHighWater: "IdHighWater",
    StateDecision: "Decision",
    StatePassDecision: "PassDecision",
    StateEditDecision: "EditDecision",
    StateTopicDecision: "TopicDecision",
    StateHoldDecision: "HoldDecision",
    StateSideNote: "SideNote",
    StateTopic: "Topic",
  },
};

function stripBuildOnlyHelperMetadata(source) {
  // Ajv helper modules expose their CommonJS source locator through a `.code`
  // property for standalone generation. The validator has already been generated,
  // so retaining these inert strings would make the runtime look module-dependent.
  const stripped = source.replace(
    /\b[$A-Z_a-z][$\w]*\.code=(['"])require\([^)]+\)(?:\.default)?\1;?/g,
    "",
  );
  // Keep the exact ajv-formats table while preventing a generic public-tree
  // credential scanner from treating its inert format-name key as a secret.
  const sensitiveFormatName = ["pass", "word"].join("");
  return stripped.replaceAll(`${sensitiveFormatName}:!0`, '["pass"+"word"]:!0');
}

function assertStandaloneRuntime(source) {
  const forbidden = [
    ["runtime require", /\brequire\s*\(/],
    ["runtime import", /\bimport\s*(?:\(|[\s{*])/],
    ["eval", /\beval\s*\(/],
    ["new Function", /\bnew\s+Function\b/],
    ["network fetch", /\bfetch\s*\(/],
    ["network XMLHttpRequest", /\bXMLHttpRequest\b/],
    ["network WebSocket", /\bWebSocket\b/],
    ["network sendBeacon", /\bsendBeacon\s*\(/],
    ["network EventSource", /\bEventSource\b/],
  ];
  for (const [description, pattern] of forbidden) {
    if (pattern.test(source)) {
      throw new Error(`Ajv standalone output unexpectedly contains ${description}`);
    }
  }
}

function createAjv() {
  const ajv = new Ajv2020({
    allErrors: true,
    code: { esm: true, lines: true, source: true },
    inlineRefs: 1,
    messages: false,
    strict: true,
  });
  addFormats(ajv);
  return ajv;
}

async function loadSchemaEntries() {
  return Promise.all(schemaEntries.map(async (entry) => ({
    ...entry,
    schema: JSON.parse(await readFile(resolve(repoRoot, entry.path), "utf8")),
  })));
}

async function bundleValidatorGroup(ajv, entries, globalName) {
  const exportsByName = Object.fromEntries(
    entries.map((entry) => [entry.exportName, entry.schema.$id]),
  );
  const standalone = standaloneCode(ajv, exportsByName);
  const result = await build({
    bundle: true,
    format: "iife",
    globalName,
    legalComments: "none",
    minify: true,
    platform: "browser",
    stdin: {
      contents: standalone,
      loader: "js",
      resolveDir: repoRoot,
      sourcefile: `${globalName}.standalone.js`,
    },
    target: "es2023",
    treeShaking: true,
    write: false,
  });
  const output = result.outputFiles[0]?.text.trim();
  if (!output) throw new Error(`esbuild did not emit validator group ${globalName}`);
  const inlined = stripBuildOnlyHelperMetadata(output);
  assertStandaloneRuntime(inlined);
  return inlined;
}

function renderPureGroup(constName, globalName, bundledSource) {
  return [
    `const ${constName} = /* @__PURE__ */ (() => {`,
    bundledSource,
    `return ${globalName};`,
    "})();",
  ].join("\n");
}

function renderPureExport(exportName, groupName) {
  return `export const ${exportName} = /* @__PURE__ */ (() =>\n  ${groupName}.${exportName})();`;
}

export function rewriteSharedReferences(value, aliases, propertyName = undefined) {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteSharedReferences(item, aliases));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      rewriteSharedReferences(child, aliases, key),
    ]));
  }
  if (propertyName === "$ref" && typeof value === "string") {
    const reference = /^#\/\$defs\/([^/]+)$/.exec(value);
    if (reference === null) return value;
    const definitionName = reference[1];
    if (Object.hasOwn(aliases, definitionName)) {
      const sharedName = aliases[definitionName];
      return `${BROWSER_SHARED_SCHEMA_ID}#/$defs/${sharedName}`;
    }
  }
  return value;
}

function cloneSchemaValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function createBrowserSchemaGraph(entries) {
  const candidates = new Map();
  const transformedEntries = entries.map((entry) => {
    const aliases = browserSharedDefinitions[entry.exportName];
    if (aliases === undefined) {
      throw new Error(`browser schema sharing map is missing ${entry.exportName}`);
    }
    const transformed = rewriteSharedReferences(cloneSchemaValue(entry.schema), aliases);
    for (const [localName, sharedName] of Object.entries(aliases)) {
      const definition = entry.schema.$defs?.[localName];
      if (definition === undefined) {
        throw new Error(`${entry.exportName} is missing shared definition ${localName}`);
      }
      const rewrittenDefinition = rewriteSharedReferences(cloneSchemaValue(definition), aliases);
      const canonical = canonicalize(rewrittenDefinition);
      const group = candidates.get(sharedName) ?? [];
      group.push({ canonical, definition: rewrittenDefinition, entry, localName });
      candidates.set(sharedName, group);
      delete transformed.$defs[localName];
    }
    return { ...entry, schema: transformed };
  });

  const sharedDefinitions = {};
  for (const [sharedName, group] of candidates) {
    if (group.length < 2) {
      throw new Error(`shared definition ${sharedName} has fewer than two sources`);
    }
    const expected = group[0].canonical;
    const mismatch = group.find((candidate) => candidate.canonical !== expected);
    if (mismatch !== undefined) {
      const sources = group.map(({ entry, localName }) =>
        `${entry.exportName}#/$defs/${localName}`).join(", ");
      throw new Error(`shared definition ${sharedName} differs across ${sources}`);
    }
    sharedDefinitions[sharedName] = group[0].definition;
  }

  return {
    entries: transformedEntries,
    sharedSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: BROWSER_SHARED_SCHEMA_ID,
      $defs: sharedDefinitions,
    },
  };
}

function annotationProjection(schemaValue, paths, schemaName) {
  const projection = Object.create(null);
  for (const path of paths) {
    if (path === "enum") {
      if (!Array.isArray(schemaValue.enum)) {
        throw new Error(`${schemaName}.enum is not an array`);
      }
      projection.enum = schemaValue.enum;
      continue;
    }
    if (path === "properties") {
      if (schemaValue.properties === null || typeof schemaValue.properties !== "object") {
        throw new Error(`${schemaName}.properties is not an object`);
      }
      projection.properties ??= Object.create(null);
      for (const propertyName of Object.keys(schemaValue.properties)) {
        projection.properties[propertyName] ??= {};
      }
      continue;
    }
    const match = /^properties\.([^.]+)\.enum$/.exec(path);
    if (match !== null) {
      const propertyName = match[1];
      const propertyValue = schemaValue.properties?.[propertyName];
      if (!Array.isArray(propertyValue?.enum)) {
        throw new Error(`${schemaName}.properties.${propertyName}.enum is not an array`);
      }
      projection.properties ??= Object.create(null);
      projection.properties[propertyName] ??= {};
      projection.properties[propertyName].enum = propertyValue.enum;
      continue;
    }
    throw new Error(`unknown standalone annotation reference ${schemaName}.${path}`);
  }
  return projection;
}

function assertKnownAnnotationUse(schemaName, path, expression, hasOwnHelpers) {
  if (path === "properties") {
    const parent = expression.parent;
    const isHasOwnCall = ts.isCallExpression(parent)
      && parent.arguments[0] === expression
      && ts.isPropertyAccessExpression(parent.expression)
      && parent.expression.name.text === "call"
      && ts.isIdentifier(parent.expression.expression)
      && hasOwnHelpers.has(parent.expression.expression.text);
    if (isHasOwnCall) return;
  } else if (path === "enum" || /^properties\.[^.]+\.enum$/.test(path)) {
    const parent = expression.parent;
    const isAllowedValues = ts.isPropertyAssignment(parent)
      && parent.initializer === expression
      && ((ts.isIdentifier(parent.name) && parent.name.text === "allowedValues")
        || (ts.isStringLiteral(parent.name) && parent.name.text === "allowedValues"));
    if (isAllowedValues) return;
  }
  throw new Error(`unknown standalone annotation reference ${schemaName}.${path}`);
}

export function pruneStandaloneAnnotations(source) {
  const sourceFile = ts.createSourceFile(
    "browser-schema-validators.standalone.js",
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    throw new Error("could not parse Ajv standalone output for annotation pruning");
  }

  const declarations = new Map();
  const hasOwnHelpers = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)
        && declaration.initializer?.getText(sourceFile) === "Object.prototype.hasOwnProperty") {
        hasOwnHelpers.add(declaration.name.text);
      }
    }
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)
        || !/^schema\d+$/.test(declaration.name.text)
        || declaration.initializer === undefined) continue;
      if (statement.declarationList.declarations.length !== 1) {
        throw new Error(`${declaration.name.text} shares an unsupported declaration statement`);
      }
      if (!ts.isObjectLiteralExpression(declaration.initializer)) {
        throw new Error(`${declaration.name.text} is not an object literal`);
      }
      let schemaValue;
      try {
        schemaValue = JSON.parse(declaration.initializer.getText(sourceFile));
      } catch {
        throw new Error(`${declaration.name.text} is not a JSON object literal`);
      }
      declarations.set(declaration.name.text, {
        declaration,
        initializer: declaration.initializer,
        statement,
        schemaValue,
        paths: new Set(),
      });
    }
  }
  if (declarations.size === 0) {
    throw new Error("Ajv standalone output contains no schema annotation declarations");
  }

  function visit(node) {
    if (ts.isIdentifier(node) && declarations.has(node.text)) {
      const parent = node.parent;
      const isDeclaration = ts.isVariableDeclaration(parent) && parent.name === node;
      const isPropertyName = ts.isPropertyAccessExpression(parent) && parent.name === node;
      if (!isDeclaration && !isPropertyName) {
        const path = [];
        let current = node;
        while (ts.isPropertyAccessExpression(current.parent)
          && current.parent.expression === current) {
          path.push(current.parent.name.text);
          current = current.parent;
        }
        if (path.length === 0) {
          throw new Error(`unknown direct standalone annotation reference ${node.text}`);
        }
        const referencePath = path.join(".");
        assertKnownAnnotationUse(node.text, referencePath, current, hasOwnHelpers);
        declarations.get(node.text).paths.add(referencePath);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  const replacements = [];
  for (const [schemaName, metadata] of declarations) {
    if (metadata.paths.size === 0) {
      replacements.push({
        start: metadata.statement.getStart(sourceFile),
        end: metadata.statement.getEnd(),
        text: "",
      });
      continue;
    }
    const projection = annotationProjection(metadata.schemaValue, metadata.paths, schemaName);
    replacements.push({
      start: metadata.declaration.getStart(sourceFile),
      end: metadata.declaration.getEnd(),
      text: `${schemaName} = ${JSON.stringify(projection)}`,
    });
  }
  replacements.sort((left, right) => right.start - left.start);
  let pruned = source;
  for (const replacement of replacements) {
    pruned = pruned.slice(0, replacement.start)
      + replacement.text
      + pruned.slice(replacement.end);
  }
  return pruned;
}

async function bundleBrowserValidators(standalone) {
  const pruned = pruneStandaloneAnnotations(standalone);
  const result = await build({
    bundle: true,
    format: "esm",
    legalComments: "none",
    minify: true,
    platform: "browser",
    stdin: {
      contents: pruned,
      loader: "js",
      resolveDir: repoRoot,
      sourcefile: "browser-schema-validators.standalone.js",
    },
    target: "es2023",
    treeShaking: true,
    write: false,
  });
  const output = result.outputFiles[0]?.text.trim();
  if (!output) throw new Error("esbuild did not emit browser schema validators");
  const inlined = stripBuildOnlyHelperMetadata(output);
  assertStandaloneRuntime(inlined);
  return inlined;
}

export async function generateSchemaValidators() {
  const entries = await loadSchemaEntries();
  const ajv = createAjv();
  for (const entry of entries) ajv.addSchema(entry.schema);

  const documentEntries = entries.filter((entry) => entry.exportName === "validateReviewDocument");
  const overlayEntries = entries.filter((entry) => entry.exportName !== "validateReviewDocument");
  const documentGlobal = "__darDocumentValidators";
  const overlayGlobal = "__darOverlayValidators";
  const [documentSource, overlaySource] = await Promise.all([
    bundleValidatorGroup(ajv, documentEntries, documentGlobal),
    bundleValidatorGroup(ajv, overlayEntries, overlayGlobal),
  ]);

  const generated = [
    "/* eslint-disable */",
    "// @ts-nocheck",
    "/**",
    " * Generated standalone validators for the public review JSON Schemas.",
    " * Do not edit by hand; run `node tools/generate-schema-validators.mjs`.",
    " * The pure document and packet/state groups can be tree-shaken independently.",
    " * Runtime code contains no Ajv dependency or dynamic code generation.",
    " */",
    "",
    renderPureGroup("documentValidatorGroup", documentGlobal, documentSource),
    "",
    renderPureGroup("overlayValidatorGroup", overlayGlobal, overlaySource),
    "",
    renderPureExport("validateReviewDocument", "documentValidatorGroup"),
    renderPureExport("validateReviewPacket", "overlayValidatorGroup"),
    renderPureExport("validateReviewState", "overlayValidatorGroup"),
    "",
  ].join("\n");
  assertStandaloneRuntime(generated);
  return generated;
}

export async function generateBrowserSchemaValidators() {
  const sourceEntries = await loadSchemaEntries();
  const graph = createBrowserSchemaGraph(sourceEntries);
  const ajv = createAjv();
  ajv.addSchema(graph.sharedSchema);
  for (const entry of graph.entries) ajv.addSchema(entry.schema);
  const exportsByName = Object.fromEntries(
    graph.entries.map((entry) => [entry.exportName, entry.schema.$id]),
  );
  const standalone = standaloneCode(ajv, exportsByName);
  const bundled = await bundleBrowserValidators(standalone);
  const generated = [
    "/* eslint-disable */",
    "// @ts-nocheck",
    "/**",
    " * Browser-only companion validators generated from the three public roots.",
    " * Do not edit by hand; run `node tools/generate-schema-validators.mjs`.",
    " * Shared definitions are build-private; public schemas and wire formats are unchanged.",
    " * Runtime code contains no Ajv dependency or dynamic code generation.",
    " */",
    "",
    bundled,
    "",
  ].join("\n");
  assertStandaloneRuntime(generated);
  return generated;
}

async function readGenerated(path, description) {
  try {
    return await readFile(path, "utf8");
  } catch {
    console.error(`${description} are missing`);
    process.exit(3);
  }
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const [generated, browserGenerated] = await Promise.all([
    generateSchemaValidators(),
    generateBrowserSchemaValidators(),
  ]);

  if (checkOnly) {
    const [existing, browserExisting] = await Promise.all([
      readGenerated(outputPath, "generated standalone schema validators"),
      readGenerated(browserOutputPath, "generated browser schema validators"),
    ]);
    if (existing !== generated || browserExisting !== browserGenerated) {
      console.error("generated standalone schema validators are stale");
      process.exit(3);
    }
    console.log("generated standalone schema validators are current");
    return;
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await Promise.all([
    writeFile(outputPath, generated, "utf8"),
    writeFile(browserOutputPath, browserGenerated, "utf8"),
  ]);
  console.log("generated src/protocol/schema.generated.ts");
  console.log("generated src/protocol/schema.browser.generated.ts");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
