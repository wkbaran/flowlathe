import { expect, test } from "@playwright/test";

test("a map node fans out over 3 items concurrently and joins them in order", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("New flow name").fill("Map Fanout");
  await page.getByRole("button", { name: "New Flow" }).click();
  await expect(page).toHaveURL(/\/flows\/.+/);

  const kindSelect = page.getByRole("combobox", { name: "New node kind" });
  const addButton = page.getByRole("button", { name: "Add Node" });

  await kindSelect.click();
  await page.getByRole("option", { name: "map" }).click();
  await addButton.click();

  await kindSelect.click();
  await page.getByRole("option", { name: "prompt", exact: true }).click();
  await addButton.click();

  const mapNode = page.getByTestId("node-node-1");
  const bodyNode = page.getByTestId("node-node-2");
  await expect(mapNode).toBeVisible();
  await expect(bodyNode).toBeVisible();

  await bodyNode.click();
  await page.getByRole("textbox", { name: "Template" }).fill("got: {{item}}");
  await page.getByRole("combobox", { name: "Parent (Loop/Map body of)" }).click();
  await page.getByRole("option", { name: /body of/ }).click();

  await page.getByRole("button", { name: "Run" }).click();

  await expect(mapNode).toHaveAttribute("data-status", "done", { timeout: 10_000 });

  const log = page.getByTestId("execution-log");
  const logText = await log.innerText();
  const lines = logText.split("\n");

  // genuine concurrency: all three body iterations must have STARTED before any of them finished.
  const firstFinishedIdx = lines.findIndex((l) => l.includes("finished ->"));
  const startedBeforeFirstFinish = lines
    .slice(0, firstFinishedIdx)
    .filter((l) => l.includes("started") && l.startsWith("node-2@node-1:"));
  expect(startedBeforeFirstFinish).toHaveLength(3);

  // deterministic join: the map's own result is ordered by input index, not completion order.
  await expect(log).toContainText(
    'node-1: finished -> ["[mock:mock] got: a","[mock:mock] got: b","[mock:mock] got: c"]',
  );
  await expect(log).toContainText("run finished");
});
