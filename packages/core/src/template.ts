const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export function extractTemplateVars(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name) names.add(name);
  }
  return [...names];
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_whole, name: string) => {
    if (!Object.hasOwn(vars, name)) {
      throw new Error(`missing template variable "${name}"`);
    }
    return vars[name] ?? "";
  });
}
