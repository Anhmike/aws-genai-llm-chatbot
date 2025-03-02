#!/usr/bin/env node

// Copyright 2021 Amazon.com.
// SPDX-License-Identifier: MIT

import { Command } from "commander";
import * as enquirer from "enquirer";
import {
  SupportedRegion,
  SupportedSageMakerModels,
  SystemConfig,
  SupportedBedrockRegion,
} from "../lib/shared/types";
import { LIB_VERSION } from "./version.js";
import * as fs from "fs";

const iamRoleRegExp = RegExp(/arn:aws:iam::\d+:role\/[\w-_]+/);
const kendraIdRegExp = RegExp(/^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/);

const embeddingModels = [
  {
    provider: "sagemaker",
    name: "intfloat/multilingual-e5-large",
    dimensions: 1024,
  },
  {
    provider: "sagemaker",
    name: "sentence-transformers/all-MiniLM-L6-v2",
    dimensions: 384,
  },
  {
    provider: "bedrock",
    name: "amazon.titan-embed-text-v1",
    dimensions: 1536,
  },
  {
    provider: "openai",
    name: "text-embedding-ada-002",
    dimensions: 1536,
  },
];

/**
 * Main entry point
 */

(async () => {
  let program = new Command().description(
    "Creates a new chatbot configuration"
  );
  program.version(LIB_VERSION);

  program.option("-p, --prefix <prefix>", "The prefix for the stack");

  program.action(async (options) => {
    if (fs.existsSync("./bin/config.json")) {
      const config: SystemConfig = JSON.parse(
        fs.readFileSync("./bin/config.json").toString("utf8")
      );
      options.prefix = config.prefix;
      options.privateWebsite = config.privateWebsite;
      options.certificate = config.certificate;
      options.domain = config.domain;
      options.bedrockEnable = config.bedrock?.enabled;
      options.bedrockRegion = config.bedrock?.region;
      options.bedrockRoleArn = config.bedrock?.roleArn;
      options.sagemakerModels = config.llms?.sagemaker ?? [];
      options.enableSagemakerModels = config.llms?.sagemaker
        ? config.llms?.sagemaker.length > 0
        : false;
      options.enableRag = config.rag.enabled;
      options.ragsToEnable = Object.keys(config.rag.engines ?? {}).filter(
        (v: string) => (config.rag.engines as any)[v].enabled
      );
      if (
        options.ragsToEnable.includes("kendra") &&
        !config.rag.engines.kendra.createIndex
      ) {
        options.ragsToEnable.pop("kendra");
      }
      options.embeddings = config.rag.embeddingsModels.map((m: any) => m.name);
      options.defaultEmbedding = (config.rag.embeddingsModels ?? []).filter(
        (m: any) => m.default
      )[0].name;
      options.kendraExternal = config.rag.engines.kendra.external;
      options.kendraEnterprise = config.rag.engines.kendra.enterprise;
    }
    try {
      await processCreateOptions(options);
    } catch (err: any) {
      console.error("Could not complete the operation.");
      console.error(err.message);
      process.exit(1);
    }
  });

  program.parse(process.argv);
})();

function createConfig(config: any): void {
  fs.writeFileSync("./bin/config.json", JSON.stringify(config, undefined, 2));
  console.log("Configuration written to ./bin/config.json");
}

/**
 * Prompts the user for missing options
 *
 * @param options Options provided via the CLI
 * @returns The complete options
 */
