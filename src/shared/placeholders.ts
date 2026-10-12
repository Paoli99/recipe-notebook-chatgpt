// Illustrated placeholders (inline SVG) used when a recipe has no photo, and as
// form thumbnails for ingredients. Data URIs keep them CSP-safe in the host.

const PALETTE: Record<string, { bg: string; ink: string }> = {
  sage: { bg: "#dfe7d6", ink: "#56704b" },
  terra: { bg: "#f2d9c9", ink: "#a4512c" },
  sand: { bg: "#f1e6cc", ink: "#8a6a2f" },
  sky: { bg: "#dbe6ea", ink: "#46707d" },
  plum: { bg: "#eadbe2", ink: "#80506a" },
};

// Simple line drawings on a 100×100 canvas.
const DRAWINGS: Record<string, string> = {
  bowl: '<path d="M18 50h64c0 18-14 30-32 30S18 68 18 50z"/><path d="M36 42c0-6 6-6 6-12M50 42c0-6 6-6 6-12M64 42c0-6 6-6 6-12"/>',
  plate: '<circle cx="50" cy="52" r="26"/><circle cx="50" cy="52" r="16"/><path d="M14 26v18M10 26v10c0 4 8 4 8 0V26M86 26c-6 4-6 14 0 18v12"/>',
  fish: '<path d="M18 50c12-16 36-18 50 0-14 18-38 16-50 0z"/><path d="M68 50l14-12v24z"/><circle cx="32" cy="47" r="2"/>',
  leaf: '<path d="M24 76c0-30 20-48 52-52-2 32-20 52-52 52z"/><path d="M24 76l34-34"/>',
  pasta: '<path d="M20 58h60c0 14-12 22-30 22S20 72 20 58z"/><path d="M30 58c0-14 8-26 20-26s20 12 20 26M38 58c0-10 5-18 12-18s12 8 12 18M46 58c0-4 2-8 4-8s4 4 4 8"/>',
  cup: '<path d="M26 34h40v26c0 10-8 18-20 18s-20-8-20-18z"/><path d="M66 40h6c6 0 6 14 0 14h-6M38 22c0 4 4 4 4 8M50 22c0 4 4 4 4 8"/>',
  cake: '<path d="M22 54h56v24H22z"/><path d="M22 62c8 6 12-6 18 0s12-6 18 0 12-6 20 0"/><path d="M50 54V40M50 30c-4 4 0 8 0 8s4-4 0-8"/>',
  egg: '<circle cx="50" cy="52" r="26"/><circle cx="54" cy="56" r="10"/><path d="M14 30c6-2 10 2 16 0"/>',
  grain: '<path d="M50 80V24"/><path d="M50 34c-8-2-10-10-10-10s8 0 10 8c2-8 10-8 10-8s-2 8-10 10zM50 50c-8-2-10-10-10-10s8 0 10 8c2-8 10-8 10-8s-2 8-10 10zM50 66c-8-2-10-10-10-10s8 0 10 8c2-8 10-8 10-8s-2 8-10 10z"/>',
  jar: '<path d="M32 30h36v8l4 6v32c0 4-2 6-6 6H34c-4 0-6-2-6-6V44l4-6z"/><path d="M30 24h40v6H30zM28 56h44"/>',
  nut: '<ellipse cx="50" cy="54" rx="22" ry="26"/><path d="M50 28c-6 10-6 42 0 52"/>',
  drop: '<path d="M50 20c14 20 22 30 22 42a22 22 0 0 1-44 0c0-12 8-22 22-42z"/>',
  apple: '<path d="M50 34c-20-10-34 6-30 24 4 18 16 26 30 20 14 6 26-2 30-20 4-18-10-34-30-24z"/><path d="M50 34c0-8 4-12 10-14"/>',
};

const RECIPE_STYLE: Record<string, [string, string]> = {
  poultry: ["plate", "terra"], meat: ["plate", "terra"], seafood: ["fish", "sky"],
  vegetarian: ["leaf", "sage"], vegan: ["leaf", "sage"], salad: ["leaf", "sage"],
  pasta: ["pasta", "sand"], rice: ["bowl", "sand"], soup: ["bowl", "terra"],
  breakfast: ["egg", "sand"], dessert: ["cake", "plum"], baking: ["cake", "plum"],
  drink: ["cup", "sky"], other: ["bowl", "sage"],
};

const INGREDIENT_STYLE: Record<string, [string, string]> = {
  poultry: ["plate", "terra"], meat: ["plate", "terra"], seafood: ["fish", "sky"], egg: ["egg", "sand"],
  "plant-protein": ["leaf", "sage"], legume: ["nut", "sage"], dairy: ["cup", "sky"], cheese: ["jar", "sand"],
  grain: ["grain", "sand"], pasta: ["pasta", "sand"], bread: ["grain", "sand"], "starchy-vegetable": ["leaf", "terra"],
  vegetable: ["leaf", "sage"], fruit: ["apple", "terra"], "nut-seed": ["nut", "sand"], "fat-oil": ["drop", "sand"],
  sweetener: ["jar", "plum"], baking: ["cake", "plum"], condiment: ["jar", "terra"], spice: ["jar", "terra"],
  herb: ["leaf", "sage"], drink: ["cup", "sky"], other: ["bowl", "sage"],
};

function svg(drawing: string, palette: string, size = 100): string {
  const p = PALETTE[palette] ?? PALETTE.sage;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100"><rect width="100" height="100" fill="${p.bg}"/><g fill="none" stroke="${p.ink}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${DRAWINGS[drawing] ?? DRAWINGS.bowl}</g></svg>`;
}

const toDataUri = (markup: string) => `data:image/svg+xml;base64,${typeof btoa === "function" ? btoa(markup) : Buffer.from(markup).toString("base64")}`;

export function recipePlaceholder(category: string): string {
  const [drawing, palette] = RECIPE_STYLE[category] ?? RECIPE_STYLE.other;
  return toDataUri(svg(drawing, palette, 320));
}

export function ingredientThumbnail(category: string): string {
  const [drawing, palette] = INGREDIENT_STYLE[category] ?? INGREDIENT_STYLE.other;
  return toDataUri(svg(drawing, palette, 96));
}
