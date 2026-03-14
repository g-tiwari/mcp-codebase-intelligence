import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSource } from "./helpers.js";

/**
 * Grammar regression tests — real-world syntax that previously failed
 * with older tree-sitter grammars. If any of these fail after a dependency
 * update, the grammar upgrade broke something.
 *
 * Before upgrading tree-sitter or any grammar package:
 *   1. Run `npm test` — all tests must pass
 *   2. Upgrade the package
 *   3. Run `npm test` — if these fail, the new grammar has regressions
 *   4. Test on real repos: ripgrep (Rust), gson (Java)
 */

describe("grammar regression — modern Rust syntax", () => {
  it("parses async functions", () => {
    const { symbols } = parseSource(
      `pub async fn fetch_data(url: &str) -> Result<String, Error> {
         let response = reqwest::get(url).await?;
         Ok(response.text().await?)
       }`,
      "test.rs"
    );
    const fn_ = symbols.find((s) => s.name === "fetch_data");
    assert.ok(fn_, "should parse async fn");
    assert.equal(fn_!.kind, "function");
  });

  it("parses closure syntax", () => {
    const { symbols } = parseSource(
      `pub fn process(items: Vec<i32>) -> Vec<i32> {
         items.iter()
           .filter(|x| **x > 0)
           .map(|x| x * 2)
           .collect()
       }`,
      "test.rs"
    );
    assert.ok(symbols.find((s) => s.name === "process"));
  });

  it("parses impl blocks with generics and lifetimes", () => {
    const { symbols, references } = parseSource(
      `impl<'a, T: Display + Clone> Iterator for MyIter<'a, T> {
         type Item = &'a T;
         fn next(&mut self) -> Option<Self::Item> {
           self.inner.next()
         }
       }`,
      "test.rs"
    );
    assert.ok(symbols.find((s) => s.name === "next"), "should find next function in impl block");
    assert.ok(references.find((r) => r.toSymbolName === "Iterator"), "should track trait impl reference");
  });

  it("parses pattern matching with complex patterns", () => {
    const { symbols } = parseSource(
      `pub fn classify(value: &Value) -> &str {
         match value {
           Value::String(s) if s.is_empty() => "empty_string",
           Value::Number(n) if *n > 0.0 => "positive",
           Value::Array(arr) => "array",
           _ => "other",
         }
       }`,
      "test.rs"
    );
    assert.ok(symbols.find((s) => s.name === "classify"));
  });

  it("parses derive macros and attributes", () => {
    const { symbols } = parseSource(
      `#[derive(Debug, Clone, Serialize, Deserialize)]
       #[serde(rename_all = "camelCase")]
       pub struct Config {
         pub name: String,
         #[serde(default)]
         pub timeout_ms: u64,
       }`,
      "test.rs"
    );
    assert.ok(symbols.find((s) => s.name === "Config" && s.kind === "class"));
  });

  it("parses trait with associated types and default methods", () => {
    const { symbols } = parseSource(
      `pub trait Processor {
         type Input;
         type Output;
         fn process(&self, input: Self::Input) -> Self::Output;
         fn validate(&self, input: &Self::Input) -> bool {
           true
         }
       }`,
      "test.rs"
    );
    assert.ok(symbols.find((s) => s.name === "Processor" && s.kind === "interface"));
    // validate has a body so it gets extracted; process is abstract (no body) so our walker skips it
    assert.ok(symbols.find((s) => s.name === "validate"), "should find method with default impl");
  });
});