async function processCreateOptions(options: any): Promise<void> {
  let questions = [
    {
      type: "input",
      name: "prefix",
      message: "Prefix to differentiate this deployment",
      initial: options.prefix,
      askAnswered: false,
    },
    {
      type: "confirm",
      name: "privateWebsite",
      message:
        "Do you want to deploy a private website? I.e only accessible in VPC",
      initial: options.privateWebsite || false,
    },
    {
      type: "input",
      name: "certificate",
      message: "ACM certificate ARN",
      initial: options.certificate,
      skip(): boolean {
        return !(this as any).state.answers.privateWebsite;
      },
    },
    {
      type: "input",
      name: "domain",
      message: "Domain for private website",
      initial: options.domain,
      skip(): boolean {
        return !(this as any).state.answers.privateWebsite;
      },
    },
    {
      type: "confirm",
      name: "bedrockEnable",
      message: "Do you have access to Bedrock and want to enable it",
      initial: true,
    },
    {
      type: "select",
      name: "bedrockRegion",
      message: "Region where Bedrock is available",
      choices: Object.values(SupportedBedrockRegion),
      initial: options.bedrockRegion ?? "us-east-1",
      skip() {
        return !(this as any).state.answers.bedrockEnable;
      },
    },
    {
      type: "input",
      name: "bedrockRoleArn",
      message:
        "Cross account role arn to invoke Bedrock - leave empty if Bedrock is in same account",
      validate: (v: string) => {
        const valid = iamRoleRegExp.test(v);
        return v.length === 0 || valid;
      },
      initial: options.bedrockRoleArn || "",
    },
    {
      type: "confirm",
      name: "enableSagemakerModels",
      message: "Do you want to use any Sagemaker Models",
      initial: options.enableSagemakerModels || false,
    },
    {
      type: "multiselect",
      name: "sagemakerModels",
      hint: "SPACE to select, ENTER to confirm selection [denotes instance size to host model]",
      message: "Which SageMaker Models do you want to enable",
      choices: Object.values(SupportedSageMakerModels),
      initial:
        (options.sagemakerModels ?? []).filter((m: string) =>
          Object.values(SupportedSageMakerModels)
            .map((x) => x.toString())
            .includes(m)
        ) || [],
      validate(choices: any) {
        return (this as any).skipped || choices.length > 0
          ? true
          : "You need to select at least one model";
      },
      skip(): boolean {
        (this as any).state._choices = (this as any).state.choices;
        return !(this as any).state.answers.enableSagemakerModels;
      },
    },
    {
      type: "confirm",
      name: "enableRag",
      message: "Do you want to enable RAG",
      initial: options.enableRag || false,
    },
    {
      type: "multiselect",
      name: "ragsToEnable",
      hint: "SPACE to select, ENTER to confirm selection",
      message: "Which datastores do you want to enable for RAG",
      choices: [
        { message: "Aurora", name: "aurora" },
        { message: "OpenSearch", name: "opensearch" },
        { message: "Kendra (managed)", name: "kendra" },
      ],
      validate(choices: any) {
        return (this as any).skipped || choices.length > 0
          ? true
          : "You need to select at least one engine";
      },
      skip(): boolean {
        // workaround for https://github.com/enquirer/enquirer/issues/298
        (this as any).state._choices = (this as any).state.choices;
        return !(this as any).state.answers.enableRag;
      },
      initial: options.ragsToEnable || [],
    },
    {
      type: "confirm",
      name: "kendraEnterprise",
      message: "Do you want to enable Kendra Enterprise Edition?",
      initial: options.kendraEnterprise || false,
      skip(): boolean {
        return !(this as any).state.answers.ragsToEnable.includes("kendra");
      },
    },
    {
      type: "confirm",
      name: "kendra",
      message: "Do you want to add existing Kendra indexes",
      initial:
        (options.kendraExternal !== undefined &&
          options.kendraExternal.length > 0) ||
        false,
      skip(): boolean {
        return !(this as any).state.answers.enableRag;
      },
    },
  ];
  const answers: any = await enquirer.prompt(questions);
  const kendraExternal: any[] = [];
  let newKendra = answers.enableRag && answers.kendra;
  const existingKendraIndices = Array.from(options.kendraExternal || []);
  while (newKendra === true) {
    let existingIndex: any = existingKendraIndices.pop();
    const kendraQ = [
      {
        type: "input",
        name: "name",
        message: "Kendra source name",
        validate(v: string) {
          return RegExp(/^\w[\w-_]*\w$/).test(v);
        },
        initial: existingIndex?.name,
      },
      {
        type: "autocomplete",
        limit: 8,
        name: "region",
        choices: Object.values(SupportedRegion),
        message: `Region of the Kendra index${
          existingIndex?.region ? " (" + existingIndex?.region + ")" : ""
        }`,
        initial: Object.values(SupportedRegion).indexOf(existingIndex?.region),
      },
      {
        type: "input",
        name: "roleArn",
        message:
          "Cross account role Arn to assume to call Kendra, leave empty if not needed",
        validate: (v: string) => {
          const valid = iamRoleRegExp.test(v);
          return v.length === 0 || valid;
        },
        initial: existingIndex?.roleArn ?? "",
      },
      {
        type: "input",
        name: "kendraId",
        message: "Kendra ID",
        validate(v: string) {
          return kendraIdRegExp.test(v);
        },
        initial: existingIndex?.kendraId,
      },
      {
        type: "confirm",
        name: "enabled",
        message: "Enable this index",
        initial: existingIndex?.enabled ?? true,
      },
      {
        type: "confirm",
        name: "newKendra",
        message: "Do you want to add another Kendra source",
        initial: false,
      },
    ];
    const kendraInstance: any = await enquirer.prompt(kendraQ);
    const ext = (({ enabled, name, roleArn, kendraId, region }) => ({
      enabled,
      name,
      roleArn,
      kendraId,
      region,
    }))(kendraInstance);
    if (ext.roleArn === "") ext.roleArn = undefined;
    kendraExternal.push({
      ...ext,
    });
    newKendra = kendraInstance.newKendra;
  }
  const modelsPrompts = [
    {
      type: "select",
      name: "defaultEmbedding",
      message: "Which is the default embedding model",
      choices: embeddingModels.map((m) => ({ name: m.name, value: m })),
      initial: options.defaultEmbedding || undefined,
      skip(): boolean {
        return !(this as any).state.answers.enableRag;
      },
    },
  ];
  const models: any = await enquirer.prompt(modelsPrompts);

  // Create the config object
  const config = {
    prefix: answers.prefix,
    privateWebsite: answers.privateWebsite,
    certificate: answers.certificate,
    domain: answers.domain,
    bedrock: answers.bedrockEnable
      ? {
          enabled: answers.bedrockEnable,
          region: answers.bedrockRegion,
          roleArn:
            answers.bedrockRoleArn === "" ? undefined : answers.bedrockRoleArn,
        }
      : undefined,
    llms: {
      sagemaker: answers.sagemakerModels,
    },
    rag: {
      enabled: answers.enableRag,
      engines: {
        aurora: {
          enabled: answers.ragsToEnable.includes("aurora"),
        },
        opensearch: {
          enabled: answers.ragsToEnable.includes("opensearch"),
        },
        kendra: {
          enabled: false,
          createIndex: false,
          external: [{}],
          enterprise: false,
        },
      },
      embeddingsModels: [{}],
      crossEncoderModels: [{}],
    },
  };

  // If we have not enabled rag the default embedding is set to the first model
  if (!answers.enableRag) {
    models.defaultEmbedding = embeddingModels[0].name;
  }

  config.rag.crossEncoderModels[0] = {
    provider: "sagemaker",
    name: "cross-encoder/ms-marco-MiniLM-L-12-v2",
    default: true,
  };
  config.rag.embeddingsModels = embeddingModels;
  config.rag.embeddingsModels.forEach((m: any) => {
    if (m.name === models.defaultEmbedding) {
      m.default = true;
    }
  });

  config.rag.engines.kendra.createIndex =
    answers.ragsToEnable.includes("kendra");
  config.rag.engines.kendra.enabled =
    config.rag.engines.kendra.createIndex || kendraExternal.length > 0;
  config.rag.engines.kendra.external = [...kendraExternal];
  config.rag.engines.kendra.enterprise = answers.kendraEnterprise;

  console.log("\n✨ This is the chosen configuration:\n");
  console.log(JSON.stringify(config, undefined, 2));
  (
    (await enquirer.prompt([
      {
        type: "confirm",
        name: "create",
        message: "Do you want to create/update the configuration based on the above settings",
        initial: true,
      },
    ])) as any
  ).create
    ? createConfig(config)
    : console.log("Skipping");
}
