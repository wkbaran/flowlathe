import { expect, test } from "@playwright/test";

test("state: a prompt's write_state tool call updates the flow's shared state store", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("New flow name").fill("State Tools");
  await page.getByRole("button", { name: "New Flow" }).click();
  await expect(page).toHaveURL(/\/flows\/.+/);

  await page.getByRole("button", { name: "Add state entry" }).click();
  await page.getByRole("textbox", { name: "State entry 0 name" }).fill("notes");
  await page.getByRole("combobox", { name: "State entry 0 merge rule" }).click();
  await page.getByRole("option", { name: "append" }).click();

  await page.getByRole("button", { name: "Add Node" }).click();
  const node = page.getByTestId("node-node-1");
  await node.click();

  const templateField = page.getByRole("textbox", { name: "Template" });
  await templateField.fill('CALL_TOOL: write_state {"entry":"notes","value":"hello"}');
  await page.getByRole("checkbox", { name: "Enable read_state/write_state tool" }).check();

  await page.getByRole("button", { name: "Run" }).click();
  await expect(node).toHaveAttribute("data-status", "done", { timeout: 10_000 });

  await expect(page.getByTestId("execution-log")).toContainText('state[notes] <- ["hello"] (append, via tool)');
  await expect(page.locator('[data-testid="state-decl-list"]')).toContainText('current: ["hello"]');
});

test("gate: overrides ambient LLM settings for every node wired downstream of it", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("New flow name").fill("Gated Settings");
  await page.getByRole("button", { name: "New Flow" }).click();
  await expect(page).toHaveURL(/\/flows\/.+/);

  const kindSelect = page.getByRole("combobox", { name: "New node kind" });
  const addButton = page.getByRole("button", { name: "Add Node" });
  const templateField = page.getByRole("textbox", { name: "Template" });

  // node-1: prompt (seed)
  await addButton.click();
  const seed = page.getByTestId("node-node-1");
  await seed.click();
  await expect(templateField).toHaveValue("");
  await templateField.fill("hello");
  await expect(templateField).toHaveValue("hello");

  // node-2: gate
  await kindSelect.click();
  await page.getByRole("option", { name: "gate", exact: true }).click();
  await addButton.click();
  const gate = page.getByTestId("node-node-2");
  await gate.click();
  const temperatureField = page.getByRole("spinbutton", { name: "Temperature" });
  // .fill() on a React-controlled type="number" input is flaky under fast, no-delay automation
  // (the value tracker misses the change) -- type it out character-by-character instead.
  await temperatureField.pressSequentially("0.5");
  await expect(temperatureField).toHaveValue("0.5");

  // node-3: prompt (reply)
  await kindSelect.click();
  await page.getByRole("option", { name: "prompt", exact: true }).click();
  await addButton.click();
  const reply = page.getByTestId("node-node-3");
  await reply.click();
  await expect(templateField).toHaveValue("");
  await templateField.fill("{{input}}");
  await expect(templateField).toHaveValue("{{input}}");

  // Nodes land further apart than one screen's width by the time all 3 exist (default spacing is
  // generous enough that the diamond Gate never overlaps its neighbors) -- fit the whole graph
  // into view first, or a node past the fold gets an off-screen boundingBox and the drag misses.
  await page.getByRole("button", { name: "Fit View" }).click();

  // wire seed -> gate -> reply, all via each node's single "input"/"output" handle
  await dragBetween(page, seed.locator(".react-flow__handle-right"), gate.locator(".react-flow__handle-left"));
  await dragBetween(page, gate.locator(".react-flow__handle-right"), reply.locator(".react-flow__handle-left"));

  await page.getByRole("button", { name: "Run" }).click();
  await expect(reply).toHaveAttribute("data-status", "done", { timeout: 10_000 });

  const log = page.getByTestId("execution-log");
  await expect(log).toContainText('node-2: gate set {"temperature":0.5}');
  await expect(log).toContainText("node-3: finished -> [mock:mock] [mock:mock] hello");
});

async function dragBetween(
  page: import("@playwright/test").Page,
  source: import("@playwright/test").Locator,
  target: import("@playwright/test").Locator,
): Promise<void> {
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("could not locate handle");
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 10 });
  await page.mouse.up();
}
