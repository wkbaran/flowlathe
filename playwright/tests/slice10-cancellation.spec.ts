import { expect, test } from "@playwright/test";

test("a failing fan-out sibling stops in-flight work and shows a cancelled (not green) node card", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("New flow name").fill("Cancellation");
  await page.getByRole("button", { name: "New Flow" }).click();
  await expect(page).toHaveURL(/\/flows\/.+/);

  await page.getByRole("button", { name: "Add Node" }).click();
  await page.getByRole("button", { name: "Add Node" }).click();

  const boom = page.getByTestId("node-node-1");
  const slow = page.getByTestId("node-node-2");
  await expect(boom).toBeVisible();
  await expect(slow).toBeVisible();

  const templateField = page.getByRole("textbox", { name: "Template" });

  await boom.click();
  await expect(templateField).toHaveValue("");
  await templateField.fill("FAIL: boom node exploded");
  await expect(templateField).toHaveValue("FAIL: boom node exploded");

  await slow.click();
  await expect(templateField).toHaveValue("");
  await templateField.fill("DELAY_MS: 2000 slow node");
  await expect(templateField).toHaveValue("DELAY_MS: 2000 slow node");

  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "Run" }).click();

  const log = page.getByTestId("execution-log");
  await expect(log).toContainText("node-1: failed (boom node exploded)");
  await expect(log).toContainText("node-2: cancelled");
  await expect(log).toContainText("run failed");

  await expect(boom).toHaveAttribute("data-status", "failed");
  await expect(slow).toHaveAttribute("data-status", "cancelled");
  await expect(slow).not.toHaveAttribute("data-status", "done");
});
