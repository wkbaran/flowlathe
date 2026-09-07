import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { flowsDir } from "../playwright.config.js";

// PLAN-FLOW-DSL.md S4's definition-of-done: "E2E spec covering canvas->file and file->canvas."
// The first plugin/DSL-shaped e2e spec in this repo (CLAUDE.md's own notes flag every prior one
// as a tracked-but-deferred gap) — everything here drives the real built app against the real
// server, the same way every other slice spec does.

test("editing a flow on the canvas writes its .flow file, and pasting DSL text imports a new flow", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("New flow name").fill("DSL Sync Chain");
  await page.getByRole("button", { name: "New Flow" }).click();
  await expect(page).toHaveURL(/\/flows\/.+/);
  const flowId = page.url().split("/flows/")[1]!;

  await page.getByRole("button", { name: "Add Node" }).click();
  const node = page.getByTestId("node-node-1");
  await expect(node).toBeVisible();
  await node.click();
  await page.getByRole("textbox", { name: "Template" }).fill("hi from the canvas");

  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("v2")).toBeVisible();

  const onDiskAfterSave = await readFile(join(flowsDir, `${flowId}.flow`), "utf8");
  expect(onDiskAfterSave).toContain("hi from the canvas");
  expect(onDiskAfterSave).toContain(`flow "DSL Sync Chain"`);

  // The live Text panel reflects the same graph the file was just written from.
  await page.getByTestId("toggle-text-view").click();
  await expect(page.getByRole("textbox", { name: "Flow DSL text" })).toHaveValue(onDiskAfterSave);
  await page.getByTestId("toggle-text-view").click();

  // Paste-to-import: a flow created from pasted text, verified via the API (same pattern every
  // other slice spec uses to check saved state) rather than a second full UI walkthrough.
  await page.goto("/");
  await page.getByRole("button", { name: "Import from text" }).click();
  await page.getByRole("textbox", { name: "Flow DSL text to import" }).fill(
    ['flow "Pasted Flow" {', "  node a: prompt @(0, 0) {", '    template = "hi"', '    providerId = "mock"', '    modelId = "m"', "  }", "}"].join(
      "\n",
    ),
  );
  await page.getByRole("button", { name: "Import" }).click();
  await expect(page).toHaveURL(/\/flows\/pasted-flow$/);
  const importedGraph = await page.evaluate(async () => (await fetch("/api/flows/pasted-flow")).json());
  expect(importedGraph.graph.nodes).toHaveLength(1);
  expect(importedGraph.graph.nodes[0]).toMatchObject({ id: "a", type: "prompt" });
});

test("an external edit to a flow's .flow file surfaces a reload prompt in the canvas", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("New flow name").fill("Externally Edited Chain");
  await page.getByRole("button", { name: "New Flow" }).click();
  await expect(page).toHaveURL(/\/flows\/.+/);
  const flowId = page.url().split("/flows/")[1]!;

  // Bypass the canvas entirely — an editor, `git checkout`, or `flowlathe fmt` would do the same.
  const path = join(flowsDir, `${flowId}.flow`);
  const original = await readFile(path, "utf8");
  await writeFile(path, original.replace("Externally Edited Chain", "Externally Edited Chain (v2)"));

  await expect(page.getByText("This flow changed on disk")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("reload-flow-button").click();
  await expect(page.getByRole("heading", { name: "Externally Edited Chain (v2)" })).toBeVisible();
});
