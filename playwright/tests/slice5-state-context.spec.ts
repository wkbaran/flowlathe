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

test("context transforms: append -> filter-role chains into a prompt's flat-text template", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("New flow name").fill("Context Chain");
  await page.getByRole("button", { name: "New Flow" }).click();
  await expect(page).toHaveURL(/\/flows\/.+/);

  const kindSelect = page.getByRole("combobox", { name: "New node kind" });
  const addButton = page.getByRole("button", { name: "Add Node" });

  // node-1: contextTransform, starts a new context with a system message
  await kindSelect.click();
  await page.getByRole("option", { name: "contextTransform" }).click();
  await addButton.click();

  // node-2: contextTransform, appends a user message onto node-1's context
  await addButton.click();

  // node-3: prompt, renders the final context as flat text
  await kindSelect.click();
  await page.getByRole("option", { name: "prompt", exact: true }).click();
  await addButton.click();

  const seed = page.getByTestId("node-node-1");
  const addUser = page.getByTestId("node-node-2");
  const reply = page.getByTestId("node-node-3");
  const appendTemplateField = page.getByRole("textbox", { name: "Append template" });

  await seed.click();
  await expect(appendTemplateField).toHaveValue("");
  await page.getByRole("checkbox", { name: "Starts a new context" }).check();
  await appendTemplateField.fill("sys prompt");
  await expect(appendTemplateField).toHaveValue("sys prompt");
  await page.getByRole("combobox", { name: "Append role" }).click();
  await page.getByRole("option", { name: "system" }).click();

  await addUser.click();
  await expect(appendTemplateField).toHaveValue("");
  await appendTemplateField.fill("hi there");
  await expect(appendTemplateField).toHaveValue("hi there");
  await page.getByRole("combobox", { name: "Append role" }).click();
  await page.getByRole("option", { name: "user" }).click();

  await reply.click();
  const templateField = page.getByRole("textbox", { name: "Template" });
  await expect(templateField).toHaveValue("");
  await templateField.fill("{{input}}");
  await expect(templateField).toHaveValue("{{input}}");

  // wire node-1's "context" output -> node-2's "context" input, and node-2's "output" -> node-3's "ctx"
  const seedContextOut = seed.locator('.react-flow__handle-right[data-handleid="context"]');
  const addUserContextIn = addUser.locator('.react-flow__handle-left[data-handleid="context"]');
  await dragBetween(page, seedContextOut, addUserContextIn);

  const addUserOutputOut = addUser.locator('.react-flow__handle-right[data-handleid="output"]');
  const replyIn = reply.locator(".react-flow__handle-left");
  await dragBetween(page, addUserOutputOut, replyIn);

  await page.getByRole("button", { name: "Run" }).click();
  await expect(reply).toHaveAttribute("data-status", "done", { timeout: 10_000 });

  await expect(page.getByTestId("execution-log")).toContainText(
    "node-3: finished -> [mock:mock] system: sys prompt\nuser: hi there",
  );
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
