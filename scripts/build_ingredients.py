"""Builds data/ingredients.json from the USDA FoodData Central SR Legacy CSV release.

Usage:
    python3 -I scripts/build_ingredients.py <path-to-FoodData_Central_sr_legacy_food_csv_2018-04> data/ingredients.json

Download the dataset from https://fdc.nal.usda.gov/download-datasets
("SR Legacy", CSV, April 2018). Every ingredient below is pinned to an exact
FDC ID; the script copies kcal / protein / carbohydrate / fat per 100 g and,
when a unit is listed, the gram weight of that USDA portion. It fails loudly if
an ID, description or portion is missing so the data cannot silently drift.
"""

import csv
import json
import sys

# id, display name, category, state, fdc_id, (unit name, USDA portion modifier) or None
SPEC = [
    # Poultry
    ("chicken-breast-raw", "Chicken breast, skinless, raw", "poultry", "raw", 171077, None),
    ("chicken-breast-roasted", "Chicken breast, skinless, roasted", "poultry", "cooked", 171477, None),
    ("chicken-thigh-raw", "Chicken thigh, skinless, raw", "poultry", "raw", 173627, None),
    ("turkey-ground-raw", "Ground turkey, raw", "poultry", "raw", 171505, None),
    # Meat
    ("beef-ground-85-raw", "Ground beef 85% lean, raw", "meat", "raw", 171796, None),
    ("beef-ground-85-cooked", "Ground beef 85% lean, broiled", "meat", "cooked", 174032, None),
    ("beef-sirloin-raw", "Beef top sirloin steak, raw", "meat", "raw", 168726, None),
    ("pork-tenderloin-raw", "Pork tenderloin, lean, raw", "meat", "raw", 168249, None),
    ("bacon-raw", "Bacon, raw", "meat", "raw", 168277, None),
    ("ham-deli", "Ham, sliced deli (about 11% fat)", "meat", None, 173864, None),
    # Seafood
    ("shrimp-raw", "Shrimp, raw", "seafood", "raw", 175179, None),
    ("shrimp-cooked", "Shrimp, cooked", "seafood", "cooked", 175180, None),
    ("salmon-raw", "Atlantic salmon, farmed, raw", "seafood", "raw", 175167, None),
    ("salmon-cooked", "Atlantic salmon, farmed, cooked", "seafood", "cooked", 175168, None),
    ("cod-raw", "Atlantic cod, raw", "seafood", "raw", 171955, None),
    ("tuna-canned-water", "Tuna, light, canned in water, drained", "seafood", "canned", 171986, None),
    # Eggs
    ("egg-whole-raw", "Egg, whole, raw", "egg", "raw", 171287, ("egg", "large")),
    ("egg-whole-hard-boiled", "Egg, hard-boiled", "egg", "cooked", 173424, ("egg", "large")),
    ("egg-white-raw", "Egg white, raw", "egg", "raw", 172183, ("egg white", "large")),
    # Plant protein
    ("tofu-firm", "Tofu, firm", "plant-protein", None, 172475, None),
    ("tempeh", "Tempeh", "plant-protein", None, 174272, None),
    # Legumes
    ("lentils-dry", "Lentils, dry", "legume", "dry", 172420, None),
    ("lentils-cooked", "Lentils, boiled", "legume", "cooked", 172421, None),
    ("chickpeas-dry", "Chickpeas, dry", "legume", "dry", 173756, None),
    ("chickpeas-cooked", "Chickpeas, boiled", "legume", "cooked", 173757, None),
    ("chickpeas-canned", "Chickpeas, canned, drained", "legume", "canned", 173800, None),
    ("black-beans-cooked", "Black beans, boiled", "legume", "cooked", 173735, None),
    ("hummus", "Hummus", "legume", None, 174289, None),
    # Dairy
    ("milk-whole", "Milk, whole 3.25%", "dairy", None, 171265, None),
    ("milk-skim", "Milk, skim", "dairy", None, 171269, None),
    ("greek-yogurt-nonfat", "Greek yogurt, plain, nonfat", "dairy", None, 170894, None),
    ("greek-yogurt-whole", "Greek yogurt, plain, whole milk", "dairy", None, 171304, None),
    ("heavy-cream", "Heavy whipping cream", "dairy", None, 170859, None),
    ("sour-cream", "Sour cream", "dairy", None, 171257, None),
    ("butter-unsalted", "Butter, unsalted", "dairy", None, 173430, None),
    # Cheese
    ("cheddar", "Cheddar cheese", "cheese", None, 173414, None),
    ("mozzarella-part-skim", "Mozzarella, low-moisture part-skim", "cheese", None, 171244, None),
    ("parmesan-grated", "Parmesan, grated", "cheese", None, 171247, None),
    ("feta", "Feta cheese", "cheese", None, 173420, None),
    ("cream-cheese", "Cream cheese", "cheese", None, 173418, None),
    ("cottage-cheese-2", "Cottage cheese 2%", "cheese", None, 172182, None),
    ("ricotta-whole", "Ricotta, whole milk", "cheese", None, 170851, None),
    # Grains, pasta, bread
    ("rice-white-dry", "White rice, long-grain, dry", "grain", "dry", 168877, None),
    ("rice-white-cooked", "White rice, long-grain, cooked", "grain", "cooked", 168878, None),
    ("rice-brown-cooked", "Brown rice, long-grain, cooked", "grain", "cooked", 169704, None),
    ("quinoa-dry", "Quinoa, dry", "grain", "dry", 168874, None),
    ("quinoa-cooked", "Quinoa, cooked", "grain", "cooked", 168917, None),
    ("couscous-dry", "Couscous, dry", "grain", "dry", 169699, None),
    ("oats-rolled-dry", "Rolled oats, dry", "grain", "dry", 173904, None),
    ("pasta-dry", "Pasta, dry", "pasta", "dry", 169736, None),
    ("pasta-cooked", "Pasta, cooked", "pasta", "cooked", 169737, None),
    ("rice-noodles-dry", "Rice noodles, dry", "pasta", "dry", 169742, None),
    ("bread-white", "White bread", "bread", None, 174924, ("slice", "slice")),
    ("tortilla-flour", "Flour tortilla", "bread", None, 175037, None),
    ("tortilla-corn", "Corn tortilla", "bread", None, 175036, ("tortilla", "tortilla")),
    ("bread-crumbs", "Bread crumbs, dry", "bread", None, 174928, None),
    # Starchy vegetables
    ("potato-raw", "Potato, with skin, raw", "starchy-vegetable", "raw", 170026, None),
    ("potato-boiled", "Potato, boiled, peeled", "starchy-vegetable", "cooked", 170440, None),
    ("sweet-potato-raw", "Sweet potato, raw", "starchy-vegetable", "raw", 168482, None),
    ("corn-kernels-canned", "Sweet corn, canned, drained", "starchy-vegetable", "canned", 169214, None),
    ("peas-frozen", "Green peas, frozen", "starchy-vegetable", None, 170016, None),
    # Vegetables
    ("onion", "Onion, raw", "vegetable", "raw", 170000, ("onion", "medium (2-1/2\" dia)")),
    ("garlic", "Garlic, raw", "vegetable", "raw", 169230, ("clove", "clove")),
    ("scallion", "Scallions, raw", "vegetable", "raw", 170005, None),
    ("tomato", "Tomato, raw", "vegetable", "raw", 170457, ("tomato", "medium whole (2-3/5\" dia)")),
    ("tomatoes-canned", "Tomatoes, canned in juice", "vegetable", "canned", 170051, None),
    ("tomato-paste", "Tomato paste", "vegetable", "canned", 170459, None),
    ("tomato-sauce", "Tomato sauce, canned", "vegetable", "canned", 170054, None),
    ("carrot", "Carrot, raw", "vegetable", "raw", 170393, ("carrot", "medium")),
    ("broccoli-raw", "Broccoli, raw", "vegetable", "raw", 170379, None),
    ("spinach-raw", "Spinach, raw", "vegetable", "raw", 168462, None),
    ("red-bell-pepper", "Red bell pepper, raw", "vegetable", "raw", 170108, None),
    ("jalapeno", "Jalapeño, raw", "vegetable", "raw", 168576, None),
    ("mushrooms-white", "White mushrooms, raw", "vegetable", "raw", 169251, None),
    ("zucchini", "Zucchini, raw", "vegetable", "raw", 169291, None),
    ("cucumber", "Cucumber, with peel, raw", "vegetable", "raw", 168409, None),
    ("romaine", "Romaine lettuce, raw", "vegetable", "raw", 169247, None),
    ("cauliflower", "Cauliflower, raw", "vegetable", "raw", 169986, None),
    ("celery", "Celery, raw", "vegetable", "raw", 169988, None),
    ("eggplant", "Eggplant, raw", "vegetable", "raw", 169228, None),
    ("kale", "Kale, raw", "vegetable", "raw", 168421, None),
    ("asparagus", "Asparagus, raw", "vegetable", "raw", 168389, None),
    ("green-beans", "Green beans, raw", "vegetable", "raw", 169961, None),
    ("ginger", "Ginger root, raw", "vegetable", "raw", 169231, None),
    ("avocado", "Avocado", "vegetable", "raw", 171705, None),
    # Fruit
    ("banana", "Banana", "fruit", "raw", 173944, ("banana", "medium (7\" to 7-7/8\" long)")),
    ("apple", "Apple, with skin", "fruit", "raw", 171688, ("apple", "medium (3\" dia)")),
    ("strawberries", "Strawberries", "fruit", "raw", 167762, None),
    ("blueberries", "Blueberries", "fruit", "raw", 171711, None),
    ("mango", "Mango", "fruit", "raw", 169910, None),
    ("raisins", "Raisins, dark", "fruit", "dry", 168165, None),
    ("lemon-juice", "Lemon juice", "fruit", None, 167747, None),
    ("lime-juice", "Lime juice", "fruit", None, 168156, None),
    ("orange-juice", "Orange juice", "fruit", None, 169098, None),
    # Nuts and seeds
    ("almonds", "Almonds", "nut-seed", None, 170567, None),
    ("walnuts", "Walnuts", "nut-seed", None, 170187, None),
    ("cashews", "Cashews, raw", "nut-seed", "raw", 170162, None),
    ("peanuts", "Peanuts, raw", "nut-seed", "raw", 172430, None),
    ("peanut-butter", "Peanut butter, smooth, unsalted", "nut-seed", None, 172470, None),
    ("chia-seeds", "Chia seeds", "nut-seed", "dry", 170554, None),
    ("sesame-seeds", "Sesame seeds", "nut-seed", "dry", 170150, None),
    ("coconut-milk-canned", "Coconut milk, canned", "nut-seed", "canned", 170173, None),
    # Fats and oils
    ("olive-oil", "Olive oil", "fat-oil", None, 171413, None),
    ("canola-oil", "Canola oil", "fat-oil", None, 172336, None),
    ("coconut-oil", "Coconut oil", "fat-oil", None, 171412, None),
    ("sesame-oil", "Sesame oil", "fat-oil", None, 171016, None),
    ("mayonnaise", "Mayonnaise", "fat-oil", None, 171009, None),
    # Sweeteners and baking
    ("sugar-white", "Sugar, granulated", "sweetener", None, 169655, None),
    ("sugar-brown", "Sugar, brown", "sweetener", None, 168833, None),
    ("honey", "Honey", "sweetener", None, 169640, None),
    ("maple-syrup", "Maple syrup", "sweetener", None, 169661, None),
    ("flour-all-purpose", "All-purpose flour", "baking", None, 168894, None),
    ("cornstarch", "Cornstarch", "baking", None, 169698, None),
    ("cocoa-powder", "Cocoa powder, unsweetened", "baking", None, 169593, None),
    ("dark-chocolate", "Dark chocolate 70–85%", "baking", None, 170273, None),
    ("baking-powder", "Baking powder", "baking", None, 172803, None),
    ("baking-soda", "Baking soda", "baking", None, 175040, None),
    ("vanilla-extract", "Vanilla extract", "baking", None, 173471, None),
    ("yeast-dry", "Active dry yeast", "baking", None, 175043, None),
    # Condiments and sauces
    ("soy-sauce", "Soy sauce", "condiment", None, 174277, None),
    ("vinegar-balsamic", "Balsamic vinegar", "condiment", None, 172241, None),
    ("mustard-yellow", "Yellow mustard", "condiment", None, 172234, None),
    ("ketchup", "Ketchup", "condiment", None, 168556, None),
    ("salsa", "Salsa", "condiment", None, 174524, None),
    ("pesto", "Pesto, refrigerated", "condiment", None, 171579, None),
    ("chicken-broth", "Chicken broth", "condiment", None, 174536, None),
    ("vegetable-broth", "Vegetable broth", "condiment", None, 171583, None),
    ("capers", "Capers", "condiment", "canned", 172238, None),
    # Herbs and spices
    ("salt", "Salt", "spice", None, 173468, None),
    ("black-pepper", "Black pepper", "spice", None, 170931, None),
    ("cumin", "Cumin", "spice", None, 170923, None),
    ("paprika", "Paprika", "spice", None, 171329, None),
    ("chili-powder", "Chili powder", "spice", None, 171319, None),
    ("cinnamon", "Cinnamon, ground", "spice", None, 171320, None),
    ("oregano-dried", "Oregano, dried", "spice", None, 171328, None),
    ("turmeric", "Turmeric, ground", "spice", None, 172231, None),
    ("curry-powder", "Curry powder", "spice", None, 170924, None),
    ("basil-fresh", "Basil, fresh", "herb", "raw", 172232, None),
    ("parsley-fresh", "Parsley, fresh", "herb", "raw", 170416, None),
    ("cilantro-fresh", "Cilantro, fresh", "herb", "raw", 169997, None),
    # Drinks
    ("almond-milk", "Almond milk, unsweetened", "drink", None, 174832, None),
    ("soy-milk", "Soy milk, unsweetened", "drink", None, 175215, None),
    ("water", "Water", "drink", None, 173647, None),
]

