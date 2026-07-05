/**
 * XMPP model and thinking level helpers
 * Zones: pi agent model control, xmpp controls
 * Owns model identity, thinking levels, and current-model state
 */

import type { ExtensionContext } from "./pi.ts";

export interface MenuModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
}

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export interface ScopedXmppModel<TModel extends MenuModel = MenuModel> {
  model: TModel;
  thinkingLevel?: ThinkingLevel;
}

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export interface CurrentModelStore<
  TContext,
  TModel extends MenuModel = MenuModel,
> {
  get: (ctx: TContext) => TModel | undefined;
  getStored: () => TModel | undefined;
  set: (model: TModel | undefined) => void;
}

export interface CurrentModelUpdateRuntime<
  TContext,
  TModel extends MenuModel = MenuModel,
> {
  setCurrentModel: (model: TModel | undefined, ctx: TContext) => void;
  onModelSelect: (event: { model: TModel | undefined }, ctx: TContext) => void;
}

export type CurrentModelRuntime<
  TContext,
  TModel extends MenuModel = MenuModel,
> = CurrentModelStore<TContext, TModel> &
  CurrentModelUpdateRuntime<TContext, TModel>;

export function createCurrentModelStore<
  TContext,
  TModel extends MenuModel = MenuModel,
>(
  getContextModel: (ctx: TContext) => TModel | undefined,
): CurrentModelStore<TContext, TModel> {
  let currentModel: TModel | undefined;
  return {
    get: (ctx) => currentModel ?? getContextModel(ctx),
    getStored: () => currentModel,
    set: (model) => {
      currentModel = model;
    },
  };
}

export function createCurrentModelUpdateRuntime<
  TContext extends ExtensionContext,
  TModel extends MenuModel = MenuModel,
>(
  deps: CurrentModelStore<TContext, TModel> & {
    setModel: (model: TModel | undefined) => void;
  },
): CurrentModelUpdateRuntime<TContext, TModel> {
  return {
    setCurrentModel(model, ctx) {
      deps.set(model);
      if (model) {
        deps.setModel(model as Parameters<typeof deps.setModel>[0]);
      }
    },
    onModelSelect(event, ctx) {
      deps.set(event.model);
    },
  };
}
