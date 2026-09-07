import { expect, test } from "@playwright/test";

// PLAN-FLOW-VERSIONING.md §7's E2E instruction, applied to flow history: "edit a flow, save as a
// named version, edit again, open history, diff the two, restore the first, assert a new head
// exists and the intermediate version is still listed" — the exact shape of Slice 4's branch-fork
// spec, one level up (flow history instead of execution branches).

test("name a version, diff it against a later edit, restore it, and history is never rewritten", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("New flow name").fill("Versioning Chain");
  await page.getByRole("button", { name: "New Flow" }).click();
  await expect(page).toHaveURL(/\/flows\/.+/);

  await page.getByRole("button", { name: "Add Node" }).click();
  await expect(page.getByTestId("node-node-1")).toBeVisible();
  await page.getByTestId("node-node-1").click();
  const template = page.getByRole("textbox", { name: "Template" });

  // v2: an ordinary, unnamed save.
  await template.fill("alpha");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("v2")).toBeVisible();

  // v3: named "baseline" via the version dialog, not a plain Save.
  await template.fill("beta");
  await page.getByTestId("open-name-version").click();
  await page.getByRole("textbox", { name: "Label" }).fill("baseline");
  await page.getByTestId("save-version-confirm").click();
  await expect(page.getByText("v3")).toBeVisible();

  // v4: another ordinary edit and save — HEAD moves on.
  await template.fill("gamma");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("v4")).toBeVisible();

  await page.getByTestId("open-history").click();
  const list = page.getByTestId("version-history-list");
  await expect(list).toContainText("baseline");
  await expect(list).toContainText("v4");
  await expect(list).toContainText("(HEAD)");

  // Diff v3 ("baseline") against the current head (v4): the template field changed beta -> gamma.
  await page.getByTestId("version-pick-from-3").click();
  await page.getByTestId("version-pick-to-4").click();
  await page.getByTestId("compare-versions").click();
  const diff = page.getByTestId("version-diff");
  await expect(diff).toContainText("data.template");
  await expect(diff).toContainText('"beta"');
  await expect(diff).toContainText('"gamma"');

  // Restore v3 ("baseline"): a NEW head is created, equal to v3's graph — history is not rewritten.
  await page.getByTestId("version-restore-3").click();
  await expect(list).toContainText("v5");
  await expect(list).toContainText("baseline"); // v3 is still there, unrewritten
  await expect(list).toContainText("v4"); // so is the version restored past

  // Close the dialog (MUI marks the rest of the page aria-hidden while it's open) to confirm the
  // canvas itself picked up the restored graph. Reloading a graph replaces xyflow's node objects
  // wholesale, which drops the node's `selected` flag and fires onSelectionChange(null) — so
  // re-select it before reading the properties panel.
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.locator("header").getByText("v5")).toBeVisible();
  await page.getByTestId("node-node-1").click();
  await expect(template).toHaveValue("beta");
});
