# ast-grep Rule Reference

## Rule Categories

| Category | Purpose |
| -------- | ------- |
| **Atomic** | Match single node properties: `pattern`, `kind`, `regex`, `nthChild` |
| **Relational** | Match by position: `inside`, `has`, `precedes`, `follows` |
| **Composite** | Logical combinations: `all` (AND), `any` (OR), `not`, `matches` |

## Rule Object Properties

| Property | Category | Purpose | Example |
| -------- | -------- | ------- | ------- |
| `pattern` | Atomic | Match code pattern | `pattern: console.log($ARG)` |
| `kind` | Atomic | Match AST node type | `kind: call_expression` |
| `regex` | Atomic | Match node text by regex | `regex: ^[a-z]+$` |
| `nthChild` | Atomic | Match by index in parent | `nthChild: 1` |
| `inside` | Relational | Must be inside matched node | `inside: { kind: class_declaration, stopBy: end }` |
| `has` | Relational | Must have descendant matching | `has: { pattern: await $EXPR, stopBy: end }` |
| `precedes` | Relational | Must appear before match | `precedes: { pattern: return $VAL }` |
| `follows` | Relational | Must appear after match | `follows: { pattern: import $M from '$P' }` |
| `all` | Composite | All sub-rules match (AND) | `all: [{ kind: call_expression }, { pattern: foo($A) }]` |
| `any` | Composite | Any sub-rule matches (OR) | `any: [{ pattern: foo() }, { pattern: bar() }]` |
| `not` | Composite | Sub-rule must NOT match | `not: { pattern: console.log($ARG) }` |
| `matches` | Composite | Reference utility rule by ID | `matches: my-utility-rule-id` |

## Metavariables

| Syntax | Captures | Example |
| ------ | -------- | ------- |
| `$VAR` | Single named node | `console.log($ARG)` matches `console.log('hi')` |
| `$$VAR` | Single unnamed node (operators, punctuation) | `$$OP` captures `+` in `a + b` |
| `$$$VAR` | Zero or more nodes (non-greedy) | `fn($$$ARGS)` matches any arity |
| `$_VAR` | Non-capturing (perf optimization) | `$_OBJ.method()` matches without storing |

**Constraints:** Same-named metavar must match identical code: `$X == $X` matches `a == a` but not `a == b`.

**Invalid:** `$lowercase`, `$123`, `$KEBAB-CASE`, embedded in strings (`"Hello $WORLD"`).

## stopBy (Relational Rules)

| Value | Behavior |
| ----- | -------- |
| `"neighbor"` (default) | Stop at first non-matching sibling |
| `"end"` | Search to root (`inside`) or leaf (`has`) |
| Rule object | Stop when surrounding node matches rule |

**Best practice:** Always use `stopBy: end` unless you have a specific reason not to.

## Pattern Forms

**String pattern** (simple):

```yaml
pattern: console.log($ARG)
```

**Object pattern** (ambiguous syntax or contextual):

```yaml
pattern:
  selector: field_definition
  context: class { $F }
  strictness: relaxed  # cst | smart | ast | relaxed | signature
```

## Common Patterns

### Functions containing specific code

```yaml
rule:
  kind: function_declaration
  has:
    pattern: await $EXPR
    stopBy: end
```

### Code inside specific context

```yaml
rule:
  pattern: console.log($$$)
  inside:
    kind: method_definition
    stopBy: end
```

### Negation (missing expected pattern)

```yaml
rule:
  all:
    - kind: function_declaration
    - has:
        pattern: await $EXPR
        stopBy: end
    - not:
        has:
          pattern: try { $$$ } catch ($E) { $$$ }
          stopBy: end
```

### Multiple alternatives

```yaml
rule:
  any:
    - pattern: console.log($$$)
    - pattern: console.warn($$$)
    - pattern: console.error($$$)
```

## Java-Specific Gotchas

1. **Modifiers don't work as metavars:** `$MOD String $FIELD` fails. Use `kind: field_declaration` + `regex`.
2. **Annotations break simple patterns:** `@NotNull String field` won't match `String $FIELD`. Use `kind: method_declaration` + `has: { kind: marker_annotation }`.
3. **Generics:** Complex generics like `Map<String, List<Integer>>` may need `kind` + `regex` on the type field.
4. **Lambdas vs method refs:** `lambda_expression` and `method_reference` are different node kinds — match separately.

## Common Java Node Kinds

**Declarations:** `class_declaration`, `interface_declaration`, `enum_declaration`, `record_declaration`, `method_declaration`, `field_declaration`, `constructor_declaration`, `local_variable_declaration`

**Statements:** `try_statement`, `try_with_resources_statement`, `if_statement`, `for_statement`, `enhanced_for_statement`, `while_statement`, `return_statement`, `throw_statement`

**Expressions:** `method_invocation`, `object_creation_expression`, `lambda_expression`, `method_reference`, `field_access`, `cast_expression`, `instanceof_expression`

**Annotations:** `annotation` (with values), `marker_annotation` (without)

## Debugging

```bash
# Dump CST to find correct node kinds
ast-grep run -p 'your code here' -l javascript --debug-query=cst

# Formats: cst (all nodes), ast (named only), pattern (interpretation)
```

## Resources

- Playground: <https://ast-grep.github.io/playground.html>
- Docs: <https://ast-grep.github.io/>
