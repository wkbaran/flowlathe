import { expect, test } from "@playwright/test";

test("creates a provider and model, and the canvas picks it up in the property panel", async ({ page }) => {
  await page.goto("/providers");

  // the seeded default provider is always present
  await expect(page.getByTestId("provider-Mock")).toBeVisible();

  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Local LM Studio");
  await page.getByRole("textbox", { name: "Base URL" }).fill("http://127.0.0.1:1234/v1");
  await page.getByRole("textbox", { name: "Secret (API key)" }).fill("sk-test-key");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  const providerCard = page.getByTestId("provider-Local LM Studio");
  await expect(providerCard).toBeVisible();
  await expect(providerCard).toContainText("secret set");
  await expect(providerCard).not.toContainText("sk-test-key");

  await providerCard.getByRole("textbox", { name: "Model name" }).fill("llama-3.1-8b");
  await providerCard.getByRole("button", { name: "Add model" }).click();
  await expect(providerCard).toContainText("llama-3.1-8b");

  // the raw API response must never carry the plaintext secret either
  const raw = await page.evaluate(() => fetch("/api/providers").then((r) => r.text()));
  expect(raw).not.toContain("sk-test-key");

  await page.getByRole("link", { name: "Flows" }).click();
  await page.getByLabel("New flow name").fill("Provider Test");
  await page.getByRole("button", { name: "New Flow" }).click();
  await page.getByRole("button", { name: "Add Prompt Node" }).click();
  await page.getByTestId("node-node-1").click();

  await page.getByRole("combobox", { name: "Provider" }).click();
  await page.getByRole("option", { name: "Local LM Studio" }).click();
  await page.getByRole("combobox", { name: "Model" }).click();
  await expect(page.getByRole("option", { name: "llama-3.1-8b" })).toBeVisible();
});