describe("grammar regression — modern Java syntax", () => {
  it("parses records (Java 16+)", () => {
    const { symbols } = parseSource(
      `public record Point(double x, double y) {
         public double distance(Point other) {
           return Math.sqrt(Math.pow(x - other.x, 2) + Math.pow(y - other.y, 2));
         }
       }`,
      "test.java"
    );
    // record may parse as class — that's fine as long as it doesn't error
    assert.ok(symbols.length > 0, "should parse record without errors");
  });

  it("parses sealed classes (Java 17+)", () => {
    const { symbols } = parseSource(
      `public sealed interface Shape permits Circle, Rectangle {
         double area();
       }`,
      "test.java"
    );
    assert.ok(symbols.find((s) => s.name === "Shape"));
  });

  it("parses text blocks (Java 15+)", () => {
    const { symbols } = parseSource(
      `public class Query {
         public static String getSQL() {
           return """
             SELECT id, name
             FROM users
             WHERE active = true
             """;
         }
       }`,
      "test.java"
    );
    assert.ok(symbols.find((s) => s.name === "getSQL"));
  });

  it("parses generics with wildcards and bounds", () => {
    const { symbols } = parseSource(
      `public class Container<T extends Comparable<? super T>> {
         private final List<T> items;
         public <U extends T> void addAll(Collection<? extends U> source) {
           items.addAll(source);
         }
       }`,
      "test.java"
    );
    assert.ok(symbols.find((s) => s.name === "Container" && s.kind === "class"));
    assert.ok(symbols.find((s) => s.name === "addAll" && s.kind === "method"));
  });

  it("parses annotations with parameters", () => {
    const { symbols, references } = parseSource(
      `@Entity
       @Table(name = "users")
       public class User {
         @Id
         @GeneratedValue(strategy = GenerationType.IDENTITY)
         private Long id;

         @Column(nullable = false, length = 255)
         private String email;
       }`,
      "test.java"
    );
    assert.ok(symbols.find((s) => s.name === "User" && s.kind === "class"));
    // Annotations inside the class body (Id, GeneratedValue, Column) are tracked as references
    assert.ok(references.some((r) => r.toSymbolName === "Id" || r.toSymbolName === "GeneratedValue" || r.toSymbolName === "Column"));
  });
});

describe("grammar regression — modern Python syntax", () => {
  it("parses match statement (3.10+)", () => {
    const { symbols } = parseSource(
      `def handle_command(command):
         match command:
           case "quit":
             return False
           case "hello" | "hi":
             print("Hello!")
           case _:
             print(f"Unknown: {command}")
         return True`,
      "test.py"
    );
    assert.ok(symbols.find((s) => s.name === "handle_command"));
  });

  it("parses type hints with unions (3.10+)", () => {
    const { symbols } = parseSource(
      `def process(value: int | str | None) -> list[int]:
         if isinstance(value, str):
           return [len(value)]
         return [value or 0]`,
      "test.py"
    );
    assert.ok(symbols.find((s) => s.name === "process"));
  });

  it("parses dataclasses with complex types", () => {
    const { symbols } = parseSource(
      `from dataclasses import dataclass, field
       from typing import Optional

       @dataclass
       class Config:
         name: str
         values: list[int] = field(default_factory=list)
         metadata: Optional[dict[str, str]] = None`,
      "test.py"
    );
    assert.ok(symbols.find((s) => s.name === "Config" && s.kind === "class"));
  });

  it("parses async generators", () => {
    const { symbols } = parseSource(
      `async def stream_data(url: str):
         async with aiohttp.ClientSession() as session:
           async for chunk in session.get(url).content:
             yield chunk`,
      "test.py"
    );
    assert.ok(symbols.find((s) => s.name === "stream_data"));
  });
});

describe("grammar regression — modern Go syntax", () => {
  it("parses generics (Go 1.18+)", () => {
    const { symbols } = parseSource(
      `func Map[T any, U any](slice []T, fn func(T) U) []U {
         result := make([]U, len(slice))
         for i, v := range slice {
           result[i] = fn(v)
         }
         return result
       }`,
      "test.go"
    );
    assert.ok(symbols.find((s) => s.name === "Map" && s.kind === "function"));
  });

  it("parses generic type constraints", () => {
    const { symbols } = parseSource(
      `type Number interface {
         ~int | ~float64 | ~int64
       }

       func Sum[T Number](values []T) T {
         var total T
         for _, v := range values {
           total += v
         }
         return total
       }`,
      "test.go"
    );
    assert.ok(symbols.find((s) => s.name === "Number" && s.kind === "interface"));
    assert.ok(symbols.find((s) => s.name === "Sum" && s.kind === "function"));
  });

  it("parses generic structs", () => {
    const { symbols } = parseSource(
      `type Pair[T any, U any] struct {
         First  T
         Second U
       }

       func NewPair[T any, U any](first T, second U) Pair[T, U] {
         return Pair[T, U]{First: first, Second: second}
       }`,
      "test.go"
    );
    assert.ok(symbols.find((s) => s.name === "Pair" && s.kind === "class"));
    assert.ok(symbols.find((s) => s.name === "NewPair" && s.kind === "function"));
  });
});