NUTRIENTS = {"1008": "kcal", "1003": "protein", "1005": "carbs", "1004": "fat"}


def main(src: str, out: str) -> None:
    foods = {r["fdc_id"]: r["description"] for r in csv.DictReader(open(f"{src}/food.csv", encoding="utf-8"))}
    wanted = {str(s[4]) for s in SPEC}
    values: dict[str, dict[str, float]] = {}
    for r in csv.DictReader(open(f"{src}/food_nutrient.csv", encoding="utf-8")):
        if r["fdc_id"] in wanted and r["nutrient_id"] in NUTRIENTS:
            values.setdefault(r["fdc_id"], {})[NUTRIENTS[r["nutrient_id"]]] = float(r["amount"])
    portions: dict[str, list[dict[str, str]]] = {}
    for r in csv.DictReader(open(f"{src}/food_portion.csv", encoding="utf-8")):
        if r["fdc_id"] in wanted:
            portions.setdefault(r["fdc_id"], []).append(r)

    ids = [s[0] for s in SPEC]
    if len(ids) != len(set(ids)):
        raise SystemExit("duplicate ingredient id in SPEC")

    rows = []
    for ing_id, name, category, state, fdc, unit in SPEC:
        key = str(fdc)
        if key not in foods:
            raise SystemExit(f"{ing_id}: FDC {fdc} not found")
        v = values.get(key, {})
        missing = [n for n in NUTRIENTS.values() if n not in v]
        if missing:
            raise SystemExit(f"{ing_id}: FDC {fdc} missing {missing}")
        grams_per_unit = None
        unit_name = None
        if unit:
            unit_name, modifier = unit
            match = [p for p in portions.get(key, []) if p["modifier"] == modifier and p["amount"] in ("1", "1.0")]
            if not match:
                raise SystemExit(f"{ing_id}: portion '{modifier}' not found for FDC {fdc}")
            grams_per_unit = float(match[0]["gram_weight"])
        rows.append({
            "id": ing_id,
            "name": name,
            "category": category,
            "state": state,
            "kcal100g": v["kcal"],
            "protein100g": v["protein"],
            "carbs100g": v["carbs"],
            "fat100g": v["fat"],
            "gramsPerUnit": grams_per_unit,
            "unitName": unit_name,
            "source": {"dataset": "USDA FoodData Central SR Legacy (2018-04)", "fdcId": fdc, "description": foods[key]},
        })
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(rows, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    print(f"wrote {len(rows)} ingredients to {out}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
