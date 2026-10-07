import { installApi, realApi } from "@/api";
import { createDemoApi } from "./api";
import { DemoEnvironment } from "./DemoEnvironment";

/**
 * Lazy-component loader for the demo build: swaps the REST client for the fake server, then
 * resolves to the provider that injects the demo's adapters. Nothing under the app renders
 * (or calls the API) until this settles.
 */
export async function loadDemoEnvironment(): Promise<{ default: typeof DemoEnvironment }> {
  installApi(createDemoApi(realApi));
  return { default: DemoEnvironment };
}
