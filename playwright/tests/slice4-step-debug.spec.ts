import { expect, test } from "@playwright/test";

test("run, step back, edit a prompt, step forward: a new branch exists and the original is intact", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("New flow name").fill("Step Debug");
  await page.getByRole("button", { name: "New Flow" }).click();
  await expect(page).toHaveURL(/\/flows\/.+/);

  await page.getByRole("button", { name: "Add Node" }).click();
  await page.getByRole("button", { name: "Add Node" }).click();

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
  await expect(templateField).toHaveValue("");
  await templateField.fill("hello");
  await expect(templateField).toHaveValue("hello");

  await nodeB.click();
  await expect(templateField).toHaveValue("");
  await templateField.fill("original reply: {{input}}");
  await expect(templateField).toHaveValue("original reply: {{input}}");

  await page.getByRole("button", { name: "Save" }).click();

  await page.getByRole("button", { name: "Start Stepping" }).click();
  await expect(page.getByTestId("step-debug-panel")).toBeVisible();

  const stepButton = page.getByRole("button", { name: "Step", exact: true });
  await stepButton.click(); // node-1 runs
  await expect(nodeA).toHaveAttribute("data-status", "done", { timeout: 10_000 });
  await stepButton.click(); // node-2 runs
  await expect(nodeB).toHaveAttribute("data-status", "done", { timeout: 10_000 });

  await expect(page.getByTestId("execution-log")).toContainText(
    "node-2: finished -> [mock:mock] original reply: [mock:mock] hello",
  );

  // step back to right after node-1: forks a new branch, and node-2 reverts to idle
  const history = page.getByTestId("step-history");
  await history
    .locator("li")
    .filter({ hasText: "node-1" })
    .getByRole("button", { name: "Step back to here" })
    .click();
  await expect(nodeB).toHaveAttribute("data-status", "idle");

  const branchList = page.getByTestId("branch-list");
  await expect(branchList).toBeVisible();

  // edit node-2's prompt on the fork, then step forward
  await nodeB.click();
  await expect(templateField).toHaveValue("original reply: {{input}}");
  await templateField.fill("edited reply: {{input}}");
  await expect(templateField).toHaveValue("edited reply: {{input}}");
  await page.getByRole("button", { name: "Save" }).click();
  await stepButton.click();
  await expect(nodeB).toHaveAttribute("data-status", "done", { timeout: 10_000 });

  await expect(page.getByTestId("execution-log")).toContainText(
    "node-2: finished -> [mock:mock] edited reply: [mock:mock] hello",
  );

  // the original branch still exists and is untouched by the edit
  const branchButtons = branchList.getByRole("button");
  await expect(branchButtons).toHaveCount(2);
  await branchButtons.filter({ hasNotText: "●" }).click();
  await expect(page.getByTestId("execution-log")).not.toContainText("edited reply");
  await expect(page.getByTestId("execution-log")).toContainText("node-2: finished");
});
