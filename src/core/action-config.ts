/**
 * ActionConfig - Single Source of Truth for GitHub Action Definitions
 *
 * Each action exports a config object that defines its inputs, outputs,
 * and metadata. This is used to:
 * 1. Generate action.yml files
 * 2. Provide type-safe input getters
 * 3. Generate documentation
 */

import * as core from "@actions/core";

export interface InputDefinition {
  description: string;
  required?: boolean;
  default?: string;
}

export interface OutputDefinition {
  description: string;
}

export interface ActionRuns {
  using: "node24";
  main: string;
}

export interface ActionConfig<
  TInputs extends Record<string, InputDefinition> = Record<string, InputDefinition>,
  TOutputs extends Record<string, OutputDefinition> = Record<string, OutputDefinition>,
> {
  name: string;
  description: string;
  inputs?: TInputs;
  outputs?: TOutputs;
  runs: ActionRuns;
}

export interface InputAccessor<TInputNames extends string> {
  get(name: TInputNames): string;
  getOptional(name: TInputNames): string | undefined;
  getRequired(name: TInputNames): string;
  getBool(name: TInputNames): boolean;
  getBoolWithDefault(name: TInputNames, defaultValue: boolean): boolean;
}

export interface OutputAccessor<TOutputNames extends string> {
  set(name: TOutputNames, value: string): void;
}

export function createInputs<TInputs extends Record<string, InputDefinition>>(
  config: ActionConfig<TInputs, Record<string, OutputDefinition>>,
): InputAccessor<Extract<keyof TInputs, string>> {
  type Names = Extract<keyof TInputs, string>;

  return {
    get(name: Names): string {
      const inputDef = config.inputs?.[name];
      const value = core.getInput(name);
      return value || inputDef?.default || "";
    },

    getOptional(name: Names): string | undefined {
      const value = core.getInput(name);
      return value || undefined;
    },

    getRequired(name: Names): string {
      return core.getInput(name, { required: true });
    },

    getBool(name: Names): boolean {
      return this.get(name) === "true";
    },

    getBoolWithDefault(name: Names, defaultValue: boolean): boolean {
      const value = core.getInput(name);
      if (!value) return defaultValue;
      return value === "true";
    },
  };
}

export function createOutputs<TOutputs extends Record<string, OutputDefinition>>(
  _config: ActionConfig<Record<string, InputDefinition>, TOutputs>,
): OutputAccessor<Extract<keyof TOutputs, string>> {
  type Names = Extract<keyof TOutputs, string>;

  return {
    set(name: Names, value: string): void {
      core.setOutput(name, value);
    },
  };
}

export function defineAction<
  TInputs extends Record<string, InputDefinition>,
  TOutputs extends Record<string, OutputDefinition>,
>(config: ActionConfig<TInputs, TOutputs>): ActionConfig<TInputs, TOutputs> {
  return config;
}
