import { expect, test } from "@playwright/test";

test("draws a two-node prompt chain, runs it, and shows logs + export", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("New flow name").fill("Prompt Chain");
  await page.getByRole("button", { name: "New Flow" }).click();
  await expect(page).toHaveURL(/\/flows\/.+/);
  const flowId = page.url().split("/flows/")[1]!;

  await page.getByRole("button", { name: "Add Prompt Node" }).click();
  await page.getByRole("button", { name: "Add Prompt Node" }).click();

  const nodeA = page.getByTestId("node-node-1");
  const nodeB = page.getByTestId("node-node-2");
  await expect(nodeA).toBeVisible();
  await expect(nodeB).toBeVisible();

  const sourceHandle = nodeA.locator(".react-flow__handle-right");
  const targetHandle = nodeB.locator(".react-flow__handle-left");
  const sourceBox = await sourceHandle.boundingBox();
  const targetBox = await targetHandle.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("could not locate node handles");
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 10 });
  await page.mouse.up();

  const templateField = page.getByRole("textbox", { name: "Template" });

  await nodeA.click();
  await templateField.fill("Say hello");
  await expect(templateField).toHaveValue("Say hello");

  await nodeB.click();
  await expect(templateField).toHaveValue("");
  await templateField.fill("Reply to: {{input}}");
  await expect(templateField).toHaveValue("Reply to: {{input}}");

  await page.getByRole("button", { name: "Save" }).click();

  const savedGraph = await page.evaluate(async (id) => {
    const res = await fetch(`/api/flows/${id}`);
    return res.json();
  }, flowId);
  expect(savedGraph.graph.nodes.find((n: { id: string }) => n.id === "node-1").data.template).toBe("Say hello");
  expect(savedGraph.graph.nodes.find((n: { id: string }) => n.id === "node-2").data.template).toBe(
    "Reply to: {{input}}",
  );
  expect(savedGraph.graph.edges).toHaveLength(1);
  expect(savedGraph.graph.edges[0]).toMatchObject({ source: "node-1", target: "node-2", targetHandle: "input" });

  await page.getByRole("button", { name: "Run" }).click();

  await expect(nodeA).toHaveAttribute("data-status", "done");
  await expect(nodeB).toHaveAttribute("data-status", "done");

  const log = page.getByTestId("execution-log");
  await expect(log).toContainText("node-1: finished");
  await expect(log).toContainText("node-2: finished -> [mock:mock] Reply to: [mock:mock] Say hello");
  await expect(log).toContainText("run finished");

  await page.getByRole("button", { name: "Export" }).click();
  const script = page.getByTestId("exported-script");
  await expect(script).toContainText("MockProviderAdapter");
  await expect(script).toContainText("rt.prompt(N.n_node_1");
  await expect(script).toContainText("rt.prompt(N.n_node_2, { input: n_node_1.output })");
});
