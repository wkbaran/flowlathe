import { expect, test } from "@playwright/test";

test("creating a flow persists across reload", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("New flow name").fill("Persistence Test");
  await page.getByRole("button", { name: "New Flow" }).click();

  await expect(page).toHaveURL(/\/flows\/.+/);
  await expect(page.getByRole("heading", { name: "Persistence Test" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Persistence Test" })).toBeVisible();

  await page.goto("/");
  await expect(page.getByText("Persistence Test")).toBeVisible();
});
