import { expect, test } from "@playwright/test";

test("a Map with a two-node body dispatches both nodes per item and lights up their status", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("New flow name").fill("Multinode Map Body");
  await page.getByRole("button", { name: "New Flow" }).click();
  await expect(page).toHaveURL(/\/flows\/.+/);

  const kindSelect = page.getByRole("combobox", { name: "New node kind" });
  const addButton = page.getByRole("button", { name: "Add Node" });
  const templateField = page.getByRole("textbox", { name: "Template" });
  const parentSelect = page.getByRole("combobox", { name: "Parent (Loop/Map body of)" });

  await kindSelect.click();
  await page.getByRole("option", { name: "map" }).click();
  await addButton.click();
  const mapNode = page.getByTestId("node-node-1");

  await kindSelect.click();
  await page.getByRole("option", { name: "prompt", exact: true }).click();
  await addButton.click();
  const nodeA = page.getByTestId("node-node-2");

  await addButton.click();
  const nodeB = page.getByTestId("node-node-3");

  await expect(mapNode).toBeVisible();
  await expect(nodeA).toBeVisible();
  await expect(nodeB).toBeVisible();

  // "a" is the body's entry: it declares the map's itemPortName ("item") with no incoming edge,
  // so it receives each item's injected value directly -- no edge needed for that binding.
  await nodeA.click();
  await parentSelect.click();
  await page.getByRole("option", { name: /body of node-1/ }).click();
  await templateField.fill("{{item}}");
  await expect(templateField).toHaveValue("{{item}}");

  // "b" is the body's terminal: it consumes "a"'s output over a real edge. Every prompt's visual
  // target handle is hardcoded to id "input" regardless of template variable name (CLAUDE.md), so
  // its template must use {{input}}.
  await nodeB.click();
  await parentSelect.click();
  await page.getByRole("option", { name: /body of node-1/ }).click();
  await templateField.fill("next: {{input}}");
  await expect(templateField).toHaveValue("next: {{input}}");

  // Reassigning parentId repositions both nodes (xyflow treats a child's position as
  // parent-relative) -- fit the whole graph into view before locating handles to drag (CLAUDE.md).
  await page.getByRole("button", { name: "Fit View" }).click();

  const sourceHandle = nodeA.locator(".react-flow__handle-right");
  const targetHandle = nodeB.locator(".react-flow__handle-left");
  const sourceBox = await sourceHandle.boundingBox();
  const targetBox = await targetHandle.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("could not locate node handles");
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 10 });
  await page.mouse.up();

  await page.getByRole("button", { name: "Run" }).click();

  await expect(mapNode).toHaveAttribute("data-status", "done", { timeout: 10_000 });
  // both body nodes' status lights up, keyed by their base (unscoped) id -- the fix this slice
  // makes: nodeStatus is written from each event's *scoped* activation id (e.g. "node-2@node-1:0").
  await expect(nodeA).toHaveAttribute("data-status", "done");
  await expect(nodeB).toHaveAttribute("data-status", "done");

  const log = page.getByTestId("execution-log");
  const logText = await log.innerText();

  // both body nodes actually dispatched per item, under scoped activation keys -- the raw scoped
  // id is what's asserted here (kept verbatim in the log text, per CLAUDE.md).
  for (const i of [0, 1, 2]) {
    expect(logText).toContain(`node-2@node-1:${i}: finished`);
    expect(logText).toContain(`node-3@node-1:${i}: finished`);
  }

  // the map joins the CHAIN's final (node-3) output per item, in input order.
  await expect(log).toContainText(
    'node-1: finished -> ["[mock:mock] next: [mock:mock] a","[mock:mock] next: [mock:mock] b","[mock:mock] next: [mock:mock] c"]',
  );
  await expect(log).toContainText("run finished");
});
