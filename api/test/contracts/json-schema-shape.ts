/**
 * Reduces a JSON Schema to what both validators enforce, so pydantic's export and Zod's
 * can be compared: titles, descriptions and defaults go; `$ref`s are inlined; nullable
 * `anyOf`s become a `nullable` flag; Zod's safe-integer bounds are dropped.
 */
type Schema = Record<string, unknown>;

const SAFE_INTEGER_BOUNDS = new Set([Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]);

export function schemaShape(node: Schema, defs: Record<string, Schema> = {}): unknown {
  if (typeof node.$ref === "string") {
    const name = node.$ref.replace("#/$defs/", "");
    const target = defs[name];
    if (!target) throw new Error(`unresolved $ref ${node.$ref}`);
    return schemaShape(target, defs);
  }
  if (Array.isArray(node.anyOf)) {
    const options = node.anyOf as Schema[];
    const nonNull = options.filter((option) => option.type !== "null");
    const nullable = nonNull.length < options.length ? { nullable: true } : {};
    if (nonNull.length === 1) return { ...(schemaShape(nonNull[0]!, defs) as object), ...nullable };
    return { anyOf: nonNull.map((option) => schemaShape(option, defs)), ...nullable };
  }

  const shape: Record<string, unknown> = {};
  if (Array.isArray(node.type)) {
    const types = (node.type as string[]).filter((type) => type !== "null");
    shape.type = types.length === 1 ? types[0] : types;
    if (types.length < node.type.length) shape.nullable = true;
  } else if (node.type !== undefined) {
    shape.type = node.type;
  }
  if (Array.isArray(node.enum)) {
    const values = (node.enum as (string | null)[]).filter((value) => value !== null);
    shape.enum = values.sort();
    if (values.length < node.enum.length) shape.nullable = true;
  }
  for (const bound of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) {
    const value = node[bound];
    if (typeof value === "number" && !SAFE_INTEGER_BOUNDS.has(value)) shape[bound] = value;
  }
  if (node.items) shape.items = schemaShape(node.items as Schema, defs);

  if (node.type === "object") {
    const properties = (node.properties ?? {}) as Record<string, Schema>;
    if (Object.keys(properties).length > 0) {
      shape.properties = Object.fromEntries(
        Object.entries(properties)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, property]) => [name, schemaShape(property, defs)]),
      );
      shape.required = [...((node.required ?? []) as string[])].sort();
    } else {
      const values = node.additionalProperties;
      const isAny =
        values === undefined ||
        values === true ||
        (typeof values === "object" && Object.keys(values as object).length === 0);
      shape.values = isAny ? "any" : schemaShape(values as Schema, defs);
    }
  }
  return shape;
}
